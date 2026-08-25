import { describe, expect, it } from "vitest";
import {
  mapOtlpRequest,
  OtlpExportTraceServiceRequestSchema,
  stableOtlpUuid,
  unixNanoToIso,
} from "../../src/routes/otlp.js";

const validRequest = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "sql-change-agent" } },
          { key: "service.instance.id", value: { stringValue: "worker-1" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "@opentelemetry/instrumentation-openai", version: "0.1.0" },
          spans: [
            {
              traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
              spanId: "00f067aa0ba902b7",
              name: "agent.run",
              kind: 1,
              startTimeUnixNano: "1710000000000000000",
              endTimeUnixNano: "1710000001000000000",
              status: { code: 1 },
            },
            {
              traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
              spanId: "b7ad6b7169203331",
              parentSpanId: "00f067aa0ba902b7",
              name: "openai.chat",
              kind: 3,
              startTimeUnixNano: "1710000000100000000",
              endTimeUnixNano: "1710000000900000000",
              attributes: [
                { key: "gen_ai.request.model", value: { stringValue: "gpt-test" } },
                { key: "gen_ai.usage.input_tokens", value: { intValue: "12" } },
                { key: "large.integer", value: { intValue: "9007199254740993" } },
              ],
              events: [
                {
                  timeUnixNano: "1710000000500000000",
                  name: "exception",
                  attributes: [{ key: "exception.type", value: { stringValue: "Timeout" } }],
                },
              ],
              status: { code: 2, message: "provider timed out" },
            },
          ],
        },
      ],
    },
  ],
} as const;

describe("OTLP JSON contract", () => {
  it("strictly validates the protobuf JSON mapping and fills protobuf defaults", () => {
    const parsed = OtlpExportTraceServiceRequestSchema.parse(validRequest);
    const first = parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(first).toMatchObject({
      attributes: [],
      events: [],
      links: [],
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    });
  });

  it("ignores forward-compatible fields but rejects invalid IDs, attributes, enums, and time", () => {
    const baseSpan = validRequest.resourceSpans[0].scopeSpans[0].spans[0];
    const wrap = (span: unknown) => ({
      resourceSpans: [{ scopeSpans: [{ spans: [span] }] }],
    });

    const forwardCompatible = OtlpExportTraceServiceRequestSchema.parse({
      ...validRequest,
      futureProtocolField: true,
    });
    expect(forwardCompatible).not.toHaveProperty("futureProtocolField");
    expect(
      OtlpExportTraceServiceRequestSchema.safeParse(
        wrap({ ...baseSpan, traceId: "00000000000000000000000000000000" }),
      ).success,
    ).toBe(false);
    expect(
      OtlpExportTraceServiceRequestSchema.safeParse(
        wrap({ ...baseSpan, kind: "SPAN_KIND_INTERNAL" }),
      ).success,
    ).toBe(false);
    expect(
      OtlpExportTraceServiceRequestSchema.safeParse(
        wrap({
          ...baseSpan,
          attributes: [
            { key: "same", value: { boolValue: true } },
            { key: "same", value: { boolValue: false } },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      OtlpExportTraceServiceRequestSchema.safeParse(
        wrap({
          ...baseSpan,
          startTimeUnixNano: "1710000001000000000",
          endTimeUnixNano: "1710000000000000000",
        }),
      ).success,
    ).toBe(false);
  });

  it("maps resource, scope, status, time, attributes, and parent IDs deterministically", () => {
    const parsed = OtlpExportTraceServiceRequestSchema.parse(validRequest);
    const firstMapping = mapOtlpRequest(parsed, "tenant-a:project-a");
    const secondMapping = mapOtlpRequest(parsed, "tenant-a:project-a");
    expect(secondMapping).toEqual(firstMapping);
    expect(firstMapping).toHaveLength(1);

    const trace = firstMapping[0];
    expect(trace).toMatchObject({
      externalId: "otlp:4bf92f3577b34da6a3ce929d0e0e4736",
      name: "agent.run",
      status: "FAILED",
      startedAt: "2024-03-09T16:00:00.000Z",
      endedAt: "2024-03-09T16:00:01.000Z",
    });
    expect(trace?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(trace?.spans[1]).toMatchObject({
      externalId: "otlp:b7ad6b7169203331",
      kind: "GENERATION",
      status: "ERROR",
      model: "gpt-test",
      error: { type: "OTLP_STATUS_ERROR", message: "provider timed out" },
      usage: { "gen_ai.usage.input_tokens": 12 },
    });
    const child = trace?.spans[1];
    expect(child).toBeDefined();
    if (child === undefined) throw new Error("mapped child span was not returned");
    expect(child.parentId).toBe(trace?.spans[0]?.id);
    expect(
      (child.metadata.otel as { attributes: Record<string, unknown> }).attributes["large.integer"],
    ).toBe("9007199254740993");
  });

  it("namespaces stable UUIDs so different projects cannot collide", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    expect(stableOtlpUuid("trace", traceId, "project-a")).toBe(
      stableOtlpUuid("trace", traceId, "project-a"),
    );
    expect(stableOtlpUuid("trace", traceId.toUpperCase(), "project-a")).toBe(
      stableOtlpUuid("trace", traceId, "project-a"),
    );
    expect(stableOtlpUuid("trace", traceId, "project-a")).not.toBe(
      stableOtlpUuid("trace", traceId, "project-b"),
    );
    expect(() => stableOtlpUuid("span", "0000000000000000")).toThrow("invalid W3C");
  });

  it("normalizes case-insensitive OTLP IDs and accepts numeric int64 timestamps", () => {
    const span = {
      ...validRequest.resourceSpans[0].scopeSpans[0].spans[0],
      traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
      spanId: "00F067AA0BA902B7",
      startTimeUnixNano: 1_000_000,
      endTimeUnixNano: 2_000_000,
    };
    const parsed = OtlpExportTraceServiceRequestSchema.parse({
      resourceSpans: [{ scopeSpans: [{ spans: [span] }] }],
    });
    expect(parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
    });
  });

  it("converts nanoseconds without floating point timestamp drift", () => {
    expect(unixNanoToIso("1710000000123456789")).toBe("2024-03-09T16:00:00.123Z");
  });
});

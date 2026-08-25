import { createHash } from "node:crypto";
import type { Database, JsonObject, SpanKind, SpanStatus, SqlExecutor } from "@arcdb/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePermission, requireProject } from "../auth.js";
import { ApiHttpError } from "../http-error.js";
import { idempotentMutation } from "../idempotency.js";

const MAX_RESOURCE_SPANS = 100;
const MAX_SCOPE_SPANS = 100;
const MAX_SPANS_PER_SCOPE = 500;
const MAX_SPANS_PER_REQUEST = 1_000;
const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 64;
const MAX_LINKS = 32;
const MAX_COLLECTION_VALUES = 64;

const TraceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/iu, "traceId must be 32 hexadecimal characters")
  .transform((value) => value.toLowerCase())
  .refine((value) => value !== "0".repeat(32), "traceId cannot be all zeroes");

const SpanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/iu, "spanId must be 16 hexadecimal characters")
  .transform((value) => value.toLowerCase())
  .refine((value) => value !== "0".repeat(16), "spanId cannot be all zeroes");

const ParentSpanIdSchema = z
  .union([z.literal(""), SpanIdSchema])
  .transform((value) => (value === "" ? undefined : value));

const UnixNanoStringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/u, "timestamps must be unsigned decimal values");

const UnixNanoSchema = z.union([
  UnixNanoStringSchema,
  z
    .number()
    .finite()
    .nonnegative()
    .refine(Number.isInteger, "timestamps must be integers")
    .transform((value) => BigInt(value).toString()),
]);

const Base64Schema = z
  .string()
  .max(256 * 1024)
  .refine(
    (value) => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
    "bytesValue must be canonical base64",
  );

export interface OtlpKeyValue {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly boolValue: boolean }
  | { readonly intValue: string | number }
  | { readonly doubleValue: number }
  | { readonly arrayValue: { readonly values: readonly OtlpAnyValue[] } }
  | { readonly kvlistValue: { readonly values: readonly OtlpKeyValue[] } }
  | { readonly bytesValue: string };

export const OtlpAnyValueSchema: z.ZodType<OtlpAnyValue> = z.lazy(() =>
  z
    .object({
      stringValue: z
        .string()
        .max(256 * 1024)
        .optional(),
      boolValue: z.boolean().optional(),
      intValue: z
        .union([z.string().regex(/^-?(?:0|[1-9][0-9]{0,39})$/u), z.number().int().safe()])
        .optional(),
      doubleValue: z.number().finite().optional(),
      arrayValue: z
        .object({ values: z.array(OtlpAnyValueSchema).max(MAX_COLLECTION_VALUES).default([]) })
        .strip()
        .optional(),
      kvlistValue: z
        .object({ values: z.array(OtlpKeyValueSchema).max(MAX_COLLECTION_VALUES).default([]) })
        .strip()
        .optional(),
      bytesValue: Base64Schema.optional(),
    })
    .strip()
    .superRefine((value, context) => {
      const recognized = [
        value.stringValue,
        value.boolValue,
        value.intValue,
        value.doubleValue,
        value.arrayValue,
        value.kvlistValue,
        value.bytesValue,
      ].filter((entry) => entry !== undefined).length;
      if (recognized !== 1) {
        context.addIssue({
          code: "custom",
          message: "AnyValue must contain exactly one recognized value field",
        });
      }
    })
    .transform((value) => value as OtlpAnyValue),
);

export const OtlpKeyValueSchema: z.ZodType<OtlpKeyValue> = z
  .object({
    key: z.string().min(1).max(256),
    value: OtlpAnyValueSchema,
  })
  .strip();

function attributesSchema(limit: number) {
  return z
    .array(OtlpKeyValueSchema)
    .max(limit)
    .default([])
    .superRefine((attributes, context) => {
      const keys = new Set<string>();
      for (const [index, attribute] of attributes.entries()) {
        if (keys.has(attribute.key)) {
          context.addIssue({
            code: "custom",
            message: `duplicate attribute key: ${attribute.key}`,
            path: [index, "key"],
          });
        }
        keys.add(attribute.key);
      }
    });
}

const OtlpEventSchema = z
  .object({
    timeUnixNano: UnixNanoSchema,
    name: z.string().min(1).max(300),
    attributes: attributesSchema(MAX_ATTRIBUTES),
    droppedAttributesCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
  })
  .strip();

const OtlpLinkSchema = z
  .object({
    traceId: TraceIdSchema,
    spanId: SpanIdSchema,
    traceState: z.string().max(512).optional(),
    attributes: attributesSchema(MAX_ATTRIBUTES),
    droppedAttributesCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
    flags: z.number().int().min(0).max(255).optional(),
  })
  .strip();

const OtlpSpanKindSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

const OtlpStatusCodeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

const OtlpSpanSchema = z
  .object({
    traceId: TraceIdSchema,
    spanId: SpanIdSchema,
    traceState: z.string().max(512).optional(),
    parentSpanId: ParentSpanIdSchema.optional(),
    flags: z.number().int().min(0).max(255).optional(),
    name: z.string().min(1).max(300),
    kind: OtlpSpanKindSchema.default(0),
    startTimeUnixNano: UnixNanoSchema,
    endTimeUnixNano: UnixNanoSchema,
    attributes: attributesSchema(MAX_ATTRIBUTES),
    droppedAttributesCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
    events: z.array(OtlpEventSchema).max(MAX_EVENTS).default([]),
    droppedEventsCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
    links: z.array(OtlpLinkSchema).max(MAX_LINKS).default([]),
    droppedLinksCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
    status: z
      .object({
        message: z.string().max(4_096).optional(),
        code: OtlpStatusCodeSchema.default(0),
      })
      .strip()
      .default({ code: 0 }),
  })
  .strip()
  .superRefine((span, context) => {
    const start = BigInt(span.startTimeUnixNano);
    const end = BigInt(span.endTimeUnixNano);
    if (end < start) {
      context.addIssue({
        code: "custom",
        message: "endTimeUnixNano cannot precede startTimeUnixNano",
        path: ["endTimeUnixNano"],
      });
    }
    try {
      unixNanoToIso(span.startTimeUnixNano);
      unixNanoToIso(span.endTimeUnixNano);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "timestamp is outside the ISO date range",
        path: ["startTimeUnixNano"],
      });
    }
  });

const OtlpScopeSchema = z
  .object({
    name: z.string().max(256).default(""),
    version: z.string().max(128).optional(),
    attributes: attributesSchema(MAX_ATTRIBUTES),
    droppedAttributesCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
  })
  .strip();

const OtlpScopeSpansSchema = z
  .object({
    scope: OtlpScopeSchema.default({ name: "", attributes: [], droppedAttributesCount: 0 }),
    spans: z.array(OtlpSpanSchema).max(MAX_SPANS_PER_SCOPE).default([]),
    schemaUrl: z.string().url().max(2_048).optional(),
  })
  .strip();

const OtlpResourceSchema = z
  .object({
    attributes: attributesSchema(MAX_ATTRIBUTES),
    droppedAttributesCount: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .default(0),
  })
  .strip();

const OtlpResourceSpansSchema = z
  .object({
    resource: OtlpResourceSchema.default({ attributes: [], droppedAttributesCount: 0 }),
    scopeSpans: z.array(OtlpScopeSpansSchema).max(MAX_SCOPE_SPANS).default([]),
    schemaUrl: z.string().url().max(2_048).optional(),
  })
  .strip();

export const OtlpExportTraceServiceRequestSchema = z
  .object({
    resourceSpans: z.array(OtlpResourceSpansSchema).max(MAX_RESOURCE_SPANS).default([]),
  })
  .strip()
  .superRefine((request, context) => {
    let spanCount = 0;
    const spanKeys = new Set<string>();
    for (const resource of request.resourceSpans) {
      for (const scope of resource.scopeSpans) {
        for (const span of scope.spans) {
          spanCount += 1;
          const key = `${span.traceId}:${span.spanId}`;
          if (spanKeys.has(key)) {
            context.addIssue({
              code: "custom",
              message: `duplicate span identity: ${key}`,
              path: ["resourceSpans"],
            });
          }
          spanKeys.add(key);
        }
      }
    }
    if (spanCount > MAX_SPANS_PER_REQUEST) {
      context.addIssue({
        code: "too_big",
        origin: "array",
        maximum: MAX_SPANS_PER_REQUEST,
        inclusive: true,
        message: `a request may contain at most ${MAX_SPANS_PER_REQUEST} spans`,
        path: ["resourceSpans"],
      });
    }
  });

export type OtlpExportTraceServiceRequest = z.infer<typeof OtlpExportTraceServiceRequestSchema>;

export function stableOtlpUuid(
  kind: "trace" | "span",
  hexadecimalId: string,
  namespace = "arcdb",
): string {
  const normalizedId = hexadecimalId.toLowerCase();
  const expectedLength = kind === "trace" ? 32 : 16;
  if (
    normalizedId.length !== expectedLength ||
    !/^[0-9a-f]+$/u.test(normalizedId) ||
    /^0+$/u.test(normalizedId)
  ) {
    throw new TypeError(`invalid W3C ${kind} identifier`);
  }
  const bytes = createHash("sha256")
    .update(`arcdb:otlp:${kind}:${namespace}:${normalizedId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function unixNanoToIso(value: string): string {
  const milliseconds = BigInt(value) / 1_000_000n;
  if (milliseconds > 8_640_000_000_000_000n) {
    throw new RangeError("timestamp is outside the ISO date range");
  }
  return new Date(Number(milliseconds)).toISOString();
}

function anyValueToJson(value: OtlpAnyValue, depth = 0): unknown {
  if (depth > 16) throw new TypeError("OTLP attribute nesting cannot exceed 16 levels");
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if ("intValue" in value) {
    if (typeof value.intValue === "number") return value.intValue;
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : value.intValue;
  }
  if ("doubleValue" in value) return value.doubleValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) {
    return value.arrayValue.values.map((entry) => anyValueToJson(entry, depth + 1));
  }
  return attributesToJson(value.kvlistValue.values, depth + 1);
}

function attributesToJson(attributes: readonly OtlpKeyValue[], depth = 0): JsonObject {
  return Object.fromEntries(
    attributes.map((attribute) => [attribute.key, anyValueToJson(attribute.value, depth)]),
  );
}

function statusCode(
  status: OtlpExportTraceServiceRequest["resourceSpans"][number]["scopeSpans"][number]["spans"][number]["status"],
): SpanStatus {
  if (status.code === 2) return "ERROR";
  if (status.code === 1) return "OK";
  return "UNSET";
}

function spanKind(attributes: JsonObject): SpanKind {
  const keys = Object.keys(attributes);
  if (keys.some((key) => key.startsWith("gen_ai.") || key.startsWith("llm."))) {
    return "GENERATION";
  }
  if (keys.includes("tool.name") || keys.includes("gen_ai.tool.name")) return "TOOL_CALL";
  return "SPAN";
}

function modelName(attributes: JsonObject): string | undefined {
  for (const key of ["gen_ai.response.model", "gen_ai.request.model", "llm.model_name"]) {
    const value = attributes[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  }
  return undefined;
}

function usageFromAttributes(attributes: JsonObject): JsonObject {
  const usage: Record<string, unknown> = {};
  const keys = [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "llm.token_count.prompt",
    "llm.token_count.completion",
    "llm.token_count.total",
  ];
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "number" || typeof value === "string") usage[key] = value;
  }
  return usage;
}

type MappedSpan = {
  readonly id: string;
  readonly externalId: string;
  readonly traceHexId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly status: SpanStatus;
  readonly model?: string;
  readonly error?: JsonObject;
  readonly metadata: JsonObject;
  readonly usage: JsonObject;
  readonly startedAt: string;
  readonly endedAt: string;
};

export type MappedOtlpTrace = {
  readonly id: string;
  readonly externalId: string;
  readonly name: string;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly metadata: JsonObject;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly spans: readonly MappedSpan[];
};

export function mapOtlpRequest(
  request: OtlpExportTraceServiceRequest,
  namespace = "arcdb",
): readonly MappedOtlpTrace[] {
  type PendingTrace = {
    readonly traceHexId: string;
    readonly spans: MappedSpan[];
    readonly resourceSets: JsonObject[];
  };
  const traces = new Map<string, PendingTrace>();

  for (const resourceSpans of request.resourceSpans) {
    const resource = attributesToJson(resourceSpans.resource.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans) {
      const scopeAttributes = attributesToJson(scopeSpans.scope.attributes);
      const scope: JsonObject = {
        name: scopeSpans.scope.name,
        attributes: scopeAttributes,
        droppedAttributesCount: scopeSpans.scope.droppedAttributesCount,
        ...(scopeSpans.scope.version === undefined ? {} : { version: scopeSpans.scope.version }),
        ...(scopeSpans.schemaUrl === undefined ? {} : { schemaUrl: scopeSpans.schemaUrl }),
      };
      for (const span of scopeSpans.spans) {
        const attributes = attributesToJson(span.attributes);
        const mappedStatus = statusCode(span.status);
        const model = modelName(attributes);
        const spanNamespace = `${namespace}:${span.traceId}`;
        const metadata: JsonObject = {
          otel: {
            traceId: span.traceId,
            spanId: span.spanId,
            kind: span.kind,
            attributes,
            resource,
            scope,
            startTimeUnixNano: span.startTimeUnixNano,
            endTimeUnixNano: span.endTimeUnixNano,
            events: span.events.map((event) => ({
              name: event.name,
              timeUnixNano: event.timeUnixNano,
              attributes: attributesToJson(event.attributes),
              droppedAttributesCount: event.droppedAttributesCount,
            })),
            links: span.links.map((link) => ({
              traceId: link.traceId,
              spanId: link.spanId,
              attributes: attributesToJson(link.attributes),
              droppedAttributesCount: link.droppedAttributesCount,
              ...(link.traceState === undefined ? {} : { traceState: link.traceState }),
              ...(link.flags === undefined ? {} : { flags: link.flags }),
            })),
            droppedAttributesCount: span.droppedAttributesCount,
            droppedEventsCount: span.droppedEventsCount,
            droppedLinksCount: span.droppedLinksCount,
            ...(span.traceState === undefined ? {} : { traceState: span.traceState }),
            ...(span.flags === undefined ? {} : { flags: span.flags }),
            ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
          },
        };
        const error =
          mappedStatus === "ERROR"
            ? {
                type: "OTLP_STATUS_ERROR",
                ...(span.status.message === undefined ? {} : { message: span.status.message }),
              }
            : undefined;
        const mappedSpan: MappedSpan = {
          id: stableOtlpUuid("span", span.spanId, spanNamespace),
          externalId: `otlp:${span.spanId}`,
          traceHexId: span.traceId,
          ...(span.parentSpanId === undefined
            ? {}
            : { parentId: stableOtlpUuid("span", span.parentSpanId, spanNamespace) }),
          name: span.name,
          kind: spanKind(attributes),
          status: mappedStatus,
          ...(model === undefined ? {} : { model }),
          ...(error === undefined ? {} : { error }),
          metadata,
          usage: usageFromAttributes(attributes),
          startedAt: unixNanoToIso(span.startTimeUnixNano),
          endedAt: unixNanoToIso(span.endTimeUnixNano),
        };
        const pending = traces.get(span.traceId) ?? {
          traceHexId: span.traceId,
          spans: [],
          resourceSets: [],
        };
        pending.spans.push(mappedSpan);
        if (
          !pending.resourceSets.some((entry) => JSON.stringify(entry) === JSON.stringify(resource))
        ) {
          pending.resourceSets.push(resource);
        }
        traces.set(span.traceId, pending);
      }
    }
  }

  return [...traces.values()]
    .map((trace): MappedOtlpTrace => {
      trace.spans.sort(
        (left, right) =>
          Date.parse(left.startedAt) - Date.parse(right.startedAt) ||
          left.id.localeCompare(right.id),
      );
      const spanIds = new Set(trace.spans.map((span) => span.id));
      const root = trace.spans.find(
        (span) => span.parentId === undefined || !spanIds.has(span.parentId),
      );
      const first = root ?? trace.spans[0];
      if (first === undefined) throw new TypeError("an OTLP trace must contain at least one span");
      const last = trace.spans.reduce((latest, span) =>
        Date.parse(span.endedAt) > Date.parse(latest.endedAt) ? span : latest,
      );
      const failed = trace.spans.some((span) => span.status === "ERROR");
      return {
        id: stableOtlpUuid("trace", trace.traceHexId, namespace),
        externalId: `otlp:${trace.traceHexId}`,
        name: first.name,
        status: failed ? "FAILED" : "SUCCEEDED",
        metadata: {
          otel: {
            traceId: trace.traceHexId,
            resources: trace.resourceSets,
            spanCount: trace.spans.length,
          },
        },
        startedAt: trace.spans[0]?.startedAt ?? first.startedAt,
        endedAt: last.endedAt,
        spans: trace.spans,
      };
    })
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id),
    );
}

async function persistTrace(
  executor: SqlExecutor,
  tenantId: string,
  projectId: string,
  trace: MappedOtlpTrace,
): Promise<void> {
  await executor.query(
    `INSERT INTO traces (
       id, tenant_id, project_id, external_id, name, status, metadata, started_at, ended_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz, $9::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       status = CASE
         WHEN traces.status = 'FAILED' OR EXCLUDED.status = 'FAILED' THEN 'FAILED'
         WHEN traces.status = 'CANCELLED' THEN 'CANCELLED'
         ELSE 'SUCCEEDED'
       END,
       metadata = traces.metadata || EXCLUDED.metadata,
       started_at = LEAST(traces.started_at, EXCLUDED.started_at),
       ended_at = GREATEST(traces.ended_at, EXCLUDED.ended_at),
       updated_at = now()
     WHERE traces.tenant_id = EXCLUDED.tenant_id AND traces.project_id = EXCLUDED.project_id`,
    [
      trace.id,
      tenantId,
      projectId,
      trace.externalId,
      trace.name,
      trace.status,
      JSON.stringify(trace.metadata),
      trace.startedAt,
      trace.endedAt,
    ],
  );

  for (const span of trace.spans) {
    await executor.query(
      `INSERT INTO spans (
         id, tenant_id, project_id, trace_id, external_id, kind, name, status, model,
         error, metadata, usage, started_at, ended_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
         $12::jsonb, $13::timestamptz, $14::timestamptz
       )
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         status = CASE
           WHEN spans.status = 'ERROR' OR EXCLUDED.status = 'ERROR' THEN 'ERROR'
           ELSE EXCLUDED.status
         END,
         model = COALESCE(EXCLUDED.model, spans.model),
         error = COALESCE(EXCLUDED.error, spans.error),
         metadata = spans.metadata || EXCLUDED.metadata,
         usage = spans.usage || EXCLUDED.usage,
         started_at = LEAST(spans.started_at, EXCLUDED.started_at),
         ended_at = GREATEST(spans.ended_at, EXCLUDED.ended_at),
         updated_at = now()
       WHERE spans.tenant_id = EXCLUDED.tenant_id
         AND spans.project_id = EXCLUDED.project_id
         AND spans.trace_id = EXCLUDED.trace_id`,
      [
        span.id,
        tenantId,
        projectId,
        trace.id,
        span.externalId,
        span.kind,
        span.name,
        span.status,
        span.model ?? null,
        span.error === undefined ? null : JSON.stringify(span.error),
        JSON.stringify(span.metadata),
        JSON.stringify(span.usage),
        span.startedAt,
        span.endedAt,
      ],
    );
  }

  for (const span of trace.spans) {
    if (span.parentId === undefined) continue;
    await executor.query(
      `UPDATE spans AS child
          SET parent_span_id = parent.id, updated_at = now()
         FROM spans AS parent
        WHERE child.tenant_id = $1 AND child.project_id = $2 AND child.id = $3
          AND parent.tenant_id = child.tenant_id AND parent.trace_id = child.trace_id
          AND parent.id = $4`,
      [tenantId, projectId, span.id, span.parentId],
    );
  }

  // A child can arrive before its parent in a different OTLP batch. The original W3C parent ID
  // retained in metadata lets a later batch repair that relationship without rewriting history.
  await executor.query(
    `UPDATE spans AS child
        SET parent_span_id = parent.id, updated_at = now()
       FROM spans AS parent
      WHERE child.tenant_id = $1 AND child.project_id = $2 AND child.trace_id = $3
        AND child.parent_span_id IS NULL
        AND parent.tenant_id = child.tenant_id AND parent.trace_id = child.trace_id
        AND parent.external_id = 'otlp:' || (child.metadata #>> '{otel,parentSpanId}')`,
    [tenantId, projectId, trace.id],
  );
}

export function assertOtlpJsonContentType(request: FastifyRequest): void {
  const value = request.headers["content-type"];
  const encoding = request.headers["content-encoding"];
  if (
    typeof value !== "string" ||
    !/^application\/json(?:\s*;|$)/iu.test(value) ||
    (encoding !== undefined && encoding !== "identity")
  ) {
    throw new ApiHttpError(
      "INVALID_REQUEST",
      415,
      "This endpoint supports uncompressed OTLP/HTTP JSON only; protobuf is not supported",
      {
        details: {
          supportedContentType: "application/json",
          supportedContentEncoding: "identity",
        },
      },
    );
  }
}

export async function registerOtlpRoutes(app: FastifyInstance, database: Database): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.post(
    "/v1/otlp/v1/traces",
    {
      onRequest: assertOtlpJsonContentType,
      schema: {
        body: OtlpExportTraceServiceRequestSchema,
        description:
          "Ingests OTLP/HTTP JSON traces. The protobuf encoding and OTLP/gRPC are not supported.",
        tags: ["telemetry"],
      },
    },
    async (request, reply) => {
      requirePermission(request, "run:write");
      const projectId = requireProject(request);
      const tenantId = request.principal.tenantId;
      const mapped = mapOtlpRequest(request.body, `${tenantId}:${projectId}`);
      const spanCount = mapped.reduce((total, trace) => total + trace.spans.length, 0);
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        for (const trace of mapped) await persistTrace(executor, tenantId, projectId, trace);
        return {
          status: 200,
          data: { acceptedTraces: mapped.length, acceptedSpans: spanCount },
        };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      reply.header("X-Request-Id", request.id);
      reply.header("X-ArcDB-Accepted-Traces", String(result.data.acceptedTraces));
      reply.header("X-ArcDB-Accepted-Spans", String(result.data.acceptedSpans));
      return reply.status(result.status).send({});
    },
  );
}

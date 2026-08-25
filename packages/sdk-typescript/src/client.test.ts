import { describe, expect, it, vi } from "vitest";
import { ArcDB } from "./client.js";
import { ArcDBBufferedError } from "./errors.js";
import { MemoryOfflineBuffer } from "./offline.js";

const RUN = {
  id: "019a0000-0000-7000-8000-000000000001",
  name: "test",
  status: "RUNNING",
  startedAt: "2026-08-25T00:00:00.000Z",
  metadata: {},
};

const REMEDIATION = {
  id: "019a0000-0000-7000-8000-000000000020",
  tenantId: "019a0000-0000-7000-8000-000000000021",
  projectId: "019a0000-0000-7000-8000-000000000010",
  intentId: "019a0000-0000-7000-8000-000000000022",
  invalidatedOutputVersionId: "query@v1",
  status: "IN_PROGRESS",
  riskLevel: "HIGH",
  reason: "The source output was invalidated",
  approvedBy: "019a0000-0000-7000-8000-000000000023",
  approvedByActorType: "API_KEY",
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:01:00.000Z",
};

describe("ArcDB SDK", () => {
  it("propagates run context and an idempotency key", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body = calls.length === 1 ? RUN : { ...RUN, id: "output" };
      return new Response(JSON.stringify({ data: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    await client.withRun({ name: "test" }, async (run) => {
      expect(client.currentContext()?.runId).toBe(RUN.id);
      await run.createOutput({ logicalId: "sql/x", outputType: "sql", content: "SELECT 1" });
    });

    const outputHeaders = new Headers(calls[1]?.init?.headers);
    expect(outputHeaders.get("x-arcdb-run-id")).toBe(RUN.id);
    expect(outputHeaders.get("idempotency-key")).toBeTruthy();
    expect(outputHeaders.get("authorization")).toBe("Bearer arcdb_test_key_more_than_sixteen");
    expect(outputHeaders.get("x-arcdb-project-id")).toBe("019a0000-0000-7000-8000-000000000010");
  });

  it("retries a transient response with the same idempotency key", async () => {
    const keys: (string | null)[] = [];
    const fakeFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      if (keys.length === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ data: RUN }), { status: 200 });
    });
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await client.createRun({ name: "test" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses typed span and score ingestion endpoints", async () => {
    const paths: string[] = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ data: { id: "record-1" } }), { status: 201 });
    });
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    await client.createSpan("019a0000-0000-7000-8000-000000000001", {
      name: "generate SQL",
      kind: "GENERATION",
    });
    await client.createScore({
      traceId: "019a0000-0000-7000-8000-000000000001",
      name: "correctness",
      value: 1,
    });

    expect(paths).toEqual(["/v1/traces/019a0000-0000-7000-8000-000000000001/spans", "/v1/scores"]);
  });

  it("durably exposes buffered ingestion after a network failure", async () => {
    const buffer = new MemoryOfflineBuffer();
    const fakeFetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
      offlineBuffer: buffer,
    });

    await expect(
      client.ingestBatch({ batchId: "batch-1", events: [{ type: "run.create" }] }),
    ).rejects.toBeInstanceOf(ArcDBBufferedError);
    expect(await buffer.size()).toBe(1);
    const operation = (await buffer.peek())[0];
    expect(operation?.headers.Authorization).toBeUndefined();
    expect(operation?.headers["Idempotency-Key"]).toBe("batch-1");
  });

  it("performs a typed remediation compare-and-swap and validates the response", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ data: REMEDIATION }), { status: 200 });
    });
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    const result = await client.transitionRemediation(REMEDIATION.intentId, REMEDIATION.id, {
      expectedStatus: "PENDING_APPROVAL",
      nextStatus: "IN_PROGRESS",
    });

    expect(result).toEqual(REMEDIATION);
    expect(new URL(calls[0]?.url ?? "https://invalid.test").pathname).toBe(
      `/v1/effects/${REMEDIATION.intentId}/remediations/${REMEDIATION.id}/transition`,
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expectedStatus: "PENDING_APPROVAL",
      nextStatus: "IN_PROGRESS",
    });
  });

  it("rejects missing terminal resolution before issuing a remediation request", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 500 }));
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    await expect(
      client.transitionRemediation(REMEDIATION.intentId, REMEDIATION.id, {
        expectedStatus: "IN_PROGRESS",
        nextStatus: "RESOLVED",
      }),
    ).rejects.toThrow(/structured resolution/u);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed successful remediation response", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { ...REMEDIATION, status: "UNKNOWN" } }), {
          status: 200,
        }),
    );
    const client = new ArcDB({
      baseUrl: "https://arcdb.test",
      apiKey: "arcdb_test_key_more_than_sixteen",
      projectId: "019a0000-0000-7000-8000-000000000010",
      fetch: fakeFetch as typeof fetch,
      retry: { maxAttempts: 1 },
    });

    await expect(
      client.transitionRemediation(REMEDIATION.intentId, REMEDIATION.id, {
        expectedStatus: "PENDING_APPROVAL",
        nextStatus: "IN_PROGRESS",
      }),
    ).rejects.toThrow();
  });
});

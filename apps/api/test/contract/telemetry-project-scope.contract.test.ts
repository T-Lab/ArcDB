import type { ArtifactStore } from "@arcdb/artifacts";
import { generateApiKey, hashApiKey } from "@arcdb/auth";
import { type Database, DatabaseError, type SqlExecutor } from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectA = "22222222-2222-4222-8222-222222222222";
const projectB = "33333333-3333-4333-8333-333333333333";
const apiKeyId = "44444444-4444-4444-8444-444444444444";
const runA = "55555555-5555-4555-8555-555555555551";
const runB = "55555555-5555-4555-8555-555555555552";
const traceA = "66666666-6666-4666-8666-666666666661";
const otherTraceA = "66666666-6666-4666-8666-666666666662";
const traceB = "66666666-6666-4666-8666-666666666663";
const parentOtherTraceA = "77777777-7777-4777-8777-777777777771";
const parentB = "77777777-7777-4777-8777-777777777772";
const spanB = "77777777-7777-4777-8777-777777777773";

const config: ApiConfig = {
  NODE_ENV: "test",
  ARCDB_HOST: "127.0.0.1",
  ARCDB_API_PORT: 4000,
  ARCDB_DATABASE_URL: "postgresql://arcdb:arcdb@localhost:5432/arcdb",
  ARCDB_SYSTEM_DATABASE_URL: "postgresql://arcdb-system:arcdb@localhost:5432/arcdb",
  ARCDB_PUBLIC_URL: "http://localhost:3000",
  ARCDB_API_PUBLIC_URL: "http://localhost:4000",
  ARCDB_LOG_LEVEL: "silent",
  ARCDB_S3_ENDPOINT: "http://localhost:9000",
  ARCDB_S3_REGION: "us-east-1",
  ARCDB_S3_BUCKET: "arcdb-test",
  ARCDB_S3_ACCESS_KEY: "test",
  ARCDB_S3_SECRET_KEY: "test",
  ARCDB_S3_FORCE_PATH_STYLE: true,
  ARCDB_ALLOW_DEV_BOOTSTRAP: false,
  ARCDB_ALLOWED_CONNECTORS: ["manual-receipt"],
  ARCDB_RATE_LIMIT_MAX: 300,
  ARCDB_MAX_PAYLOAD_BYTES: 1024 * 1024,
};

const unusedArtifacts = {
  putStream: async () => Promise.reject(new Error("not used")),
  finalize: async () => Promise.reject(new Error("not used")),
  read: () => {
    throw new Error("not used");
  },
  diff: async () => Promise.reject(new Error("not used")),
  fork: async () => Promise.reject(new Error("not used")),
  collectGarbage: async () => Promise.reject(new Error("not used")),
} as unknown as ArtifactStore;

type Entity = "runs" | "traces" | "spans" | "scores";

type QueryCall = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

type Harness = {
  readonly database: Database;
  readonly queryCalls: QueryCall[];
  readonly insertCalls: Entity[];
};

function runRow(id: string, projectId: string) {
  return {
    id,
    tenant_id: tenantId,
    project_id: projectId,
    session_id: null,
    external_id: null,
    name: `run-${id.slice(-1)}`,
    status: "RUNNING",
    environment: null,
    agent_id: null,
    input: null,
    output: null,
    error: null,
    metadata: {},
    started_at: new Date("2026-08-26T00:00:00.000Z"),
    ended_at: null,
    created_at: new Date("2026-08-26T00:00:00.000Z"),
    updated_at: new Date("2026-08-26T00:00:00.000Z"),
  };
}

function traceRow(id: string, projectId: string, linkedRunId: string) {
  return {
    id,
    tenant_id: tenantId,
    project_id: projectId,
    run_id: linkedRunId,
    session_id: null,
    external_id: null,
    name: `trace-${id.slice(-1)}`,
    status: "RUNNING",
    input: null,
    output: null,
    metadata: {},
    started_at: new Date("2026-08-26T00:00:00.000Z"),
    ended_at: null,
    created_at: new Date("2026-08-26T00:00:00.000Z"),
    updated_at: new Date("2026-08-26T00:00:00.000Z"),
  };
}

function spanRow(id: string, projectId: string, linkedTraceId: string) {
  return {
    id,
    tenant_id: tenantId,
    project_id: projectId,
    trace_id: linkedTraceId,
    parent_span_id: null,
    external_id: null,
    kind: "SPAN",
    name: `span-${id.slice(-1)}`,
    status: "UNSET",
    model: null,
    input: null,
    output: null,
    error: null,
    metadata: {},
    usage: {},
    started_at: new Date("2026-08-26T00:00:00.000Z"),
    ended_at: null,
    created_at: new Date("2026-08-26T00:00:00.000Z"),
    updated_at: new Date("2026-08-26T00:00:00.000Z"),
  };
}

function scopedRow<T extends { readonly id: string; readonly project_id: string }>(
  sql: string,
  values: readonly unknown[],
  rows: readonly T[],
): T | undefined {
  const hasProjectPredicate = /project_id = \$2/u.test(sql);
  const id = String(values[hasProjectPredicate ? 2 : 1]);
  const requestedProject = hasProjectPredicate ? String(values[1]) : undefined;
  return rows.find(
    (row) =>
      row.id === id && (requestedProject === undefined || row.project_id === requestedProject),
  );
}

function createHarness(keyHash: string, foreignKeyFailureOn?: Entity): Harness {
  const queryCalls: QueryCall[] = [];
  const insertCalls: Entity[] = [];
  const runRows = [runRow(runA, projectA), runRow(runB, projectB)];
  const traceRows = [
    traceRow(traceA, projectA, runA),
    traceRow(otherTraceA, projectA, runA),
    traceRow(traceB, projectB, runB),
  ];
  const spanRows = [
    spanRow(parentOtherTraceA, projectA, otherTraceA),
    spanRow(parentB, projectB, traceB),
    spanRow(spanB, projectB, traceB),
  ];
  const tenantExecutor = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queryCalls.push({ sql, values: [...values] });
      if (sql.includes("SELECT * FROM runs")) {
        const row = scopedRow(sql, values, runRows);
        return { rows: row === undefined ? [] : [row] };
      }
      if (sql.includes("SELECT * FROM traces")) {
        const row = scopedRow(sql, values, traceRows);
        return { rows: row === undefined ? [] : [row] };
      }
      if (sql.includes("SELECT * FROM spans")) {
        const row = scopedRow(sql, values, spanRows);
        return { rows: row === undefined ? [] : [row] };
      }
      for (const entity of ["runs", "traces", "spans", "scores"] as const) {
        if (sql.includes(`INSERT INTO ${entity}`)) {
          insertCalls.push(entity);
          if (foreignKeyFailureOn === entity) {
            throw new DatabaseError("PostgreSQL query failed", "23503");
          }
          throw new Error(`unexpected successful ${entity} insert`);
        }
      }
      throw new Error(`unexpected tenant query: ${sql}`);
    },
  } as unknown as SqlExecutor;
  const authExecutor = {
    query: async (sql: string) => {
      if (sql.includes("FROM api_keys")) {
        return {
          rows: [
            {
              id: apiKeyId,
              tenant_id: tenantId,
              project_id: projectA,
              key_hash: keyHash,
              permissions: ["run:read", "run:write"],
              expires_at: null,
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.includes("UPDATE api_keys")) return { rows: [] };
      throw new Error(`unexpected authentication query: ${sql}`);
    },
  } as unknown as SqlExecutor;
  const database = {
    healthcheck: async () => true,
    withSystem: async (callback: (executor: SqlExecutor) => Promise<unknown>) =>
      callback(authExecutor),
    withTenant: async (
      scopedTenantId: string,
      scopedProjectId: string,
      callback: (executor: SqlExecutor) => Promise<unknown>,
    ) => {
      expect(scopedTenantId).toBe(tenantId);
      expect(scopedProjectId).toBe(projectA);
      return callback(tenantExecutor);
    },
  } as unknown as Database;
  return { database, queryCalls, insertCalls };
}

async function makeApp(database: Database): Promise<FastifyInstance> {
  return buildApp({
    config,
    database,
    artifactStore: unusedArtifacts,
    metrics: createMetrics({ service: `api-telemetry-scope-${crypto.randomUUID()}` }),
  });
}

function headers(plaintext: string): Record<string, string> {
  return {
    authorization: `Bearer ${plaintext}`,
    "content-type": "application/json",
    "x-arcdb-project-id": projectA,
  };
}

const apps: FastifyInstance[] = [];
let plaintext = "";
let keyHash = "";

beforeAll(async () => {
  const generated = generateApiKey();
  plaintext = generated.plaintext;
  keyHash = await hashApiKey(plaintext);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("telemetry project boundary", () => {
  it.each([
    { resource: "run", url: `/v1/runs/${runB}` },
    { resource: "trace", url: `/v1/traces/${traceB}` },
  ])("hides a same-tenant cross-project $resource", async ({ url }) => {
    const harness = createHarness(keyHash);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({ method: "GET", url, headers: headers(plaintext) });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND", retryable: false } });
    const subjectQuery = harness.queryCalls.find((call) => call.sql.includes("SELECT * FROM"));
    expect(subjectQuery?.sql).toMatch(/tenant_id = \$1 AND project_id = \$2 AND id = \$3/u);
    expect(subjectQuery?.values).toEqual([tenantId, projectA, expect.any(String)]);
  });

  it("rejects a trace linked to a run in another project before insertion", async () => {
    const harness = createHarness(keyHash);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: headers(plaintext),
      payload: { name: "cross-project trace", runId: runB },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Run not found", retryable: false },
    });
    expect(harness.insertCalls).toHaveLength(0);
  });

  it("rejects both a cross-project trace and parent span", async () => {
    const crossTraceHarness = createHarness(keyHash);
    const crossTraceApp = await makeApp(crossTraceHarness.database);
    apps.push(crossTraceApp);
    const crossTrace = await crossTraceApp.inject({
      method: "POST",
      url: `/v1/traces/${traceB}/spans`,
      headers: headers(plaintext),
      payload: { name: "child", kind: "SPAN" },
    });
    expect(crossTrace.statusCode).toBe(404);
    expect(crossTrace.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Trace not found" },
    });
    expect(crossTraceHarness.insertCalls).toHaveLength(0);

    const crossParentHarness = createHarness(keyHash);
    const crossParentApp = await makeApp(crossParentHarness.database);
    apps.push(crossParentApp);
    const crossParent = await crossParentApp.inject({
      method: "POST",
      url: `/v1/traces/${traceA}/spans`,
      headers: headers(plaintext),
      payload: { name: "child", kind: "SPAN", parentSpanId: parentB },
    });
    expect(crossParent.statusCode).toBe(404);
    expect(crossParent.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Parent span not found" },
    });
    expect(crossParentHarness.insertCalls).toHaveLength(0);
  });

  it("returns 422 when a parent is in the project but belongs to another trace", async () => {
    const harness = createHarness(keyHash);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/traces/${traceA}/spans`,
      headers: headers(plaintext),
      payload: { name: "child", kind: "SPAN", parentSpanId: parentOtherTraceA },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Parent span must belong to the target trace",
        retryable: false,
      },
    });
    expect(harness.insertCalls).toHaveLength(0);
  });

  it.each([
    { subject: "run", payload: { runId: runB } },
    { subject: "trace", payload: { traceId: traceB } },
    { subject: "span", payload: { spanId: spanB } },
  ])("rejects a score linked to a cross-project $subject", async ({ subject, payload }) => {
    const harness = createHarness(keyHash);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/scores",
      headers: headers(plaintext),
      payload: { ...payload, name: "quality", value: 0.9 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: `${subject[0]?.toUpperCase()}${subject.slice(1)} not found`,
      },
    });
    expect(harness.insertCalls).toHaveLength(0);
  });

  it.each([
    {
      entity: "traces" as const,
      url: "/v1/traces",
      payload: { name: "trace", runId: runA },
      message: "Trace references a run or session that is not available in this project",
    },
    {
      entity: "spans" as const,
      url: `/v1/traces/${traceA}/spans`,
      payload: { name: "span", kind: "SPAN" },
      message: "Span references a trace or parent span that is not available in this project",
    },
    {
      entity: "scores" as const,
      url: "/v1/scores",
      payload: { traceId: traceA, name: "quality", value: 0.9 },
      message: "Score subject is not available in this project",
    },
  ])("maps a composite FK failure for $entity to a stable 422", async (testCase) => {
    const harness = createHarness(keyHash, testCase.entity);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: testCase.url,
      headers: headers(plaintext),
      payload: testCase.payload,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: testCase.message,
        retryable: false,
      },
    });
    expect(harness.insertCalls).toEqual([testCase.entity]);
  });
});

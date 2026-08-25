import type { ArtifactStore } from "@arcdb/artifacts";
import { generateApiKey, hashApiKey } from "@arcdb/auth";
import type { Database, SqlExecutor } from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const apiKeyId = "33333333-3333-4333-8333-333333333333";
const intentId = "44444444-4444-4444-8444-444444444444";
const remediationId = "55555555-5555-4555-8555-555555555555";

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

type ExecutorOptions = {
  readonly permissions?: readonly string[];
  readonly found?: boolean;
  readonly currentStatus?: "OPEN" | "PENDING_APPROVAL" | "IN_PROGRESS" | "RESOLVED" | "WAIVED";
  readonly loseCas?: boolean;
};

type ExecutorTrace = {
  readonly selectValues: readonly unknown[][];
  readonly updateValues: readonly unknown[][];
  readonly lifecycleInserts: readonly unknown[][];
  readonly auditInserts: readonly unknown[][];
};

function executorFor(
  keyHash: string,
  options: ExecutorOptions = {},
): { readonly executor: SqlExecutor; readonly trace: ExecutorTrace } {
  const selectValues: unknown[][] = [];
  const updateValues: unknown[][] = [];
  const lifecycleInserts: unknown[][] = [];
  const auditInserts: unknown[][] = [];
  const baseRow = {
    id: remediationId,
    tenant_id: tenantId,
    project_id: projectId,
    intent_id: intentId,
    invalidated_output_version_id: "query@v1",
    status: options.currentStatus ?? "PENDING_APPROVAL",
    risk_level: "HIGH",
    reason: "The source output was invalidated",
    resolution: null,
    approved_by: null,
    approved_by_actor_type: null,
    resolved_at: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
  const executor = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("FROM api_keys")) {
        return {
          rows: [
            {
              id: apiKeyId,
              tenant_id: tenantId,
              project_id: projectId,
              key_hash: keyHash,
              permissions: [...(options.permissions ?? ["effect:remediate"])],
              expires_at: null,
              revoked_at: null,
            },
          ],
        };
      }
      if (sql.includes("UPDATE api_keys")) return { rows: [] };
      if (sql.includes("SELECT * FROM remediation_obligations")) {
        selectValues.push([...values]);
        return { rows: options.found === false ? [] : [baseRow] };
      }
      if (sql.includes("UPDATE remediation_obligations")) {
        updateValues.push([...values]);
        if (options.loseCas === true) return { rows: [] };
        const resolution = values[5] === null ? null : JSON.parse(String(values[5]));
        return {
          rows: [
            {
              ...baseRow,
              status: values[3],
              resolution,
              approved_by: values[6],
              approved_by_actor_type: values[7],
              resolved_at:
                values[3] === "RESOLVED" || values[3] === "WAIVED"
                  ? "2026-08-25T00:01:00.000Z"
                  : null,
              updated_at: "2026-08-25T00:01:00.000Z",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO lifecycle_events")) {
        lifecycleInserts.push([...values]);
        return { rows: [] };
      }
      if (sql.includes("SELECT event_hash FROM audit_events")) return { rows: [] };
      if (sql.includes("INSERT INTO audit_events")) {
        auditInserts.push([...values]);
        return { rows: [] };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as SqlExecutor;
  return {
    executor,
    trace: { selectValues, updateValues, lifecycleInserts, auditInserts },
  };
}

function databaseFor(executor: SqlExecutor): Database {
  return {
    healthcheck: async () => true,
    withSystem: async (callback: (systemExecutor: SqlExecutor) => Promise<unknown>) =>
      callback(executor),
    withTenant: async (
      _tenantId: string,
      _projectId: string,
      callback: (tenantExecutor: SqlExecutor) => Promise<unknown>,
    ) => callback(executor),
  } as unknown as Database;
}

async function makeApp(executor: SqlExecutor): Promise<FastifyInstance> {
  return buildApp({
    config,
    database: databaseFor(executor),
    artifactStore: unusedArtifacts,
    metrics: createMetrics({ service: `api-remediation-${crypto.randomUUID()}` }),
  });
}

function requestHeaders(plaintext: string): Record<string, string> {
  return {
    authorization: `Bearer ${plaintext}`,
    "content-type": "application/json",
    "x-arcdb-project-id": projectId,
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

describe("remediation transition contract", () => {
  it("waives a pending obligation with CAS, approver identity, lifecycle, and audit records", async () => {
    const { executor, trace } = executorFor(keyHash);
    const app = await makeApp(executor);
    apps.push(app);
    const resolution = {
      summary: "An owner accepted the documented residual risk.",
      references: [{ kind: "TICKET", reference: "RISK-42" }],
      metadata: { owner: "platform" },
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: {
        expectedStatus: "PENDING_APPROVAL",
        nextStatus: "WAIVED",
        resolution,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        id: remediationId,
        intentId,
        status: "WAIVED",
        resolution,
        approvedBy: apiKeyId,
        approvedByActorType: "API_KEY",
        resolvedAt: "2026-08-25T00:01:00.000Z",
      },
      requestId: expect.any(String),
    });
    expect(trace.selectValues).toEqual([[tenantId, projectId, intentId, remediationId]]);
    expect(trace.updateValues).toEqual([
      [
        tenantId,
        remediationId,
        "PENDING_APPROVAL",
        "WAIVED",
        true,
        JSON.stringify(resolution),
        apiKeyId,
        "API_KEY",
      ],
    ]);
    expect(trace.lifecycleInserts).toHaveLength(1);
    expect(trace.auditInserts).toHaveLength(1);
  });

  it("requires effect:remediate before tenant-scoped access", async () => {
    const { executor, trace } = executorFor(keyHash, { permissions: ["effect:read"] });
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: { expectedStatus: "PENDING_APPROVAL", nextStatus: "IN_PROGRESS" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(trace.selectValues).toHaveLength(0);
  });

  it("returns a stable 404 when tenant, project, effect, and obligation do not match", async () => {
    const { executor, trace } = executorFor(keyHash, { found: false });
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: { expectedStatus: "PENDING_APPROVAL", nextStatus: "IN_PROGRESS" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "Remediation obligation not found", retryable: false },
    });
    expect(trace.selectValues).toEqual([[tenantId, projectId, intentId, remediationId]]);
    expect(trace.updateValues).toHaveLength(0);
  });

  it("returns a stable retryable 409 for a stale expected status", async () => {
    const { executor, trace } = executorFor(keyHash, { currentStatus: "OPEN" });
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: { expectedStatus: "PENDING_APPROVAL", nextStatus: "IN_PROGRESS" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_TRANSITION",
        retryable: true,
        details: { expectedStatus: "PENDING_APPROVAL", currentStatus: "OPEN" },
      },
    });
    expect(trace.updateValues).toHaveLength(0);
  });

  it("returns 409 for a transition outside the explicit state matrix", async () => {
    const { executor, trace } = executorFor(keyHash);
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: {
        expectedStatus: "PENDING_APPROVAL",
        nextStatus: "RESOLVED",
        resolution: { summary: "Attempted to skip execution" },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_TRANSITION",
        retryable: false,
        details: { currentStatus: "PENDING_APPROVAL", nextStatus: "RESOLVED" },
      },
    });
    expect(trace.updateValues).toHaveLength(0);
  });

  it("rejects terminal transitions without a structured resolution", async () => {
    const { executor, trace } = executorFor(keyHash, { currentStatus: "IN_PROGRESS" });
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: { expectedStatus: "IN_PROGRESS", nextStatus: "RESOLVED" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(trace.selectValues).toHaveLength(0);
    expect(trace.updateValues).toHaveLength(0);
  });

  it("returns a retryable 409 when the database CAS loses a race", async () => {
    const { executor, trace } = executorFor(keyHash, { loseCas: true });
    const app = await makeApp(executor);
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/v1/effects/${intentId}/remediations/${remediationId}/transition`,
      headers: requestHeaders(plaintext),
      payload: { expectedStatus: "PENDING_APPROVAL", nextStatus: "IN_PROGRESS" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_TRANSITION",
        message: "Remediation obligation status changed during transition",
        retryable: true,
      },
    });
    expect(trace.updateValues).toHaveLength(1);
    expect(trace.lifecycleInserts).toHaveLength(0);
    expect(trace.auditInserts).toHaveLength(0);
  });
});

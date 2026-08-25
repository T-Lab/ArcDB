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

type QueryCall = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

type DashboardHarness = {
  readonly database: Database;
  readonly queryCalls: QueryCall[];
  readonly tenantCalls: Array<{
    readonly tenantId: string;
    readonly projectId: string;
    readonly readOnly: boolean;
  }>;
};

function rowId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function dashboardHarness(keyHash: string, permissions = ["project:read"]): DashboardHarness {
  const queryCalls: QueryCall[] = [];
  const tenantCalls: DashboardHarness["tenantCalls"] = [];
  const executor = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      queryCalls.push({ sql, values: [...values] });
      if (sql.includes("AS runs_24h")) {
        return {
          rows: [
            {
              runs_24h: "12",
              traces_24h: "9",
              outputs_total: "7",
              verified_outputs: "4",
              stale_outputs: "2",
              open_effects: "3",
              reconciliation_required: "1",
              open_remediations: "5",
            },
          ],
        };
      }
      if (sql.includes("FROM traces trace")) {
        return {
          rows: Array.from({ length: 9 }, (_, index) => ({
            id: rowId(index + 1),
            name: `trace-${index + 1}`,
            status: index === 0 ? "SUCCEEDED" : "RUNNING",
            started_at: new Date(`2026-08-${String(26 - index).padStart(2, "0")}T01:00:00.000Z`),
            ended_at: index === 0 ? new Date("2026-08-26T01:00:01.250Z") : null,
            duration_ms: index === 0 ? "1250" : null,
            span_count: String(index + 1),
            output_count: index === 0 ? "2" : "0",
            agent_id: index === 0 ? "sql-agent" : null,
            session_id: null,
            metadata: { rank: index + 1 },
          })),
        };
      }
      if (sql.includes("SELECT id, logical_id, version_id")) {
        return {
          rows: Array.from({ length: 9 }, (_, index) => ({
            id: rowId(index + 101),
            logical_id: `report-${index + 1}`,
            version_id: `report-${index + 1}@v1`,
            output_type: "markdown",
            lifecycle_state: index === 0 ? "PROMOTED" : "STAGED",
            content_ref: `s3://arcdb/report-${index + 1}`,
            content_digest: `sha256:${"a".repeat(64)}`,
            producer_run_id: null,
            producer_agent_id: "sql-agent",
            policy_version: index === 0 ? "production-v1" : null,
            parent_version_ids: [],
            metadata: { rank: index + 1 },
            created_at: new Date(`2026-08-${String(26 - index).padStart(2, "0")}T02:00:00.000Z`),
            updated_at: new Date(`2026-08-${String(26 - index).padStart(2, "0")}T02:00:01.000Z`),
          })),
        };
      }
      if (sql.includes("WITH buckets AS")) {
        return {
          rows: [
            { label: "2026-08-20", value: "0" },
            { label: "2026-08-21", value: "1" },
            { label: "2026-08-22", value: "0" },
            { label: "2026-08-23", value: "3" },
            { label: "2026-08-24", value: "2" },
            { label: "2026-08-25", value: "0" },
            { label: "2026-08-26", value: "3" },
          ],
        };
      }
      throw new Error(`unexpected dashboard query: ${sql}`);
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
              project_id: projectId,
              key_hash: keyHash,
              permissions,
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
    withSystem: async (callback: (systemExecutor: SqlExecutor) => Promise<unknown>) =>
      callback(authExecutor),
    withTenant: async (
      scopedTenantId: string,
      scopedProjectId: string,
      callback: (tenantExecutor: SqlExecutor) => Promise<unknown>,
      options: { readonly readOnly?: boolean } = {},
    ) => {
      tenantCalls.push({
        tenantId: scopedTenantId,
        projectId: scopedProjectId,
        readOnly: options.readOnly === true,
      });
      return callback(executor);
    },
  } as unknown as Database;
  return { database, queryCalls, tenantCalls };
}

async function makeApp(database: Database): Promise<FastifyInstance> {
  return buildApp({
    config,
    database,
    artifactStore: unusedArtifacts,
    metrics: createMetrics({ service: `api-dashboard-${crypto.randomUUID()}` }),
  });
}

function requestHeaders(plaintext: string): Record<string, string> {
  return {
    authorization: `Bearer ${plaintext}`,
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

describe("dashboard contract", () => {
  it("returns scoped metrics, bounded recent records, and seven UTC activity buckets", async () => {
    const harness = dashboardHarness(keyHash);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/dashboard",
      headers: requestHeaders(plaintext),
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json<{
      data: {
        recentTraces: Array<Record<string, unknown>>;
        recentOutputs: Array<Record<string, unknown>>;
        activity: Array<{ label: string; value: number }>;
      };
    }>();
    expect(responseBody).toMatchObject({
      data: {
        runs24h: 12,
        traces24h: 9,
        outputsTotal: 7,
        verifiedOutputs: 4,
        staleOutputs: 2,
        openEffects: 3,
        reconciliationRequired: 1,
        openRemediations: 5,
        activity: [
          { label: "2026-08-20", value: 0 },
          { label: "2026-08-21", value: 1 },
          { label: "2026-08-22", value: 0 },
          { label: "2026-08-23", value: 3 },
          { label: "2026-08-24", value: 2 },
          { label: "2026-08-25", value: 0 },
          { label: "2026-08-26", value: 3 },
        ],
      },
      requestId: expect.any(String),
    });
    expect(responseBody.data.recentTraces).toHaveLength(8);
    expect(responseBody.data.recentTraces[0]).toMatchObject({
      id: rowId(1),
      name: "trace-1",
      status: "SUCCEEDED",
      startedAt: "2026-08-26T01:00:00.000Z",
      endedAt: "2026-08-26T01:00:01.250Z",
      durationMs: 1250,
      spanCount: 1,
      outputCount: 2,
      agentId: "sql-agent",
    });
    expect(responseBody.data.recentOutputs).toHaveLength(8);
    expect(responseBody.data.recentOutputs[0]).toMatchObject({
      id: rowId(101),
      logicalId: "report-1",
      versionId: "report-1@v1",
      lifecycleState: "PROMOTED",
      createdAt: "2026-08-26T02:00:00.000Z",
    });
    expect(responseBody.data.activity).toHaveLength(7);

    expect(harness.tenantCalls).toEqual([{ tenantId, projectId, readOnly: true }]);
    expect(harness.queryCalls).toHaveLength(4);
    for (const call of harness.queryCalls) {
      expect(call.values).toEqual([tenantId, projectId]);
    }

    const aggregateSql = harness.queryCalls.find((call) => call.sql.includes("AS runs_24h"))?.sql;
    expect(aggregateSql).toContain("AS verified_outputs");
    expect(aggregateSql).toContain("'VERIFIED', 'APPROVED', 'COMMITTED', 'CONSUMED', 'PROMOTED'");

    const tracesSql = harness.queryCalls.find((call) =>
      call.sql.includes("FROM traces trace"),
    )?.sql;
    expect(tracesSql).toMatch(/WHERE trace\.tenant_id = \$1 AND trace\.project_id = \$2/u);
    expect(tracesSql).toMatch(/ORDER BY trace\.started_at DESC, trace\.id DESC\s+LIMIT 8/u);

    const outputsSql = harness.queryCalls.find((call) =>
      call.sql.includes("SELECT id, logical_id, version_id"),
    )?.sql;
    expect(outputsSql).toMatch(/WHERE tenant_id = \$1 AND project_id = \$2/u);
    expect(outputsSql).toMatch(/ORDER BY created_at DESC, id DESC\s+LIMIT 8/u);

    const activitySql = harness.queryCalls.find((call) =>
      call.sql.includes("WITH buckets AS"),
    )?.sql;
    expect(activitySql).toContain("interval '6 days'");
    expect(activitySql).toContain("trace.tenant_id = $1");
    expect(activitySql).toContain("trace.project_id = $2");
    expect(activitySql).toContain("ORDER BY bucket.bucket_start ASC");
  });

  it("requires project:read before entering the tenant-scoped transaction", async () => {
    const harness = dashboardHarness(keyHash, ["run:read"]);
    const app = await makeApp(harness.database);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/dashboard",
      headers: requestHeaders(plaintext),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN", retryable: false } });
    expect(harness.tenantCalls).toHaveLength(0);
    expect(harness.queryCalls).toHaveLength(0);
  });
});

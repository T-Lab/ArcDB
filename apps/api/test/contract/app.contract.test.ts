import type { ArtifactStore } from "@arcdb/artifacts";
import { generateApiKey, hashApiKey } from "@arcdb/auth";
import type { Database, SqlExecutor } from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { ApiConfig } from "../../src/config.js";
import { MANUAL_RECEIPT_CONNECTOR_CAPABILITIES } from "../../src/effect-connectors.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

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

function databaseStub(
  systemExecutor?: SqlExecutor,
  tenantCallback?: Database["withTenant"],
): Database {
  return {
    healthcheck: async () => true,
    withSystem: async (callback: (executor: SqlExecutor) => Promise<unknown>) => {
      if (systemExecutor === undefined) throw new Error("unexpected system database access");
      return callback(systemExecutor);
    },
    withTenant:
      tenantCallback ??
      (async () => {
        throw new Error("unexpected tenant database access");
      }),
  } as unknown as Database;
}

async function makeApp(database: Database): Promise<FastifyInstance> {
  return buildApp({
    config,
    database,
    artifactStore: unusedArtifacts,
    metrics: createMetrics({ service: `api-contract-${crypto.randomUUID()}` }),
  });
}

function authenticatedExecutor(input: {
  readonly keyHash: string;
  readonly permissions: readonly string[];
  readonly projectId?: string;
}): SqlExecutor {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM api_keys")) {
        return {
          rows: [
            {
              id: "33333333-3333-4333-8333-333333333333",
              tenant_id: tenantId,
              project_id: input.projectId ?? null,
              key_hash: input.keyHash,
              permissions: [...input.permissions],
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
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("public and error response contracts", () => {
  it("serves liveness without credentials", async () => {
    const app = await makeApp(databaseStub());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("uses the unified envelope for unauthenticated requests", async () => {
    const app = await makeApp(databaseStub());
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/traces" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "A Bearer API key is required",
        retryable: false,
      },
      requestId: expect.any(String),
    });
  });
});

describe("OTLP transport contract", () => {
  let plaintext = "";
  let keyHash = "";

  beforeAll(async () => {
    const generated = generateApiKey();
    plaintext = generated.plaintext;
    keyHash = await hashApiKey(plaintext);
  });

  it("returns 415 for protobuf and names JSON as the only supported encoding", async () => {
    const executor = authenticatedExecutor({ keyHash, permissions: ["run:write"], projectId });
    const app = await makeApp(databaseStub(executor));
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/otlp/v1/traces",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/x-protobuf",
        "x-arcdb-project-id": projectId,
      },
      payload: Buffer.from([0]),
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        retryable: false,
        details: {
          supportedContentType: "application/json",
          supportedContentEncoding: "identity",
        },
      },
      requestId: expect.any(String),
    });
  });

  it("advances valid JSON requests beyond the content-type hook", async () => {
    const authExecutor = authenticatedExecutor({
      keyHash,
      permissions: ["run:write"],
      projectId,
    });
    const tenantExecutor = {
      query: async () => ({ rows: [] }),
    } as unknown as SqlExecutor;
    const withTenant = (async (
      scopedTenantId: string,
      scopedProjectId: string,
      callback: (executor: SqlExecutor) => Promise<unknown>,
    ) => {
      expect(scopedTenantId).toBe(tenantId);
      expect(scopedProjectId).toBe(projectId);
      return callback(tenantExecutor);
    }) as unknown as Database["withTenant"];
    const app = await makeApp(databaseStub(authExecutor, withTenant));
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/otlp/v1/traces",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/json",
        "x-arcdb-project-id": projectId,
      },
      payload: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "contract-valid-json",
                    startTimeUnixNano: "1710000000000000000",
                    endTimeUnixNano: "1710000001000000000",
                    status: { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-arcdb-accepted-traces"]).toBe("1");
    expect(response.headers["x-arcdb-accepted-spans"]).toBe("1");
    expect(response.json()).toEqual({});
  });
});

describe("authenticated request security boundary", () => {
  let plaintext = "";
  let keyHash = "";

  beforeAll(async () => {
    const generated = generateApiKey();
    plaintext = generated.plaintext;
    keyHash = await hashApiKey(plaintext);
  });

  it("rejects a malformed project header before tenant database access", async () => {
    const executor = authenticatedExecutor({ keyHash, permissions: ["run:read"] });
    const app = await makeApp(databaseStub(executor));
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/v1/traces",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "x-arcdb-project-id": "not-a-uuid",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        message: "X-ArcDB-Project-Id must be a valid UUID",
        retryable: false,
      },
      requestId: expect.any(String),
    });
  });

  it.each([
    {
      name: "unknown connector",
      connectorType: "postgres",
      connectorCapabilities: MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
      expectedCode: "POLICY_DENIED",
      expectedReason: "NOT_REGISTERED",
    },
    {
      name: "caller capability escalation",
      connectorType: "manual-receipt",
      connectorCapabilities: {
        ...MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
        supportsFencingToken: true,
      },
      expectedCode: "INVALID_REQUEST",
      expectedReason: "CAPABILITIES_MISMATCH",
    },
  ])("rejects $name before artifact or tenant database access", async (testCase) => {
    const executor = authenticatedExecutor({
      keyHash,
      permissions: ["effect:prepare"],
      projectId,
    });
    const app = await makeApp(databaseStub(executor));
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/effects",
      headers: {
        authorization: `Bearer ${plaintext}`,
        "content-type": "application/json",
        "idempotency-key": "effect-request-0001",
        "x-arcdb-project-id": projectId,
      },
      payload: {
        sourceOutputVersionId: "output-v1",
        connectorType: testCase.connectorType,
        connectorCapabilities: testCase.connectorCapabilities,
        target: "production/database",
        resourceKey: "database/table/users",
        arguments: { sql: "UPDATE users SET active = true" },
        idempotencyKey: "effect-request-0001",
        reversibility: "R3",
        riskLevel: "HIGH",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: testCase.expectedCode,
        retryable: false,
        details: {
          connectorType: testCase.connectorType,
          reason: testCase.expectedReason,
        },
      },
      requestId: expect.any(String),
    });
  });
});

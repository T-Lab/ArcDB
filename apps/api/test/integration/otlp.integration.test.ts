import type { ArtifactStore } from "@arcdb/artifacts";
import { generateApiKey, hashApiKey } from "@arcdb/auth";
import {
  createDatabase,
  createRepositories,
  type Database,
  migrateDatabase,
  type SqlExecutor,
} from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const applicationDatabaseUrl = process.env.ARCDB_DATABASE_URL;
const systemDatabaseUrl = process.env.ARCDB_SYSTEM_DATABASE_URL;
const administratorDatabaseUrl =
  process.env.ARCDB_ADMIN_DATABASE_URL ?? process.env.ARCDB_RLS_TEST_ADMIN_DATABASE_URL;
const withDatabase =
  applicationDatabaseUrl === undefined ||
  systemDatabaseUrl === undefined ||
  administratorDatabaseUrl === undefined
    ? describe.skip
    : describe;

// This correctness test performs two independent scrypt-authenticated HTTP requests. Keep a
// bounded wall-clock budget for slower hosted runners, while ensuring a blocked database statement
// fails first and is distinguishable from CPU starvation through the per-stage timing records.
const OTLP_REPLAY_TEST_TIMEOUT_MS = 15_000;
const DATABASE_STATEMENT_TIMEOUT_MS = 3_000;

async function timedStage<Result>(
  stage: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const startedAt = performance.now();
  process.stdout.write(`${JSON.stringify({ event: "otlp_integration_stage", stage })}\n`);
  try {
    const result = await operation();
    process.stdout.write(
      `${JSON.stringify({
        event: "otlp_integration_stage_complete",
        stage,
        durationMs: Math.round(performance.now() - startedAt),
      })}\n`,
    );
    return result;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        event: "otlp_integration_stage_failed",
        stage,
        durationMs: Math.round(performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
    throw error;
  }
}

const artifactStore = {
  putStream: async () => Promise.reject(new Error("not used")),
  finalize: async () => Promise.reject(new Error("not used")),
  read: () => {
    throw new Error("not used");
  },
  diff: async () => Promise.reject(new Error("not used")),
  fork: async () => Promise.reject(new Error("not used")),
  collectGarbage: async () => Promise.reject(new Error("not used")),
} as unknown as ArtifactStore;

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const rootSpanId = "00f067aa0ba902b7";
const childSpanId = "b7ad6b7169203331";
const payload = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "arcdb-integration" } }],
      },
      scopeSpans: [
        {
          scope: { name: "arcdb.integration" },
          spans: [
            {
              traceId,
              spanId: rootSpanId,
              name: "root",
              startTimeUnixNano: "1710000000000000000",
              endTimeUnixNano: "1710000001000000000",
              status: { code: 1 },
            },
            {
              traceId,
              spanId: childSpanId,
              parentSpanId: rootSpanId,
              name: "child",
              startTimeUnixNano: "1710000000100000000",
              endTimeUnixNano: "1710000000900000000",
              status: { code: 2, message: "integration failure" },
            },
          ],
        },
      ],
    },
  ],
};

withDatabase("OTLP PostgreSQL integration", () => {
  let database: Database;
  let administratorDatabase: Database;
  let app: FastifyInstance;
  let tenantId: string;
  let projectId: string;
  let apiKey: string;

  beforeAll(async () => {
    if (
      applicationDatabaseUrl === undefined ||
      systemDatabaseUrl === undefined ||
      administratorDatabaseUrl === undefined
    ) {
      throw new Error(
        "ARCDB_DATABASE_URL, ARCDB_SYSTEM_DATABASE_URL, and ARCDB_ADMIN_DATABASE_URL are required",
      );
    }
    administratorDatabase = createDatabase({
      connectionString: administratorDatabaseUrl,
      systemConnectionString: administratorDatabaseUrl,
      applicationName: "arcdb-api-test-migrate",
      max: 1,
    });
    await migrateDatabase(administratorDatabase);
    database = createDatabase({
      connectionString: applicationDatabaseUrl,
      systemConnectionString: systemDatabaseUrl,
      applicationName: "arcdb-api-test",
      statementTimeoutMillis: DATABASE_STATEMENT_TIMEOUT_MS,
    });
    const generated = generateApiKey();
    apiKey = generated.plaintext;
    const keyHash = await hashApiKey(apiKey);
    await administratorDatabase.withSystem(async (executor) => {
      const repositories = createRepositories(executor);
      const suffix = crypto.randomUUID();
      const organization = await repositories.organizations.create({
        name: "OTLP integration test",
        slug: `otlp-test-${suffix}`,
      });
      tenantId = organization.id;
      const project = await repositories.projects.create({
        tenantId,
        name: "OTLP integration test",
        slug: `otlp-test-${suffix}`,
      });
      projectId = project.id;
      await repositories.apiKeys.create({
        tenantId,
        projectId,
        name: "integration test",
        prefix: generated.prefix,
        keyHash,
        lastFour: generated.lastFour,
        permissions: ["run:write", "run:read"],
      });
    });
    app = await buildApp({
      config: {
        NODE_ENV: "test",
        ARCDB_HOST: "127.0.0.1",
        ARCDB_API_PORT: 4000,
        ARCDB_DATABASE_URL: applicationDatabaseUrl,
        ARCDB_SYSTEM_DATABASE_URL: systemDatabaseUrl,
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
      },
      database,
      artifactStore,
      metrics: createMetrics({ service: `api-integration-${crypto.randomUUID()}` }),
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (administratorDatabase !== undefined && tenantId !== undefined) {
        await administratorDatabase
          .withSystem((executor: SqlExecutor) =>
            executor.query("DELETE FROM organizations WHERE id = $1", [tenantId]),
          )
          .catch(() => undefined);
      }
    } finally {
      await Promise.all([database?.close(), administratorDatabase?.close()]);
    }
  });

  it(
    "persists parent-linked spans and replays the same HTTP idempotency key",
    async () => {
      const headers = {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `otlp-test-${crypto.randomUUID()}`,
        "x-arcdb-project-id": projectId,
      };
      const first = await timedStage("first_http_request", () =>
        app.inject({
          method: "POST",
          url: "/v1/otlp/v1/traces",
          headers,
          payload,
        }),
      );
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({});
      expect(first.headers["x-arcdb-accepted-traces"]).toBe("1");
      expect(first.headers["x-arcdb-accepted-spans"]).toBe("2");

      const replay = await timedStage("idempotent_replay_request", () =>
        app.inject({
          method: "POST",
          url: "/v1/otlp/v1/traces",
          headers,
          payload,
        }),
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.headers["idempotency-replayed"]).toBe("true");

      const persisted = await timedStage("persistence_query", () =>
        database.withTenant(
          tenantId,
          projectId,
          async (executor) => {
            const traces = await executor.query<{ id: string; status: string }>(
              "SELECT id, status FROM traces WHERE tenant_id = $1 AND project_id = $2",
              [tenantId, projectId],
            );
            const spans = await executor.query<{
              external_id: string;
              parent_span_id: string | null;
              status: string;
            }>(
              "SELECT external_id, parent_span_id, status FROM spans WHERE tenant_id = $1 AND project_id = $2 ORDER BY started_at",
              [tenantId, projectId],
            );
            return { traces: traces.rows, spans: spans.rows };
          },
          { readOnly: true },
        ),
      );
      expect(persisted.traces).toHaveLength(1);
      expect(persisted.traces[0]?.status).toBe("FAILED");
      expect(persisted.spans).toHaveLength(2);
      expect(persisted.spans[0]).toMatchObject({
        external_id: `otlp:${rootSpanId}`,
        parent_span_id: null,
        status: "OK",
      });
      expect(persisted.spans[1]?.external_id).toBe(`otlp:${childSpanId}`);
      expect(persisted.spans[1]?.parent_span_id).toBeTypeOf("string");
      expect(persisted.spans[1]?.status).toBe("ERROR");
    },
    OTLP_REPLAY_TEST_TIMEOUT_MS,
  );
});

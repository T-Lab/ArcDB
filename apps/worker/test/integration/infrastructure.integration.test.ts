import { randomUUID } from "node:crypto";
import {
  createDatabase,
  createRepositories,
  type Database,
  type EffectIntentRecord,
  type JobRecord,
} from "@arcdb/db";
import { createMetrics } from "@arcdb/observability";
import { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../../src/config.js";
import { ManualReceiptConnector } from "../../src/connectors/manual-receipt.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import { PostgresEffectStore } from "../../src/effect-store.js";
import { EffectRuntime, registerEffectJobHandlers } from "../../src/effects.js";
import { PostgresDurableJobStore } from "../../src/job-store.js";
import { BullMqNotifier, redisConnection } from "../../src/notification.js";
import { JobHandlerRegistry } from "../../src/registry.js";
import { WorkerServiceRuntime } from "../../src/runtime.js";
import { silentLogger } from "../support/logger.js";

const databaseUrl = process.env.ARCDB_DATABASE_URL ?? "";
const systemDatabaseUrl = process.env.ARCDB_SYSTEM_DATABASE_URL ?? "";
const administratorDatabaseUrl =
  process.env.ARCDB_ADMIN_DATABASE_URL ?? process.env.ARCDB_RLS_TEST_ADMIN_DATABASE_URL ?? "";
const redisUrl = process.env.ARCDB_REDIS_URL ?? "";
const hasInfrastructure =
  databaseUrl.trim() !== "" &&
  systemDatabaseUrl.trim() !== "" &&
  administratorDatabaseUrl.trim() !== "" &&
  redisUrl.trim() !== "";
const runId = randomUUID();
const tenantId = randomUUID();
const projectId = randomUUID();
const siblingProjectId = randomUUID();
const outputVersionId = `worker-integration-output-${runId}`;
const queueName = `arcdb-worker-it-${runId}`;
const workerId = `worker-integration-${runId}`;

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function eventually<T>(
  load: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await load();
    if (accept(lastValue)) return lastValue;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not converge; last value: ${JSON.stringify(lastValue)}`);
}

class ObservedManualReceiptConnector extends ManualReceiptConnector {
  public executeCalls = 0;

  public override async execute(): ReturnType<ManualReceiptConnector["execute"]> {
    this.executeCalls += 1;
    return super.execute();
  }
}

describe.skipIf(!hasInfrastructure)(
  "PostgreSQL durable jobs with BullMQ wakeups [requires application/system PostgreSQL + Redis URLs]",
  () => {
    const verifierStarted = deferred();
    const releaseVerifier = deferred();
    const manualConnector = new ObservedManualReceiptConnector();
    let verifierCalls = 0;
    let database: Database | undefined;
    let administratorDatabase: Database | undefined;
    let jobStore: PostgresDurableJobStore | undefined;
    let runtime: WorkerServiceRuntime | undefined;
    let notifier: BullMqNotifier | undefined;

    const requireDatabase = (): Database => {
      if (database === undefined) throw new Error("integration database is not initialized");
      return database;
    };

    const requireJobStore = (): PostgresDurableJobStore => {
      if (jobStore === undefined) throw new Error("integration job store is not initialized");
      return jobStore;
    };

    const requireNotifier = (): BullMqNotifier => {
      if (notifier === undefined) throw new Error("integration notifier is not initialized");
      return notifier;
    };

    const getJob = (id: string): Promise<JobRecord | null> =>
      requireDatabase().withSystem(
        (executor) => createRepositories(executor).jobs.get({ tenantId, id }),
        { readOnly: true },
      );

    const getIntent = (
      id: string,
      scopedProjectId = projectId,
    ): Promise<EffectIntentRecord | null> =>
      requireDatabase().withSystem(
        (executor) =>
          createRepositories(executor).effects.get({
            tenantId,
            projectId: scopedProjectId,
            id,
          }),
        { readOnly: true },
      );

    beforeAll(async () => {
      database = createDatabase({
        connectionString: databaseUrl,
        systemConnectionString: systemDatabaseUrl,
        applicationName: `arcdb-worker-integration-${runId}`,
        max: 4,
        statementTimeoutMillis: 10_000,
      });
      administratorDatabase = createDatabase({
        connectionString: administratorDatabaseUrl,
        systemConnectionString: administratorDatabaseUrl,
        applicationName: `arcdb-worker-integration-${runId}-admin`,
        max: 2,
        statementTimeoutMillis: 10_000,
      });

      await administratorDatabase.withSystem(async (executor) => {
        const schema = await executor.query<{
          jobs: string | null;
          effects: string | null;
          outputs: string | null;
        }>(
          `SELECT to_regclass('public.jobs')::text AS jobs,
                  to_regclass('public.effect_intents')::text AS effects,
                  to_regclass('public.outputs')::text AS outputs`,
        );
        if (Object.values(schema.rows[0] ?? {}).some((table) => table === null)) {
          throw new Error("ARCDB_DATABASE_URL must point to an already migrated ArcDB database");
        }

        const repositories = createRepositories(executor);
        await repositories.organizations.create({
          id: tenantId,
          name: `Worker integration ${runId}`,
          slug: `worker-it-${runId.slice(0, 12)}`,
        });
        await repositories.projects.create({
          id: projectId,
          tenantId,
          name: "Worker integration project",
          slug: "worker-integration-project",
        });
        await repositories.projects.create({
          id: siblingProjectId,
          tenantId,
          name: "Worker sibling project",
          slug: "worker-sibling-project",
        });
        await repositories.outputs.create({
          tenantId,
          projectId,
          logicalId: "worker-integration-output",
          versionId: outputVersionId,
          outputType: "json",
          contentRef: `arcdb://${tenantId}/integration/${runId}`,
          contentDigest: `sha256:${"a".repeat(64)}`,
        });
      });

      const config: WorkerConfig = {
        NODE_ENV: "test",
        ARCDB_DATABASE_URL: databaseUrl,
        ARCDB_SYSTEM_DATABASE_URL: systemDatabaseUrl,
        ARCDB_REDIS_URL: redisUrl,
        ARCDB_WORKER_HOST: "127.0.0.1",
        ARCDB_WORKER_PORT: 40_002,
        ARCDB_WORKER_QUEUE: queueName,
        ARCDB_WORKER_CONCURRENCY: 1,
        ARCDB_WORKER_LEASE_MS: 10_000,
        ARCDB_WORKER_HEARTBEAT_MS: 1_000,
        ARCDB_WORKER_POLL_MS: 60_000,
        ARCDB_WORKER_POLL_BATCH: 25,
        ARCDB_WORKER_READY_MAX_HEARTBEAT_AGE_MS: 120_000,
        ARCDB_WORKER_READY_MAX_STALLED: 0,
        ARCDB_WORKER_SHUTDOWN_GRACE_MS: 10_000,
        ARCDB_LOG_LEVEL: "silent",
      };
      jobStore = new PostgresDurableJobStore(database);
      const effectStore = new PostgresEffectStore(database);
      const connectors = new ConnectorRegistry({ allowlist: [manualConnector.type] }).register(
        manualConnector,
      );
      const effectRuntime = new EffectRuntime({ store: effectStore, connectors });
      const handlers = registerEffectJobHandlers(
        new JobHandlerRegistry().register("run_verifier", async (context) => {
          verifierCalls += 1;
          await context.assertCurrentFence();
          verifierStarted.resolve();
          await releaseVerifier.promise;
          await context.assertCurrentFence();
          return { verified: true, source: "bullmq-wakeup" };
        }),
        effectRuntime,
      );
      runtime = new WorkerServiceRuntime({
        config,
        store: jobStore,
        registry: handlers,
        logger: silentLogger,
        metrics: createMetrics({ service: "worker-integration", collectDefault: false }),
        workerId,
      });
      notifier = new BullMqNotifier({ queueName, redisUrl, logger: silentLogger });
      await within(runtime.start(), 20_000, "worker runtime startup");
    }, 30_000);

    afterAll(async () => {
      releaseVerifier.resolve();
      const cleanupErrors: unknown[] = [];

      await notifier?.close().catch((error: unknown) => cleanupErrors.push(error));
      await runtime?.close().catch((error: unknown) => cleanupErrors.push(error));

      if (hasInfrastructure) {
        const queue = new Queue(queueName, {
          connection: redisConnection(redisUrl),
          prefix: "arcdb",
        });
        await within(queue.obliterate({ force: true }), 10_000, "BullMQ queue cleanup").catch(
          (error: unknown) => cleanupErrors.push(error),
        );
        await queue.close().catch((error: unknown) => cleanupErrors.push(error));
      }

      if (administratorDatabase !== undefined) {
        await administratorDatabase
          .withSystem(async (executor) => {
            // These predicates can only target this test's randomly generated tenant.
            await executor.query("DELETE FROM jobs WHERE tenant_id = $1", [tenantId]);
            await executor.query("DELETE FROM effect_intents WHERE tenant_id = $1", [tenantId]);
            await executor.query("DELETE FROM resource_fences WHERE tenant_id = $1", [tenantId]);
            await executor.query("DELETE FROM outputs WHERE tenant_id = $1", [tenantId]);
            await executor.query("DELETE FROM projects WHERE tenant_id = $1", [tenantId]);
            await executor.query("DELETE FROM organizations WHERE id = $1", [tenantId]);
          })
          .catch((error: unknown) => cleanupErrors.push(error));
        await administratorDatabase.close().catch((error: unknown) => cleanupErrors.push(error));
      }
      if (database !== undefined) {
        await database.close().catch((error: unknown) => cleanupErrors.push(error));
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "worker infrastructure integration cleanup failed");
      }
    }, 30_000);

    it("atomically claims a BullMQ-notified durable job and commits its PostgreSQL result", async () => {
      const store = requireJobStore();
      const job = await store.enqueue({
        tenantId,
        projectId,
        jobType: "run_verifier",
        idempotencyKey: `worker-integration-verifier-${runId}`,
        payload: { runId },
        timeoutMs: 10_000,
      });

      await requireNotifier().notify({ tenantId, hintedJobId: job.id });
      try {
        await within(verifierStarted.promise, 10_000, "verifier handler start");
        const running = await getJob(job.id);
        expect(running).toMatchObject({
          status: "RUNNING",
          attemptCount: 1,
          lockedBy: workerId,
          fencingToken: "1",
        });
        await expect(store.claim(tenantId, `competing-${runId}`, 10_000)).resolves.toBeNull();
      } finally {
        releaseVerifier.resolve();
      }

      const completed = await eventually(
        () => getJob(job.id),
        (record) => record?.status === "SUCCEEDED",
        "durable verifier job completion",
      );
      expect(completed).toMatchObject({
        status: "SUCCEEDED",
        attemptCount: 1,
        fencingToken: "1",
        result: { verified: true, source: "bullmq-wakeup" },
      });
      expect(verifierCalls).toBe(1);
    }, 20_000);

    it("keeps manual-receipt external-write-free and requires reconciliation", async () => {
      const intent = await requireDatabase().withSystem((executor) =>
        createRepositories(executor).effects.create({
          tenantId,
          projectId,
          sourceOutputVersionId: outputVersionId,
          connectorType: manualConnector.type,
          connectorCapabilities: { ...manualConnector.capabilities },
          target: "urn:arcdb:integration:manual-target",
          resourceKey: `worker-integration-resource-${runId}`,
          argumentsRef: `arcdb://${tenantId}/integration/manual-arguments`,
          idempotencyKey: `worker-integration-manual-${runId}`,
          reversibility: "R3",
          riskLevel: "HIGH",
          status: "PREPARED",
        }),
      );
      const job = await requireJobStore().enqueue({
        tenantId,
        projectId,
        jobType: "reconcile_effect",
        idempotencyKey: `worker-integration-reconcile-${runId}`,
        payload: { intentId: intent.id },
        timeoutMs: 10_000,
      });

      await requireNotifier().notify({ tenantId, hintedJobId: job.id });
      const completed = await eventually(
        () => getJob(job.id),
        (record) => record?.status === "SUCCEEDED",
        "manual receipt reconciliation job completion",
      );
      expect(completed).toMatchObject({
        status: "SUCCEEDED",
        attemptCount: 1,
        result: {
          intentId: intent.id,
          status: "RECONCILIATION_REQUIRED",
          waitingForManualReceipt: true,
        },
      });

      const reconciled = await getIntent(intent.id);
      expect(reconciled).toMatchObject({
        status: "RECONCILIATION_REQUIRED",
        connectorType: "manual-receipt",
      });
      expect(reconciled?.fencingToken).toBeUndefined();
      const evidence = await requireDatabase().withSystem(
        async (executor) => {
          const repositories = createRepositories(executor);
          const receipts = await repositories.receipts.listByIntent({
            tenantId,
            projectId,
            intentId: intent.id,
          });
          const fences = await executor.query<{ count: number | string }>(
            "SELECT count(*) AS count FROM resource_fences WHERE tenant_id = $1",
            [tenantId],
          );
          return { receipts, resourceFenceCount: Number(fences.rows[0]?.count ?? 0) };
        },
        { readOnly: true },
      );
      expect(evidence.receipts).toEqual([]);
      expect(evidence.resourceFenceCount).toBe(0);
      expect(manualConnector.executeCalls).toBe(1);
    }, 20_000);

    it("dead-letters malformed effect jobs without mutating a sibling-project intent", async () => {
      const siblingOutputVersionId = `worker-sibling-output-${runId}`;
      const siblingIntent = await requireDatabase().withSystem(async (executor) => {
        const repositories = createRepositories(executor);
        await repositories.outputs.create({
          tenantId,
          projectId: siblingProjectId,
          logicalId: "worker-sibling-output",
          versionId: siblingOutputVersionId,
          outputType: "json",
          contentRef: `arcdb://${tenantId}/${siblingProjectId}/${runId}`,
          contentDigest: `sha256:${"b".repeat(64)}`,
        });
        return repositories.effects.create({
          tenantId,
          projectId: siblingProjectId,
          sourceOutputVersionId: siblingOutputVersionId,
          connectorType: manualConnector.type,
          connectorCapabilities: { ...manualConnector.capabilities },
          target: "urn:arcdb:integration:sibling-target",
          resourceKey: `worker-sibling-resource-${runId}`,
          argumentsRef: `arcdb://${tenantId}/${siblingProjectId}/arguments`,
          idempotencyKey: `worker-sibling-intent-${runId}`,
          reversibility: "R3",
          riskLevel: "HIGH",
          status: "PREPARED",
        });
      });
      const store = requireJobStore();
      const wrongProjectJob = await store.enqueue({
        tenantId,
        projectId,
        jobType: "reconcile_effect",
        idempotencyKey: `worker-cross-project-${runId}`,
        payload: { intentId: siblingIntent.id },
      });
      const deadLetterWorker = `dead-letter-${runId}`;
      const claimedWrongProject = await store.claim(tenantId, deadLetterWorker, 10_000);
      expect(claimedWrongProject?.id).toBe(wrongProjectJob.id);
      const wrongProjectResolution = await store.fail({
        tenantId,
        jobId: wrongProjectJob.id,
        workerId: deadLetterWorker,
        fencingToken: claimedWrongProject?.fencingToken ?? "",
        retryable: false,
        error: { code: "EFFECT_SCOPE_MISMATCH", message: "cross-project regression" },
      });
      expect(wrongProjectResolution.kind).toBe("DEAD_LETTER");
      expect((await getIntent(siblingIntent.id, siblingProjectId))?.status).toBe("PREPARED");

      await expect(
        requireDatabase().withSystem((executor) =>
          createRepositories(executor).jobs.enqueue({
            tenantId,
            jobType: "reconcile_effect",
            idempotencyKey: `worker-null-project-${runId}`,
            payload: { intentId: siblingIntent.id },
          }),
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect((await getIntent(siblingIntent.id, siblingProjectId))?.status).toBe("PREPARED");
    }, 20_000);
  },
);

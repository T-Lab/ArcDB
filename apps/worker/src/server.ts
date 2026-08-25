import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createDatabase } from "@arcdb/db";
import { createLogger, createMetrics } from "@arcdb/observability";
import { readWorkerConfig } from "./config.js";
import { ManualReceiptConnector } from "./connectors/manual-receipt.js";
import { ConnectorRegistry } from "./connectors/registry.js";
import { PostgresEffectStore } from "./effect-store.js";
import { EffectRuntime, registerEffectJobHandlers } from "./effects.js";
import { WorkerHealthServer } from "./health-server.js";
import { PostgresDurableJobStore } from "./job-store.js";
import { JobHandlerRegistry } from "./registry.js";
import { WorkerServiceRuntime } from "./runtime.js";
import { ObservabilityWorkerTelemetry } from "./telemetry.js";

const config = readWorkerConfig();
const logger = createLogger({
  service: "worker",
  version: "0.1.0",
  environment: config.NODE_ENV,
  level: config.ARCDB_LOG_LEVEL,
});
const metrics = createMetrics({ service: "worker", collectDefault: true });
const database = createDatabase({
  connectionString: config.ARCDB_DATABASE_URL,
  systemConnectionString: config.ARCDB_SYSTEM_DATABASE_URL,
  applicationName: "arcdb-worker",
});
try {
  await database.assertRuntimeRoleSeparation();
} catch (error) {
  await database.close();
  throw error;
}
const jobStore = new PostgresDurableJobStore(database);
const effectStore = new PostgresEffectStore(database);
const connectors = new ConnectorRegistry({ allowlist: ["manual-receipt"] }).register(
  new ManualReceiptConnector(),
);
const effectRuntime = new EffectRuntime({
  store: effectStore,
  connectors,
  telemetry: new ObservabilityWorkerTelemetry(metrics),
});
const handlers = registerEffectJobHandlers(new JobHandlerRegistry(), effectRuntime);
const workerId = `${hostname()}-${process.pid}-${randomUUID()}`;
const runtime = new WorkerServiceRuntime({
  config,
  store: jobStore,
  registry: handlers,
  logger,
  metrics,
  workerId,
});
const healthServer = new WorkerHealthServer({ config, runtime, metrics, logger });

let closing: Promise<void> | undefined;
async function close(reason: string): Promise<void> {
  if (closing !== undefined) return closing;
  closing = (async () => {
    logger.info({ reason, workerId }, "worker shutting down");
    const deadline = setTimeout(() => {
      logger.fatal(
        { reason, graceMs: config.ARCDB_WORKER_SHUTDOWN_GRACE_MS },
        "worker graceful shutdown deadline exceeded",
      );
      // Durable RUNNING rows retain their leases and are recovered by another
      // worker after expiry, so forced process termination cannot mark success.
      process.exit(1);
    }, config.ARCDB_WORKER_SHUTDOWN_GRACE_MS);
    try {
      await healthServer.close().catch((error: unknown) => {
        logger.error({ err: error }, "health server close failed");
      });
      await runtime.close().catch((error: unknown) => {
        logger.error({ err: error }, "worker runtime close failed");
      });
      await database.close();
    } finally {
      clearTimeout(deadline);
    }
  })();
  return closing;
}

process.once("SIGTERM", () => void close("SIGTERM"));
process.once("SIGINT", () => void close("SIGINT"));

try {
  await runtime.start();
  await healthServer.start();
  logger.info(
    {
      workerId,
      healthPort: config.ARCDB_WORKER_PORT,
      connectorTypes: connectors.types(),
      handlerCoverage: handlers.coverage(),
    },
    "ArcDB worker started",
  );
} catch (error) {
  logger.fatal({ err: error }, "ArcDB worker failed to start");
  await close("startup_failure");
  process.exitCode = 1;
}

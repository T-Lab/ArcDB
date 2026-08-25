import { z } from "zod";

export const WorkerConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ARCDB_DATABASE_URL: z.string().url().startsWith("postgresql://"),
  ARCDB_SYSTEM_DATABASE_URL: z.string().url().startsWith("postgresql://"),
  ARCDB_REDIS_URL: z.string().url().startsWith("redis").default("redis://localhost:6379/0"),
  ARCDB_WORKER_HOST: z.string().default("0.0.0.0"),
  ARCDB_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(4002),
  ARCDB_WORKER_QUEUE: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/u)
    .default("arcdb-jobs"),
  ARCDB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  ARCDB_WORKER_LEASE_MS: z.coerce.number().int().min(3_000).max(3_600_000).default(60_000),
  ARCDB_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(250).max(1_200_000).default(15_000),
  ARCDB_WORKER_POLL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  ARCDB_WORKER_POLL_BATCH: z.coerce.number().int().min(1).max(10_000).default(500),
  ARCDB_WORKER_READY_MAX_HEARTBEAT_AGE_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(30_000),
  ARCDB_WORKER_READY_MAX_STALLED: z.coerce.number().int().min(0).default(0),
  ARCDB_WORKER_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  ARCDB_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function readWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = WorkerConfigSchema.parse(environment);
  if (config.ARCDB_DATABASE_URL === config.ARCDB_SYSTEM_DATABASE_URL) {
    throw new TypeError("ARCDB_DATABASE_URL and ARCDB_SYSTEM_DATABASE_URL must be distinct");
  }
  if (config.ARCDB_WORKER_HEARTBEAT_MS * 2 >= config.ARCDB_WORKER_LEASE_MS) {
    throw new TypeError("ARCDB_WORKER_HEARTBEAT_MS must be less than half ARCDB_WORKER_LEASE_MS");
  }
  if (config.ARCDB_WORKER_READY_MAX_HEARTBEAT_AGE_MS <= config.ARCDB_WORKER_POLL_MS) {
    throw new TypeError(
      "ARCDB_WORKER_READY_MAX_HEARTBEAT_AGE_MS must be greater than ARCDB_WORKER_POLL_MS",
    );
  }
  return config;
}

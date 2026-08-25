import type { JobRecord, JobType, JsonObject } from "@arcdb/db";

export const JOB_TYPES = [
  "process_ingestion_batch",
  "run_verifier",
  "evaluate_policy",
  "compute_impact",
  "propagate_invalidation",
  "materialize_dataset_view",
  "compact_artifacts",
  "garbage_collect_chunks",
  "reconcile_effect",
  "run_compensation",
  "create_remediation_obligation",
  "publish_analytics_projection",
] as const satisfies readonly JobType[];

export type JobResult = JsonObject;

export interface JobLogger {
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface JobExecutionContext {
  readonly job: JobRecord;
  readonly signal: AbortSignal;
  readonly logger: JobLogger;
  readonly assertCurrentFence: () => Promise<void>;
}

export type JobHandler = (context: JobExecutionContext) => Promise<JobResult>;

export function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

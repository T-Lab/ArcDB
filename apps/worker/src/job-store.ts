import {
  createRepositories,
  type Database,
  type JobRecord,
  type JobType,
  type JsonObject,
  type SqlExecutor,
} from "@arcdb/db";

export interface EnqueueJobInput {
  readonly tenantId: string;
  readonly projectId?: string;
  readonly jobType: JobType;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly availableAt?: string;
  readonly traceContext?: JsonObject;
}

export interface JobFailureInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  readonly retryable: boolean;
  readonly retryAt?: string;
  readonly error: JsonObject;
}

export type JobFailureResolution =
  | { readonly kind: "RETRY_SCHEDULED"; readonly job: JobRecord }
  | { readonly kind: "DEAD_LETTER"; readonly job: JobRecord }
  | { readonly kind: "FENCE_LOST" };

export interface QueueHealthSnapshot {
  readonly pending: number;
  readonly running: number;
  readonly failed: number;
  readonly deadLetter: number;
  readonly stalled: number;
  readonly runnable: number;
  readonly oldestRunnableLagSeconds: number;
}

export interface QueueWakeup {
  readonly tenantId: string;
  /** Diagnostic only. A wakeup lets PostgreSQL select the next runnable job. */
  readonly hintedJobId?: string;
}

export interface DurableJobStore {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  claim(tenantId: string, workerId: string, leaseMs: number): Promise<JobRecord | null>;
  heartbeat(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    leaseMs: number,
  ): Promise<boolean>;
  isFenceCurrent(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
  ): Promise<boolean>;
  complete(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    result: JsonObject,
  ): Promise<boolean>;
  fail(input: JobFailureInput): Promise<JobFailureResolution>;
  listRunnableWakeups(limit: number): Promise<readonly QueueWakeup[]>;
  recoverStalled(limitPerTenant?: number): Promise<readonly QueueWakeup[]>;
  health(): Promise<QueueHealthSnapshot>;
  databaseHealth(): Promise<boolean>;
}

function validateEnqueue(input: EnqueueJobInput): void {
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 512) {
    throw new TypeError("idempotencyKey must contain between 1 and 512 characters");
  }
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new TypeError("maxAttempts must be an integer between 1 and 100");
  }
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60_000) {
    throw new TypeError("timeoutMs must be between 1ms and 24h");
  }
  if (input.availableAt !== undefined && Number.isNaN(Date.parse(input.availableAt))) {
    throw new TypeError("availableAt must be an ISO timestamp");
  }
  if (
    (input.jobType === "reconcile_effect" || input.jobType === "run_compensation") &&
    input.projectId === undefined
  ) {
    throw new TypeError("Effect jobs require an explicit projectId");
  }
}

async function markDeadLetterEffectForReconciliation(
  executor: SqlExecutor,
  job: JobRecord,
): Promise<void> {
  if (
    job.status !== "DEAD_LETTER" ||
    (job.jobType !== "reconcile_effect" && job.jobType !== "run_compensation") ||
    job.projectId === undefined ||
    typeof job.payload.intentId !== "string"
  ) {
    return;
  }
  await executor.query(
    `UPDATE effect_intents
        SET status = 'RECONCILIATION_REQUIRED'
      WHERE tenant_id = $1 AND id::text = $2
        AND project_id = $3
        AND status IN ('PREPARED', 'EXECUTING', 'FAILED', 'COMPENSATION_PENDING')`,
    [job.tenantId, job.payload.intentId, job.projectId],
  );
}

/** PostgreSQL is the correctness oracle. Redis never appears in this adapter. */
export class PostgresDurableJobStore implements DurableJobStore {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    validateEnqueue(input);
    return this.#database.withSystem((executor) =>
      createRepositories(executor).jobs.enqueue(input),
    );
  }

  public async claim(
    tenantId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<JobRecord | null> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError("leaseMs must be a positive safe integer");
    }
    return this.#database.withSystem((executor) =>
      createRepositories(executor).jobs.claim({
        tenantId,
        workerId,
        lockSeconds: Math.max(1, Math.ceil(leaseMs / 1_000)),
      }),
    );
  }

  public async heartbeat(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError("leaseMs must be a positive safe integer");
    }
    return this.#database.withSystem((executor) =>
      createRepositories(executor).jobs.heartbeat({
        tenantId,
        id: jobId,
        workerId,
        fencingToken,
        extendSeconds: Math.max(1, Math.ceil(leaseMs / 1_000)),
      }),
    );
  }

  public async isFenceCurrent(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
  ): Promise<boolean> {
    return this.#database.withSystem(
      async (executor) => {
        const result = await executor.query<{ current: boolean }>(
          `SELECT EXISTS (
           SELECT 1 FROM jobs
            WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'
              AND locked_by = $3 AND fencing_token = $4 AND lock_expires_at > now()
         ) AS current`,
          [tenantId, jobId, workerId, fencingToken],
        );
        return result.rows[0]?.current === true;
      },
      { readOnly: true },
    );
  }

  public async complete(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    result: JsonObject,
  ): Promise<boolean> {
    const completed = await this.#database.withSystem((executor) =>
      createRepositories(executor).jobs.complete({
        tenantId,
        id: jobId,
        workerId,
        fencingToken,
        result,
      }),
    );
    return completed !== null;
  }

  public async fail(input: JobFailureInput): Promise<JobFailureResolution> {
    const failed = await this.#database.withSystem(async (executor) => {
      if (input.retryable) {
        const result = await createRepositories(executor).jobs.fail({
          tenantId: input.tenantId,
          id: input.jobId,
          workerId: input.workerId,
          fencingToken: input.fencingToken,
          error: input.error,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        });
        if (result !== null) await markDeadLetterEffectForReconciliation(executor, result);
        return result;
      }

      // The shared repository retries until maxAttempts. Permanent failures,
      // especially missing handlers, must instead enter dead-letter now.
      const result = await executor.query<{ id: string }>(
        `UPDATE jobs SET status = 'DEAD_LETTER', error = $5::jsonb,
           locked_by = NULL, lock_expires_at = NULL
         WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'
           AND locked_by = $3 AND fencing_token = $4 AND lock_expires_at > now()
         RETURNING id`,
        [
          input.tenantId,
          input.jobId,
          input.workerId,
          input.fencingToken,
          JSON.stringify(input.error),
        ],
      );
      if (result.rows[0] === undefined) return null;
      const resultJob = await createRepositories(executor).jobs.get({
        tenantId: input.tenantId,
        id: input.jobId,
      });
      if (resultJob !== null) await markDeadLetterEffectForReconciliation(executor, resultJob);
      return resultJob;
    });
    if (failed === null) return { kind: "FENCE_LOST" };
    return failed.status === "FAILED"
      ? { kind: "RETRY_SCHEDULED", job: failed }
      : { kind: "DEAD_LETTER", job: failed };
  }

  public async listRunnableWakeups(limit: number): Promise<readonly QueueWakeup[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("limit must be an integer between 1 and 10000");
    }
    return this.#database.withSystem(
      async (executor) => {
        const result = await executor.query<{ tenant_id: string; hinted_job_id: string }>(
          `SELECT tenant_id, id::text AS hinted_job_id
           FROM jobs
          WHERE status IN ('PENDING', 'FAILED') AND available_at <= now()
            AND attempt_count < max_attempts
          ORDER BY available_at, created_at, id
          LIMIT $1`,
          [limit],
        );
        return result.rows.map((row) => ({
          tenantId: row.tenant_id,
          hintedJobId: row.hinted_job_id,
        }));
      },
      { readOnly: true },
    );
  }

  public async recoverStalled(limitPerTenant = 100): Promise<readonly QueueWakeup[]> {
    if (!Number.isSafeInteger(limitPerTenant) || limitPerTenant < 1 || limitPerTenant > 10_000) {
      throw new TypeError("limitPerTenant must be an integer between 1 and 10000");
    }
    return this.#database.withSystem(async (executor) => {
      const tenants = await executor.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM jobs
          WHERE status = 'RUNNING' AND lock_expires_at <= now()`,
      );
      const repositories = createRepositories(executor);
      const wakeups: QueueWakeup[] = [];
      for (const row of tenants.rows) {
        const recovered = await repositories.jobs.recoverStalled({
          tenantId: row.tenant_id,
          limit: limitPerTenant,
        });
        if (recovered.length > 0) {
          await executor.query(
            `UPDATE jobs SET error = error || jsonb_build_object(
               'message', 'The worker heartbeat expired before completion',
               'externalOutcome', CASE
                 WHEN job_type IN ('reconcile_effect', 'run_compensation') THEN 'UNKNOWN'
                 ELSE 'NOT_EXTERNAL'
               END,
               'occurredAt', now()
             )
             WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
            [row.tenant_id, recovered.map((job) => job.id)],
          );
        }
        for (const job of recovered) {
          await markDeadLetterEffectForReconciliation(executor, job);
          if (job.status === "FAILED")
            wakeups.push({ tenantId: job.tenantId, hintedJobId: job.id });
        }
      }
      return wakeups;
    });
  }

  public async health(): Promise<QueueHealthSnapshot> {
    return this.#database.withSystem(
      async (executor) => {
        const result = await executor.query<{
          pending: number | string;
          running: number | string;
          failed: number | string;
          dead_letter: number | string;
          stalled: number | string;
          runnable: number | string;
          oldest_runnable_lag_seconds: number | string | null;
        }>(
          `SELECT
           count(*) FILTER (WHERE status = 'PENDING') AS pending,
           count(*) FILTER (WHERE status = 'RUNNING') AS running,
           count(*) FILTER (WHERE status = 'FAILED') AS failed,
           count(*) FILTER (WHERE status = 'DEAD_LETTER') AS dead_letter,
           count(*) FILTER (WHERE status = 'RUNNING' AND lock_expires_at <= now()) AS stalled,
           count(*) FILTER (WHERE status IN ('PENDING', 'FAILED') AND available_at <= now()) AS runnable,
           EXTRACT(EPOCH FROM now() - min(available_at)
             FILTER (WHERE status IN ('PENDING', 'FAILED') AND available_at <= now()))
             AS oldest_runnable_lag_seconds
         FROM jobs`,
        );
        const row = result.rows[0];
        return {
          pending: Number(row?.pending ?? 0),
          running: Number(row?.running ?? 0),
          failed: Number(row?.failed ?? 0),
          deadLetter: Number(row?.dead_letter ?? 0),
          stalled: Number(row?.stalled ?? 0),
          runnable: Number(row?.runnable ?? 0),
          oldestRunnableLagSeconds: Math.max(0, Number(row?.oldest_runnable_lag_seconds ?? 0)),
        };
      },
      { readOnly: true },
    );
  }

  public databaseHealth(): Promise<boolean> {
    return this.#database.healthcheck();
  }
}

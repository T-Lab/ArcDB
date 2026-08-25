import type { JsonObject } from "@arcdb/db";
import { withLogContext } from "@arcdb/observability";
import {
  type BackoffPolicy,
  boundedExponentialBackoff,
  DEFAULT_BACKOFF_POLICY,
} from "./backoff.js";
import {
  isRetryableError,
  JobFenceLostError,
  JobTimeoutError,
  persistedJobError,
  WorkerRuntimeError,
} from "./errors.js";
import type { DurableJobStore, QueueWakeup } from "./job-store.js";
import type { JobLogger } from "./job-types.js";
import type { JobHandlerRegistry } from "./registry.js";
import { NOOP_WORKER_TELEMETRY, type WorkerTelemetry } from "./telemetry.js";

export interface RetryNotifier {
  notify(wakeup: QueueWakeup, delayMs?: number): Promise<void>;
}

export type ProcessWakeupResult =
  | { readonly kind: "NO_JOB" }
  | { readonly kind: "SUCCEEDED"; readonly jobId: string }
  | { readonly kind: "RETRY_SCHEDULED"; readonly jobId: string }
  | { readonly kind: "DEAD_LETTER"; readonly jobId: string }
  | { readonly kind: "FENCE_LOST"; readonly jobId: string };

export interface DurableJobProcessorOptions {
  readonly workerId: string;
  readonly store: DurableJobStore;
  readonly registry: JobHandlerRegistry;
  readonly logger: JobLogger;
  readonly notifier?: RetryNotifier;
  readonly telemetry?: WorkerTelemetry;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly backoff?: BackoffPolicy;
  readonly random?: () => number;
  readonly now?: () => Date;
}

function assertJsonValue(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
    seen.add(value);
    value.forEach((child, index) => {
      assertJsonValue(child, `${path}[${index}]`, seen);
    });
    seen.delete(value);
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError(`${path} contains a cycle`);
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) throw new TypeError(`${path}.${key} is undefined`);
      assertJsonValue(child, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new TypeError(`${path} contains unsupported type ${typeof value}`);
}

function assertJobResult(value: JsonObject): void {
  assertJsonValue(value, "job result", new Set());
}

function retryable(error: unknown): boolean {
  if (isRetryableError(error)) return true;
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}

function abortReason(signal: AbortSignal, fallback: unknown): unknown {
  return signal.aborted && signal.reason !== undefined ? signal.reason : fallback;
}

export class DurableJobProcessor {
  readonly #workerId: string;
  readonly #store: DurableJobStore;
  readonly #registry: JobHandlerRegistry;
  readonly #logger: JobLogger;
  readonly #notifier: RetryNotifier | undefined;
  readonly #telemetry: WorkerTelemetry;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #backoff: BackoffPolicy;
  readonly #random: () => number;
  readonly #now: () => Date;
  #lastHeartbeatAt: Date | undefined;
  #activeJobs = 0;

  public constructor(options: DurableJobProcessorOptions) {
    this.#workerId = options.workerId;
    this.#store = options.store;
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#notifier = options.notifier;
    this.#telemetry = options.telemetry ?? NOOP_WORKER_TELEMETRY;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF_POLICY;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? (() => new Date());
    if (this.#heartbeatMs * 2 >= this.#leaseMs) {
      throw new TypeError("heartbeatMs must be less than half leaseMs");
    }
  }

  public heartbeatNow(): void {
    this.#lastHeartbeatAt = this.#now();
  }

  public snapshot(): { readonly lastHeartbeatAt?: string; readonly activeJobs: number } {
    return {
      ...(this.#lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: this.#lastHeartbeatAt.toISOString() }),
      activeJobs: this.#activeJobs,
    };
  }

  public async processWakeup(wakeup: QueueWakeup): Promise<ProcessWakeupResult> {
    this.heartbeatNow();
    const job = await this.#store.claim(wakeup.tenantId, this.#workerId, this.#leaseMs);
    if (job === null) return { kind: "NO_JOB" };

    return withLogContext(
      {
        tenantId: job.tenantId,
        ...(job.projectId === undefined ? {} : { projectId: job.projectId }),
        jobId: job.id,
        workerId: this.#workerId,
      },
      async () => this.#executeClaimed(job),
    );
  }

  async #executeClaimed(
    job: Awaited<ReturnType<DurableJobStore["claim"]>> & {},
  ): Promise<ProcessWakeupResult> {
    if (job === null) return { kind: "NO_JOB" };
    const controller = new AbortController();
    let heartbeatRunning = false;
    this.#activeJobs += 1;
    this.#telemetry.transition(job.jobType, "CLAIMABLE", "RUNNING");
    const finishMetric = this.#telemetry.start(job.jobType);
    let metricFinished = false;
    const finish = (outcome: string): void => {
      if (metricFinished) return;
      metricFinished = true;
      finishMetric(outcome);
    };

    const assertCurrentFence = async (): Promise<void> => {
      if (controller.signal.aborted) {
        throw abortReason(controller.signal, new JobFenceLostError(job.id));
      }
      const current = await this.#store.isFenceCurrent(
        job.tenantId,
        job.id,
        this.#workerId,
        job.fencingToken,
      );
      if (!current) {
        const error = new JobFenceLostError(job.id);
        controller.abort(error);
        throw error;
      }
    };

    const heartbeat = async (): Promise<void> => {
      if (heartbeatRunning || controller.signal.aborted) return;
      heartbeatRunning = true;
      try {
        const renewed = await this.#store.heartbeat(
          job.tenantId,
          job.id,
          this.#workerId,
          job.fencingToken,
          this.#leaseMs,
        );
        if (!renewed) controller.abort(new JobFenceLostError(job.id));
        else this.heartbeatNow();
      } catch (error) {
        this.#logger.error({ err: error, jobId: job.id }, "job heartbeat failed");
        controller.abort(new JobFenceLostError(job.id));
      } finally {
        heartbeatRunning = false;
      }
    };

    const heartbeatTimer = setInterval(() => void heartbeat(), this.#heartbeatMs);
    heartbeatTimer.unref();
    const timeoutError = new JobTimeoutError(job.id, job.timeoutMs);
    const timeoutTimer = setTimeout(() => controller.abort(timeoutError), job.timeoutMs);
    timeoutTimer.unref();

    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(abortReason(controller.signal, timeoutError)),
        { once: true },
      );
    });

    try {
      this.#logger.info(
        { jobId: job.id, jobType: job.jobType, attempt: job.attemptCount },
        "job started",
      );
      const handler = this.#registry.resolve(job.jobType);
      const handlerPromise = handler({
        job,
        signal: controller.signal,
        logger: this.#logger,
        assertCurrentFence,
      });
      const result = await Promise.race([handlerPromise, abortPromise]);
      assertJobResult(result);
      await assertCurrentFence();
      const completed = await this.#store.complete(
        job.tenantId,
        job.id,
        this.#workerId,
        job.fencingToken,
        result,
      );
      if (!completed) throw new JobFenceLostError(job.id);
      this.#telemetry.transition(job.jobType, "RUNNING", "SUCCEEDED");
      finish("succeeded");
      this.#logger.info(
        { jobId: job.id, jobType: job.jobType, attempt: job.attemptCount },
        "job succeeded",
      );
      return { kind: "SUCCEEDED", jobId: job.id };
    } catch (caught) {
      const error = abortReason(controller.signal, caught);
      if (error instanceof JobFenceLostError) {
        this.#telemetry.error(error.code);
        finish("fence_lost");
        this.#logger.warn({ jobId: job.id, jobType: job.jobType }, "job fence lost");
        return { kind: "FENCE_LOST", jobId: job.id };
      }

      const durableError = persistedJobError(error, this.#now());
      const canRetry = retryable(error);
      const delayMs = canRetry
        ? boundedExponentialBackoff(job.attemptCount, this.#backoff, this.#random)
        : 0;
      const retryAt = canRetry
        ? new Date(this.#now().getTime() + delayMs).toISOString()
        : undefined;
      const resolution = await this.#store.fail({
        tenantId: job.tenantId,
        jobId: job.id,
        workerId: this.#workerId,
        fencingToken: job.fencingToken,
        retryable: canRetry,
        ...(retryAt === undefined ? {} : { retryAt }),
        error: { ...durableError },
      });
      this.#telemetry.error(durableError.code);
      if (resolution.kind === "FENCE_LOST") {
        finish("fence_lost");
        return { kind: "FENCE_LOST", jobId: job.id };
      }
      if (resolution.kind === "RETRY_SCHEDULED") {
        this.#telemetry.transition(job.jobType, "RUNNING", "FAILED");
        finish("retry_scheduled");
        this.#logger.warn(
          { jobId: job.id, jobType: job.jobType, code: durableError.code, retryAt },
          "job retry scheduled",
        );
        await this.#notifier?.notify({ tenantId: job.tenantId, hintedJobId: job.id }, delayMs);
        return { kind: "RETRY_SCHEDULED", jobId: job.id };
      }
      this.#telemetry.transition(job.jobType, "RUNNING", "DEAD_LETTER");
      finish("dead_letter");
      this.#logger.error(
        { jobId: job.id, jobType: job.jobType, code: durableError.code },
        "job moved to dead-letter",
      );
      return { kind: "DEAD_LETTER", jobId: job.id };
    } finally {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutTimer);
      this.#activeJobs -= 1;
      finish("abandoned");
    }
  }
}

export function retryableJobError(
  code: string,
  message: string,
  cause?: unknown,
): WorkerRuntimeError {
  return new WorkerRuntimeError(code, message, {
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

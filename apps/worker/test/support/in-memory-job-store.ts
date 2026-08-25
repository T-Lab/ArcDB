import { randomUUID } from "node:crypto";
import type { JobRecord, JsonObject } from "@arcdb/db";
import type {
  DurableJobStore,
  EnqueueJobInput,
  JobFailureInput,
  JobFailureResolution,
  QueueHealthSnapshot,
  QueueWakeup,
} from "../../src/job-store.js";

export class InMemoryJobStore implements DurableJobStore {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const existing = [...this.#jobs.values()].find(
      (job) =>
        job.tenantId === input.tenantId &&
        job.jobType === input.jobType &&
        job.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return existing;
    const now = this.#now().toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      jobType: input.jobType,
      idempotencyKey: input.idempotencyKey,
      status: "PENDING",
      payload: input.payload,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 5,
      timeoutMs: input.timeoutMs ?? 30_000,
      availableAt: input.availableAt ?? now,
      fencingToken: "0",
      traceContext: input.traceContext ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(job.id, job);
    return job;
  }

  public async claim(
    tenantId: string,
    workerId: string,
    leaseMs: number,
  ): Promise<JobRecord | null> {
    const now = this.#now();
    const job = [...this.#jobs.values()]
      .filter(
        (candidate) =>
          candidate.tenantId === tenantId &&
          (candidate.status === "PENDING" || candidate.status === "FAILED") &&
          Date.parse(candidate.availableAt) <= now.getTime() &&
          candidate.attemptCount < candidate.maxAttempts,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (job === undefined) return null;
    const claimed: JobRecord = {
      ...job,
      status: "RUNNING",
      attemptCount: job.attemptCount + 1,
      lockedBy: workerId,
      lockExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      fencingToken: String(BigInt(job.fencingToken) + 1n),
      updatedAt: now.toISOString(),
    };
    this.#jobs.set(job.id, claimed);
    return claimed;
  }

  public async heartbeat(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (!this.#current(job, tenantId, workerId, fencingToken)) return false;
    this.#jobs.set(jobId, {
      ...job,
      lockExpiresAt: new Date(this.#now().getTime() + leaseMs).toISOString(),
    });
    return true;
  }

  public async isFenceCurrent(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
  ): Promise<boolean> {
    return this.#current(this.#jobs.get(jobId), tenantId, workerId, fencingToken);
  }

  public async complete(
    tenantId: string,
    jobId: string,
    workerId: string,
    fencingToken: string,
    result: JsonObject,
  ): Promise<boolean> {
    const job = this.#jobs.get(jobId);
    if (!this.#current(job, tenantId, workerId, fencingToken)) return false;
    this.#jobs.set(jobId, {
      ...job,
      status: "SUCCEEDED",
      result,
      lockedBy: undefined,
      lockExpiresAt: undefined,
      updatedAt: this.#now().toISOString(),
    } as JobRecord);
    return true;
  }

  public async fail(input: JobFailureInput): Promise<JobFailureResolution> {
    const job = this.#jobs.get(input.jobId);
    if (!this.#current(job, input.tenantId, input.workerId, input.fencingToken)) {
      return { kind: "FENCE_LOST" };
    }
    const retry = input.retryable && job.attemptCount < job.maxAttempts;
    const failed: JobRecord = {
      ...job,
      status: retry ? "FAILED" : "DEAD_LETTER",
      error: input.error,
      availableAt: input.retryAt ?? job.availableAt,
      lockedBy: undefined,
      lockExpiresAt: undefined,
      updatedAt: this.#now().toISOString(),
    } as JobRecord;
    this.#jobs.set(job.id, failed);
    return retry ? { kind: "RETRY_SCHEDULED", job: failed } : { kind: "DEAD_LETTER", job: failed };
  }

  public async listRunnableWakeups(limit: number): Promise<readonly QueueWakeup[]> {
    const now = this.#now().getTime();
    return [...this.#jobs.values()]
      .filter(
        (job) =>
          (job.status === "PENDING" || job.status === "FAILED") &&
          Date.parse(job.availableAt) <= now,
      )
      .slice(0, limit)
      .map((job) => ({ tenantId: job.tenantId, hintedJobId: job.id }));
  }

  public async recoverStalled(): Promise<readonly QueueWakeup[]> {
    const now = this.#now().getTime();
    const wakeups: QueueWakeup[] = [];
    for (const job of this.#jobs.values()) {
      if (
        job.status !== "RUNNING" ||
        job.lockExpiresAt === undefined ||
        Date.parse(job.lockExpiresAt) > now
      ) {
        continue;
      }
      const retry = job.attemptCount < job.maxAttempts;
      this.#jobs.set(job.id, {
        ...job,
        status: retry ? "FAILED" : "DEAD_LETTER",
        lockedBy: undefined,
        lockExpiresAt: undefined,
      } as JobRecord);
      if (retry) wakeups.push({ tenantId: job.tenantId, hintedJobId: job.id });
    }
    return wakeups;
  }

  public async health(): Promise<QueueHealthSnapshot> {
    const now = this.#now().getTime();
    const jobs = [...this.#jobs.values()];
    const runnable = jobs.filter(
      (job) =>
        (job.status === "PENDING" || job.status === "FAILED") && Date.parse(job.availableAt) <= now,
    );
    return {
      pending: jobs.filter((job) => job.status === "PENDING").length,
      running: jobs.filter((job) => job.status === "RUNNING").length,
      failed: jobs.filter((job) => job.status === "FAILED").length,
      deadLetter: jobs.filter((job) => job.status === "DEAD_LETTER").length,
      stalled: jobs.filter(
        (job) =>
          job.status === "RUNNING" &&
          job.lockExpiresAt !== undefined &&
          Date.parse(job.lockExpiresAt) <= now,
      ).length,
      runnable: runnable.length,
      oldestRunnableLagSeconds:
        runnable.length === 0
          ? 0
          : Math.max(
              0,
              (now - Math.min(...runnable.map((job) => Date.parse(job.availableAt)))) / 1_000,
            ),
    };
  }

  public async databaseHealth(): Promise<boolean> {
    return true;
  }

  public get(jobId: string): JobRecord | undefined {
    return this.#jobs.get(jobId);
  }

  public stealFence(jobId: string): void {
    const job = this.#jobs.get(jobId);
    if (job === undefined) throw new Error("job not found");
    this.#jobs.set(jobId, {
      ...job,
      lockedBy: "other-worker",
      fencingToken: String(BigInt(job.fencingToken) + 1n),
    });
  }

  #current(
    job: JobRecord | undefined,
    tenantId: string,
    workerId: string,
    fencingToken: string,
  ): job is JobRecord & { readonly lockedBy: string; readonly lockExpiresAt: string } {
    return (
      job !== undefined &&
      job.tenantId === tenantId &&
      job.status === "RUNNING" &&
      job.lockedBy === workerId &&
      job.fencingToken === fencingToken &&
      job.lockExpiresAt !== undefined &&
      Date.parse(job.lockExpiresAt) > this.#now().getTime()
    );
  }
}

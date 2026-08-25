import { describe, expect, it, vi } from "vitest";
import { WorkerRuntimeError } from "../../src/errors.js";
import { DurableJobProcessor } from "../../src/processor.js";
import { JobHandlerRegistry } from "../../src/registry.js";
import { InMemoryJobStore } from "../support/in-memory-job-store.js";
import { silentLogger } from "../support/logger.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";

function processor(
  store: InMemoryJobStore,
  registry: JobHandlerRegistry,
  notifier?: { notify: ReturnType<typeof vi.fn> },
): DurableJobProcessor {
  return new DurableJobProcessor({
    workerId: "worker-a",
    store,
    registry,
    logger: silentLogger,
    ...(notifier === undefined ? {} : { notifier }),
    leaseMs: 100,
    heartbeatMs: 20,
    backoff: { baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
    random: () => 0.5,
  });
}

describe("DurableJobProcessor", () => {
  it("completes through the durable fencing CAS", async () => {
    const store = new InMemoryJobStore();
    const job = await store.enqueue({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      jobType: "run_verifier",
      idempotencyKey: "verify:one",
      payload: {},
    });
    const registry = new JobHandlerRegistry().register("run_verifier", async (context) => {
      await context.assertCurrentFence();
      return { verdict: "PASS" };
    });
    await expect(
      processor(store, registry).processWakeup({ tenantId: TENANT_ID }),
    ).resolves.toEqual({
      kind: "SUCCEEDED",
      jobId: job.id,
    });
    expect(store.get(job.id)?.status).toBe("SUCCEEDED");
    expect(store.get(job.id)?.attemptCount).toBe(1);
  });

  it("dead-letters an unconfigured handler instead of silently succeeding", async () => {
    const store = new InMemoryJobStore();
    const job = await store.enqueue({
      tenantId: TENANT_ID,
      jobType: "compact_artifacts",
      idempotencyKey: "compact:one",
      payload: {},
      maxAttempts: 8,
    });
    const result = await processor(store, new JobHandlerRegistry()).processWakeup({
      tenantId: TENANT_ID,
    });
    expect(result).toEqual({ kind: "DEAD_LETTER", jobId: job.id });
    expect(store.get(job.id)?.status).toBe("DEAD_LETTER");
    expect(store.get(job.id)?.error).toMatchObject({ code: "JOB_HANDLER_NOT_CONFIGURED" });
  });

  it("uses durable attempt count and bounded retry scheduling on timeout", async () => {
    const store = new InMemoryJobStore();
    const job = await store.enqueue({
      tenantId: TENANT_ID,
      jobType: "run_verifier",
      idempotencyKey: "verify:timeout",
      payload: {},
      timeoutMs: 15,
      maxAttempts: 2,
    });
    const registry = new JobHandlerRegistry().register(
      "run_verifier",
      async () => new Promise<never>(() => undefined),
    );
    const notify = vi.fn(async () => undefined);
    const result = await processor(store, registry, { notify }).processWakeup({
      tenantId: TENANT_ID,
    });
    expect(result).toEqual({ kind: "RETRY_SCHEDULED", jobId: job.id });
    expect(store.get(job.id)?.status).toBe("FAILED");
    expect(store.get(job.id)?.error).toMatchObject({ code: "JOB_TIMEOUT", retryable: true });
    expect(notify).toHaveBeenCalledOnce();
  });

  it("cannot complete after another worker steals the fencing token", async () => {
    const store = new InMemoryJobStore();
    const job = await store.enqueue({
      tenantId: TENANT_ID,
      jobType: "run_verifier",
      idempotencyKey: "verify:fence",
      payload: {},
    });
    const registry = new JobHandlerRegistry().register("run_verifier", async (context) => {
      store.stealFence(context.job.id);
      await context.assertCurrentFence();
      return { impossible: true };
    });
    const result = await processor(store, registry).processWakeup({ tenantId: TENANT_ID });
    expect(result).toEqual({ kind: "FENCE_LOST", jobId: job.id });
    expect(store.get(job.id)?.status).not.toBe("SUCCEEDED");
  });

  it("retries explicitly retryable handler failures", async () => {
    const store = new InMemoryJobStore();
    const job = await store.enqueue({
      tenantId: TENANT_ID,
      jobType: "evaluate_policy",
      idempotencyKey: "policy:retry",
      payload: {},
    });
    const registry = new JobHandlerRegistry().register("evaluate_policy", async () => {
      throw new WorkerRuntimeError("TEMPORARY_POLICY_BACKEND", "temporarily unavailable", {
        retryable: true,
      });
    });
    const result = await processor(store, registry).processWakeup({ tenantId: TENANT_ID });
    expect(result).toEqual({ kind: "RETRY_SCHEDULED", jobId: job.id });
    expect(store.get(job.id)?.status).toBe("FAILED");
  });
});

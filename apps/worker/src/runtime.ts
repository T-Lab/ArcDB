import type { ArcDBMetrics } from "@arcdb/observability";
import { type Job, Worker } from "bullmq";
import type { WorkerConfig } from "./config.js";
import type { DurableJobStore, QueueHealthSnapshot, QueueWakeup } from "./job-store.js";
import type { JobLogger } from "./job-types.js";
import { BullMqNotifier, QueueWakeupSchema, redisConnection } from "./notification.js";
import { DurableJobProcessor, type ProcessWakeupResult } from "./processor.js";
import type { JobHandlerRegistry } from "./registry.js";
import { ObservabilityWorkerTelemetry } from "./telemetry.js";

export interface WorkerReadiness {
  readonly status: "ready" | "not_ready";
  readonly database: boolean;
  readonly redis: boolean;
  readonly queue: QueueHealthSnapshot;
  readonly notificationQueue: {
    readonly waiting: number;
    readonly active: number;
    readonly delayed: number;
    readonly failed: number;
  };
  readonly lastHeartbeatAt?: string;
  readonly heartbeatAgeMs?: number;
  readonly activeJobs: number;
  readonly bullMqStalledSinceStart: number;
  readonly lastBullMqStalledAt?: string;
}

type DurableQueueHealthResult =
  | { readonly ok: true; readonly queue: QueueHealthSnapshot }
  | { readonly ok: false; readonly queue: null };

async function within<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class WorkerServiceRuntime {
  readonly #config: WorkerConfig;
  readonly #store: DurableJobStore;
  readonly #logger: JobLogger;
  readonly #metrics: ArcDBMetrics;
  readonly #notifier: BullMqNotifier;
  readonly #processor: DurableJobProcessor;
  readonly #worker: Worker<QueueWakeup, ProcessWakeupResult, "durable-job-wakeup">;
  #pollTimer: NodeJS.Timeout | undefined;
  #tickRunning = false;
  #started = false;
  #runPromise: Promise<void> | undefined;
  #bullMqStalledSinceStart = 0;
  #lastBullMqStalledAt: Date | undefined;

  public constructor(options: {
    readonly config: WorkerConfig;
    readonly store: DurableJobStore;
    readonly registry: JobHandlerRegistry;
    readonly logger: JobLogger;
    readonly metrics: ArcDBMetrics;
    readonly workerId: string;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#metrics = options.metrics;
    const telemetry = new ObservabilityWorkerTelemetry(options.metrics);
    this.#notifier = new BullMqNotifier({
      queueName: options.config.ARCDB_WORKER_QUEUE,
      redisUrl: options.config.ARCDB_REDIS_URL,
      logger: options.logger,
    });
    this.#processor = new DurableJobProcessor({
      workerId: options.workerId,
      store: options.store,
      registry: options.registry,
      logger: options.logger,
      notifier: this.#notifier,
      telemetry,
      leaseMs: options.config.ARCDB_WORKER_LEASE_MS,
      heartbeatMs: options.config.ARCDB_WORKER_HEARTBEAT_MS,
    });
    this.#worker = new Worker<QueueWakeup, ProcessWakeupResult, "durable-job-wakeup">(
      options.config.ARCDB_WORKER_QUEUE,
      async (notification: Job<QueueWakeup, ProcessWakeupResult, "durable-job-wakeup">) => {
        const validated = QueueWakeupSchema.parse(notification.data);
        const wakeup: QueueWakeup = {
          tenantId: validated.tenantId,
          ...(validated.hintedJobId === undefined ? {} : { hintedJobId: validated.hintedJobId }),
        };
        return this.#processor.processWakeup(wakeup);
      },
      {
        connection: redisConnection(options.config.ARCDB_REDIS_URL),
        prefix: "arcdb",
        name: options.workerId,
        autorun: false,
        concurrency: options.config.ARCDB_WORKER_CONCURRENCY,
        lockDuration: options.config.ARCDB_WORKER_LEASE_MS,
        maxStalledCount: 1,
        stalledInterval: Math.max(1_000, options.config.ARCDB_WORKER_HEARTBEAT_MS),
        removeOnComplete: { age: 60 * 60, count: 1_000 },
        removeOnFail: { age: 24 * 60 * 60, count: 1_000 },
      },
    );
    this.#worker.on("error", (error) => {
      this.#logger.error({ err: error }, "BullMQ worker error");
    });
    this.#worker.on("failed", (job, error) => {
      this.#logger.error(
        { err: error, notificationId: job?.id },
        "BullMQ notification processing failed",
      );
    });
    this.#worker.on("stalled", (notificationId) => {
      this.#bullMqStalledSinceStart += 1;
      this.#lastBullMqStalledAt = new Date();
      this.#logger.warn({ notificationId }, "BullMQ notification stalled");
    });
  }

  public async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#processor.heartbeatNow();
    this.#runPromise = this.#worker.run();
    this.#runPromise.catch((error: unknown) => {
      if (this.#started) this.#logger.error({ err: error }, "BullMQ worker loop stopped");
    });
    await this.#worker.waitUntilReady();
    await this.#tick();
    this.#pollTimer = setInterval(() => void this.#tick(), this.#config.ARCDB_WORKER_POLL_MS);
    this.#pollTimer.unref();
  }

  async #tick(): Promise<void> {
    if (this.#tickRunning || !this.#started) return;
    this.#tickRunning = true;
    this.#processor.heartbeatNow();
    try {
      const recovered = await this.#store.recoverStalled(this.#config.ARCDB_WORKER_POLL_BATCH);
      const runnable = await this.#store.listRunnableWakeups(this.#config.ARCDB_WORKER_POLL_BATCH);
      const wakeups = [...recovered, ...runnable];
      await Promise.all(wakeups.map((wakeup) => this.#notifier.notify(wakeup)));
      const queue = await this.#store.health();
      this.#metrics.jobQueueLagSeconds.set(
        { service: "worker", job_type: "all" },
        queue.oldestRunnableLagSeconds,
      );
    } catch (error) {
      this.#logger.error({ err: error }, "durable queue sweep failed");
    } finally {
      this.#tickRunning = false;
    }
  }

  public async readiness(): Promise<WorkerReadiness> {
    const [database, notificationHealth, queueResult] = await Promise.all([
      within(this.#store.databaseHealth(), 2_000, false),
      this.#notifier.health(),
      within<DurableQueueHealthResult>(
        this.#store.health().then((queue): DurableQueueHealthResult => ({ ok: true, queue })),
        2_000,
        { ok: false, queue: null },
      ),
    ]);
    const queue = queueResult.queue ?? {
      pending: 0,
      running: 0,
      failed: 0,
      deadLetter: 0,
      stalled: 0,
      runnable: 0,
      oldestRunnableLagSeconds: 0,
    };
    const processor = this.#processor.snapshot();
    const heartbeatAgeMs =
      processor.lastHeartbeatAt === undefined
        ? undefined
        : Math.max(0, Date.now() - Date.parse(processor.lastHeartbeatAt));
    const heartbeatFresh =
      heartbeatAgeMs !== undefined &&
      heartbeatAgeMs <= this.#config.ARCDB_WORKER_READY_MAX_HEARTBEAT_AGE_MS;
    const ready =
      this.#started &&
      database &&
      notificationHealth.ready &&
      queueResult.ok &&
      heartbeatFresh &&
      queue.stalled <= this.#config.ARCDB_WORKER_READY_MAX_STALLED;
    return {
      status: ready ? "ready" : "not_ready",
      database,
      redis: notificationHealth.ready,
      queue,
      notificationQueue: {
        waiting: notificationHealth.waiting,
        active: notificationHealth.active,
        delayed: notificationHealth.delayed,
        failed: notificationHealth.failed,
      },
      ...(processor.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: processor.lastHeartbeatAt }),
      ...(heartbeatAgeMs === undefined ? {} : { heartbeatAgeMs }),
      activeJobs: processor.activeJobs,
      bullMqStalledSinceStart: this.#bullMqStalledSinceStart,
      ...(this.#lastBullMqStalledAt === undefined
        ? {}
        : { lastBullMqStalledAt: this.#lastBullMqStalledAt.toISOString() }),
    };
  }

  public async close(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    if (this.#pollTimer !== undefined) clearInterval(this.#pollTimer);
    await this.#worker.close(false);
    await this.#runPromise?.catch(() => undefined);
    await this.#notifier.close();
  }
}

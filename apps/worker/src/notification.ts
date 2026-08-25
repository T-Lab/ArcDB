import { type ConnectionOptions, Queue } from "bullmq";
import { z } from "zod";
import type { QueueWakeup } from "./job-store.js";
import type { JobLogger } from "./job-types.js";
import type { RetryNotifier } from "./processor.js";

export const QueueWakeupSchema = z
  .object({
    tenantId: z.string().uuid(),
    hintedJobId: z.string().uuid().optional(),
  })
  .strict();

export interface NotificationQueueHealth {
  readonly ready: boolean;
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly error?: string;
}

export function redisConnection(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
  };
}

export class BullMqNotifier implements RetryNotifier {
  readonly #queue: Queue<QueueWakeup, unknown, "durable-job-wakeup">;
  readonly #logger: JobLogger;

  public constructor(options: {
    readonly queueName: string;
    readonly redisUrl: string;
    readonly logger: JobLogger;
  }) {
    this.#logger = options.logger;
    this.#queue = new Queue<QueueWakeup, unknown, "durable-job-wakeup">(options.queueName, {
      connection: redisConnection(options.redisUrl),
      prefix: "arcdb",
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 1_000 },
      },
    });
    this.#queue.on("error", (error) => {
      this.#logger.error({ err: error }, "BullMQ notification queue error");
    });
  }

  public async notify(wakeup: QueueWakeup, delayMs = 0): Promise<void> {
    const validated = QueueWakeupSchema.parse(wakeup);
    const parsed: QueueWakeup = {
      tenantId: validated.tenantId,
      ...(validated.hintedJobId === undefined ? {} : { hintedJobId: validated.hintedJobId }),
    };
    await this.#queue.add("durable-job-wakeup", parsed, {
      delay: Math.max(0, Math.round(delayMs)),
    });
  }

  public async health(timeoutMs = 2_000): Promise<NotificationQueueHealth> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const counts = await Promise.race([
        this.#queue.getJobCounts("wait", "active", "delayed", "failed"),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Redis health check timed out")), timeoutMs);
          timer.unref();
        }),
      ]);
      return {
        ready: true,
        waiting: counts.wait ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    } catch (error) {
      return {
        ready: false,
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        error: error instanceof Error ? error.message : "Redis health check failed",
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  public close(): Promise<void> {
    return this.#queue.close();
  }
}

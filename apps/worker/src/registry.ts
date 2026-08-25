import type { JobType } from "@arcdb/db";
import { MissingJobHandlerError } from "./errors.js";
import { JOB_TYPES, type JobHandler } from "./job-types.js";

export class JobHandlerRegistry {
  readonly #handlers = new Map<JobType, JobHandler>();

  public register(jobType: JobType, handler: JobHandler): this {
    if (this.#handlers.has(jobType)) {
      throw new TypeError(`A handler is already registered for ${jobType}`);
    }
    this.#handlers.set(jobType, handler);
    return this;
  }

  public resolve(jobType: JobType): JobHandler {
    const handler = this.#handlers.get(jobType);
    if (handler === undefined) {
      throw new MissingJobHandlerError(jobType);
    }
    return handler;
  }

  public has(jobType: JobType): boolean {
    return this.#handlers.has(jobType);
  }

  /** Every guideline job type is represented, even when deliberately unconfigured. */
  public coverage(): Readonly<Record<JobType, "CONFIGURED" | "DEAD_LETTER_IF_RECEIVED">> {
    return Object.fromEntries(
      JOB_TYPES.map((jobType) => [
        jobType,
        this.#handlers.has(jobType) ? "CONFIGURED" : "DEAD_LETTER_IF_RECEIVED",
      ]),
    ) as Record<JobType, "CONFIGURED" | "DEAD_LETTER_IF_RECEIVED">;
  }
}

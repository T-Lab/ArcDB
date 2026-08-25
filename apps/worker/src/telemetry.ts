import type { JobType } from "@arcdb/db";
import type { ArcDBMetrics } from "@arcdb/observability";

export interface WorkerTelemetry {
  transition(jobType: JobType, from: string, to: string): void;
  start(jobType: JobType): (outcome: string) => void;
  error(code: string): void;
  queueLag(seconds: number): void;
  reconciliation(connector: string, outcome: string): void;
}

export class ObservabilityWorkerTelemetry implements WorkerTelemetry {
  readonly #metrics: ArcDBMetrics;

  public constructor(metrics: ArcDBMetrics) {
    this.#metrics = metrics;
  }

  public transition(jobType: JobType, from: string, to: string): void {
    this.#metrics.observeJobTransition(jobType, from, to);
  }

  public start(jobType: JobType): (outcome: string) => void {
    return this.#metrics.startJob(jobType);
  }

  public error(code: string): void {
    this.#metrics.errorsTotal.inc({ service: "worker", component: "job", code });
  }

  public queueLag(seconds: number): void {
    this.#metrics.jobQueueLagSeconds.set(
      { service: "worker", job_type: "all" },
      Math.max(0, seconds),
    );
  }

  public reconciliation(connector: string, outcome: string): void {
    this.#metrics.effectReconciliationsTotal.inc({
      service: "worker",
      connector,
      outcome,
    });
  }
}

export const NOOP_WORKER_TELEMETRY: WorkerTelemetry = Object.freeze({
  transition: () => undefined,
  start: () => () => undefined,
  error: () => undefined,
  queueLag: () => undefined,
  reconciliation: () => undefined,
});

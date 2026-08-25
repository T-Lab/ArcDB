import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const JOB_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 300, 900];

export interface CreateMetricsOptions {
  readonly service: string;
  readonly registry?: Registry;
  readonly collectDefault?: boolean;
}

export class ArcDBMetrics {
  public readonly registry: Registry;
  public readonly httpRequestsTotal: Counter<"service" | "method" | "route" | "status_code">;
  public readonly httpRequestDurationSeconds: Histogram<
    "service" | "method" | "route" | "status_code"
  >;
  public readonly ingestionItemsTotal: Counter<"service" | "kind" | "outcome">;
  public readonly ingestionBatchSize: Histogram<"service" | "kind">;
  public readonly errorsTotal: Counter<"service" | "component" | "code">;
  public readonly jobTransitionsTotal: Counter<
    "service" | "job_type" | "from_status" | "to_status"
  >;
  public readonly jobDurationSeconds: Histogram<"service" | "job_type" | "outcome">;
  public readonly jobQueueLagSeconds: Gauge<"service" | "job_type">;
  public readonly jobsInFlight: Gauge<"service" | "job_type">;
  public readonly lifecycleTransitionsTotal: Counter<
    "service" | "aggregate_type" | "from_state" | "to_state"
  >;
  public readonly effectReconciliationsTotal: Counter<"service" | "connector" | "outcome">;
  public readonly artifactBytesTotal: Counter<"service" | "operation" | "outcome">;
  public readonly databaseQueryDurationSeconds: Histogram<"service" | "operation" | "outcome">;
  readonly #service: string;

  public constructor(options: CreateMetricsOptions) {
    this.#service = options.service;
    this.registry = options.registry ?? new Registry();
    this.registry.setDefaultLabels({ service: options.service });
    if (options.collectDefault === true) {
      collectDefaultMetrics({ register: this.registry, prefix: "arcdb_" });
    }
    this.httpRequestsTotal = new Counter({
      name: "arcdb_http_requests_total",
      help: "HTTP requests handled by ArcDB.",
      labelNames: ["service", "method", "route", "status_code"],
      registers: [this.registry],
    });
    this.httpRequestDurationSeconds = new Histogram({
      name: "arcdb_http_request_duration_seconds",
      help: "HTTP request latency in seconds.",
      labelNames: ["service", "method", "route", "status_code"],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.ingestionItemsTotal = new Counter({
      name: "arcdb_ingestion_items_total",
      help: "Ingestion items accepted or rejected.",
      labelNames: ["service", "kind", "outcome"],
      registers: [this.registry],
    });
    this.ingestionBatchSize = new Histogram({
      name: "arcdb_ingestion_batch_size",
      help: "Number of records in an ingestion batch.",
      labelNames: ["service", "kind"],
      buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1_000],
      registers: [this.registry],
    });
    this.errorsTotal = new Counter({
      name: "arcdb_errors_total",
      help: "Errors grouped by component and stable error code.",
      labelNames: ["service", "component", "code"],
      registers: [this.registry],
    });
    this.jobTransitionsTotal = new Counter({
      name: "arcdb_job_transitions_total",
      help: "Durable background job state transitions.",
      labelNames: ["service", "job_type", "from_status", "to_status"],
      registers: [this.registry],
    });
    this.jobDurationSeconds = new Histogram({
      name: "arcdb_job_duration_seconds",
      help: "Background job execution time.",
      labelNames: ["service", "job_type", "outcome"],
      buckets: JOB_DURATION_BUCKETS,
      registers: [this.registry],
    });
    this.jobQueueLagSeconds = new Gauge({
      name: "arcdb_job_queue_lag_seconds",
      help: "Age of the oldest runnable job.",
      labelNames: ["service", "job_type"],
      registers: [this.registry],
    });
    this.jobsInFlight = new Gauge({
      name: "arcdb_jobs_in_flight",
      help: "Jobs currently leased to workers.",
      labelNames: ["service", "job_type"],
      registers: [this.registry],
    });
    this.lifecycleTransitionsTotal = new Counter({
      name: "arcdb_lifecycle_transitions_total",
      help: "Output and effect lifecycle transitions.",
      labelNames: ["service", "aggregate_type", "from_state", "to_state"],
      registers: [this.registry],
    });
    this.effectReconciliationsTotal = new Counter({
      name: "arcdb_effect_reconciliations_total",
      help: "External effect reconciliation outcomes.",
      labelNames: ["service", "connector", "outcome"],
      registers: [this.registry],
    });
    this.artifactBytesTotal = new Counter({
      name: "arcdb_artifact_bytes_total",
      help: "Bytes read from and written to ArcStore.",
      labelNames: ["service", "operation", "outcome"],
      registers: [this.registry],
    });
    this.databaseQueryDurationSeconds = new Histogram({
      name: "arcdb_database_query_duration_seconds",
      help: "Database operation latency in seconds.",
      labelNames: ["service", "operation", "outcome"],
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });
  }

  public observeJobTransition(jobType: string, fromStatus: string, toStatus: string): void {
    this.jobTransitionsTotal.inc({
      service: this.#service,
      job_type: jobType,
      from_status: fromStatus,
      to_status: toStatus,
    });
  }

  public startJob(jobType: string): (outcome: string) => void {
    const start = process.hrtime.bigint();
    this.jobsInFlight.inc({ service: this.#service, job_type: jobType });
    return (outcome: string): void => {
      const seconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
      this.jobsInFlight.dec({ service: this.#service, job_type: jobType });
      this.jobDurationSeconds.observe(
        { service: this.#service, job_type: jobType, outcome },
        seconds,
      );
    };
  }

  public observeHttp(input: {
    readonly method: string;
    readonly route: string;
    readonly statusCode: number;
    readonly durationSeconds: number;
  }): void {
    const labels = {
      service: this.#service,
      method: input.method,
      route: input.route,
      status_code: String(input.statusCode),
    };
    this.httpRequestsTotal.inc(labels);
    this.httpRequestDurationSeconds.observe(labels, input.durationSeconds);
  }

  public async render(): Promise<{ readonly contentType: string; readonly body: string }> {
    return {
      contentType: this.registry.contentType,
      body: await this.registry.metrics(),
    };
  }
}

export function createMetrics(options: CreateMetricsOptions): ArcDBMetrics {
  return new ArcDBMetrics(options);
}

export async function metricsHandler(metrics: ArcDBMetrics): Promise<{
  readonly contentType: string;
  readonly body: string;
}> {
  return metrics.render();
}

# `@arcdb/observability`

Internal operational telemetry shared by ArcDB services.

- `createLogger` emits structured Pino JSON and redacts credentials, cookies,
  connector arguments, and other known secret fields.
- `withLogContext` propagates request, tenant, trace, and job identifiers through
  asynchronous work.
- `createMetrics` creates an isolated Prometheus registry with HTTP, ingestion,
  queue lag, job transition, lifecycle transition, effect reconciliation,
  artifact, error, and database latency metrics.

Keep metric labels bounded. IDs such as tenant, request, trace, and job IDs belong
in logs and traces, never Prometheus labels.

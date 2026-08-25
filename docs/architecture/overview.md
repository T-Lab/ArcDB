# Architecture overview

ArcDB is an agent data plane. It accepts telemetry and artifact versions, evaluates evidence, moves
outputs through an explicit lifecycle, and records the external consequences those outputs cause.

```text
SDK / agent / OTLP client
            |
            v
       Fastify API  -----> OpenAPI + Prometheus metrics
            |
            +---- PostgreSQL: lifecycle truth, tenant catalog, lineage, outbox
            |
            +---- S3 / MinIO: content-addressed artifact bytes and manifests
            |
            `---- Redis / BullMQ: retryable work notification
                            |
                            v
                         Worker
                    effect recovery
                  reconcile / compensate

       Next.js console reads the same authenticated public API
```

PostgreSQL is the ArcDB-PG correctness source. Redis may be rebuilt from durable jobs. Object storage
holds immutable bytes addressed by a SHA-256 digest. A future analytical or native service is a
projection until it passes differential tests against ArcDB-PG.

The durable contract names verifier, impact, dataset, compaction, and remediation jobs, but the v0.1
worker runtime intentionally registers only effect reconciliation and compensation handlers.
Unsupported job types fail visibly into the dead-letter state; they are roadmap interfaces, not
running background implementations.

## Request boundary

Every public input is parsed by a shared Zod contract. Authentication resolves an API key to an
organization, optional project, role, and scopes. The service layer applies lifecycle rules. A
tenant-scoped repository transaction writes business records, lifecycle events, audit records, and
durable jobs. Handlers translate typed domain errors into stable HTTP error codes.

## Lifecycle boundary

Output bytes and a version ID become immutable at commit. A mutable logical head is protected with a
compare-and-swap. Evidence is scoped to exact versions of the subject, verifier, dependencies,
environment, and policy. External effects follow prepare → execute → receipt, with reconciliation for
unknown outcomes. Invalidation changes ArcDB's view of validity but never rewrites external reality.

See the ADRs in `docs/decisions/` for the choices and tradeoffs behind each boundary.

# Langfuse comparison and release scope

ArcDB v0.1 aims for comparable **product discipline** on its supported vertical slice, not feature
parity with Langfuse. Langfuse is a mature LLM engineering platform with observability, prompt
management, evaluation, datasets, experiments, and a broad integration ecosystem. ArcDB's distinct
scope is the lifecycle of durable agent outputs and their external consequences.

The comparison baseline was checked against Langfuse's official
[core feature overview](https://github.com/langfuse/langfuse#-core-features),
[observability SDK guide](https://langfuse.com/docs/observability/sdk/overview), and
[self-hosting architecture](https://langfuse.com/handbook/product-engineering/architecture) on
2026-08-25.

## Implemented in ArcDB v0.1

| Product foundation | ArcDB evidence |
| --- | --- |
| Authenticated multi-project API | hashed API keys, RBAC scopes, PostgreSQL FORCE RLS |
| Tracing | run/trace/span/score ingestion, OTLP/HTTP JSON adapter, explorer and timeline |
| Typed SDK | Node.js SDK with context, retries, idempotency, typed errors and offline buffer |
| Operational UI | dashboard, traces, outputs, lineage impact, effects/receipts and audit views |
| Self-hosting | pinned Compose topology for API, worker, web, PostgreSQL, Redis and MinIO |
| Operability | readiness/liveness, Prometheus metrics, structured redacted logs and backup guides |
| Reliability | PostgreSQL-owned jobs, BullMQ notifications, fencing, bounded retries and dead letters |

ArcDB additionally implements immutable Output versions, Evidence freshness, policy-gated head
promotion, selector-aware lineage invalidation, EffectIntent/Receipt crash recovery, and explicit
remediation obligations. Those are ArcDB features and should not be described as Langfuse features.

## Explicitly not at parity

ArcDB v0.1 does not yet include Langfuse's prompt-management product, dataset/experiment product,
hosted service, SSO/SCIM, Python and framework SDK ecosystem, ClickHouse-scale analytics, or years of
production hardening. ArcKernel/DLI native storage is also roadmap work. The UI labels unsupported
configuration surfaces unavailable instead of presenting inert controls.

OTLP support is limited to authenticated OTLP/HTTP JSON trace payloads. Protobuf and gRPC are not
accepted. The default `manual-receipt` connector performs no external write; automatic connectors
must be separately implemented, allowlisted, capability-checked, fenced, and recovery-tested.

## Release gate

A release is credible only when the checked-in lockfile installs reproducibly and format, lint,
strict type checking, unit/contract/integration/fault tests, production builds, Compose validation,
and the SQL Change Agent workflow all pass. If an environment cannot run one of these gates, the
release notes must say which gate was not executed rather than treating it as passed.

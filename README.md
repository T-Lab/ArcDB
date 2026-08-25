# ArcDB

[![CI](https://github.com/T-Lab/ArcDB/actions/workflows/ci.yml/badge.svg)](https://github.com/T-Lab/ArcDB/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

**The output lifecycle database for autonomous agents.**

ArcDB manages what agents create, how those outputs are verified, who consumes them, and what they
cause. It complements tracing systems with durable, typed records for versioned artifacts, evidence,
lineage, external effects, immutable receipts, invalidation, and remediation.

```text
Agent run -> Output v2 -> Evidence -> Policy promotion -> Effect intent -> Receipt
                ^                                               |
                `---- correction -> selective invalidation -----+
                                      recompute / remediate
```

ArcDB is an **agent data plane**, not a chain-of-thought store, inference server, workflow engine, or
claim of global transactions over arbitrary APIs.

## What is implemented

This repository starts with the ArcDB-PG reference path: PostgreSQL holds lifecycle truth, MinIO holds
content-addressed artifacts, Redis/BullMQ carries durable-work notifications, Fastify exposes a typed
API and OpenAPI document, and Next.js provides the operational console.

The first release covers:

- organizations, projects, RBAC-scoped and hashed API keys;
- run, trace, span, session, and score ingestion;
- immutable output versions and logical-head compare-and-swap;
- evidence fingerprints, expiry, and policy-gated promotion;
- typed lineage, selector-aware impact, invalidation, and recomputation plans;
- prepared external effects, append-only receipts, reconciliation, and remediation obligations;
- TypeScript SDK retries, idempotency, context propagation, and transient-failure buffering;
- real-data dashboard, trace timeline, output/evidence, lineage, effect/receipt, and audit views;
- Compose development stack, migrations, seed data, SQL Change Agent demo, CI, and layered tests.

See [first-release scope](docs/decisions/0006-first-release-scope.md) for explicit boundaries. The Rust
ArcKernel, compressed Delta-Lineage Index, ClickHouse analytics projection, Python SDK, Helm/Terraform,
and broad connector catalog remain roadmap work; they are not hidden mocks in this repository.
The [Langfuse comparison](docs/compatibility/langfuse.md) records what “comparable” does and does not
mean for this release.

## Quick start

You need Docker with Compose, Node.js 22+, and Corepack.

```bash
git clone https://github.com/T-Lab/ArcDB.git
cd ArcDB
corepack enable
cp .env.example .env
pnpm install
docker compose up -d --build --wait
pnpm demo:sql-agent
```

The Compose `migrate` service applies checksum-verified migrations and seeds the deterministic local
project before API startup. The root scripts load `.env` with Node's built-in environment-file
support. `pnpm db:migrate` and `pnpm db:seed` prefer `ARCDB_ADMIN_DATABASE_URL`; API, worker, and demo
tenant traffic uses the constrained `ARCDB_DATABASE_URL` role, while narrowly scoped authentication
and worker control-plane operations use the separate `ARCDB_SYSTEM_DATABASE_URL` role.

Open:

- Web console: <http://localhost:3000> (`arcdb` / `arcdb_console_local_only` for the local-only
  Basic Auth prompt)
- API documentation: <http://localhost:4000/docs>
- API readiness: <http://localhost:4000/health/ready>
- MinIO console: <http://localhost:9001>

Compose binds published ports to `127.0.0.1` by default. The committed credentials in `.env.example`
are local-only placeholders; rotate all of them before changing that binding or deploying ArcDB.
Production guidance is in [hardening](docs/operations/hardening.md).

## Use the SDK

```ts
import { ArcDB } from "@arcdb/sdk";

const arc = new ArcDB({
  baseUrl: "http://localhost:4000",
  apiKey: process.env.ARCDB_API_KEY!,
  projectId: process.env.ARCDB_PROJECT_ID!,
});

await arc.withRun({ name: "schema-change-agent" }, async (run) => {
  const output = await run.createOutput({
    logicalId: "sql/customer-status-index",
    outputType: "sql",
    content: "CREATE INDEX CONCURRENTLY ...",
    metadata: { repository: "billing" },
  });

  await arc.addEvidence(output.versionId, {
    verifierType: "shadow-sql",
    verifierVersion: "1.0.0",
    verdict: "PASS",
    metrics: { migrationApplied: true, lockSeconds: 0.03 },
  });

  await arc.promoteOutput(output.versionId, {
    expectedHeadVersionId: null,
    requiredVerifierTypes: ["shadow-sql"],
  });
});
```

Run `pnpm demo:sql-agent` for Output → Evidence → promotion → lineage → Effect preparation. The
default connector intentionally performs no external write; the example's documented `inspect`,
`receipt`, and `invalidate` commands complete the operator-controlled recovery flow.

## Why receipts are different from logs

An external write can succeed immediately before the worker crashes. ArcDB therefore persists an
effect intent before execution and an immutable receipt afterward. If the connector can look up an
idempotency key, a worker reconciles the outcome. Otherwise ArcDB exposes
`RECONCILIATION_REQUIRED`—it does not silently retry an unknown payment, email, deployment, or public
post.

Likewise, invalidating an upstream output never claims to undo external reality. It preserves the
receipt and creates compensation or human remediation work according to risk and reversibility.

## Repository map

```text
apps/api             authenticated HTTP API and lifecycle boundary
apps/worker          durable jobs, effect execution, reconciliation
apps/web             Next.js operations console
packages/contracts   Zod schemas and stable error contracts
packages/db          migrations, tenant-safe repositories, outbox
packages/lifecycle   OLT state machine and evidence policy
packages/lineage     impact and selective invalidation algorithms
packages/artifacts   content-addressed S3/MinIO abstraction
packages/auth        API-key hashing and RBAC
packages/sdk-typescript
examples/sql-change-agent
docs                 concepts, ADRs, API and operations guides
```

Read the [architecture overview](docs/architecture/overview.md), [lifecycle concepts](docs/concepts/lifecycle.md),
and [API quickstart](docs/api/quickstart.md) next.

## Development and verification

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

PostgreSQL/Redis integration tests activate when their service URLs are present. Artifact tests cover
the S3 command boundary deterministically, while the Compose stack supplies the real MinIO path.
Browser tests exercise desktop and mobile console flows against a contract-faithful local API server;
HTTP contract tests separately cover the production Fastify routes. See
[CONTRIBUTING.md](CONTRIBUTING.md) before changing a public contract or migration.

## Design principles

- Correct lifecycle semantics before storage novelty.
- Immutable versions and receipts; mutable heads use compare-and-swap.
- Evidence is fresh only for the exact subject, dependencies, verifier, environment, and policy.
- Connector capabilities bound the guarantee ArcDB can honestly provide.
- Tenant and project scope are mandatory at API, repository, and database boundaries.
- Unknown dependencies degrade to conservative invalidation; temporal order is not causality.
- PostgreSQL is the reference oracle until a benchmark justifies ArcDB-Native.

## License

ArcDB is licensed under the [Apache License 2.0](LICENSE).

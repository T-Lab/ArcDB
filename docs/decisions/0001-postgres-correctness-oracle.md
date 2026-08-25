# ADR 0001: PostgreSQL is the initial correctness source

- Status: accepted
- Date: 2026-08-25

## Context

ArcDB needs transactional lifecycle updates, immutable history, tenant isolation, and useful query
behavior before a native engine can be justified. Building a WAL, consensus layer, or SQL parser first
would delay validation of the product semantics.

## Decision

ArcDB-PG stores control-plane and lifecycle truth in PostgreSQL. Artifact bytes live behind the
`ArtifactStore` interface in S3-compatible storage. Redis carries retryable work and ephemeral
coordination only; losing Redis must not erase ArcDB truth. Analytics mirrors are projections and
must be rebuildable.

All multi-record lifecycle changes use database transactions. Migrations are ordered, immutable
files. Repository methods require an organization and project scope, while PostgreSQL row-level
security provides defense in depth.

## Consequences

This gives us a reference implementation against which future ArcKernel behavior can be tested. A
native engine is deferred until ArcBench identifies a measured workload that PostgreSQL and object
storage cannot meet.

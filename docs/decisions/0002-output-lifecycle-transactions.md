# ADR 0002: Lifecycle changes use an explicit OLT state machine

- Status: accepted
- Date: 2026-08-25

## Context

An output, its evidence, logical head, lineage, effect preparation, lifecycle event, and audit record
may need to change together. Treating these as unrelated CRUD records makes partial promotion and
unexplained state changes likely.

## Decision

The lifecycle package owns an explicit transition graph. The API may request a transition but cannot
invent one. Promotion verifies fresh policy evidence and performs the head compare-and-swap in the
same PostgreSQL transaction that writes lifecycle and audit events. Committed content, version IDs,
and receipts are immutable.

Concurrent branches coexist. Exactly one candidate can replace a given expected head; other
candidates receive the typed `HEAD_CONFLICT` error and remain inspectable.

## Consequences

State transitions are testable without infrastructure and auditable with infrastructure. Some
apparently convenient updates require creating a new output version, which is intentional.

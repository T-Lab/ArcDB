# ADR 0004: External effects use prepare, execute, and reconcile

- Status: accepted
- Date: 2026-08-25

## Context

No database transaction can atomically commit with every external API. A process may fail after an
external write succeeds but before ArcDB persists its receipt.

## Decision

ArcDB first persists an `EffectIntent`, idempotency key, connector capabilities, and fencing token.
Only after that transaction commits may a worker call the connector. Receipts are append-only.
Unknown outcomes are never blindly retried: connectors that support lookup are reconciled by
idempotency key; otherwise the intent becomes `RECONCILIATION_REQUIRED`.

Invalidating source data never deletes a receipt. Reversible effects can create compensation work;
committed irreversible effects create a remediation obligation and require human approval.

## Consequences

Guarantees vary with connector capabilities and ArcDB exposes that limitation. Callers get explicit
unknown and remediation states rather than a misleading all-or-nothing claim.

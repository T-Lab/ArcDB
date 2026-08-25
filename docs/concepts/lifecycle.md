# Output lifecycle

An output is a versioned artifact identified by a stable `logicalId` and immutable `versionId`.
Branches can contain competing versions. Promotion moves one verified version to the logical head
only when the caller's `expectedHeadVersionId` still matches.

```text
CREATED -> STAGED -> VERIFIED -> APPROVED -> COMMITTED -> PROMOTED
                |         |                         |
                v         v                         v
             REJECTED   STALE                  CONSUMED
                            \
                             -> INVALIDATED -> recompute / remediate
```

Lifecycle events are append-only and include actor, request, previous state, next state, and reason.
Changing committed content requires a new version.

## Evidence and policy

Evidence answers why one exact output version was accepted, rejected, or uncertain. Freshness checks
bind it to dependency digests, verifier and environment versions, policy version, and expiry. A
promotion policy declares which verifier results are required; stale evidence never satisfies it.

## Effects and receipts

An effect intent describes a desired external change, including resource key, idempotency key,
preconditions, risk, and reversibility. The worker executes only a durably prepared intent. Its
receipt records the observed external result and is immutable.

If execution may have succeeded but no receipt exists, ArcDB exposes
`RECONCILIATION_REQUIRED`. It does not blindly retry. Invalidating the source later leaves the receipt
intact and creates a compensation or remediation obligation.

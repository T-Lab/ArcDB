# ADR 0003: Evidence is bound to exact verification inputs

- Status: accepted
- Date: 2026-08-25

## Context

A passing test result is unsafe if the artifact, dependencies, verifier, environment, or policy has
changed since it ran.

## Decision

Evidence fingerprints include the subject version, dependency digests, verifier type and version,
environment digest, and policy version. Promotion evaluates both the verdict and freshness against
the current policy. Expired or mismatched evidence is reported as stale and cannot satisfy a policy.

Evidence is append-only. Reverification creates another record rather than rewriting why an earlier
decision was made.

## Consequences

Policy and environment upgrades can invalidate evidence even when output bytes are unchanged. This
cost is necessary for reproducible promotion decisions.

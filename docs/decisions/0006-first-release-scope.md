# ADR 0006: The first release is a complete vertical slice, not ArcDB-Native

- Status: accepted
- Date: 2026-08-25

## Context

The ArcDB specification contains a staged, year-long roadmap. The initial repository needs to be
useful and honest without presenting placeholders as completed infrastructure.

## Decision

The first release implements the ArcDB-PG lifecycle slice and Langfuse-class engineering foundation:
tenant-aware ingestion, output/evidence promotion, typed lineage impact, prepared effects and
receipts, reconciliation, a TypeScript SDK, a real-data dashboard, local Compose, tests, and
operations documentation.

ArcKernel, DLI compressed postings, ClickHouse projection, the Python SDK, distributed storage,
high-availability orchestration, and broad connector coverage remain explicit roadmap items.

## Consequences

The project can validate its distinct lifecycle model now. “Comparable to Langfuse” means comparable
product discipline and operability for this supported slice, not feature-count parity with years of
upstream development.

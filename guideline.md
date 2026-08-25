# ArcDB Codebase Generation Instruction

## 0. Mission

You are building **ArcDB**, a production-grade Output Lifecycle Database for autonomous agents and multi-agent systems.

ArcDB is not merely an LLM tracing dashboard, a vector database, or an APM log collector. Its purpose is to manage the complete lifecycle of agent-generated outputs:

```text
Agent creates an Output
        -> Output is verified by Evidence
        -> Output is consumed or promoted
        -> Output causes an external Effect
        -> Effect produces an immutable Receipt
        -> Later corrections trigger selective invalidation and remediation
```

The product must have the usability, reliability, developer experience, local development workflow, documentation quality, and operational discipline expected from a mature open-source platform such as Langfuse. However, the core domain model must be ArcDB-specific.

The implementation must be incremental. Build a usable product surface first, then progressively introduce ArcDB-native storage and query optimizations. Do not start by implementing a distributed database from scratch.

---

## 1. Product Definition

### 1.1 One-sentence definition

> ArcDB manages what agents create, how outputs are verified, who consumes them, and what they cause.

### 1.2 ARC meaning

Use the following product interpretation consistently:

- **A - Artifacts**: agent-generated outputs and versioned artifacts.
- **R - Reliability**: evidence, verification, provenance, and freshness.
- **C - Consequences**: external effects, receipts, compensation, and remediation.

### 1.3 Product positioning

ArcDB should be positioned as an **Agent Data Plane** rather than another observability UI.

It should coexist with existing observability tools and ingest OpenTelemetry-style traces, but it must add first-class support for:

- versioned agent outputs;
- structured artifact storage;
- evidence-bound validity;
- typed lineage and dependency tracking;
- selective invalidation and recomputation;
- effect intents and external receipts;
- training-ready dataset views;
- long-lived memory and policy provenance.

### 1.4 Explicit non-goals

Do not implement the following as first-year goals:

- a general-purpose replacement for Git;
- a full Temporal replacement;
- a universal graph database;
- a universal vector database;
- a general LLM inference serving system;
- a new standalone query language with unrelated syntax;
- a claim of global ACID transactions across arbitrary external APIs;
- storage of implicit chain-of-thought as an authoritative database fact;
- fully autonomous policy updates in production without isolation and rollback.

---

## 2. Engineering Strategy

### 2.1 Three implementation tracks

Implement the codebase in three tracks that remain compatible with each other.

#### Track A: Langfuse-level product foundation

This is the first deliverable and must feel like a serious production SaaS / self-hosted product.

- multi-tenant organizations, projects, users, roles, and API keys;
- ingestion API and SDKs;
- runs, traces, spans, generations, tool calls, observations, scores, and sessions;
- dashboard, search, filters, trace detail, timelines, and run comparison;
- prompt / schema / evaluator configuration;
- datasets and dataset versions;
- background workers, retry, dead-letter handling, and observability;
- local Docker Compose development environment;
- complete README, setup instructions, API documentation, and examples.

#### Track B: ArcDB lifecycle semantics

This is the core product differentiation.

- OutputObject;
- EvidenceObject;
- EffectIntent and EffectReceipt;
- typed lineage edges;
- Output Lifecycle Transaction (OLT);
- evidence freshness and policy-gated promotion;
- invalidation and recomputation plans;
- idempotent effect commit and reconciliation;
- remediation obligations for irreversible effects.

#### Track C: ArcDB-native physical engine

This is the long-term database moat.

- ArcStore content-addressed artifact storage;
- copy-on-write versions and manifests;
- type-aware chunking and component selectors;
- Delta-Lineage Index (DLI);
- lifecycle-aware compaction;
- native physical operators for impact analysis and dataset views;
- optional Rust ArcKernel service;
- ClickHouse as an optional analytical mirror, never as the correctness source.

### 2.2 Default implementation priority

Always implement in this order:

1. Correct domain model.
2. Stable API contract.
3. Reference implementation with clear semantics.
4. Tests and failure handling.
5. Production-grade UI and developer experience.
6. Performance optimization.
7. Native storage replacement only when a benchmark demonstrates the need.

Do not optimize an unvalidated workload.

---

## 3. Repository and Monorepo Standard

Use a clean, documented monorepo. The default stack is:

- `pnpm` workspaces;
- Turborepo or an equivalent task runner;
- TypeScript in strict mode for product services and SDKs;
- Next.js for the web application;
- React and a consistent component system;
- Fastify or another explicit HTTP service framework for the API;
- PostgreSQL for the initial control plane and reference metadata store;
- S3-compatible object storage, with MinIO for local development;
- Redis for queues, rate limiting, and ephemeral coordination only;
- ClickHouse as an optional analytics projection;
- Rust for ArcKernel-native storage and high-performance operators when Track C starts;
- OpenAPI for HTTP API contracts;
- Zod or an equivalent runtime schema validator;
- Vitest for TypeScript unit tests;
- Playwright for end-to-end browser tests;
- `cargo test` and property-based tests for Rust components;
- Docker Compose for one-command local startup.

Do not introduce a heavy dependency without documenting why it is needed.

### 3.1 Required directory layout

Create and maintain a structure close to the following:

```text
arcdb/
├── apps/
│   ├── web/                         # Next.js application and dashboard
│   ├── api/                         # Public HTTP API and auth boundary
│   ├── ingestion/                   # High-throughput ingestion service
│   ├── worker/                      # Async jobs, evaluators, compaction, reconciliation
│   └── docs/                        # Developer and API documentation site
├── packages/
│   ├── contracts/                   # Zod / OpenAPI / shared schemas
│   ├── db/                          # PostgreSQL schema, migrations, repositories
│   ├── auth/                        # Auth, RBAC, API keys, tenant checks
│   ├── sdk-typescript/              # TypeScript SDK
│   ├── sdk-python/                 # Python SDK when the API is stable
│   ├── lifecycle/                   # OLT state machine and domain services
│   ├── lineage/                     # Typed edges, impact, invalidation contracts
│   ├── evidence/                    # Verifiers, freshness, policy evaluation
│   ├── consequence/                 # Effect intents, receipts, connectors, remediation
│   ├── artifacts/                   # Output manifests, CAS abstraction, diff interface
│   ├── observability/               # Internal logs, metrics, tracing, audit events
│   ├── ui/                          # Shared UI primitives and design system
│   └── config/                      # Shared lint, TypeScript, test, and build config
├── services/
│   └── arckernel/                   # Rust-native storage engine, introduced incrementally
├── infra/
│   ├── docker/                      # Dockerfiles and local services
│   ├── migrations/                  # Deployment migrations and seed data
│   └── helm/                        # Optional Kubernetes deployment
├── examples/
│   ├── sql-change-agent/
│   ├── coding-agent/
│   └── minimal-sdk/
├── benchmarks/
│   ├── arcbench/
│   ├── baselines/
│   └── workload-generators/
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── fault-injection/
│   └── e2e/
├── docs/
│   ├── architecture/
│   ├── concepts/
│   ├── api/
│   ├── operations/
│   └── decisions/
├── docker-compose.yml
├── .env.example
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── README.md
└── package.json
```

If the repository is initially smaller, preserve these boundaries conceptually. Do not put all logic into one `server.ts` or one database table.

### 3.2 Code quality requirements

The generated code must include:

- strict TypeScript settings;
- no implicit `any`;
- explicit error types at service boundaries;
- schema validation at every external input boundary;
- structured JSON logs;
- request IDs and tenant IDs in logs;
- metrics for ingestion, queue lag, errors, latency, and state transitions;
- database transactions for all multi-record lifecycle transitions;
- migrations rather than ad hoc schema mutation;
- idempotent background jobs;
- retry policies with bounded exponential backoff;
- dead-letter or reconciliation queues;
- unit, integration, contract, and end-to-end tests;
- no secrets committed to the repository;
- no silent swallowing of errors;
- no fake implementations presented as production-ready.

Every non-trivial design decision must be recorded in `docs/decisions/` as a short ADR.

---

## 4. Core Domain Model

### 4.1 OutputObject

An OutputObject represents a versioned artifact produced by an agent, tool, evaluator, or human.

Required fields:

```ts
type OutputObject = {
  id: string;
  tenantId: string;
  projectId: string;
  logicalId: string;
  versionId: string;
  outputType:
    | "text"
    | "json"
    | "markdown"
    | "code_patch"
    | "file_tree"
    | "sql"
    | "tool_plan"
    | "decision"
    | "dataset_record";
  schemaId?: string;
  contentRef: string;
  contentDigest: string;
  producerRunId?: string;
  producerAgentId?: string;
  parentVersionIds: string[];
  policyVersion?: string;
  lifecycleState:
    | "CREATED"
    | "STAGED"
    | "VERIFIED"
    | "APPROVED"
    | "COMMITTED"
    | "CONSUMED"
    | "PROMOTED"
    | "REJECTED"
    | "STALE"
    | "INVALIDATED"
    | "SUPERSEDED";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
```

Rules:

- `versionId` is immutable.
- `logicalId` identifies the conceptual artifact across versions.
- `head` is a mutable pointer protected by compare-and-swap semantics.
- Creating a branch must not overwrite another branch.
- A content digest must be computed from canonical content plus relevant metadata.
- Original bytes must remain recoverable even when canonicalized forms are stored.

### 4.2 EvidenceObject

An EvidenceObject records why an Output is considered valid, invalid, or uncertain.

Required fields:

```ts
type EvidenceObject = {
  id: string;
  tenantId: string;
  subjectVersionId: string;
  verifierType: string;
  verifierVersion: string;
  environmentDigest?: string;
  dependencyDigests: string[];
  policyVersion?: string;
  verdict: "PASS" | "FAIL" | "STALE" | "UNKNOWN";
  confidence?: number;
  metrics: Record<string, number | string | boolean>;
  payloadRef?: string;
  fingerprint: string;
  expiresAt?: string;
  createdAt: string;
};
```

Evidence is scoped to:

- the exact Output version;
- the dependency versions used during verification;
- the verification environment;
- the verifier implementation and version;
- the policy version.

If any of these change, the evidence must be re-evaluated or marked `STALE`.

### 4.3 EffectIntent and EffectReceipt

Never model an external side effect as an ordinary log line.

```ts
type EffectIntent = {
  id: string;
  tenantId: string;
  sourceOutputVersionId: string;
  connectorType: string;
  target: string;
  resourceKey: string;
  argumentsRef: string;
  preconditions: Record<string, unknown>;
  expectedEffects: Record<string, unknown>;
  readSet: string[];
  writeSet: string[];
  baseResourceVersion?: string;
  idempotencyKey: string;
  reversibility: "R0" | "R1" | "R2" | "R3";
  compensationHandler?: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status:
    | "PREPARED"
    | "EXECUTING"
    | "COMMITTED"
    | "FAILED"
    | "COMPENSATION_PENDING"
    | "COMPENSATED"
    | "REMEDIATION_REQUIRED"
    | "IRREVERSIBLE_COMMITTED"
    | "RECONCILIATION_REQUIRED";
  createdAt: string;
};

type EffectReceipt = {
  id: string;
  intentId: string;
  externalTransactionId?: string;
  externalStatus: string;
  beforeDigest?: string;
  afterDigest?: string;
  actualEffects: Record<string, unknown>;
  rawResponseRef?: string;
  compensationStatus?: string;
  committedAt?: string;
  createdAt: string;
};
```

### 4.4 Typed lineage edges

Implement typed edges, not generic `parent_id` columns only.

Required edge types:

- `PRODUCED_BY`
- `DERIVED_FROM`
- `READ_FROM`
- `VERIFIED_BY`
- `CONSUMED_BY`
- `CAUSED`
- `SUPERSEDES`
- `COMPENSATED_BY`
- `REMEDIATED_BY`

Each dependency edge should support:

```ts
type LineageEdge = {
  id: string;
  sourceVersionId: string;
  targetVersionId: string;
  edgeType: string;
  selector?: {
    kind: "json_path" | "file" | "symbol" | "table_column" | "record" | "unknown";
    value: string;
  };
  transferFunction?: string;
  inferred: boolean;
  confidence?: number;
  createdAt: string;
};
```

Temporal order must not automatically be labeled as causality. Inferred edges must carry `inferred: true` and an optional confidence.

---

## 5. Lifecycle and Transaction Semantics

### 5.1 Output Lifecycle Transaction

Implement OLT as a domain service and explicit state machine.

Normal lifecycle:

```text
CREATED -> STAGED -> VERIFIED -> APPROVED -> COMMITTED -> CONSUMED / PROMOTED
```

Exceptional lifecycle:

```text
REJECTED
STALE
INVALIDATED
COMPENSATION_PENDING
COMPENSATED
REMEDIATION_REQUIRED
RECONCILIATION_REQUIRED
```

An OLT may atomically update, when applicable:

- Output metadata;
- lineage edges;
- Evidence records;
- logical head reservation;
- EffectIntent;
- lifecycle event;
- audit record.

### 5.2 Required OLT invariants

Implement and test these invariants:

1. An immutable version cannot be modified after commit.
2. A committed Output must have provenance closure.
3. A policy-gated Output cannot be promoted without required fresh Evidence.
4. The same EffectIntent cannot produce duplicate external effects when the connector supports idempotency.
5. A Receipt is append-only.
6. Invalidating an Output cannot erase a committed Receipt.
7. Every EffectIntent eventually reaches a known terminal state or `RECONCILIATION_REQUIRED`.
8. A stale worker cannot commit after losing its fencing token.

### 5.3 Invalidation semantics

Separate Output validity from external reality.

When an upstream Output becomes invalid:

- mark the Output and affected Evidence as stale or invalid;
- compute affected downstream Outputs using lineage;
- mark affected derived Outputs as `STALE` or `INVALIDATED`;
- create a recomputation plan;
- preserve all historical EffectReceipts;
- create a `RemediationObligation` for already committed Effects;
- require human approval for high-risk or irreversible remediation.

Never pretend that invalidating an upstream record automatically undoes a sent email, a payment, a public post, or an external API write.

---

## 6. Concurrency and External Effect Protocol

### 6.1 Branch and head semantics

If two agents derive `spec@v2a` and `spec@v2b` from `spec@v1`:

- both immutable versions may coexist;
- both may be independently verified;
- only one may promote the logical head using `CAS(expected_head = v1)`;
- the loser must receive `HEAD_CONFLICT` and choose rebase, merge, or reverify;
- conflicting external Effects must be serialized by `resourceKey`.

### 6.2 Protocol

Implement this sequence:

```text
1. Observe
   Read base head, resource version, policy, dependencies, and current Evidence.

2. Validate
   Check preconditions, freshness, read set, write set, and risk policy.

3. Fence
   Reserve the logical head and acquire a monotonic resource fencing token.

4. Prepare
   Persist EffectIntent with idempotency key and durable local state.

5. Execute
   Invoke the external connector after the local transaction commits.

6. Reconcile
   Persist EffectReceipt. If the process crashed, query the connector by idempotency key.
```

Do not hold a database transaction open while waiting for an arbitrary external API.

### 6.3 Connector contract

Every write connector must declare whether it supports:

- idempotency keys;
- query by idempotency key or external ID;
- conditional write / ETag;
- fencing token;
- compensation handler;
- before / after state digest;
- dry-run or shadow execution;
- human approval;
- reversibility class R0-R3.

Connector capability determines the guarantee level. Never expose a stronger guarantee than the connector can provide.

---

## 7. Storage Architecture

### 7.1 Reference implementation

The first implementation may use:

- PostgreSQL for metadata, lifecycle state, references, and reference graph;
- S3 / MinIO for large payloads;
- Redis for queues and ephemeral locks;
- a background worker for verification, compaction, reconciliation, and dataset materialization.

This implementation is called **ArcDB-PG** and acts as a correctness oracle.

### 7.2 Native implementation

The native path is called **ArcDB-Native**.

Use Rust and expose a service boundary through gRPC or Arrow Flight.

Initially reuse RocksDB or an equivalent mature LSM substrate for:

- WAL;
- atomic WriteBatch;
- snapshots;
- SSTables;
- crash recovery.

ArcDB must own:

- the logical schema;
- key layout;
- lifecycle transaction coordinator;
- evidence freshness index;
- typed lineage index;
- DLI;
- resource fencing;
- output-aware compaction;
- native impact and dataset operators.

Do not implement a new WAL, Raft, or SQL parser unless benchmark evidence justifies it.

### 7.3 Suggested native keyspaces

```text
L|tenant|logical_id|...       logical catalog and head
O|tenant|logical|version|...  immutable Output version
C|content_hash|...            content chunk
M|root_hash|...               manifest / Merkle node
F|source|selector|edge|target forward lineage postings
R|target|edge|source          reverse lineage
V|subject|verifier|evidence   evidence fingerprint index
I|resource|intent             EffectIntent
X|intent|sequence             EffectReceipt log
Z|resource                   fencing state
T|timestamp|event             append-only lifecycle events
```

### 7.4 ArcStore requirements

Implement the following abstraction before optimizing it:

```ts
interface ArtifactStore {
  putStream(input: AsyncIterable<Uint8Array>, options: PutOptions): Promise<StagedArtifact>;
  finalize(staged: StagedArtifact, manifest: ManifestInput): Promise<ContentRef>;
  read(ref: ContentRef): AsyncIterable<Uint8Array>;
  diff(left: ContentRef, right: ContentRef, options?: DiffOptions): Promise<ArtifactDiff>;
  fork(ref: ContentRef): Promise<ContentRef>;
  collectGarbage(options: GCOptions): Promise<GCReport>;
}
```

Start with content-addressed chunks and manifests. Add FastCDC / Rabin chunking, copy-on-write branches, and type-aware selectors after correctness tests exist.

Supported first-party artifact types:

- text and Markdown;
- JSON;
- file trees and code patches;
- SQL.

Preserve original bytes. Canonicalized representations are for indexing, deduplication, and diff only.

---

## 8. DLI and Incremental Invalidation

### 8.1 Delta-Lineage Index

Implement DLI as a domain-specific index, not merely recursive SQL.

Required components:

- component dictionary;
- forward postings: `(source_version, selector_token) -> dependent_edges`;
- reverse lineage index;
- dependency fingerprints;
- generation / topological metadata;
- optional Roaring bitmap or compressed postings for large graphs;
- fallback to conservative full descendant propagation when selectors are unknown.

### 8.2 Algorithm

```text
1. Compute typed Delta between old and new Output.
2. Convert Delta to selector tokens.
3. Lookup only edges whose selectors intersect the Delta.
4. Apply the edge transfer function.
5. Recompute the dependent fingerprint.
6. If the fingerprint changed, mark the target stale and continue.
7. If unchanged, stop propagation on that path.
```

Expected complexity:

```text
O(sum of delta lookups + affected vertices + affected edges)
```

Worst case remains `O(V + E)` when everything is affected. Do not claim asymptotic improvement for arbitrary graphs without stating selector assumptions.

### 8.3 Correctness requirements

- Conservative selectors must not miss affected dependencies.
- Exact selectors should minimize unnecessary recomputation.
- Unknown dependency must degrade to a safe over-approximation.
- Every invalidation must produce an explainable reason graph.
- The system must expose both `affected_nodes` and `skipped_nodes` with reasons.

---

## 9. API and SDK Requirements

### 9.1 Public API categories

Implement versioned APIs for:

- auth and organization management;
- project management;
- run / trace / span ingestion;
- Output creation and version finalization;
- Evidence creation and policy evaluation;
- lineage edge creation;
- impact analysis and invalidation;
- branch, promote, merge, and reverify;
- Effect preparation, commit, reconciliation, and remediation;
- dataset view creation;
- search and analytics;
- audit events.

### 9.2 API examples

Use standard SQL and explicit lifecycle procedures. Do not create a full new query language.

```sql
SELECT *
FROM arc.output_head('spec/payment-policy')
WHERE evidence_status = 'FRESH';

SELECT *
FROM arc.impact(
  source_version => 'spec@v2',
  delta => '{"paths":["$.refund.limit"]}'
);

CALL arc.invalidate('spec@v1', reason => 'policy corrected');

CALL arc.prepare_effect('effect_intent_9012');
CALL arc.commit_effect('effect_intent_9012');
```

The HTTP API and SDK should expose equivalent typed methods.

### 9.3 SDK requirements

The TypeScript SDK must support:

- API key authentication;
- automatic run / trace context;
- `createOutput` and `finalizeOutput`;
- `addEvidence`;
- `addLineage`;
- `prepareEffect` and `commitEffect`;
- retries with idempotency keys;
- offline buffering for transient network failure;
- typed errors;
- examples for SQL Agent and Coding Agent.

The Python SDK should be added after the HTTP contract stabilizes.

---

## 10. Web Product Requirements

The web application must be usable without reading the source code.

### 10.1 Required screens

- organization and project switcher;
- overview dashboard;
- trace / run explorer;
- trace detail with timeline and nested spans;
- Output version browser;
- artifact diff viewer;
- Evidence panel with verifier, environment, policy, and freshness;
- lineage graph and impact view;
- Effect intent / receipt / reconciliation view;
- dataset and dataset-version browser;
- evaluator and policy configuration;
- API key and connector management;
- audit log.

### 10.2 UX principles

- prioritize fast search and direct navigation;
- show lifecycle state prominently;
- distinguish `STALE`, `INVALIDATED`, `COMMITTED`, and `RECONCILIATION_REQUIRED` visually;
- never hide an unresolved external Effect behind a generic error;
- show “why this is invalid” as an explainable path;
- show raw data and structured metadata side by side;
- preserve stable URLs for traces, Outputs, Evidence, and Receipts;
- provide empty states with runnable examples;
- support pagination, filtering, and server-side search for all large views.

Do not make the UI a decorative prototype. Every important screen must be connected to real API data and have loading, empty, error, and permission-denied states.

---

## 11. Background Jobs and Reliability

Implement explicit job types:

- `process_ingestion_batch`;
- `run_verifier`;
- `evaluate_policy`;
- `compute_impact`;
- `propagate_invalidation`;
- `materialize_dataset_view`;
- `compact_artifacts`;
- `garbage_collect_chunks`;
- `reconcile_effect`;
- `run_compensation`;
- `create_remediation_obligation`;
- `publish_analytics_projection`.

Every job must have:

- deterministic idempotency key;
- retry policy;
- timeout;
- structured status;
- attempt count;
- error payload;
- dead-letter or reconciliation path;
- metrics and trace context.

Never retry an unknown external Effect blindly.

---

## 12. Security and Governance

Implement the minimum enterprise baseline from the beginning:

- tenant isolation on every query path;
- project-level authorization;
- role-based permissions;
- API key hashing and rotation;
- encrypted secrets;
- signed or tamper-evident audit events where practical;
- redaction and configurable payload retention;
- security labels on Outputs, Evidence, Effects, and datasets;
- dataset export permission checks;
- connector allowlists;
- human approval policy for R3 effects;
- request rate limits;
- payload size limits;
- secure defaults for local and production configuration.

Do not log raw secrets, authorization headers, or sensitive effect arguments.

---

## 13. Testing and Verification

### 13.1 Test layers

Implement all of the following:

1. Unit tests for domain state transitions and policy evaluation.
2. Property-based tests for version, branch, head, and invalidation invariants.
3. Repository tests against PostgreSQL and object storage.
4. Contract tests for HTTP API and SDK.
5. Integration tests for worker queues and verifiers.
6. Browser tests for the main product flows.
7. Fault-injection tests for lifecycle and external Effect recovery.
8. Performance benchmarks for ingestion, artifact storage, lineage traversal, and dataset export.

### 13.2 Mandatory fault cases

Test failures at:

- after chunk upload but before manifest finalization;
- after local Effect prepare but before external execution;
- after external execution but before Receipt persistence;
- after Receipt persistence but before head finalization;
- during compensation;
- during reconciliation;
- after a worker loses its fencing token;
- when Evidence becomes stale during a concurrent commit;
- when two branches promote the same logical head;
- when the external system changes the resource unexpectedly;
- when the same idempotency key is retried multiple times.

### 13.3 Acceptance criteria

The MVP is not complete until:

- a user can ingest a real Agent run;
- the run produces an Output version;
- a verifier produces Evidence;
- a policy can promote or reject the version;
- a downstream Output can be linked by typed lineage;
- an upstream correction creates a selective invalidation plan;
- a safe Effect can be prepared and committed;
- the external Receipt is visible in the UI;
- an uncertain Effect becomes `RECONCILIATION_REQUIRED` instead of disappearing;
- the same flow works from the SDK and the web application;
- the complete flow can be run locally with Docker Compose.

---

## 14. Benchmarking: ArcBench

Create `benchmarks/arcbench` with reproducible workloads.

### 14.1 Baselines

Compare against:

- full JSON snapshots in PostgreSQL;
- S3 full artifact snapshots;
- Git-like versioning;
- PostgreSQL recursive CTE for lineage;
- full-descendant invalidation;
- application-level retry / outbox;
- ArcDB-PG;
- ArcDB-Native.

### 14.2 Workloads

At minimum:

1. Database Change Agent: requirement -> SQL -> shadow execution -> approval -> production Effect.
2. Coding Agent: repository version -> patch -> tests / scan -> pull request -> merge.

### 14.3 Metrics

Measure:

- ingestion throughput;
- p50 / p95 version creation latency;
- physical bytes per logical bytes;
- deduplication ratio;
- artifact reconstruction latency;
- lineage query latency;
- number of visited and affected edges;
- false and missed invalidation;
- Evidence freshness latency;
- stale-Evidence commit rate;
- duplicate Effect rate;
- unknown-state duration;
- reconciliation completion time;
- compensation / remediation completion rate;
- token and tool-call savings from selective recomputation;
- developer time saved in dataset preparation;
- mean time to root cause.

Do not report percentages without stating workload, baseline, dataset size, cache state, and whether the value is measured or only a target.

---

## 15. Implementation Roadmap

### Phase 0: Repository and contracts, weeks 0-2

- initialize monorepo and CI;
- add Docker Compose for PostgreSQL, Redis, MinIO, and the web app;
- define tenant, project, run, Output, Evidence, Effect, and lineage schemas;
- write ADRs for storage boundary, OLT, Evidence freshness, and Effect semantics;
- add seed data and a minimal UI shell.

### Phase 1: Langfuse-level foundation, weeks 3-8

- ingestion API;
- TypeScript SDK;
- run / trace / span explorer;
- PostgreSQL repositories and migrations;
- object storage abstraction;
- background job system;
- auth, projects, API keys, and RBAC;
- basic dashboards and search;
- local end-to-end example.

### Phase 2: Output Lifecycle MVP, weeks 9-16

- OutputObject and versioning;
- EvidenceObject and verifier registry;
- EffectIntent / Receipt;
- OLT state machine;
- policy-gated promotion;
- SQL Agent example;
- effect reconciliation view;
- fault-injection tests.

### Phase 3: Artifact and lineage, weeks 17-24

- ArcStore abstraction;
- content digests and manifests;
- file tree and JSON diff;
- typed lineage edges;
- impact analysis;
- invalidation and recomputation plans;
- Coding Agent example.

### Phase 4: Native engine, weeks 25-36

- Rust ArcKernel prototype;
- RocksDB-backed keyspaces;
- native manifest and chunk index;
- DLI postings and dependency fingerprints;
- native impact operator;
- ArcDB-PG correctness comparison;
- ArcBench baseline results.

### Phase 5: Hardening and design partners, weeks 37-52

- high-availability deployment;
- connector capability matrix;
- security review;
- retention and deletion;
- ClickHouse analytics projection;
- dataset views and training export;
- two real design partners;
- publication-quality evaluation.

### Phase 6: Optional expansion, after week 52

- Python SDK;
- cognitive memory layers;
- semantic compaction and skill store;
- advanced SQL/PGQ operators;
- distributed native storage only if the workload requires it;
- multi-region resource ownership.

---

## 16. Development Workflow for Codex

When implementing this repository:

1. Inspect the current repository before changing files.
2. Preserve existing user changes.
3. Read relevant ADRs and package documentation before implementing a new subsystem.
4. Make one coherent change at a time.
5. Add tests with each domain feature.
6. Run formatting, linting, type checking, unit tests, and the smallest relevant integration test.
7. Update documentation and examples when changing public APIs.
8. Never silently change database semantics to make a test pass.
9. If a requirement is ambiguous, encode the assumption in an ADR and keep the implementation reversible.
10. Report exact files changed, commands run, tests passed, and remaining risks.

Do not generate placeholder code that looks complete but does not work. If a subsystem is intentionally incomplete, expose a clear interface, add a tracked TODO, document the limitation, and make the failure explicit.

### 16.1 Definition of done for each feature

A feature is done only when it has:

- domain type and validation;
- persistence representation;
- service-layer behavior;
- API endpoint or SDK method where applicable;
- UI surface where user-facing;
- authorization checks;
- structured logs and metrics;
- unit and integration tests;
- failure and retry behavior;
- documentation and example;
- migration if schema changes;
- backward compatibility consideration.

### 16.2 First Codex task

Start with the following implementation sequence:

```text
1. Inspect the repository and summarize the current state.
2. Create or update the monorepo structure.
3. Add Docker Compose for PostgreSQL, Redis, and MinIO.
4. Implement tenant, organization, project, API key, run, trace, and span models.
5. Implement ingestion API and TypeScript SDK.
6. Implement the first vertical slice:
   create Output -> add Evidence -> promote Output -> create EffectIntent -> record Receipt.
7. Add a SQL Change Agent example.
8. Add tests for concurrent promotion and uncertain external Effect reconciliation.
9. Add the first real dashboard and trace / Output detail pages.
10. Run the full local workflow and document the result.
```

Do not start with the Rust native engine until the Track A and Track B vertical slice is observable, testable, and benchmarkable.

---

## 17. Final Quality Bar

The generated codebase should feel like a serious open-source infrastructure product:

- one-command local startup;
- clear repository boundaries;
- reproducible migrations;
- realistic seed data;
- typed public APIs;
- accessible and consistent UI;
- robust background jobs;
- explicit failure states;
- useful documentation;
- reliable tests;
- benchmark scripts;
- security defaults;
- no hidden state transitions;
- no unsupported claims about rollback, causality, or performance.

The final product should make the following demo possible:

```text
An agent creates SQL Output v2.
ArcDB stores it as a versioned artifact.
A shadow database verifier creates Evidence.
ArcDB promotes the Output only after policy approval.
An EffectIntent updates a controlled production resource.
The external system returns a Receipt.
Another agent later identifies that an upstream requirement was wrong.
ArcDB marks only affected Outputs and Evidence stale.
The committed Effect remains immutable.
ArcDB creates a remediation obligation and a selective recomputation plan.
The user can inspect every step in the UI and through the SDK.
```

That end-to-end lifecycle is the primary acceptance test for ArcDB.

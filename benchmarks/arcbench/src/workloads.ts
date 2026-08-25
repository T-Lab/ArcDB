import { diffJson } from "@arcdb/artifacts";
import { IngestionBatchSchema, type LineageEdge, type LineageSelector } from "@arcdb/contracts";
import { computeImpact } from "@arcdb/lineage";
import { measure, type TimingMetrics } from "./measure.js";
import { deterministicUuid, seededRandom } from "./random.js";

export type WorkloadName = "artifact-diff" | "ingestion" | "lineage";

export interface BenchmarkResult {
  readonly baseline: string;
  readonly cache_state: string;
  readonly metrics: TimingMetrics;
  readonly sample: Readonly<Record<string, number | string>>;
  readonly seed: number;
  readonly workload: WorkloadName;
}

export interface WorkloadOptions {
  readonly iterations: number;
  readonly samples: number;
  readonly seed: number;
}

const CACHE_STATE = "warm-process; one unmeasured warmup; no external cache";
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

function ingestionBatch(seed: number, eventCount: number) {
  const random = seededRandom(seed);
  const events = Array.from({ length: eventCount }, (_, index) => {
    const suffix = Math.floor(random() * 1_000_000);
    if (index % 2 === 0) {
      return {
        type: "run.create" as const,
        body: {
          id: deterministicUuid(index + 1),
          externalId: `bench-run-${suffix}`,
          name: `agent-run-${index}`,
          input: { record: index, score: Number(random().toFixed(6)) },
          metadata: { shard: index % 8 },
          startedAt: FIXED_TIME,
        },
      };
    }
    return {
      type: "trace.create" as const,
      body: {
        id: deterministicUuid(index + 1),
        externalId: `bench-trace-${suffix}`,
        name: `trace-${index}`,
        input: { tokens: Math.floor(random() * 2_048) },
        metadata: { model: `model-${index % 4}` },
        startedAt: FIXED_TIME,
      },
    };
  });
  return { batchId: `arcbench-ingestion-${seed}`, events };
}

export function ingestionWorkload(options: WorkloadOptions): BenchmarkResult {
  const eventCount = 200;
  const batch = ingestionBatch(options.seed, eventCount);
  return {
    workload: "ingestion",
    seed: options.seed,
    baseline:
      "single-threaded IngestionBatchSchema validation of prebuilt JSON; excludes HTTP and database I/O",
    sample: { eventsPerBatch: eventCount, eventMix: "50% run.create, 50% trace.create" },
    cache_state: CACHE_STATE,
    metrics: measure(() => IngestionBatchSchema.parse(batch).events.length, options),
  };
}

function lineageGraph(seed: number, nodeCount: number, fanout: number): readonly LineageEdge[] {
  const random = seededRandom(seed);
  const edges: LineageEdge[] = [];
  for (let source = 0; source < nodeCount - 1; source += 1) {
    for (let offset = 1; offset <= fanout && source + offset < nodeCount; offset += 1) {
      const target = source + offset;
      const selector: LineageSelector =
        offset === 1 || random() < 0.7
          ? { kind: "table_column", value: "public.accounts.risk_score" }
          : { kind: "table_column", value: `public.accounts.column_${target % 11}` };
      edges.push({
        id: `edge-${source}-${target}`,
        sourceVersionId: `node-${source}`,
        targetVersionId: `node-${target}`,
        edgeType: "DERIVED_FROM",
        selector,
        inferred: false,
        createdAt: FIXED_TIME,
      });
    }
  }
  return edges;
}

export function lineageWorkload(options: WorkloadOptions): BenchmarkResult {
  const nodeCount = 300;
  const fanout = 3;
  const edges = lineageGraph(options.seed, nodeCount, fanout);
  return {
    workload: "lineage",
    seed: options.seed,
    baseline:
      "single-threaded selector-aware computeImpact over an in-memory acyclic graph; excludes persistence",
    sample: { edges: edges.length, fanout, nodes: nodeCount, selector: "table_column" },
    cache_state: CACHE_STATE,
    metrics: measure(() => {
      const result = computeImpact({
        sourceVersionId: "node-0",
        delta: { selectors: [{ kind: "table_column", value: "public.accounts.risk_score" }] },
        edges,
      });
      return result.affectedNodes.length * 31 + result.visitedEdgeCount;
    }, options),
  };
}

function artifactPair(seed: number, recordCount: number) {
  const random = seededRandom(seed);
  const before = Array.from({ length: recordCount }, (_, index) => ({
    id: index,
    active: index % 3 !== 0,
    score: Math.floor(random() * 10_000),
    tags: [`group-${index % 17}`, `shard-${index % 8}`],
  }));
  const after = before.map((record, index) => ({
    ...record,
    tags: [...record.tags],
    ...(index % 23 === 0 ? { score: record.score + 1, active: !record.active } : {}),
  }));
  return { before, after };
}

export function artifactDiffWorkload(options: WorkloadOptions): BenchmarkResult {
  const recordCount = 2_000;
  const pair = artifactPair(options.seed, recordCount);
  return {
    workload: "artifact-diff",
    seed: options.seed,
    baseline:
      "single-threaded structural diffJson over resident JSON values; excludes artifact serialization and object storage",
    sample: { mutationEvery: 23, records: recordCount },
    cache_state: CACHE_STATE,
    metrics: measure(() => diffJson(pair.before, pair.after).length, options),
  };
}

export const workloadRunners: Readonly<
  Record<WorkloadName, (options: WorkloadOptions) => BenchmarkResult>
> = {
  ingestion: ingestionWorkload,
  lineage: lineageWorkload,
  "artifact-diff": artifactDiffWorkload,
};

# ArcBench microbenchmarks

ArcBench measures three bounded, reproducible in-process mechanisms:

- ingestion contract validation (`IngestionBatchSchema`);
- selector-aware lineage impact (`computeImpact`); and
- structural artifact diffing (`diffJson`).

It does **not** claim API, PostgreSQL, Redis, S3, worker, or end-to-end throughput. Each JSON result
states its baseline, deterministic seed, representative sample shape, cache state, and measured
latency/throughput metrics. There are no checked-in performance numbers; every number comes from the
current invocation and depends on its recorded runtime environment.

Run the workspace benchmark from the repository root:

```bash
pnpm --filter @arcdb/arcbench bench -- --seed=42 --samples=15 --iterations=20 \
  > arcbench-result.json
```

Select a subset with `--workload=ingestion,lineage` (or use `all`). Use the same seed, sample count,
iteration count, Node release, hardware, and power settings for comparisons. The seed reproduces the
workload data; wall-clock timing is naturally not bit-for-bit deterministic.

`meanOperationMs` is total measured batch time divided by the number of operations. The p50/p95/p99
fields are explicitly named `*BatchMs`: each sample times `iterationsPerSample` operations, so those
percentiles must not be reported as single-operation latency.

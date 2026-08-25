import { describe, expect, it } from "vitest";
import { seededRandom } from "./random.js";
import { runArcBench } from "./report.js";

describe("ArcBench", () => {
  it("constructs deterministic workload randomness", () => {
    const first = seededRandom(42);
    const second = seededRandom(42);
    expect(Array.from({ length: 10 }, first)).toEqual(Array.from({ length: 10 }, second));
  });

  it("emits measured, self-describing JSON records for every workload", () => {
    const report = runArcBench({
      workloads: ["ingestion", "lineage", "artifact-diff"],
      seed: 7,
      samples: 2,
      iterations: 1,
    });
    expect(report.results.map(({ workload }) => workload)).toEqual([
      "ingestion",
      "lineage",
      "artifact-diff",
    ]);
    for (const result of report.results) {
      expect(result.seed).toBe(7);
      expect(result.baseline).toContain("single-threaded");
      expect(result.cache_state).toContain("warm-process");
      expect(result.sample).not.toEqual({});
      expect(result.metrics.operations).toBe(2);
      expect(result.metrics.totalMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.meanBatchMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.meanOperationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.metrics.operationsPerSecond)).toBe(true);
      expect(result.metrics.checksum).toBeGreaterThan(0);
    }
  });

  it("rejects invalid run controls", () => {
    expect(() =>
      runArcBench({ workloads: ["ingestion"], seed: 1, samples: 0, iterations: 1 }),
    ).toThrow("samples must be a positive integer");
  });
});

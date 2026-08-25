import { arch, platform, release } from "node:os";
import {
  type BenchmarkResult,
  type WorkloadName,
  type WorkloadOptions,
  workloadRunners,
} from "./workloads.js";

export interface ArcBenchOptions extends WorkloadOptions {
  readonly workloads: readonly WorkloadName[];
}

export interface ArcBenchReport {
  readonly generatedAt: string;
  readonly results: readonly BenchmarkResult[];
  readonly runtime: {
    readonly architecture: string;
    readonly node: string;
    readonly operatingSystem: string;
  };
  readonly schemaVersion: 2;
}

export function runArcBench(options: ArcBenchOptions): ArcBenchReport {
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
    throw new Error("seed must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 1) {
    throw new Error("samples must be a positive integer");
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
    throw new Error("iterations must be a positive integer");
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runtime: {
      architecture: arch(),
      node: process.version,
      operatingSystem: `${platform()} ${release()}`,
    },
    results: options.workloads.map((workload) =>
      workloadRunners[workload]({
        iterations: options.iterations,
        samples: options.samples,
        seed: options.seed,
      }),
    ),
  };
}

import { runArcBench } from "./report.js";
import type { WorkloadName } from "./workloads.js";

const KNOWN_WORKLOADS = ["ingestion", "lineage", "artifact-diff"] as const;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function positiveInteger(name: string, fallback: number): number {
  const value = argument(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be positive`);
  return parsed;
}

function selectedWorkloads(): readonly WorkloadName[] {
  const requested = argument("workload") ?? "all";
  if (requested === "all") return KNOWN_WORKLOADS;
  const values = requested.split(",");
  for (const value of values) {
    if (!KNOWN_WORKLOADS.includes(value as (typeof KNOWN_WORKLOADS)[number])) {
      throw new Error(`Unknown workload ${value}; choose all, ${KNOWN_WORKLOADS.join(", ")}`);
    }
  }
  return values as WorkloadName[];
}

try {
  const report = runArcBench({
    workloads: selectedWorkloads(),
    seed: Number(argument("seed") ?? 42),
    samples: positiveInteger("samples", 15),
    iterations: positiveInteger("iterations", 20),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

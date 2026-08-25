import { performance } from "node:perf_hooks";

export interface TimingMetrics {
  readonly checksum: number;
  readonly iterationsPerSample: number;
  readonly meanBatchMs: number;
  readonly meanOperationMs: number;
  readonly operations: number;
  readonly operationsPerSecond: number;
  readonly p50BatchMs: number;
  readonly p95BatchMs: number;
  readonly p99BatchMs: number;
  readonly samples: number;
  readonly totalMs: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

export function measure(
  operation: () => number,
  options: { readonly iterations: number; readonly samples: number },
): TimingMetrics {
  // One unmeasured warmup makes the declared cache state explicit and avoids timing module startup.
  operation();
  const durations: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < options.samples; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < options.iterations; iteration += 1) {
      checksum = (checksum + operation()) >>> 0;
    }
    durations.push(performance.now() - started);
  }
  const sorted = [...durations].sort((left, right) => left - right);
  const totalMs = durations.reduce((total, duration) => total + duration, 0);
  const operations = options.iterations * options.samples;
  return {
    checksum,
    iterationsPerSample: options.iterations,
    meanBatchMs: rounded(totalMs / options.samples),
    meanOperationMs: rounded(totalMs / operations),
    operations,
    operationsPerSecond: rounded(totalMs === 0 ? 0 : (operations * 1_000) / totalMs),
    p50BatchMs: rounded(percentile(sorted, 0.5)),
    p95BatchMs: rounded(percentile(sorted, 0.95)),
    p99BatchMs: rounded(percentile(sorted, 0.99)),
    samples: options.samples,
    totalMs: rounded(totalMs),
  };
}

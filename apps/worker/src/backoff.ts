export interface BackoffPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.2,
});

function assertPolicy(policy: BackoffPolicy): void {
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1) {
    throw new TypeError("baseDelayMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new TypeError("maxDelayMs must be a safe integer greater than or equal to baseDelayMs");
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError("jitterRatio must be between 0 and 1");
  }
}

/**
 * attempt is one-based. Exponentiation is capped before it can overflow and
 * symmetric jitter is applied without ever exceeding maxDelayMs.
 */
export function boundedExponentialBackoff(
  attempt: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF_POLICY,
  random: () => number = Math.random,
): number {
  assertPolicy(policy);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer");
  }
  const exponent = Math.min(attempt - 1, 52);
  const withoutJitter = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
    throw new TypeError("random must return a value between 0 and 1");
  }
  const multiplier = 1 + (sample * 2 - 1) * policy.jitterRatio;
  return Math.max(1, Math.min(policy.maxDelayMs, Math.round(withoutJitter * multiplier)));
}

import { describe, expect, it } from "vitest";
import { boundedExponentialBackoff } from "../../src/backoff.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import type { EffectConnector } from "../../src/connectors/types.js";
import { MissingJobHandlerError } from "../../src/errors.js";
import { JOB_TYPES } from "../../src/job-types.js";
import { JobHandlerRegistry } from "../../src/registry.js";

describe("bounded exponential backoff", () => {
  it("grows exponentially and stays bounded", () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0 };
    expect(
      [1, 2, 3, 4, 5, 99].map((attempt) => boundedExponentialBackoff(attempt, policy, () => 0.5)),
    ).toEqual([100, 200, 400, 800, 1_000, 1_000]);
  });

  it("applies bounded symmetric jitter", () => {
    const policy = { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0.2 };
    expect(boundedExponentialBackoff(1, policy, () => 0)).toBe(80);
    expect(boundedExponentialBackoff(1, policy, () => 1)).toBe(120);
    expect(boundedExponentialBackoff(99, policy, () => 1)).toBe(1_000);
  });
});

describe("JobHandlerRegistry", () => {
  it("represents every guideline job type and labels missing handlers honestly", () => {
    const registry = new JobHandlerRegistry();
    registry.register("run_verifier", async () => ({ ok: true }));
    const coverage = registry.coverage();
    expect(Object.keys(coverage).sort()).toEqual([...JOB_TYPES].sort());
    expect(coverage.run_verifier).toBe("CONFIGURED");
    expect(coverage.compact_artifacts).toBe("DEAD_LETTER_IF_RECEIVED");
    expect(() => registry.resolve("compact_artifacts")).toThrow(MissingJobHandlerError);
  });
});

describe("ConnectorRegistry", () => {
  it("rejects automatic writes that cannot query by idempotency key", () => {
    const connector: EffectConnector = {
      type: "external-id-only",
      mode: "automatic-write",
      capabilities: {
        supportsIdempotencyKey: true,
        supportsQueryByIdempotencyKey: false,
        supportsQueryByExternalId: true,
        supportsConditionalWrite: true,
        supportsFencingToken: true,
        supportsCompensation: false,
        supportsStateDigests: false,
        supportsDryRun: false,
        supportsHumanApproval: false,
        reversibility: "R2",
      },
      execute: async () => ({ kind: "UNKNOWN", reason: "not called" }),
      reconcile: async () => ({ kind: "UNKNOWN", reason: "not called" }),
    };
    expect(() => new ConnectorRegistry().register(connector)).toThrow(/query by idempotency key/u);
  });
});

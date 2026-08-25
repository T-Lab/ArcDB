import {
  type EffectIntent,
  type EffectReceipt,
  type EvidenceObject,
  EvidencePolicyError,
  evidenceFingerprint,
  FencingTokenLostError,
  HeadConflictError,
  ImmutableVersionError,
  InvalidTransitionError,
  type OutputLifecycleState,
  type OutputObject,
  ReceiptImmutableError,
} from "@arcdb/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { EvidencePolicy } from "./evidence-policy.js";
import {
  appendEffectReceipt,
  assessEvidenceFreshness,
  canTransitionOutput,
  evaluateEvidencePolicy,
  OUTPUT_TRANSITIONS,
  resolveIdempotentIntent,
  transitionOutput,
  updateOutputMetadata,
  validateFencingToken,
} from "./index.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const t0 = "2026-08-25T10:00:00.000Z";
const t1 = "2026-08-25T10:01:00.000Z";

function output(state: OutputLifecycleState = "CREATED", versionId = "policy@v2a"): OutputObject {
  return {
    id: `output-${versionId}`,
    tenantId: "tenant-1",
    projectId: "project-1",
    logicalId: "policy",
    versionId,
    outputType: "sql",
    contentRef: `arc://${versionId}`,
    contentDigest: digestA,
    parentVersionIds: ["policy@v1"],
    policyVersion: "policy-1",
    lifecycleState: state,
    metadata: {},
    createdAt: t0,
    updatedAt: t0,
  };
}

function evidence(overrides: Partial<EvidenceObject> = {}): EvidenceObject {
  const scope = {
    subjectVersionId: "policy@v2a",
    verifierType: "shadow-sql",
    verifierVersion: "1.0.0",
    environmentDigest: digestA,
    dependencyDigests: [digestB],
    policyVersion: "policy-1",
  };
  return {
    id: "evidence-1",
    tenantId: "tenant-1",
    ...scope,
    verdict: "PASS",
    confidence: 0.99,
    metrics: { safe: true },
    fingerprint: evidenceFingerprint(scope),
    expiresAt: "2026-08-25T11:00:00.000Z",
    createdAt: t0,
    ...overrides,
  };
}

function evidenceForVersion(versionId: string): EvidenceObject {
  const record = evidence({ subjectVersionId: versionId });
  return { ...record, fingerprint: evidenceFingerprint(record) };
}

const policy: EvidencePolicy = {
  id: "promotion-policy",
  version: "policy-1",
  requiredEvidence: [
    {
      id: "shadow",
      verifierType: "shadow-sql",
      verifierVersion: "1.0.0",
      environmentDigest: digestA,
      dependencyDigests: [digestB],
      minimumConfidence: 0.95,
      maxAgeSeconds: 3_600,
    },
  ],
};

describe("Evidence freshness", () => {
  it("binds Evidence to version, verifier, environment, dependencies and policy", () => {
    expect(
      assessEvidenceFreshness(evidence(), {
        subjectVersionId: "policy@v2a",
        verifierVersion: "1.0.0",
        environmentDigest: digestA,
        dependencyDigests: [digestB],
        policyVersion: "policy-1",
        now: t1,
      }),
    ).toEqual({ status: "FRESH", reasons: [] });

    expect(
      assessEvidenceFreshness(evidence(), {
        subjectVersionId: "policy@v2a",
        environmentDigest: digestB,
        dependencyDigests: [digestA],
        policyVersion: "policy-2",
        now: t1,
      }),
    ).toEqual({
      status: "STALE",
      reasons: ["ENVIRONMENT_CHANGED", "DEPENDENCIES_CHANGED", "POLICY_CHANGED"],
    });
  });

  it("distinguishes fresh FAIL from stale Evidence", () => {
    const failed = evidence({ verdict: "FAIL" });
    const evaluation = evaluateEvidencePolicy({
      policy,
      evidence: [failed],
      subjectVersionId: "policy@v2a",
      now: t1,
    });
    expect(evaluation.decision).toBe("DENIED");
    expect(evaluation.failures[0]?.kind).toBe("FAILED");
    expect(
      assessEvidenceFreshness(failed, { subjectVersionId: "policy@v2a", now: t1 }).status,
    ).toBe("FRESH");
  });

  it("rejects expired Evidence during a concurrent promotion", () => {
    const expired = evidence({ expiresAt: "2026-08-25T10:00:30.000Z" });
    expect(() =>
      transitionOutput({
        eventId: "event-promote",
        output: output("COMMITTED"),
        to: "PROMOTED",
        occurredAt: t1,
        evidence: [expired],
        evidencePolicy: policy,
        headReservation: {
          expectedHeadVersionId: "policy@v1",
          currentHeadVersionId: "policy@v1",
        },
        fence: { resourceKey: "head/policy", presentedToken: 2, currentToken: 2 },
      }),
    ).toThrowError(EvidencePolicyError);
  });
});

describe("Output Lifecycle Transaction state machine", () => {
  it("exactly implements its declared transition relation", () => {
    const states = Object.keys(OUTPUT_TRANSITIONS) as OutputLifecycleState[];
    fc.assert(
      fc.property(fc.constantFrom(...states), fc.constantFrom(...states), (from, to) => {
        expect(canTransitionOutput(from, to)).toBe(
          (OUTPUT_TRANSITIONS[from] as readonly OutputLifecycleState[]).includes(to),
        );
      }),
    );
  });

  it("rejects illegal state jumps with a typed error", () => {
    expect(() =>
      transitionOutput({
        eventId: "event-1",
        output: output("CREATED"),
        to: "COMMITTED",
        occurredAt: t1,
      }),
    ).toThrowError(InvalidTransitionError);
  });

  it("can mark an unvalidated downstream Output stale after upstream invalidation", () => {
    expect(
      transitionOutput({
        eventId: "event-stale-created",
        output: output("CREATED"),
        to: "STALE",
        occurredAt: t1,
      }).output.lifecycleState,
    ).toBe("STALE");
  });

  it("requires provenance closure and a current fence at commit", () => {
    expect(() =>
      transitionOutput({
        eventId: "event-commit",
        output: output("APPROVED"),
        to: "COMMITTED",
        occurredAt: t1,
        provenance: { complete: false, missingVersionIds: ["policy@v1"] },
        fence: { resourceKey: "head/policy", presentedToken: 4, currentToken: 4 },
      }),
    ).toThrow(/provenance closure/u);

    expect(() =>
      transitionOutput({
        eventId: "event-commit",
        output: output("APPROVED"),
        to: "COMMITTED",
        occurredAt: t1,
        provenance: { complete: true, missingVersionIds: [] },
        fence: { resourceKey: "head/policy", presentedToken: 3, currentToken: 4 },
      }),
    ).toThrowError(FencingTokenLostError);
  });

  it("returns HEAD_CONFLICT to the losing branch", () => {
    const common = {
      to: "PROMOTED" as const,
      occurredAt: t1,
      evidence: [evidence()],
      evidencePolicy: policy,
      fence: { resourceKey: "head/policy", presentedToken: 3, currentToken: 3 },
    };
    expect(
      transitionOutput({
        ...common,
        eventId: "event-a",
        output: output("COMMITTED", "policy@v2a"),
        headReservation: {
          expectedHeadVersionId: "policy@v1",
          currentHeadVersionId: "policy@v1",
        },
      }).output.lifecycleState,
    ).toBe("PROMOTED");

    expect(() =>
      transitionOutput({
        ...common,
        eventId: "event-b",
        output: output("COMMITTED", "policy@v2b"),
        evidence: [evidenceForVersion("policy@v2b")],
        // CAS was observed at v1, but branch A is now the head.
        headReservation: {
          expectedHeadVersionId: "policy@v1",
          currentHeadVersionId: "policy@v2a",
        },
      }),
    ).toThrowError(HeadConflictError);
  });

  it("does not permit metadata mutation after commit", () => {
    expect(() => updateOutputMetadata(output("COMMITTED"), { changed: true }, t1)).toThrowError(
      ImmutableVersionError,
    );
  });

  it("rejects a worker after it loses its fencing token", () => {
    expect(() =>
      validateFencingToken({ resourceKey: "db/table", presentedToken: 8, currentToken: 9 }),
    ).toThrowError(FencingTokenLostError);
  });
});

function intent(overrides: Partial<EffectIntent> = {}): EffectIntent {
  return {
    id: "effect-1",
    tenantId: "tenant-1",
    sourceOutputVersionId: "policy@v2a",
    connectorType: "postgres",
    target: "production",
    resourceKey: "db/policy",
    argumentsRef: "arc://arguments/1",
    preconditions: {},
    expectedEffects: {},
    readSet: ["policy"],
    writeSet: ["policy"],
    idempotencyKey: "effect-policy-v2a",
    reversibility: "R1",
    riskLevel: "HIGH",
    status: "PREPARED",
    createdAt: t0,
    ...overrides,
  };
}

function receipt(overrides: Partial<EffectReceipt> = {}): EffectReceipt {
  return {
    id: "receipt-1",
    intentId: "effect-1",
    externalStatus: "committed",
    actualEffects: { rows: 1 },
    committedAt: t1,
    createdAt: t0,
    ...overrides,
  };
}

describe("Effect idempotency and append-only Receipts", () => {
  it("replays an equivalent EffectIntent and rejects key reuse for another operation", () => {
    expect(resolveIdempotentIntent(intent({ id: "retry" }), [intent()])).toEqual({
      kind: "REPLAY",
      intent: intent(),
    });
    expect(() =>
      resolveIdempotentIntent(intent({ target: "different-production" }), [intent()]),
    ).toThrow(/Idempotency key/u);
  });

  it("treats an exact Receipt replay as idempotent but never overwrites it", () => {
    const original = receipt();
    expect(appendEffectReceipt([original], original, intent())).toEqual([original]);
    expect(() =>
      appendEffectReceipt([original], receipt({ externalStatus: "rewritten" }), intent()),
    ).toThrowError(ReceiptImmutableError);
  });
});

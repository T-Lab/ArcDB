import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CreateScoreSchema,
  canonicalDigest,
  canonicalize,
  EffectIntentSchema,
  EffectReceiptSchema,
  EvidenceObjectSchema,
  evidenceFingerprint,
  isRemediationTransitionAllowed,
  LineageEdgeSchema,
  OutputObjectSchema,
  outputContentDigest,
  TransitionRemediationSchema,
} from "./index.js";

const now = "2026-08-25T10:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

describe("strict domain contracts", () => {
  it("parses a complete Output and rejects undeclared input", () => {
    const output = {
      id: "out_1",
      tenantId: "tenant_1",
      projectId: "project_1",
      logicalId: "payment-policy",
      versionId: "payment-policy@v1",
      outputType: "sql",
      contentRef: "arc://content/1",
      contentDigest: digest,
      parentVersionIds: [],
      lifecycleState: "CREATED",
      metadata: {},
      createdAt: now,
      updatedAt: now,
    } as const;

    expect(OutputObjectSchema.parse(output)).toEqual(output);
    expect(OutputObjectSchema.safeParse({ ...output, undeclared: true }).success).toBe(false);
    expect(
      OutputObjectSchema.safeParse({ ...output, parentVersionIds: ["v0", "v0"] }).success,
    ).toBe(false);
  });

  it("validates evidence scope and confidence", () => {
    const evidence = {
      id: "evidence_1",
      tenantId: "tenant_1",
      subjectVersionId: "payment-policy@v1",
      verifierType: "sql-shadow",
      verifierVersion: "1.2.0",
      dependencyDigests: [digest],
      verdict: "PASS",
      confidence: 0.99,
      metrics: { rows: 14, safe: true },
      fingerprint: digest,
      expiresAt: "2026-08-25T11:00:00.000Z",
      createdAt: now,
    } as const;

    expect(EvidenceObjectSchema.parse(evidence)).toEqual(evidence);
    expect(EvidenceObjectSchema.safeParse({ ...evidence, confidence: 1.01 }).success).toBe(false);
    expect(
      EvidenceObjectSchema.safeParse({ ...evidence, expiresAt: "2026-08-25T09:00:00.000Z" })
        .success,
    ).toBe(false);
  });

  it("enforces effect and lineage invariants", () => {
    const intent = {
      id: "effect_1",
      tenantId: "tenant_1",
      sourceOutputVersionId: "payment-policy@v1",
      connectorType: "postgres",
      target: "production",
      resourceKey: "db/payment-policy",
      argumentsRef: "arc://arguments/1",
      preconditions: {},
      expectedEffects: {},
      readSet: ["policy"],
      writeSet: ["policy"],
      idempotencyKey: "promote-payment-policy-v1",
      reversibility: "R1",
      riskLevel: "HIGH",
      status: "PREPARED",
      createdAt: now,
    } as const;
    expect(EffectIntentSchema.parse(intent)).toEqual(intent);
    expect(
      EffectIntentSchema.safeParse({ ...intent, status: "IRREVERSIBLE_COMMITTED" }).success,
    ).toBe(false);

    expect(
      LineageEdgeSchema.safeParse({
        id: "edge_1",
        sourceVersionId: "a@v1",
        targetVersionId: "b@v1",
        edgeType: "DERIVED_FROM",
        selector: { kind: "unknown", value: "not-wildcard" },
        inferred: false,
        createdAt: now,
      }).success,
    ).toBe(false);
  });

  it("accepts an external commit timestamp before Receipt persistence", () => {
    const receipt = {
      id: "receipt_1",
      intentId: "effect_1",
      externalStatus: "committed",
      actualEffects: { rows: 1 },
      committedAt: "2026-08-25T09:59:59.000Z",
      createdAt: now,
    } as const;
    expect(EffectReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("requires every Score to identify exactly one subject", () => {
    const traceId = "019a0000-0000-7000-8000-000000000001";
    expect(CreateScoreSchema.safeParse({ traceId, name: "quality", value: 0.9 }).success).toBe(
      true,
    );
    expect(CreateScoreSchema.safeParse({ name: "quality", value: 0.9 }).success).toBe(false);
    expect(
      CreateScoreSchema.safeParse({ traceId, runId: traceId, name: "quality", value: 0.9 }).success,
    ).toBe(false);
  });

  it("shares the remediation transition matrix and terminal-resolution contract", () => {
    expect(isRemediationTransitionAllowed("PENDING_APPROVAL", "IN_PROGRESS")).toBe(true);
    expect(isRemediationTransitionAllowed("PENDING_APPROVAL", "RESOLVED")).toBe(false);
    expect(isRemediationTransitionAllowed("RESOLVED", "IN_PROGRESS")).toBe(false);
    expect(
      TransitionRemediationSchema.safeParse({
        expectedStatus: "IN_PROGRESS",
        nextStatus: "RESOLVED",
      }).success,
    ).toBe(false);
    expect(
      TransitionRemediationSchema.safeParse({
        expectedStatus: "IN_PROGRESS",
        nextStatus: "RESOLVED",
        resolution: { summary: "The external resource was corrected" },
      }).success,
    ).toBe(true);
  });
});

describe("canonical digests", () => {
  it("are invariant to object insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (record) => {
        const reversed = Object.fromEntries(Object.entries(record).reverse());
        expect(canonicalize(record)).toBe(canonicalize(reversed));
        expect(canonicalDigest(record)).toBe(canonicalDigest(reversed));
      }),
    );
  });

  it("uses domain separation", () => {
    expect(canonicalDigest({ value: 1 }, "one")).not.toBe(canonicalDigest({ value: 1 }, "two"));
  });

  it("rejects values that JSON would silently lose", () => {
    expect(() => canonicalize({ value: undefined })).toThrow(/Unsupported undefined/u);
    expect(() => canonicalize(Number.NaN)).toThrow(/Non-finite/u);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalize(cycle)).toThrow(/Cyclic/u);
  });

  it("binds output digests to relevant metadata and type", () => {
    const left = outputContentDigest({
      content: { query: "select 1" },
      outputType: "sql",
      metadata: { dialect: "postgres" },
    });
    const right = outputContentDigest({
      content: { query: "select 1" },
      outputType: "sql",
      metadata: { dialect: "sqlite" },
    });
    expect(left).not.toBe(right);
  });

  it("normalizes dependency order in Evidence fingerprints", () => {
    const scope = {
      subjectVersionId: "output@v1",
      verifierType: "unit-test",
      verifierVersion: "1",
      dependencyDigests: [`sha256:${"a".repeat(64)}`, `sha256:${"b".repeat(64)}`],
    };
    expect(evidenceFingerprint(scope)).toBe(
      evidenceFingerprint({ ...scope, dependencyDigests: [...scope.dependencyDigests].reverse() }),
    );
  });
});

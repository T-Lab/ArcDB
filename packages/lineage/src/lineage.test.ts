import {
  type EffectIntent,
  type EffectReceipt,
  type EvidenceObject,
  evidenceFingerprint,
  type LineageEdge,
  type OutputObject,
} from "@arcdb/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyInvalidationPlan,
  computeImpact,
  createInvalidationPlan,
  explainImpact,
  selectorsIntersect,
} from "./index.js";

const now = "2026-08-25T10:00:00.000Z";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

function edge(
  id: string,
  sourceVersionId: string,
  targetVersionId: string,
  selector?: LineageEdge["selector"],
): LineageEdge {
  return {
    id,
    sourceVersionId,
    targetVersionId,
    edgeType: "DERIVED_FROM",
    ...(selector === undefined ? {} : { selector }),
    inferred: false,
    createdAt: now,
  };
}

describe("component selector semantics", () => {
  it("matches JSONPath ancestors and wildcards", () => {
    expect(
      selectorsIntersect(
        { kind: "json_path", value: "$.refund.limit" },
        { kind: "json_path", value: "$.refund" },
      ),
    ).toBe(true);
    expect(
      selectorsIntersect(
        { kind: "json_path", value: "$.items[2].price" },
        { kind: "json_path", value: "$.items[*].price" },
      ),
    ).toBe(true);
    expect(
      selectorsIntersect(
        { kind: "json_path", value: "$.refund.limit" },
        { kind: "json_path", value: "$.user.name" },
      ),
    ).toBe(false);
  });

  it("always over-approximates unknown selectors", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("json_path", "file", "symbol", "table_column", "record" as const),
        // Selector values are trimmed and must remain non-empty at the contract boundary.
        fc.stringMatching(/\S/u),
        (kind, value) => {
          expect(selectorsIntersect({ kind: "unknown", value: "*" }, { kind, value })).toBe(true);
        },
      ),
    );
  });

  it("rejects whitespace-only selector values instead of treating malformed input as unknown", () => {
    expect(() =>
      selectorsIntersect({ kind: "unknown", value: "*" }, { kind: "json_path", value: " " }),
    ).toThrow();
  });
});

describe("selector-aware impact", () => {
  it("visits only intersecting descendants and explains skipped nodes", () => {
    const result = computeImpact({
      sourceVersionId: "source",
      delta: { selectors: [{ kind: "json_path", value: "$.refund.limit" }] },
      edges: [
        edge("refund", "source", "refund-view", { kind: "json_path", value: "$.refund" }),
        edge("user", "source", "user-view", { kind: "json_path", value: "$.user" }),
        edge("report", "refund-view", "report"),
        edge("profile", "user-view", "profile"),
      ],
    });
    expect(result.affectedNodes.map((node) => node.versionId)).toEqual([
      "source",
      "refund-view",
      "report",
    ]);
    expect(result.skippedNodes).toEqual([
      { versionId: "user-view", viaEdgeIds: ["user"], reasons: ["SELECTOR_DISJOINT"] },
    ]);
  });

  it("stops propagation when the dependency fingerprint is unchanged", () => {
    const result = computeImpact({
      sourceVersionId: "a",
      delta: { selectors: [{ kind: "unknown", value: "*" }] },
      edges: [edge("ab", "a", "b"), edge("bc", "b", "c")],
      currentFingerprints: { b: digestA },
      fingerprintResolver: ({ previousFingerprint }) => previousFingerprint ?? digestB,
    });
    expect(result.affectedNodes.map((node) => node.versionId)).toEqual(["a"]);
    expect(result.skippedNodes[0]?.reasons).toContain("FINGERPRINT_UNCHANGED");
    expect(result.visitedEdgeCount).toBe(1);
  });

  it("unknown selectors include every graph descendant (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 9 })), {
          maxLength: 40,
        }),
        (nodeCount, pairs) => {
          const normalizedPairs = [
            ...new Set(
              pairs
                .filter(
                  ([source, target]) => source < nodeCount && target < nodeCount && source < target,
                )
                .map(([source, target]) => `${source}:${target}`),
            ),
          ].map((pair) => pair.split(":").map(Number) as [number, number]);
          const edges = normalizedPairs.map(([source, target], index) =>
            edge(`e${index}`, `v${source}`, `v${target}`),
          );
          const expected = new Set(["v0"]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [source, target] of normalizedPairs) {
              if (expected.has(`v${source}`) && !expected.has(`v${target}`)) {
                expected.add(`v${target}`);
                changed = true;
              }
            }
          }
          const actual = computeImpact({
            sourceVersionId: "v0",
            delta: { selectors: [{ kind: "unknown", value: "*" }] },
            edges,
          });
          expect(new Set(actual.affectedNodes.map((node) => node.versionId))).toEqual(expected);
        },
      ),
    );
  });
});

function output(versionId: string, state: OutputObject["lifecycleState"]): OutputObject {
  return {
    id: `output-${versionId}`,
    tenantId: "tenant-1",
    projectId: "project-1",
    logicalId: versionId.split("@")[0] ?? versionId,
    versionId,
    outputType: "sql",
    contentRef: `arc://${versionId}`,
    contentDigest: digestA,
    parentVersionIds: [],
    lifecycleState: state,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("invalidation plans", () => {
  it("keeps an already invalidated Output terminal on repeated invalidation", () => {
    const plan = createInvalidationPlan({
      sourceVersionId: "source@v1",
      delta: { selectors: [{ kind: "unknown", value: "*" }] },
      reason: "Repeated correction",
      createdAt: now,
      edges: [],
      outputs: [output("source@v1", "INVALIDATED")],
      evidence: [],
      effectIntents: [],
      receipts: [],
    });
    expect(plan.outputTransitions).toEqual([]);
  });

  it("stales descendants and Evidence while preserving Receipts and creating remediation", () => {
    const scope = {
      subjectVersionId: "derived@v1",
      verifierType: "test",
      verifierVersion: "1",
      dependencyDigests: [digestA],
    };
    const evidence: EvidenceObject = {
      id: "evidence-1",
      tenantId: "tenant-1",
      ...scope,
      verdict: "PASS",
      metrics: {},
      fingerprint: evidenceFingerprint(scope),
      createdAt: now,
    };
    const intent: EffectIntent = {
      id: "effect-1",
      tenantId: "tenant-1",
      sourceOutputVersionId: "derived@v1",
      connectorType: "email",
      target: "customer",
      resourceKey: "email/customer",
      argumentsRef: "arc://args/1",
      preconditions: {},
      expectedEffects: {},
      readSet: [],
      writeSet: ["mailbox"],
      idempotencyKey: "send-email-1",
      reversibility: "R3",
      riskLevel: "CRITICAL",
      status: "IRREVERSIBLE_COMMITTED",
      createdAt: now,
    };
    const receipt: EffectReceipt = {
      id: "receipt-1",
      intentId: intent.id,
      externalStatus: "sent",
      actualEffects: { messageId: "42" },
      committedAt: now,
      createdAt: now,
    };
    const outputs = [output("source@v1", "PROMOTED"), output("derived@v1", "COMMITTED")];
    const plan = createInvalidationPlan({
      sourceVersionId: "source@v1",
      delta: { selectors: [{ kind: "unknown", value: "*" }] },
      reason: "Upstream requirement was corrected",
      createdAt: now,
      edges: [edge("derived", "source@v1", "derived@v1")],
      outputs,
      evidence: [evidence],
      effectIntents: [intent],
      receipts: [receipt],
    });

    expect(plan.outputTransitions.map(({ versionId, to }) => [versionId, to])).toEqual([
      ["source@v1", "INVALIDATED"],
      ["derived@v1", "STALE"],
    ]);
    expect(plan.evidenceTransitions[0]?.to).toBe("STALE");
    expect(plan.preservedReceiptIds).toEqual(["receipt-1"]);
    expect(plan.remediationObligations[0]).toMatchObject({
      effectIntentId: "effect-1",
      requiresHumanApproval: true,
      status: "PENDING_APPROVAL",
    });
    expect(explainImpact(plan, "derived@v1")[0]).toContain("source@v1");

    const applied = applyInvalidationPlan(plan, outputs, [evidence]);
    expect(applied.outputs.map((record) => record.lifecycleState)).toEqual([
      "INVALIDATED",
      "STALE",
    ]);
    expect(applied.evidence[0]?.verdict).toBe("STALE");
    // Receipts are deliberately outside applyInvalidationPlan and cannot be erased.
    expect(receipt.externalStatus).toBe("sent");
  });
});

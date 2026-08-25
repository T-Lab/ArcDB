import { describe, expect, it } from "vitest";
import {
  normalizeDashboard,
  normalizeEffectDetail,
  normalizeImpact,
  normalizeList,
  normalizeOutputDetail,
  normalizeProject,
  normalizeTrace,
  normalizeTraceDetail,
  unwrapData,
} from "../normalizers";

describe("API response normalization", () => {
  it("accepts a data array with top-level pagination", () => {
    const result = normalizeList(
      {
        data: [{ id: "trace-1", name: "Agent run" }],
        page: { hasMore: true, nextCursor: "next-2", total: 9 },
      },
      normalizeTrace,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe("Agent run");
    expect(result.pagination).toMatchObject({ nextCursor: "next-2", total: 9 });
  });

  it("accepts nested items and pageInfo envelopes", () => {
    const result = normalizeList(
      {
        data: {
          items: [{ projectId: "p-1", projectName: "Safety" }],
          pageInfo: { endCursor: "cursor-2" },
        },
      },
      normalizeProject,
    );
    expect(result.items[0]).toMatchObject({ id: "p-1", name: "Safety" });
    expect(result.pagination.nextCursor).toBe("cursor-2");
  });

  it("only unwraps payloads that contain a data property", () => {
    expect(unwrapData({ data: 0 })).toBe(0);
    expect(unwrapData({ items: [] })).toEqual({ items: [] });
  });

  it("normalizes trace detail aliases and nested spans", () => {
    const trace = normalizeTraceDetail({
      data: {
        trace: { traceId: "t-1", operationName: "deploy", startTime: "2026-08-25T00:00:00Z" },
        observations: [{ spanId: "s-1", parentId: null, type: "tool", name: "database" }],
        scores: [{ id: "score-1", name: "correctness", value: 0.95 }],
      },
    });
    expect(trace).toMatchObject({ id: "t-1", name: "deploy" });
    expect(trace.spans[0]).toMatchObject({ id: "s-1", kind: "TOOL", name: "database" });
    expect(trace.scores[0]).toMatchObject({ name: "correctness", value: 0.95 });
  });

  it("keeps output artifact, evidence, and version history from one envelope", () => {
    const output = normalizeOutputDetail({
      data: {
        output: { id: "o-1", logicalId: "sql/index", versionId: "v-2", lifecycleState: "verified" },
        content: "CREATE INDEX",
        rawContent: "CREATE  INDEX CONCURRENTLY",
        evidence: [{ id: "e-1", verdict: "pass", verifierType: "shadow-db", verifierVersion: "2" }],
        versions: [{ versionId: "v-1", logicalId: "sql/index", lifecycleState: "SUPERSEDED" }],
        head: { versionId: "v-2" },
        effects: [{ id: "fx-1", connectorType: "postgres", target: "prod", status: "COMMITTED" }],
      },
    });
    expect(output.versionId).toBe("v-2");
    expect(output.artifact).toBe("CREATE  INDEX CONCURRENTLY");
    expect(output.evidence[0]?.verdict).toBe("PASS");
    expect(output.versions[0]?.versionId).toBe("v-1");
    expect(output.isHead).toBe(true);
    expect(output.effects[0]?.id).toBe("fx-1");
  });

  it("preserves unresolved effect records and remediation payloads", () => {
    const effect = normalizeEffectDetail({
      intent: {
        id: "fx-1",
        status: "RECONCILIATION_REQUIRED",
        connectorType: "postgres",
        target: "prod",
      },
      receipts: [{ id: "r-1", externalStatus: "UNKNOWN", actualEffects: { rows: 1 } }],
      remediations: [{ id: "rm-1", reason: "review production", status: "OPEN" }],
      reconciliation: { attempts: 2 },
    });
    expect(effect.status).toBe("RECONCILIATION_REQUIRED");
    expect(effect.receipts[0]?.actualEffects).toEqual({ rows: 1 });
    expect(effect.remediation[0]?.status).toBe("OPEN");
    expect(effect.reconciliation).toEqual({ attempts: 2 });
  });

  it("adapts the production impact-analysis response without counting skipped paths", () => {
    const impact = normalizeImpact(
      {
        data: {
          sourceVersionId: "output-source-v1",
          affectedNodes: [
            {
              versionId: "output-source-v1",
              generation: 0,
              selectors: [{ kind: "json_path", value: "$.refund.limit" }],
              viaEdgeIds: [],
            },
            {
              versionId: "output-refund-view-v3",
              generation: 1,
              selectors: [{ kind: "unknown", value: "*" }],
              viaEdgeIds: ["lineage-refund"],
            },
          ],
          skippedNodes: [
            {
              versionId: "output-user-view-v2",
              viaEdgeIds: ["lineage-user"],
              reasons: ["SELECTOR_DISJOINT"],
            },
          ],
          reasonGraph: [
            {
              edgeId: "lineage-refund",
              sourceVersionId: "output-source-v1",
              targetVersionId: "output-refund-view-v3",
              disposition: "AFFECTED",
              reason: "SELECTOR_INTERSECTION",
              detail: "Delta intersects the dependency selector",
            },
            {
              edgeId: "lineage-user",
              sourceVersionId: "output-source-v1",
              targetVersionId: "output-user-view-v2",
              disposition: "SKIPPED",
              reason: "SELECTOR_DISJOINT",
              detail: "Changed components do not intersect the dependency selector",
            },
          ],
          visitedEdgeCount: 2,
        },
        requestId: "request-1",
      },
      "requested-source",
    );

    expect(impact.sourceVersionId).toBe("output-source-v1");
    expect(impact.nodes).toEqual([
      expect.objectContaining({
        id: "output-source-v1",
        kind: "SOURCE OUTPUT",
        depth: 0,
      }),
      expect.objectContaining({
        id: "output-refund-view-v3",
        kind: "OUTPUT",
        depth: 1,
        metadata: {
          selectors: [{ kind: "unknown", value: "*" }],
          viaEdgeIds: ["lineage-refund"],
        },
      }),
    ]);
    expect(impact.edges).toEqual([
      {
        id: "lineage-refund",
        sourceVersionId: "output-source-v1",
        targetVersionId: "output-refund-view-v3",
        edgeType: "SELECTOR_INTERSECTION",
        selector: {
          disposition: "AFFECTED",
          detail: "Delta intersects the dependency selector",
        },
        inferred: true,
        confidence: undefined,
      },
    ]);
    expect(impact.affectedOutputs).toEqual([
      expect.objectContaining({
        id: "output-refund-view-v3",
        logicalId: "output-refund-view-v3",
        versionId: "output-refund-view-v3",
        lifecycleState: "UNKNOWN",
      }),
    ]);
  });

  it("drops malformed or internally inconsistent impact-analysis entries", () => {
    const impact = normalizeImpact(
      {
        data: {
          sourceVersionId: " ",
          affectedNodes: [
            {
              versionId: "requested-source-v1",
              generation: 0,
              selectors: [{ kind: "unknown", value: "*" }],
              viaEdgeIds: [],
            },
            {
              versionId: "bad-negative-generation",
              generation: -1,
              selectors: [{ kind: "unknown", value: "*" }],
              viaEdgeIds: [],
            },
            {
              versionId: "bad-selector",
              generation: 1,
              selectors: [{ kind: "unknown", value: "not-a-wildcard" }],
              viaEdgeIds: ["edge-bad-selector"],
            },
            {
              versionId: "bad-via-edges",
              generation: 1,
              selectors: [{ kind: "file", value: "query.sql" }],
              viaEdgeIds: [null],
            },
          ],
          reasonGraph: [
            {
              edgeId: "edge-missing-target",
              sourceVersionId: "requested-source-v1",
              targetVersionId: "not-in-affected-nodes",
              disposition: "AFFECTED",
              reason: "UNKNOWN_SELECTOR",
              detail: "Conservative propagation",
            },
            {
              edgeId: "edge-invalid-reason",
              sourceVersionId: "requested-source-v1",
              targetVersionId: "requested-source-v1",
              disposition: "AFFECTED",
              reason: "MADE_UP_REASON",
              detail: "Invalid contract value",
            },
          ],
        },
      },
      "requested-source-v1",
    );

    expect(impact.sourceVersionId).toBe("requested-source-v1");
    expect(impact.nodes).toEqual([
      expect.objectContaining({ id: "requested-source-v1", depth: 0 }),
    ]);
    expect(impact.edges).toEqual([]);
    expect(impact.affectedOutputs).toEqual([]);
  });

  it("keeps the first impact edge when affectedNodes omits the source node", () => {
    const impact = normalizeImpact(
      {
        data: {
          sourceVersionId: "source-v1",
          affectedNodes: [
            {
              versionId: "downstream-v2",
              generation: 1,
              selectors: [{ kind: "file", value: "query.sql" }],
              viaEdgeIds: ["lineage-1"],
            },
          ],
          reasonGraph: [
            {
              edgeId: "lineage-1",
              sourceVersionId: "source-v1",
              targetVersionId: "downstream-v2",
              disposition: "AFFECTED",
              reason: "SELECTOR_INTERSECTION",
              detail: "The changed file intersects the dependency selector",
            },
          ],
        },
      },
      "source-v1",
    );

    expect(impact.nodes).toEqual([expect.objectContaining({ id: "downstream-v2", depth: 1 })]);
    expect(impact.edges).toEqual([
      expect.objectContaining({
        id: "lineage-1",
        sourceVersionId: "source-v1",
        targetVersionId: "downstream-v2",
      }),
    ]);
    expect(impact.affectedOutputs).toEqual([
      expect.objectContaining({ versionId: "downstream-v2" }),
    ]);
  });

  it("retains compatibility with the graph-and-output impact response", () => {
    const impact = normalizeImpact(
      {
        data: {
          sourceVersionId: "source-v1",
          nodes: [
            { id: "source-v1", label: "Source", depth: 0 },
            { id: "downstream-v2", label: "Report", depth: 1 },
          ],
          edges: [
            {
              id: "lineage-1",
              sourceVersionId: "source-v1",
              targetVersionId: "downstream-v2",
              edgeType: "DERIVED_FROM",
              inferred: false,
            },
          ],
          affectedOutputs: [
            {
              versionId: "downstream-v2",
              logicalId: "daily-report",
              outputType: "report",
              lifecycleState: "VERIFIED",
            },
          ],
        },
      },
      "source-v1",
    );

    expect(impact.nodes).toHaveLength(2);
    expect(impact.edges).toEqual([
      expect.objectContaining({ id: "lineage-1", edgeType: "DERIVED_FROM" }),
    ]);
    expect(impact.affectedOutputs).toEqual([
      expect.objectContaining({
        versionId: "downstream-v2",
        logicalId: "daily-report",
        lifecycleState: "VERIFIED",
      }),
    ]);
  });

  it("does not invent dashboard counts", () => {
    const dashboard = normalizeDashboard({ data: { metrics: { traces: 12 } } });
    expect(dashboard.traceCount).toBe(12);
    expect(dashboard.outputCount).toBeUndefined();
    expect(dashboard.recentOutputs).toEqual([]);
  });

  it("normalizes the production dashboard aggregation field names", () => {
    const dashboard = normalizeDashboard({
      data: {
        runs24h: 4,
        traces24h: 7,
        outputsTotal: 12,
        staleOutputs: 2,
        openEffects: 3,
        reconciliationRequired: 1,
        openRemediations: 2,
      },
    });
    expect(dashboard).toMatchObject({
      runCount: 4,
      traceCount: 7,
      outputCount: 12,
      invalidatedOutputCount: 2,
      effectCount: 3,
      unresolvedEffectCount: 1,
      remediationCount: 2,
    });
  });
});

import { GitBranch, Search, Waypoints } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiErrorState } from "../../src/components/api-state";
import { JsonViewer } from "../../src/components/json-viewer";
import { EmptyState, PageHeader, Section } from "../../src/components/page";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, apiMutation, asRemoteResult, type RemoteResult } from "../../src/lib/api";
import { shortId } from "../../src/lib/format";
import { normalizeImpact } from "../../src/lib/normalizers";
import { parseImpact } from "../../src/lib/operator-validation";
import { ensureProjectId } from "../../src/lib/project-scope";
import { firstParam, type NextSearchParams } from "../../src/lib/query";
import { recordHref } from "../../src/lib/routes";
import type { ImpactResult, LineageNode } from "../../src/lib/types";

export const metadata: Metadata = { title: "Lineage & impact" };

function impactMutationInput(
  params: NextSearchParams,
  projectId: string | undefined,
  sourceVersionId: string,
): ReturnType<typeof parseImpact> | null {
  const selectorKind = firstParam(params.selectorKind);
  const selectorValue = firstParam(params.selectorValue);
  const beforeDigest = firstParam(params.beforeDigest);
  const afterDigest = firstParam(params.afterDigest);
  if (
    selectorKind === undefined &&
    selectorValue === undefined &&
    beforeDigest === undefined &&
    afterDigest === undefined
  ) {
    return null;
  }
  const formData = new FormData();
  formData.set("projectId", projectId ?? "");
  formData.set("sourceVersionId", sourceVersionId);
  formData.set("selectorKind", selectorKind ?? "");
  formData.set("selectorValue", selectorValue ?? "");
  formData.set("beforeDigest", beforeDigest ?? "");
  formData.set("afterDigest", afterDigest ?? "");
  return parseImpact(formData);
}

function invalidImpactResult(): RemoteResult<unknown> {
  return {
    ok: false,
    error: {
      status: 400,
      code: "INVALID_IMPACT_QUERY",
      message:
        "The selector-aware impact URL is invalid. Submit it again from the operator workbench.",
      requestId: undefined,
    },
  };
}

export default async function LineagePage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/lineage");
  const sourceVersionId = firstParam(params.sourceVersionId)?.trim();
  let result: RemoteResult<unknown> | undefined;
  let advancedImpact: ReturnType<typeof parseImpact> | null = null;
  if (sourceVersionId) {
    try {
      advancedImpact = impactMutationInput(params, projectId, sourceVersionId);
      result = await asRemoteResult(
        advancedImpact === null
          ? apiGet<unknown>("/v1/lineage/impact", { sourceVersionId, projectId })
          : apiMutation<unknown>("/v1/lineage/impact", {
              projectId: advancedImpact.projectId,
              body: advancedImpact.body,
            }),
      );
    } catch {
      result = invalidImpactResult();
    }
  }
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Reliability"
        title="Lineage & impact"
        description="Trace typed dependencies and explain which downstream output versions are affected by a correction."
      />
      <form
        className="lineage-search"
        action="/lineage"
        method="get"
        aria-label="Analyze lineage impact"
      >
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        {advancedImpact?.body.deltaSelectors[0] ? (
          <>
            <input
              type="hidden"
              name="selectorKind"
              value={advancedImpact.body.deltaSelectors[0].kind}
            />
            <input
              type="hidden"
              name="selectorValue"
              value={advancedImpact.body.deltaSelectors[0].value}
            />
            {advancedImpact.body.beforeDigest ? (
              <input type="hidden" name="beforeDigest" value={advancedImpact.body.beforeDigest} />
            ) : null}
            {advancedImpact.body.afterDigest ? (
              <input type="hidden" name="afterDigest" value={advancedImpact.body.afterDigest} />
            ) : null}
          </>
        ) : null}
        <div>
          <label htmlFor="source-version">Source version ID</label>
          <input
            id="source-version"
            name="sourceVersionId"
            defaultValue={sourceVersionId}
            placeholder="e.g. spec/payment-policy@v2"
            required
          />
        </div>
        <button className="button button-primary" type="submit">
          <Search size={14} /> Analyze impact
        </button>
      </form>
      {!sourceVersionId ? (
        <section className="panel">
          <EmptyState
            icon={GitBranch}
            title="Choose an output version"
            description="Impact analysis is evaluated by the ArcDB API. Enter an immutable source version ID; the web console does not infer causality from timestamps."
            code={"GET /v1/lineage/impact?sourceVersionId=<immutable-version-id>"}
          />
        </section>
      ) : result && !result.ok ? (
        <ApiErrorState error={result.error} />
      ) : result?.ok ? (
        <ImpactContent
          impact={normalizeImpact(result.data, sourceVersionId)}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}

function nodeSet(impact: ImpactResult): LineageNode[] {
  const byId = new Map(impact.nodes.map((node) => [node.id, node]));
  for (const output of impact.affectedOutputs) {
    if (!byId.has(output.versionId))
      byId.set(output.versionId, {
        id: output.versionId,
        label: output.logicalId || output.versionId,
        kind: output.outputType.toUpperCase(),
        state: output.lifecycleState,
        depth: undefined,
        metadata: output.metadata,
      });
  }
  if (!byId.has(impact.sourceVersionId))
    byId.set(impact.sourceVersionId, {
      id: impact.sourceVersionId,
      label: impact.sourceVersionId,
      kind: "SOURCE OUTPUT",
      state: undefined,
      depth: 0,
      metadata: {},
    });
  return [...byId.values()].sort(
    (left, right) =>
      (left.depth ?? Number.MAX_SAFE_INTEGER) - (right.depth ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

function ImpactContent({
  impact,
  projectId,
}: {
  impact: ImpactResult;
  projectId: string | undefined;
}): React.JSX.Element {
  const nodes = nodeSet(impact);
  const noImpact =
    impact.affectedOutputs.length === 0 &&
    impact.edges.length === 0 &&
    impact.nodes.filter((node) => node.id !== impact.sourceVersionId).length === 0;
  return (
    <>
      <div className="impact-summary">
        <article className="impact-stat">
          <strong>{impact.affectedOutputs.length}</strong>
          <span>Affected outputs</span>
        </article>
        <article className="impact-stat">
          <strong>{impact.edges.length}</strong>
          <span>Typed edges</span>
        </article>
        <article className="impact-stat">
          <strong>{Math.max(0, nodes.length - 1)}</strong>
          <span>Downstream nodes</span>
        </article>
      </div>
      {noImpact ? (
        <section className="panel">
          <EmptyState
            icon={Waypoints}
            title="No downstream impact found"
            description="The API returned no downstream nodes or typed edges for this version. This is a real empty analysis result."
          />
        </section>
      ) : (
        <div className="detail-stack">
          <Section
            title="Impact graph"
            description="Node cards returned by the impact API; inferred edges remain explicitly labeled"
          >
            <div className="lineage-canvas">
              {nodes.map((node) => (
                <article
                  className={`lineage-node${node.id === impact.sourceVersionId ? " source" : ""}`}
                  key={node.id}
                >
                  <header>
                    <span>{node.kind}</span>
                    {node.depth !== undefined ? <span>Depth {node.depth}</span> : null}
                  </header>
                  <h3 title={node.label}>{node.label}</h3>
                  <code title={node.id}>{shortId(node.id, 28)}</code>
                  {node.state ? (
                    <div style={{ marginTop: 9 }}>
                      <StatusBadge value={node.state} />
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </Section>
          <Section
            title="Dependency paths"
            description="Explicit edge type, selector, and inference confidence"
          >
            {impact.edges.length === 0 ? (
              <div className="panel-body muted">No typed edges were returned.</div>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Relationship</th>
                      <th>Target</th>
                      <th>Selector</th>
                      <th>Provenance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.edges.map((edge) => (
                      <tr key={edge.id}>
                        <td>
                          <Link
                            className="row-link mono"
                            href={recordHref("outputs", edge.sourceVersionId, projectId)}
                          >
                            {shortId(edge.sourceVersionId, 22)}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge value={edge.edgeType} />
                        </td>
                        <td>
                          <Link
                            className="row-link mono"
                            href={recordHref("outputs", edge.targetVersionId, projectId)}
                          >
                            {shortId(edge.targetVersionId, 22)}
                          </Link>
                        </td>
                        <td className="mono">
                          {edge.selector === undefined
                            ? "—"
                            : typeof edge.selector === "string"
                              ? edge.selector
                              : JSON.stringify(edge.selector)}
                        </td>
                        <td>
                          {edge.inferred
                            ? `Inferred${edge.confidence === undefined ? "" : ` · ${Math.round(edge.confidence * 100)}%`}`
                            : "Declared"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section
            title="Affected output versions"
            description="Candidate versions for invalidation or selective recomputation"
          >
            {impact.affectedOutputs.length === 0 ? (
              <div className="panel-body muted">No affected output records were returned.</div>
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Output</th>
                      <th>Version</th>
                      <th>State</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {impact.affectedOutputs.map((output) => (
                      <tr key={output.versionId}>
                        <td>{output.logicalId}</td>
                        <td>
                          <Link
                            className="row-link mono"
                            href={recordHref("outputs", output.versionId, projectId)}
                          >
                            {shortId(output.versionId, 28)}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge value={output.lifecycleState} />
                        </td>
                        <td>{output.outputType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
          <Section
            title="Recomputation plan"
            description="Server-generated plan; no action is executed from this read-only view"
          >
            <div className="panel-body">
              <JsonViewer value={impact.recomputationPlan ?? null} label="Plan" />
            </div>
          </Section>
        </div>
      )}
    </>
  );
}

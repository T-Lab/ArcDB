import { Boxes, ChevronRight, GitBranch, History, ShieldCheck, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorState } from "../../../src/components/api-state";
import { JsonViewer } from "../../../src/components/json-viewer";
import { KeyValueGrid } from "../../../src/components/key-value";
import { EmptyState, PageHeader, Section } from "../../../src/components/page";
import { StatusBadge } from "../../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../../src/lib/api";
import { formatDateTime, shortId } from "../../../src/lib/format";
import { normalizeOutputDetail } from "../../../src/lib/normalizers";
import { ensureProjectId } from "../../../src/lib/project-scope";
import type { NextSearchParams } from "../../../src/lib/query";
import { projectHref, recordHref } from "../../../src/lib/routes";
import type { Evidence, OutputDetail } from "../../../src/lib/types";

export const metadata: Metadata = { title: "Output detail" };

const happyPath = [
  "CREATED",
  "STAGED",
  "VERIFIED",
  "APPROVED",
  "COMMITTED",
  "CONSUMED",
  "PROMOTED",
];

function Lifecycle({ state }: { state: string }): React.JSX.Element {
  const knownIndex = happyPath.indexOf(state);
  const steps = knownIndex >= 0 ? happyPath : ["CREATED", state];
  return (
    <ol className="lifecycle-strip" aria-label={`Lifecycle state: ${state}`}>
      {steps.map((step, index) => (
        <li
          className={`lifecycle-step ${knownIndex >= 0 && index < knownIndex ? "complete" : index === (knownIndex >= 0 ? knownIndex : steps.length - 1) ? "current" : ""}`}
          key={step}
        >
          <span>{step.replaceAll("_", " ")}</span>
        </li>
      ))}
    </ol>
  );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }): React.JSX.Element {
  if (evidence.length === 0)
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No evidence attached"
        description="This version has no verifier records in the API response. Treat its reliability as unestablished."
      />
    );
  return (
    <div className="evidence-list">
      {evidence.map((item) => (
        <article className="evidence-item" key={item.id}>
          <div className="item-heading">
            <div>
              <h3>
                {item.verifierType} <span className="muted">v{item.verifierVersion}</span>
              </h3>
              <p>
                Evidence {shortId(item.id, 24)} · {formatDateTime(item.createdAt)}
              </p>
            </div>
            <div className="page-actions">
              {item.freshnessStatus ? (
                <StatusBadge value={item.freshnessStatus} prefix="Freshness" />
              ) : null}
              <StatusBadge value={item.verdict} prefix="Verdict" />
            </div>
          </div>
          <div className="item-metadata">
            <span>
              <strong>Confidence</strong>
              {item.confidence === undefined ? "—" : `${Math.round(item.confidence * 100)}%`}
            </span>
            <span>
              <strong>Expires</strong>
              {formatDateTime(item.expiresAt)}
            </span>
            <span>
              <strong>Policy</strong>
              {item.policyVersion ?? "—"}
            </span>
            <span>
              <strong>Environment</strong>
              <code>{shortId(item.environmentDigest)}</code>
            </span>
            {item.freshnessReasons.length > 0 ? (
              <span>
                <strong>Freshness reasons</strong>
                {item.freshnessReasons.join(", ").replaceAll("_", " ")}
              </span>
            ) : null}
          </div>
          {Object.keys(item.metrics).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <JsonViewer value={item.metrics} label="Verifier metrics" />
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export default async function OutputDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ versionId: string }>;
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const [{ versionId }, queryParams] = await Promise.all([params, searchParams]);
  const projectId = await ensureProjectId(queryParams, `/outputs/${encodeURIComponent(versionId)}`);
  const result = await asRemoteResult(
    apiGet<unknown>(`/v1/outputs/${encodeURIComponent(versionId)}`, { projectId }),
  );
  if (!result.ok && result.error.status === 404) notFound();
  return (
    <div className="page-container">
      <div className="breadcrumbs">
        <Link href={projectHref("/outputs", projectId)}>Outputs</Link>
        <ChevronRight size={11} />
        <span>{shortId(versionId, 30)}</span>
      </div>
      {!result.ok ? (
        <>
          <PageHeader title="Output detail" />
          <ApiErrorState error={result.error} />
        </>
      ) : (
        <OutputContent output={normalizeOutputDetail(result.data)} projectId={projectId} />
      )}
    </div>
  );
}

function OutputContent({
  output,
  projectId,
}: {
  output: OutputDetail;
  projectId: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <PageHeader
        eyebrow={output.outputType}
        title={output.logicalId || "Output version"}
        description={`Immutable version ${output.versionId}`}
        actions={
          <>
            <Link
              className="button button-secondary"
              href={projectHref(
                `/operate?versionId=${encodeURIComponent(output.versionId)}`,
                projectId,
              )}
            >
              <Wrench size={14} /> Operate
            </Link>
            <Link
              className="button button-secondary"
              href={projectHref(
                `/lineage?sourceVersionId=${encodeURIComponent(output.versionId)}`,
                projectId,
              )}
            >
              <GitBranch size={14} /> Impact
            </Link>
            <StatusBadge value={output.lifecycleState} />
          </>
        }
      />
      {output.lifecycleState === "STALE" || output.lifecycleState === "INVALIDATED" ? (
        <div className="critical-banner">
          <ShieldCheck size={18} />
          <div>
            <h2>This output is {output.lifecycleState.toLowerCase()}</h2>
            <p>
              Inspect evidence and lineage before consuming this version. Historical content remains
              immutable.
            </p>
          </div>
        </div>
      ) : null}
      <Section
        title="Lifecycle"
        description="Current server-authoritative state for this immutable version"
      >
        <Lifecycle state={output.lifecycleState} />
      </Section>
      <div className="detail-grid">
        <div className="detail-stack">
          <Section
            title="Artifact"
            description="Raw artifact and structured metadata are displayed side by side"
          >
            {output.artifact === undefined ? (
              <EmptyState
                icon={Boxes}
                title="Artifact content was not returned"
                description={
                  output.contentRef
                    ? `The API returned content reference ${output.contentRef}, but did not include resolved bytes.`
                    : "The API response did not include artifact content or a content reference."
                }
              />
            ) : (
              <div className="json-pair">
                <JsonViewer value={output.artifact} label="Raw artifact" />
                <JsonViewer value={output.metadata} label="Metadata" />
              </div>
            )}
          </Section>
          <Section
            title="Evidence"
            description="Verifier, environment, policy, freshness, and metrics"
          >
            <EvidenceList evidence={output.evidence} />
          </Section>
          <Section
            title="Version history"
            description="Immutable versions sharing this logical output identity"
          >
            {output.versions.length === 0 ? (
              <EmptyState
                icon={History}
                title="No version history returned"
                description="Only the current version is available in this API response."
              />
            ) : (
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>State</th>
                      <th>Digest</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {output.versions.map((version) => (
                      <tr key={version.versionId}>
                        <td>
                          <Link
                            className="row-link mono"
                            href={recordHref("outputs", version.versionId, projectId)}
                          >
                            {shortId(version.versionId, 28)}
                          </Link>
                        </td>
                        <td>
                          <StatusBadge value={version.lifecycleState} />
                        </td>
                        <td className="mono">{shortId(version.contentDigest, 24)}</td>
                        <td className="nowrap">{formatDateTime(version.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
        <div className="detail-stack">
          <Section title="Version facts" description="Identity and provenance">
            <KeyValueGrid
              items={[
                { label: "Version ID", value: <code>{output.versionId}</code> },
                { label: "Output ID", value: <code>{output.id}</code> },
                { label: "Logical ID", value: output.logicalId || "—" },
                { label: "Content digest", value: <code>{output.contentDigest ?? "—"}</code> },
                { label: "Content ref", value: <code>{output.contentRef ?? "—"}</code> },
                { label: "Policy", value: output.policyVersion ?? "—" },
                {
                  label: "Branch head",
                  value: output.isHead === undefined ? "—" : output.isHead ? "Yes" : "No",
                },
                { label: "Created", value: formatDateTime(output.createdAt) },
                { label: "Updated", value: formatDateTime(output.updatedAt) },
              ]}
            />
          </Section>
          <Section title="Provenance" description="Producer and parent versions">
            <KeyValueGrid
              items={[
                {
                  label: "Producer run",
                  value: output.producerRunId ? (
                    <Link
                      className="row-link"
                      href={recordHref("traces", output.producerRunId, projectId)}
                    >
                      {shortId(output.producerRunId, 28)}
                    </Link>
                  ) : (
                    "—"
                  ),
                },
                { label: "Producer agent", value: output.producerAgentId ?? "—" },
                {
                  label: "Parent versions",
                  value:
                    output.parentVersionIds.length > 0
                      ? output.parentVersionIds.map((id) => (
                          <div key={id}>
                            <Link
                              className="row-link mono"
                              href={recordHref("outputs", id, projectId)}
                            >
                              {shortId(id, 28)}
                            </Link>
                          </div>
                        ))
                      : "—",
                },
              ]}
            />
          </Section>
          <Section
            title="Caused effects"
            description="External consequences linked to this output version"
          >
            {output.effects.length === 0 ? (
              <div className="panel-body muted">No linked effect intents were returned.</div>
            ) : (
              <div className="receipt-list">
                {output.effects.map((effect) => (
                  <article className="receipt-item" key={effect.id}>
                    <div className="item-heading">
                      <div>
                        <h3>{effect.target}</h3>
                        <p>{effect.connectorType}</p>
                      </div>
                      <StatusBadge value={effect.status} />
                    </div>
                    <Link
                      className="button button-ghost"
                      href={recordHref("effects", effect.id, projectId)}
                    >
                      Open intent
                    </Link>
                  </article>
                ))}
              </div>
            )}
          </Section>
          <Section title="Raw record" description="Complete detail envelope from the API">
            <div className="panel-body">
              <JsonViewer value={output.raw} label="Output response" />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

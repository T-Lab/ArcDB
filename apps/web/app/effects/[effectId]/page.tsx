import {
  AlertTriangle,
  ChevronRight,
  ExternalLink,
  RotateCcw,
  ShieldAlert,
  Wrench,
} from "lucide-react";
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
import { normalizeEffectDetail } from "../../../src/lib/normalizers";
import { ensureProjectId } from "../../../src/lib/project-scope";
import type { NextSearchParams } from "../../../src/lib/query";
import { projectHref, recordHref } from "../../../src/lib/routes";
import type { EffectDetail } from "../../../src/lib/types";

export const metadata: Metadata = { title: "Effect detail" };

export default async function EffectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ effectId: string }>;
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const [{ effectId }, queryParams] = await Promise.all([params, searchParams]);
  const projectId = await ensureProjectId(queryParams, `/effects/${encodeURIComponent(effectId)}`);
  const result = await asRemoteResult(
    apiGet<unknown>(`/v1/effects/${encodeURIComponent(effectId)}`, { projectId }),
  );
  if (!result.ok && result.error.status === 404) notFound();
  return (
    <div className="page-container">
      <div className="breadcrumbs">
        <Link href={projectHref("/effects", projectId)}>Effects</Link>
        <ChevronRight size={11} />
        <span>{shortId(effectId, 30)}</span>
      </div>
      {!result.ok ? (
        <>
          <PageHeader title="Effect detail" />
          <ApiErrorState error={result.error} />
        </>
      ) : (
        <EffectContent effect={normalizeEffectDetail(result.data)} projectId={projectId} />
      )}
    </div>
  );
}

function EffectContent({
  effect,
  projectId,
}: {
  effect: EffectDetail;
  projectId: string | undefined;
}): React.JSX.Element {
  const unresolved = effect.status === "RECONCILIATION_REQUIRED";
  const remediationRequired =
    effect.status === "REMEDIATION_REQUIRED" ||
    effect.remediation.some((item) => !["RESOLVED", "WAIVED"].includes(item.status));
  return (
    <>
      <PageHeader
        eyebrow={`${effect.connectorType} effect`}
        title={effect.target}
        description={`Intent ${effect.id}`}
        actions={
          <>
            <Link
              className="button button-secondary"
              href={projectHref(`/operate?effectId=${encodeURIComponent(effect.id)}`, projectId)}
            >
              <Wrench size={14} /> Operate
            </Link>
            <StatusBadge value={effect.riskLevel} prefix="Risk" />
            <StatusBadge value={effect.status} />
          </>
        }
      />
      {unresolved ? (
        <div className="critical-banner">
          <AlertTriangle size={19} />
          <div>
            <h2>External outcome is unknown — reconciliation required</h2>
            <p>
              Do not retry this effect blindly. Inspect immutable receipts and use only connector
              capabilities that the intent actually records. The manual connector requires an
              operator-provided receipt because it cannot query external state.
            </p>
          </div>
        </div>
      ) : null}
      {remediationRequired ? (
        <div className="critical-banner">
          <RotateCcw size={19} />
          <div>
            <h2>A remediation obligation is open</h2>
            <p>
              The committed receipt remains immutable. Resolve or waive the obligation through the
              authorized lifecycle API.
            </p>
          </div>
        </div>
      ) : null}
      <div className="detail-grid">
        <div className="detail-stack">
          <Section
            title="Receipts"
            description="Immutable responses recorded after external execution"
          >
            {effect.receipts.length === 0 ? (
              <EmptyState
                icon={ExternalLink}
                title="No receipts recorded"
                description={
                  effect.status === "PREPARED"
                    ? "The intent is prepared but has not produced an external receipt."
                    : "The API response contains no receipt. Verify connector state before retrying."
                }
              />
            ) : (
              <div className="receipt-list">
                {effect.receipts.map((receipt, index) => (
                  <article className="receipt-item" key={receipt.id}>
                    <div className="item-heading">
                      <div>
                        <h3>
                          Receipt {index + 1} · {shortId(receipt.id, 24)}
                        </h3>
                        <p>{formatDateTime(receipt.committedAt ?? receipt.createdAt)}</p>
                      </div>
                      <StatusBadge value={receipt.externalStatus} />
                    </div>
                    <div className="item-metadata">
                      <span>
                        <strong>External transaction</strong>
                        <code>{receipt.externalTransactionId ?? "—"}</code>
                      </span>
                      <span>
                        <strong>Before</strong>
                        <code>{shortId(receipt.beforeDigest)}</code>
                      </span>
                      <span>
                        <strong>After</strong>
                        <code>{shortId(receipt.afterDigest)}</code>
                      </span>
                      <span>
                        <strong>Compensation</strong>
                        {receipt.compensationStatus ?? "—"}
                      </span>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <JsonViewer value={receipt.actualEffects} label="Actual effects" />
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>
          <Section
            title="Reconciliation"
            description="Connector lookup state for uncertain external outcomes"
          >
            {effect.reconciliation ? (
              <div className="panel-body">
                <JsonViewer value={effect.reconciliation} label="Reconciliation state" />
              </div>
            ) : (
              <EmptyState
                icon={ShieldAlert}
                title="No reconciliation record returned"
                description={
                  unresolved
                    ? "This intent is marked RECONCILIATION_REQUIRED but no structured reconciliation payload was returned. Escalate this inconsistency."
                    : "This effect does not currently expose a reconciliation record."
                }
              />
            )}
          </Section>
          <Section
            title="Remediation obligations"
            description="Follow-up work for effects that cannot simply be rolled back"
          >
            {effect.remediation.length === 0 ? (
              <EmptyState
                icon={RotateCcw}
                title="No remediation obligations"
                description="The effect detail response contains no remediation obligation."
              />
            ) : (
              <div className="remediation-list">
                {effect.remediation.map((item) => (
                  <article className="remediation-item" key={item.id}>
                    <div className="item-heading">
                      <div>
                        <h3>{item.reason}</h3>
                        <p>
                          {shortId(item.id, 26)} · {formatDateTime(item.createdAt)}
                        </p>
                      </div>
                      <StatusBadge value={item.status} />
                    </div>
                    <div className="item-metadata">
                      <span>
                        <strong>Risk</strong>
                        {item.riskLevel}
                      </span>
                      <span>
                        <strong>Human approval</strong>
                        {item.requiresHumanApproval === undefined
                          ? "—"
                          : item.requiresHumanApproval
                            ? "Required"
                            : "Not required"}
                      </span>
                    </div>
                    {!["RESOLVED", "WAIVED"].includes(item.status) ? (
                      <div style={{ marginTop: 12 }}>
                        <Link
                          className="button button-secondary"
                          href={projectHref(
                            `/operate?effectId=${encodeURIComponent(effect.id)}&remediationId=${encodeURIComponent(item.id)}&remediationStatus=${encodeURIComponent(item.status)}`,
                            projectId,
                          )}
                        >
                          <Wrench size={14} /> Transition obligation
                        </Link>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </Section>
        </div>
        <div className="detail-stack">
          <Section title="Effect intent" description="Durable local intent and safety controls">
            <KeyValueGrid
              items={[
                { label: "Intent ID", value: <code>{effect.id}</code> },
                { label: "Resource key", value: <code>{effect.resourceKey ?? "—"}</code> },
                { label: "Idempotency key", value: <code>{effect.idempotencyKey ?? "—"}</code> },
                { label: "Reversibility", value: effect.reversibility },
                { label: "Base resource version", value: effect.baseResourceVersion ?? "—" },
                { label: "Arguments ref", value: <code>{effect.argumentsRef ?? "—"}</code> },
                { label: "Compensation handler", value: effect.compensationHandler ?? "—" },
                { label: "Created", value: formatDateTime(effect.createdAt) },
              ]}
            />
          </Section>
          <Section title="Source output" description="Artifact version that caused this intent">
            <div className="panel-body">
              {effect.sourceOutputVersionId ? (
                <Link
                  className="button button-secondary"
                  href={recordHref("outputs", effect.sourceOutputVersionId, projectId)}
                >
                  Open {shortId(effect.sourceOutputVersionId, 26)}
                </Link>
              ) : (
                <span className="muted">No source output version was returned.</span>
              )}
            </div>
          </Section>
          <Section
            title="Expected change"
            description="Preconditions and declared expected effects"
          >
            <div className="json-pair">
              <JsonViewer value={effect.preconditions} label="Preconditions" />
              <JsonViewer value={effect.expectedEffects} label="Expected effects" />
            </div>
          </Section>
          <Section
            title="Connector arguments"
            description="Resolved and original connector payload"
          >
            <div className="json-pair">
              <JsonViewer value={effect.arguments ?? null} label="Parsed arguments" />
              <JsonViewer value={effect.rawArguments ?? null} label="Raw arguments" />
            </div>
          </Section>
          <Section title="Read / write set" description="Declared resource access boundary">
            <div className="json-pair">
              <JsonViewer value={effect.readSet} label="Read set" />
              <JsonViewer value={effect.writeSet} label="Write set" />
            </div>
          </Section>
          <Section title="Raw record" description="Complete detail envelope from the API">
            <div className="panel-body">
              <JsonViewer value={effect.raw} label="Effect response" />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

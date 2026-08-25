import { Search, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiErrorState } from "../../src/components/api-state";
import { EmptyState, PageHeader } from "../../src/components/page";
import { PaginationControls } from "../../src/components/pagination";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../src/lib/api";
import { formatDateTime, shortId } from "../../src/lib/format";
import { normalizeEffect, normalizeList } from "../../src/lib/normalizers";
import { ensureProjectId } from "../../src/lib/project-scope";
import { effectListQuery, firstParam, type NextSearchParams } from "../../src/lib/query";
import { recordHref } from "../../src/lib/routes";

export const metadata: Metadata = { title: "Effects" };

const statuses = [
  "",
  "PREPARED",
  "EXECUTING",
  "COMMITTED",
  "FAILED",
  "COMPENSATION_PENDING",
  "COMPENSATED",
  "REMEDIATION_REQUIRED",
  "IRREVERSIBLE_COMMITTED",
  "RECONCILIATION_REQUIRED",
];
const risks = ["", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

export default async function EffectsPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/effects");
  const result = await asRemoteResult(apiGet<unknown>("/v1/effects", effectListQuery(params)));
  const effects = result.ok ? normalizeList(result.data, normalizeEffect) : undefined;
  const unresolved =
    effects?.items.filter(
      (item) => item.status === "RECONCILIATION_REQUIRED" || item.status === "REMEDIATION_REQUIRED",
    ).length ?? 0;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Consequences"
        title="Effects"
        description="Inspect durable external effect intents, receipts, reconciliation, and remediation obligations."
        actions={unresolved > 0 ? <StatusBadge value={`${unresolved} unresolved`} /> : undefined}
      />
      {unresolved > 0 ? (
        <div className="critical-banner">
          <ShieldAlert size={18} aria-hidden="true" />
          <div>
            <h2>
              {unresolved} effect{unresolved === 1 ? "" : "s"} require attention in this page
            </h2>
            <p>
              Unknown external outcomes are never retried or hidden by this console. Open each
              intent to reconcile its receipt state.
            </p>
          </div>
        </div>
      ) : null}
      <form
        className="filter-bar"
        action="/effects"
        method="get"
        aria-label="Filter effect intents"
      >
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <div className="filter-field grow">
          <label htmlFor="effect-query">Search</label>
          <input
            id="effect-query"
            name="query"
            defaultValue={firstParam(params.query)}
            placeholder="Intent ID, target, resource key, or output…"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="effect-status">Status</label>
          <select id="effect-status" name="status" defaultValue={firstParam(params.status) ?? ""}>
            {statuses.map((status) => (
              <option value={status} key={status || "all"}>
                {status ? status.replaceAll("_", " ") : "All statuses"}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="effect-risk">Risk</label>
          <select
            id="effect-risk"
            name="riskLevel"
            defaultValue={firstParam(params.riskLevel) ?? ""}
          >
            {risks.map((risk) => (
              <option value={risk} key={risk || "all"}>
                {risk || "All risk levels"}
              </option>
            ))}
          </select>
        </div>
        <button className="button button-secondary" type="submit">
          <Search size={14} /> Apply filters
        </button>
      </form>
      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : effects && effects.items.length > 0 ? (
        <section className="panel">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Intent</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Connector / target</th>
                  <th>Reversibility</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {effects.items.map((effect) => (
                  <tr key={effect.id}>
                    <td>
                      <div className="table-primary">
                        <Link
                          className="row-link mono"
                          href={recordHref("effects", effect.id, projectId)}
                        >
                          {shortId(effect.id, 28)}
                        </Link>
                        <small>{effect.resourceKey ?? "No resource key"}</small>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={effect.status} />
                    </td>
                    <td>
                      <StatusBadge value={effect.riskLevel} />
                    </td>
                    <td>
                      <div className="table-primary">
                        <span>{effect.connectorType}</span>
                        <small>{effect.target}</small>
                      </div>
                    </td>
                    <td>
                      <span className="mono">{effect.reversibility}</span>
                    </td>
                    <td className="nowrap">{formatDateTime(effect.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            pathname="/effects"
            params={params}
            pagination={effects.pagination}
            itemCount={effects.items.length}
          />
        </section>
      ) : (
        <section className="panel">
          <EmptyState
            icon={ShieldAlert}
            title="No effect intents found"
            description="Prepare an EffectIntent or adjust the filters. External calls are not represented as ordinary trace log lines."
            code={
              'await arcdb.effects.prepare({ sourceOutputVersionId, connectorType: "postgres", target, idempotencyKey })'
            }
          />
        </section>
      )}
    </div>
  );
}

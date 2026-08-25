import { Activity, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiErrorState } from "../../src/components/api-state";
import { EmptyState, PageHeader } from "../../src/components/page";
import { PaginationControls } from "../../src/components/pagination";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../src/lib/api";
import { formatDateTime, formatDuration, shortId } from "../../src/lib/format";
import { normalizeList, normalizeTrace } from "../../src/lib/normalizers";
import { ensureProjectId } from "../../src/lib/project-scope";
import { firstParam, type NextSearchParams, traceListQuery } from "../../src/lib/query";
import { recordHref } from "../../src/lib/routes";

export const metadata: Metadata = { title: "Traces" };

const traceStatuses = ["", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"];

export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const query = traceListQuery(params);
  const projectId = await ensureProjectId(params, "/traces");
  const result = await asRemoteResult(apiGet<unknown>("/v1/traces", query));
  const traces = result.ok ? normalizeList(result.data, normalizeTrace) : undefined;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Observe"
        title="Traces"
        description="Search agent runs and inspect nested execution, tool, and generation spans."
      />
      <form className="filter-bar" action="/traces" method="get" aria-label="Filter traces">
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <div className="filter-field grow">
          <label htmlFor="trace-query">Search</label>
          <input
            id="trace-query"
            name="query"
            defaultValue={firstParam(params.query)}
            placeholder="Trace name, ID, session, or agent…"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="trace-status">Status</label>
          <select id="trace-status" name="status" defaultValue={firstParam(params.status) ?? ""}>
            {traceStatuses.map((status) => (
              <option value={status} key={status || "all"}>
                {status || "All statuses"}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="trace-from">From</label>
          <input
            id="trace-from"
            type="datetime-local"
            name="from"
            defaultValue={firstParam(params.from)}
          />
        </div>
        <button className="button button-secondary" type="submit">
          <Search size={14} /> Apply filters
        </button>
      </form>
      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : traces && traces.items.length > 0 ? (
        <section className="panel">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Trace</th>
                  <th>Status</th>
                  <th>Agent / session</th>
                  <th>Spans</th>
                  <th>Duration</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {traces.items.map((trace) => (
                  <tr key={trace.id}>
                    <td>
                      <div className="table-primary">
                        <Link className="row-link" href={recordHref("traces", trace.id, projectId)}>
                          {trace.name}
                        </Link>
                        <small className="mono">{shortId(trace.id, 24)}</small>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={trace.status} />
                    </td>
                    <td>
                      <div className="table-primary">
                        <span>{trace.agentId ?? "—"}</span>
                        <small>
                          {trace.sessionId ? `Session ${shortId(trace.sessionId)}` : "No session"}
                        </small>
                      </div>
                    </td>
                    <td>{trace.spanCount ?? "—"}</td>
                    <td className="nowrap">{formatDuration(trace.durationMs)}</td>
                    <td className="nowrap">{formatDateTime(trace.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            pathname="/traces"
            params={params}
            pagination={traces.pagination}
            itemCount={traces.items.length}
          />
        </section>
      ) : (
        <section className="panel">
          <EmptyState
            icon={Activity}
            title="No traces match this view"
            description="Adjust the filters or ingest the first trace. ArcDB only shows runs returned by the API."
            code={
              'curl -X POST "$ARCDB_API_URL/v1/traces" -H "Authorization: Bearer $ARCDB_API_KEY" -d @trace.json'
            }
          />
        </section>
      )}
    </div>
  );
}

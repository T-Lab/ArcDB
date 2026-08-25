import { FileClock, Search } from "lucide-react";
import type { Metadata } from "next";
import { ApiErrorState } from "../../src/components/api-state";
import { JsonViewer } from "../../src/components/json-viewer";
import { EmptyState, PageHeader } from "../../src/components/page";
import { PaginationControls } from "../../src/components/pagination";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../src/lib/api";
import { formatDateTime, shortId } from "../../src/lib/format";
import { normalizeAuditEvent, normalizeList } from "../../src/lib/normalizers";
import { ensureProjectId } from "../../src/lib/project-scope";
import { auditListQuery, firstParam, type NextSearchParams } from "../../src/lib/query";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/audit");
  const result = await asRemoteResult(apiGet<unknown>("/v1/audit-events", auditListQuery(params)));
  const events = result.ok ? normalizeList(result.data, normalizeAuditEvent) : undefined;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Govern"
        title="Audit log"
        description="Immutable, tenant-scoped records of lifecycle transitions and privileged actions."
      />
      <form className="filter-bar" action="/audit" method="get" aria-label="Filter audit events">
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <div className="filter-field grow">
          <label htmlFor="audit-query">Search</label>
          <input
            id="audit-query"
            name="query"
            defaultValue={firstParam(params.query)}
            placeholder="Resource ID, request ID, or event…"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            name="action"
            defaultValue={firstParam(params.action)}
            placeholder="e.g. OUTPUT_PROMOTED"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="audit-actor">Actor</label>
          <input
            id="audit-actor"
            name="actor"
            defaultValue={firstParam(params.actor)}
            placeholder="User, service, or key"
          />
        </div>
        <button className="button button-secondary" type="submit">
          <Search size={14} /> Apply filters
        </button>
      </form>
      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : events && events.items.length > 0 ? (
        <section className="panel">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th>Outcome</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {events.items.map((event) => (
                  <tr key={event.id}>
                    <td className="nowrap">{formatDateTime(event.occurredAt)}</td>
                    <td>
                      <span className="mono">{event.action}</span>
                    </td>
                    <td>
                      <div className="table-primary">
                        <span>{event.actor}</span>
                        <small>{event.ipAddress ?? "IP not recorded"}</small>
                      </div>
                    </td>
                    <td>
                      <div className="table-primary">
                        <span>{event.resourceType}</span>
                        <small className="mono">{shortId(event.resourceId, 24)}</small>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={event.outcome} />
                    </td>
                    <td>
                      <details>
                        <summary className="muted">Inspect</summary>
                        <div style={{ minWidth: 320, marginTop: 8 }}>
                          <JsonViewer
                            value={{ requestId: event.requestId, ...event.metadata }}
                            label="Audit metadata"
                          />
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            pathname="/audit"
            params={params}
            pagination={events.pagination}
            itemCount={events.items.length}
          />
        </section>
      ) : (
        <section className="panel">
          <EmptyState
            icon={FileClock}
            title="No audit events found"
            description="No events matched the current server-side filters. ArcDB does not synthesize audit history."
          />
        </section>
      )}
    </div>
  );
}

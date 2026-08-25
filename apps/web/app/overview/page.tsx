import { Activity, ArrowRight, Boxes, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiErrorState } from "../../src/components/api-state";
import { EmptyState, PageHeader, Section } from "../../src/components/page";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../src/lib/api";
import { formatCompactNumber, formatDateTime, formatDuration, shortId } from "../../src/lib/format";
import { normalizeDashboard } from "../../src/lib/normalizers";
import { ensureProjectId } from "../../src/lib/project-scope";
import type { NextSearchParams } from "../../src/lib/query";
import { projectHref, recordHref } from "../../src/lib/routes";

export const metadata: Metadata = { title: "Overview" };

function ActivityChart({
  data,
}: {
  data: Array<{ label: string; value: number }>;
}): React.JSX.Element {
  const max = Math.max(...data.map((item) => item.value), 1);
  return (
    <div className="activity-chart" role="img" aria-label="Trace activity chart">
      {data.map((item) => (
        <div className="activity-bar" key={`${item.label}-${item.value}`}>
          <span style={{ height: `${Math.max(2, (item.value / max) * 100)}%` }} />
          <small>
            {item.label}: {item.value}
          </small>
        </div>
      ))}
    </div>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/overview");
  const result = await asRemoteResult(apiGet<unknown>("/v1/dashboard", { projectId }));
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Command center"
        title="Overview"
        description="Operational state across agent runs, output reliability, and external consequences."
      />
      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : (
        <OverviewContent data={normalizeDashboard(result.data)} projectId={projectId} />
      )}
    </div>
  );
}

function OverviewContent({
  data,
  projectId,
}: {
  data: ReturnType<typeof normalizeDashboard>;
  projectId: string | undefined;
}): React.JSX.Element {
  const noData =
    data.runCount === undefined &&
    data.traceCount === undefined &&
    data.outputCount === undefined &&
    data.effectCount === undefined &&
    data.remediationCount === undefined &&
    data.recentTraces.length === 0 &&
    data.recentOutputs.length === 0;
  if (noData) {
    return (
      <section className="panel">
        <EmptyState
          icon={Activity}
          title="No lifecycle activity yet"
          description="Ingest a trace and create an output to populate this dashboard. Counts are never synthesized by the web application."
          code={
            'curl -X POST "$ARCDB_API_URL/v1/traces" \\\n  -H "Authorization: Bearer $ARCDB_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d @trace.json'
          }
          action={
            <Link
              className="button button-secondary"
              href={projectHref("/settings/api-usage", projectId)}
            >
              View API setup
            </Link>
          }
        />
      </section>
    );
  }
  const metrics = [
    {
      label: "Runs · 24h",
      value: data.runCount,
      note: "Agent executions started",
      icon: Activity,
    },
    {
      label: "Traces · 24h",
      value: data.traceCount,
      note: "Execution traces started",
      icon: Activity,
    },
    {
      label: "Outputs",
      value: data.outputCount,
      note:
        data.verifiedOutputCount !== undefined
          ? `${data.verifiedOutputCount} verified`
          : "Total immutable versions",
      icon: Boxes,
    },
    {
      label: "Needs attention",
      value:
        data.unresolvedEffectCount === undefined && data.remediationCount === undefined
          ? undefined
          : (data.unresolvedEffectCount ?? 0) + (data.remediationCount ?? 0),
      note:
        data.remediationCount !== undefined
          ? `${data.remediationCount} open remediation obligations`
          : data.invalidatedOutputCount !== undefined
            ? `${data.invalidatedOutputCount} stale outputs`
            : "Unresolved consequences",
      icon: ShieldAlert,
      warning: (data.unresolvedEffectCount ?? 0) + (data.remediationCount ?? 0) > 0,
    },
  ];
  return (
    <>
      <div className="metric-grid">
        {metrics.map(({ label, value, note, icon: Icon, warning }) => (
          <article className="metric-card" key={label}>
            <header>
              <span>{label}</span>
              <Icon size={16} aria-hidden="true" />
            </header>
            <p className="metric-value">{formatCompactNumber(value)}</p>
            <p className={`metric-note${warning ? " warning" : ""}`}>{note}</p>
          </article>
        ))}
      </div>
      <div className="dashboard-grid">
        <Section title="Trace activity" description="Volume reported by the dashboard API">
          {data.activity.length > 0 ? (
            <ActivityChart data={data.activity} />
          ) : (
            <div className="panel-body muted">No time-series buckets were returned.</div>
          )}
        </Section>
        <Section title="Lifecycle posture" description="Verified and invalidated output state">
          <div className="panel-body">
            <dl className="key-value-grid">
              <div>
                <dt>Verified outputs</dt>
                <dd>{formatCompactNumber(data.verifiedOutputCount)}</dd>
              </div>
              <div>
                <dt>Invalidated outputs</dt>
                <dd>{formatCompactNumber(data.invalidatedOutputCount)}</dd>
              </div>
              <div>
                <dt>Unresolved effects</dt>
                <dd>{formatCompactNumber(data.unresolvedEffectCount)}</dd>
              </div>
              <div>
                <dt>Open effects</dt>
                <dd>{formatCompactNumber(data.effectCount)}</dd>
              </div>
            </dl>
          </div>
        </Section>
      </div>
      <div className="dashboard-grid">
        <Section
          title="Recent traces"
          description="Latest agent execution paths"
          action={
            <Link className="button button-ghost" href={projectHref("/traces", projectId)}>
              Explore <ArrowRight size={14} />
            </Link>
          }
        >
          {data.recentTraces.length === 0 ? (
            <div className="panel-body muted">No recent traces were returned.</div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Trace</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Started</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentTraces.slice(0, 8).map((trace) => (
                    <tr key={trace.id}>
                      <td>
                        <Link className="row-link" href={recordHref("traces", trace.id, projectId)}>
                          {trace.name}
                        </Link>
                        <div className="mono muted">{shortId(trace.id)}</div>
                      </td>
                      <td>
                        <StatusBadge value={trace.status} />
                      </td>
                      <td>{formatDuration(trace.durationMs)}</td>
                      <td className="nowrap">{formatDateTime(trace.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section
          title="Recent outputs"
          description="Latest artifact versions"
          action={
            <Link className="button button-ghost" href={projectHref("/outputs", projectId)}>
              Browse <ArrowRight size={14} />
            </Link>
          }
        >
          {data.recentOutputs.length === 0 ? (
            <div className="panel-body muted">No recent outputs were returned.</div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Output</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOutputs.slice(0, 8).map((output) => (
                    <tr key={output.versionId}>
                      <td>
                        <Link
                          className="row-link"
                          href={recordHref("outputs", output.versionId, projectId)}
                        >
                          {output.logicalId || shortId(output.versionId)}
                        </Link>
                        <div className="mono muted">{shortId(output.versionId)}</div>
                      </td>
                      <td>
                        <StatusBadge value={output.lifecycleState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

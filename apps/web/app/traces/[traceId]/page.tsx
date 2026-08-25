import { Activity, Braces, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiErrorState } from "../../../src/components/api-state";
import { JsonViewer } from "../../../src/components/json-viewer";
import { KeyValueGrid } from "../../../src/components/key-value";
import { EmptyState, PageHeader, Section } from "../../../src/components/page";
import { StatusBadge } from "../../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../../src/lib/api";
import { formatDateTime, formatDuration, shortId } from "../../../src/lib/format";
import { normalizeTraceDetail } from "../../../src/lib/normalizers";
import { ensureProjectId } from "../../../src/lib/project-scope";
import type { NextSearchParams } from "../../../src/lib/query";
import { projectHref } from "../../../src/lib/routes";
import { buildSpanForest, flattenSpanTree } from "../../../src/lib/span-tree";
import type { Span, TraceDetail } from "../../../src/lib/types";

export const metadata: Metadata = { title: "Trace detail" };

function timeValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function computedDuration(span: Span): number | undefined {
  if (span.durationMs !== undefined) return span.durationMs;
  const start = timeValue(span.startedAt);
  const end = timeValue(span.endedAt);
  return start !== undefined && end !== undefined ? Math.max(0, end - start) : undefined;
}

function Timeline({ trace }: { trace: TraceDetail }): React.JSX.Element {
  const rows = flattenSpanTree(buildSpanForest(trace.spans));
  const starts = rows.flatMap(({ span }) => {
    const value = timeValue(span.startedAt);
    return value === undefined ? [] : [value];
  });
  const ends = rows.flatMap(({ span }) => {
    const start = timeValue(span.startedAt);
    const duration = computedDuration(span);
    const end =
      timeValue(span.endedAt) ??
      (start !== undefined && duration !== undefined ? start + duration : undefined);
    return end === undefined ? [] : [end];
  });
  const rangeStart = starts.length > 0 ? Math.min(...starts) : 0;
  const rangeEnd = ends.length > 0 ? Math.max(...ends) : rangeStart + 1;
  const range = Math.max(rangeEnd - rangeStart, 1);
  return (
    <div className="timeline">
      <div className="timeline-scale">
        <span>Observation</span>
        <div>
          <span>0 ms</span>
          <span>{formatDuration(range)}</span>
        </div>
        <span>Duration</span>
      </div>
      {rows.map(({ span, depth }) => {
        const start = timeValue(span.startedAt);
        const duration = computedDuration(span);
        const left = start === undefined ? 0 : ((start - rangeStart) / range) * 100;
        const width = duration === undefined ? 1 : Math.max(0.5, (duration / range) * 100);
        return (
          <div className="span-row" data-status={span.status} id={`span-${span.id}`} key={span.id}>
            <div className="span-label">
              <span className="span-depth" style={{ "--depth": depth } as React.CSSProperties} />
              <span className="span-kind">{span.kind.slice(0, 2)}</span>
              <span className="span-name" title={span.name}>
                {span.name}
              </span>
            </div>
            <div
              className="span-track"
              role="img"
              aria-label={`${span.name}: ${formatDuration(duration)}`}
            >
              <span
                className="span-bar"
                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              />
            </div>
            <span className="span-duration">{formatDuration(duration)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const [{ traceId }, queryParams] = await Promise.all([params, searchParams]);
  const projectId = await ensureProjectId(queryParams, `/traces/${encodeURIComponent(traceId)}`);
  const result = await asRemoteResult(
    apiGet<unknown>(`/v1/traces/${encodeURIComponent(traceId)}`, { projectId }),
  );
  if (!result.ok && result.error.status === 404) notFound();
  return (
    <div className="page-container">
      <div className="breadcrumbs">
        <Link href={projectHref("/traces", projectId)}>Traces</Link>
        <ChevronRight size={11} />
        <span>{shortId(traceId, 28)}</span>
      </div>
      {!result.ok ? (
        <>
          <PageHeader title="Trace detail" />
          <ApiErrorState error={result.error} />
        </>
      ) : (
        <TraceContent trace={normalizeTraceDetail(result.data)} projectId={projectId} />
      )}
    </div>
  );
}

function TraceContent({
  trace,
  projectId,
}: {
  trace: TraceDetail;
  projectId: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <PageHeader
        eyebrow="Execution trace"
        title={trace.name}
        description={trace.id}
        actions={<StatusBadge value={trace.status} />}
      />
      <Section title="Trace summary" description="Server-reported execution identity and timing">
        <KeyValueGrid
          items={[
            { label: "Trace ID", value: <code>{trace.id}</code> },
            { label: "Started", value: formatDateTime(trace.startedAt) },
            { label: "Ended", value: formatDateTime(trace.endedAt) },
            { label: "Duration", value: formatDuration(trace.durationMs) },
            { label: "Agent", value: trace.agentId ?? "—" },
            { label: "Session", value: trace.sessionId ?? "—" },
            { label: "Spans", value: trace.spans.length },
            { label: "Outputs", value: trace.outputCount ?? "—" },
          ]}
        />
      </Section>
      <div className="detail-grid">
        <div className="detail-stack">
          <Section
            title="Timeline"
            description="Nested spans positioned against the trace execution window"
          >
            {trace.spans.length > 0 ? (
              <Timeline trace={trace} />
            ) : (
              <EmptyState
                icon={Activity}
                title="No spans were returned"
                description="The trace exists, but its detail response did not include spans or observations."
              />
            )}
          </Section>
          <Section
            title="Input and output"
            description="Trace payloads are shown exactly as returned by the API"
          >
            <div className="json-pair">
              <JsonViewer value={trace.input ?? null} label="Input" />
              <JsonViewer value={trace.output ?? null} label="Output" />
            </div>
          </Section>
        </div>
        <div className="detail-stack">
          <Section title="Attributes" description="Trace-level metadata">
            <div className="panel-body">
              <JsonViewer value={trace.metadata} label="Metadata" />
            </div>
          </Section>
          <Section title="Scores" description="Evaluator and human scores attached to this trace">
            {trace.scores.length === 0 ? (
              <div className="panel-body muted">No scores were returned for this trace.</div>
            ) : (
              <div className="evidence-list">
                {trace.scores.map((score) => (
                  <article className="evidence-item" key={score.id || score.name}>
                    <div className="item-heading">
                      <div>
                        <h3>{score.name}</h3>
                        <p>{score.source ?? "Unspecified source"}</p>
                      </div>
                      <StatusBadge
                        value={score.value === undefined ? "UNKNOWN" : String(score.value)}
                      />
                    </div>
                    {score.comment ? <p className="page-description">{score.comment}</p> : null}
                  </article>
                ))}
              </div>
            )}
          </Section>
          <Section title="Span payloads" description="Inspect individual observation data">
            {trace.spans.length === 0 ? (
              <div className="panel-body muted">No span payloads.</div>
            ) : (
              <div className="receipt-list">
                {trace.spans.map((span) => (
                  <details className="receipt-item" key={span.id}>
                    <summary className="item-heading">
                      <span>
                        <strong>{span.name}</strong>
                        <small className="mono"> {shortId(span.id)}</small>
                      </span>
                      <StatusBadge value={span.status} />
                    </summary>
                    <div className="json-pair">
                      <JsonViewer value={span.input ?? null} label="Input" />
                      <JsonViewer value={span.output ?? null} label="Output" />
                    </div>
                  </details>
                ))}
              </div>
            )}
          </Section>
          <Link
            className="button button-secondary"
            href={projectHref(`/outputs?query=${encodeURIComponent(trace.id)}`, projectId)}
          >
            <Braces size={14} /> Find produced outputs
          </Link>
        </div>
      </div>
    </>
  );
}

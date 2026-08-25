import { Boxes, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ApiErrorState } from "../../src/components/api-state";
import { EmptyState, PageHeader } from "../../src/components/page";
import { PaginationControls } from "../../src/components/pagination";
import { StatusBadge } from "../../src/components/status-badge";
import { apiGet, asRemoteResult } from "../../src/lib/api";
import { formatDateTime, shortId } from "../../src/lib/format";
import { normalizeList, normalizeOutput } from "../../src/lib/normalizers";
import { ensureProjectId } from "../../src/lib/project-scope";
import { firstParam, type NextSearchParams, outputListQuery } from "../../src/lib/query";
import { recordHref } from "../../src/lib/routes";

export const metadata: Metadata = { title: "Outputs" };

const states = [
  "",
  "CREATED",
  "STAGED",
  "VERIFIED",
  "APPROVED",
  "COMMITTED",
  "CONSUMED",
  "PROMOTED",
  "REJECTED",
  "STALE",
  "INVALIDATED",
  "SUPERSEDED",
];
const types = [
  "",
  "text",
  "json",
  "markdown",
  "code_patch",
  "file_tree",
  "sql",
  "tool_plan",
  "decision",
  "dataset_record",
];

export default async function OutputsPage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/outputs");
  const result = await asRemoteResult(apiGet<unknown>("/v1/outputs", outputListQuery(params)));
  const outputs = result.ok ? normalizeList(result.data, normalizeOutput) : undefined;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Artifacts"
        title="Outputs"
        description="Browse immutable artifact versions, lifecycle state, evidence, and producing runs."
      />
      <form className="filter-bar" action="/outputs" method="get" aria-label="Filter outputs">
        {projectId ? <input type="hidden" name="projectId" value={projectId} /> : null}
        <div className="filter-field grow">
          <label htmlFor="output-query">Search</label>
          <input
            id="output-query"
            name="query"
            defaultValue={firstParam(params.query)}
            placeholder="Logical ID, version ID, digest, or run…"
          />
        </div>
        <div className="filter-field">
          <label htmlFor="output-state">Lifecycle state</label>
          <select id="output-state" name="status" defaultValue={firstParam(params.status) ?? ""}>
            {states.map((state) => (
              <option value={state} key={state || "all"}>
                {state ? state.replaceAll("_", " ") : "All states"}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="output-type">Artifact type</label>
          <select id="output-type" name="type" defaultValue={firstParam(params.type) ?? ""}>
            {types.map((type) => (
              <option value={type} key={type || "all"}>
                {type || "All types"}
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
      ) : outputs && outputs.items.length > 0 ? (
        <section className="panel">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Output</th>
                  <th>State</th>
                  <th>Type</th>
                  <th>Producer</th>
                  <th>Digest</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {outputs.items.map((output) => (
                  <tr key={output.versionId}>
                    <td>
                      <div className="table-primary">
                        <Link
                          className="row-link"
                          href={recordHref("outputs", output.versionId, projectId)}
                        >
                          {output.logicalId || "Unnamed output"}
                        </Link>
                        <small className="mono">{shortId(output.versionId, 26)}</small>
                      </div>
                    </td>
                    <td>
                      <StatusBadge value={output.lifecycleState} />
                    </td>
                    <td>
                      <span className="mono">{output.outputType}</span>
                    </td>
                    <td>
                      {output.producerRunId ? (
                        <Link
                          className="row-link mono"
                          href={recordHref("traces", output.producerRunId, projectId)}
                        >
                          {shortId(output.producerRunId)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="mono" title={output.contentDigest}>
                      {shortId(output.contentDigest, 22)}
                    </td>
                    <td className="nowrap">{formatDateTime(output.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            pathname="/outputs"
            params={params}
            pagination={outputs.pagination}
            itemCount={outputs.items.length}
          />
        </section>
      ) : (
        <section className="panel">
          <EmptyState
            icon={Boxes}
            title="No output versions found"
            description="Create an OutputObject or change the filters. The browser does not generate example artifacts."
            code={
              'arcdb.outputs.create({ logicalId: "change/customer-index", outputType: "sql", content })'
            }
          />
        </section>
      )}
    </div>
  );
}

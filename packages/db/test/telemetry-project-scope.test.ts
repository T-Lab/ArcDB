import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { createRepositories, type SqlExecutor } from "../src/index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const subjectId = "33333333-3333-4333-8333-333333333333";

type QueryCall = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

describe("telemetry repository project scope", () => {
  it("requires tenant and project predicates for every subject read and update", async () => {
    const calls: QueryCall[] = [];
    const executor: SqlExecutor = {
      async query<Row extends QueryResultRow>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> {
        calls.push({ sql, values: [...values] });
        return { rows: [] } as unknown as QueryResult<Row>;
      },
    };
    const repositories = createRepositories(executor);

    await repositories.sessions.get({ tenantId, projectId, id: subjectId });
    await repositories.sessions.list({ tenantId, projectId, limit: 10 });
    await repositories.runs.get({ tenantId, projectId, id: subjectId });
    await repositories.runs.list({ tenantId, projectId, limit: 10, sessionId: subjectId });
    await repositories.runs.updateStatus({
      tenantId,
      projectId,
      id: subjectId,
      status: "FAILED",
      error: { message: "failed" },
    });
    await repositories.traces.get({ tenantId, projectId, id: subjectId });
    await repositories.traces.list({ tenantId, projectId, limit: 10, runId: subjectId });
    await repositories.traces.updateStatus({
      tenantId,
      projectId,
      id: subjectId,
      status: "FAILED",
    });
    await repositories.spans.get({ tenantId, projectId, id: subjectId });
    await repositories.spans.listByTrace({ tenantId, projectId, traceId: subjectId });
    await repositories.spans.updateStatus({
      tenantId,
      projectId,
      id: subjectId,
      status: "ERROR",
    });
    await repositories.scores.listByTrace({ tenantId, projectId, traceId: subjectId });

    expect(calls).toHaveLength(12);
    for (const call of calls) {
      expect(call.sql).toMatch(/tenant_id = \$1 AND project_id = \$2/u);
      expect(call.values.slice(0, 2)).toEqual([tenantId, projectId]);
    }
  });
});

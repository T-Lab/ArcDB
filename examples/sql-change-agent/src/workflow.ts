import type { EffectOperation } from "@arcdb/sdk";
import { createClient, type SqlExampleConfig } from "./config.js";
import { PROPOSED_SQL, verifyInShadow } from "./shadow.js";

export interface SqlChangeResult {
  readonly downstreamVersionId: string;
  readonly effectId: string;
  readonly effectStatusAtSubmission: string;
  readonly executionJob: EffectOperation["job"];
  readonly lineageEdgeId: string;
  readonly runId: string;
  readonly sourceVersionId: string;
}

export async function runSqlChangeAgent(config: SqlExampleConfig): Promise<SqlChangeResult> {
  const arcdb = createClient(config);
  return arcdb.withRun(
    {
      name: "sql-change-agent",
      input: { goal: "Add a non-null risk_score column without breaking existing rows" },
      metadata: { example: "sql-change-agent", demoId: config.demoId },
    },
    async (run) => {
      const shadow = await run.withTrace(
        { name: "shadow-database-verification", input: { sql: PROPOSED_SQL } },
        async () => verifyInShadow(),
      );
      if (!shadow.passed) throw new Error("The shadow migration did not satisfy its checks");

      const sqlOutput = await run.createOutput({
        logicalId: `examples/sql-change/${config.demoId}/migration`,
        outputType: "sql",
        content: PROPOSED_SQL,
        metadata: { dialect: "postgresql", table: "public.accounts" },
      });
      await arcdb.addEvidence(sqlOutput.versionId, {
        verifierType: "shadow-sql",
        verifierVersion: "pglite-0.5.7",
        verdict: "PASS",
        confidence: 1,
        metrics: {
          existingRowsChecked: shadow.existingRowsChecked,
          insertedRowsChecked: shadow.insertedRowsChecked,
          notNull: shadow.columnNullable === "NO",
        },
        payload: shadow,
      });
      const promotedSql = await arcdb.promoteOutput(sqlOutput.versionId, {
        expectedHeadVersionId: null,
        requiredVerifierTypes: ["shadow-sql"],
      });

      const report = await run.createOutput({
        logicalId: `examples/sql-change/${config.demoId}/verification-report`,
        outputType: "decision",
        content: {
          decision: "eligible-for-manual-production-approval",
          migrationVersionId: promotedSql.versionId,
          shadow,
        },
        parentVersionIds: [promotedSql.versionId],
        metadata: { source: "shadow-sql" },
      });
      const lineage = await arcdb.addLineage({
        sourceVersionId: promotedSql.versionId,
        targetVersionId: report.versionId,
        edgeType: "DERIVED_FROM",
        selector: { kind: "table_column", value: "public.accounts.risk_score" },
        inferred: false,
      });
      await arcdb.addEvidence(report.versionId, {
        verifierType: "shadow-report",
        verifierVersion: "1.0.0",
        verdict: "PASS",
        confidence: 1,
        metrics: { shadowPassed: shadow.passed },
      });
      const promotedReport = await arcdb.promoteOutput(report.versionId, {
        expectedHeadVersionId: null,
        requiredVerifierTypes: ["shadow-report"],
      });

      const effect = await arcdb.prepareEffect({
        sourceOutputVersionId: promotedReport.versionId,
        connectorType: "manual-receipt",
        target: "postgresql://production/public/accounts",
        resourceKey: "production/public/accounts/schema",
        arguments: { sql: PROPOSED_SQL },
        preconditions: { columnAbsent: "public.accounts.risk_score" },
        expectedEffects: { columnAdded: "public.accounts.risk_score", defaultValue: 0 },
        readSet: ["public.accounts.schema"],
        writeSet: ["public.accounts.schema"],
        idempotencyKey: `sql-change-${config.demoId}`,
        reversibility: "R3",
        riskLevel: "HIGH",
        connectorCapabilities: {
          supportsIdempotencyKey: false,
          supportsQueryByIdempotencyKey: false,
          supportsQueryByExternalId: false,
          supportsConditionalWrite: false,
          supportsFencingToken: false,
          supportsCompensation: false,
          supportsStateDigests: false,
          supportsDryRun: true,
          supportsHumanApproval: true,
          reversibility: "R3",
        },
      });
      const operation = await arcdb.commitEffect(effect.id);

      return {
        downstreamVersionId: promotedReport.versionId,
        effectId: effect.id,
        effectStatusAtSubmission: operation.intent.status,
        executionJob: operation.job,
        lineageEdgeId: lineage.id,
        runId: run.run.id,
        sourceVersionId: promotedSql.versionId,
      };
    },
  );
}

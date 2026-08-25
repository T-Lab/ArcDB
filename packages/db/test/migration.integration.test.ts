import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type SqlExecutor } from "../src/index.js";

const migrationUrls = [
  new URL("../migrations/0001_initial.sql", import.meta.url),
  new URL("../migrations/0002_allow_fk_producer_cleanup.sql", import.meta.url),
];

describe("ArcDB PostgreSQL migration", () => {
  let database: PGlite<{ pgcrypto: typeof pgcrypto }>;

  beforeEach(async () => {
    database = new PGlite({ extensions: { pgcrypto } });
    for (const migrationUrl of migrationUrls) {
      await database.exec(await readFile(migrationUrl, "utf8"));
    }
  });

  afterEach(async () => {
    await database.close();
  });

  it("creates the complete control-plane and lifecycle schema", async () => {
    const result = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = result.rows.map((row) => row.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "organizations",
        "projects",
        "runs",
        "traces",
        "spans",
        "outputs",
        "evidence",
        "logical_heads",
        "lineage_edges",
        "effect_intents",
        "effect_receipts",
        "audit_events",
        "idempotency_records",
        "jobs",
        "recomputation_plans",
        "remediation_obligations",
      ]),
    );
  });

  it("enforces tenant row-level security for the application role", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await database.query(
      `INSERT INTO organizations (id, name, slug) VALUES
       ($1, 'First', 'first-tenant'), ($2, 'Second', 'second-tenant')`,
      [first, second],
    );
    await database.exec(`
      CREATE ROLE arcdb_test_app NOLOGIN;
      GRANT USAGE ON SCHEMA public TO arcdb_test_app;
      GRANT SELECT ON organizations TO arcdb_test_app;
      SET ROLE arcdb_test_app;
      SET app.tenant_id = '${first}';
    `);
    const normallyVisible = await database.query<{ id: string }>("SELECT id FROM organizations");
    expect(normallyVisible.rows).toEqual([{ id: first }]);

    await database.exec("SET app.bypass_rls = 'on'");
    const visibleAfterUntrustedGuc = await database.query<{ id: string }>(
      "SELECT id FROM organizations",
    );
    expect(visibleAfterUntrustedGuc.rows).toEqual([{ id: first }]);
  });

  it("keeps receipts append-only even after an output is invalidated", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const projectId = "33333333-3333-4333-8333-333333333333";
    const outputId = "44444444-4444-4444-8444-444444444444";
    const intentId = "55555555-5555-4555-8555-555555555555";
    const receiptId = "66666666-6666-4666-8666-666666666666";
    await database.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant', 'tenant-one')",
      [tenantId],
    );
    await database.query(
      "INSERT INTO projects (id, tenant_id, name, slug) VALUES ($1, $2, 'Project', 'project-one')",
      [projectId, tenantId],
    );
    await database.query(
      `INSERT INTO outputs (
         id, tenant_id, project_id, logical_id, version_id, output_type,
         content_ref, content_digest, lifecycle_state
       ) VALUES ($1, $2, $3, 'query', 'query@v1', 'sql', 'arcdb://ref', $4, 'COMMITTED')`,
      [outputId, tenantId, projectId, `sha256:${"a".repeat(64)}`],
    );
    await database.query(
      `INSERT INTO effect_intents (
         id, tenant_id, project_id, source_output_version_id, connector_type,
         connector_capabilities, target, resource_key, arguments_ref,
         idempotency_key, reversibility, risk_level
       ) VALUES ($1, $2, $3, 'query@v1', 'postgres', '{}', 'shadow', 'db/query',
         'arcdb://args', 'intent-one', 'R1', 'LOW')`,
      [intentId, tenantId, projectId],
    );
    await database.query(
      `INSERT INTO effect_receipts (
         id, tenant_id, project_id, intent_id, external_status
       ) VALUES ($1, $2, $3, $4, 'committed')`,
      [receiptId, tenantId, projectId, intentId],
    );
    await database.query("UPDATE outputs SET lifecycle_state = 'INVALIDATED' WHERE id = $1", [
      outputId,
    ]);
    await expect(
      database.query("DELETE FROM effect_receipts WHERE id = $1", [receiptId]),
    ).rejects.toThrow(/append-only/u);
  });

  it("only clears immutable producer provenance through the run foreign key", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const projectId = "33333333-3333-4333-8333-333333333333";
    const runId = "44444444-4444-4444-8444-444444444444";
    const outputId = "55555555-5555-4555-8555-555555555555";
    await database.query(
      "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant', 'producer-cleanup')",
      [tenantId],
    );
    await database.query(
      "INSERT INTO projects (id, tenant_id, name, slug) VALUES ($1, $2, 'Project', 'producer-cleanup')",
      [projectId, tenantId],
    );
    await database.query(
      "INSERT INTO runs (id, tenant_id, project_id, name) VALUES ($1, $2, $3, 'producer')",
      [runId, tenantId, projectId],
    );
    await database.query(
      `INSERT INTO outputs (
         id, tenant_id, project_id, logical_id, version_id, output_type,
         content_ref, content_digest, producer_run_id
       ) VALUES ($1, $2, $3, 'result', 'result@v1', 'text', 'arcdb://result', $4, $5)`,
      [outputId, tenantId, projectId, `sha256:${"d".repeat(64)}`, runId],
    );

    await expect(
      database.query("UPDATE outputs SET producer_run_id = NULL WHERE id = $1", [outputId]),
    ).rejects.toThrow(/output version identity and content are immutable/u);
    expect(
      (
        await database.query<{ producer_run_id: string | null }>(
          "SELECT producer_run_id FROM outputs WHERE id = $1",
          [outputId],
        )
      ).rows,
    ).toEqual([{ producer_run_id: runId }]);

    await database.query("DELETE FROM runs WHERE id = $1", [runId]);
    expect(
      (
        await database.query<{ producer_run_id: string | null }>(
          "SELECT producer_run_id FROM outputs WHERE id = $1",
          [outputId],
        )
      ).rows,
    ).toEqual([{ producer_run_id: null }]);
  });

  it("runs the typed Output, Evidence, head CAS, Effect, and Receipt repositories", async () => {
    const executor: SqlExecutor = {
      async query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
        return database.query<Row>(text, [...values]) as unknown as Promise<QueryResult<Row>>;
      },
    };
    const repositories = createRepositories(executor);
    const organization = await repositories.organizations.create({
      name: "Repository Tenant",
      slug: "repository-tenant",
    });
    const project = await repositories.projects.create({
      tenantId: organization.id,
      name: "Repository Project",
      slug: "repository-project",
    });
    const output = await repositories.outputs.create({
      tenantId: organization.id,
      projectId: project.id,
      logicalId: "query",
      versionId: "query@v1",
      outputType: "sql",
      contentRef: `arcdb://${organization.id}/sha256/${"b".repeat(64)}`,
      contentDigest: `sha256:${"a".repeat(64)}`,
    });
    const evidence = await repositories.evidence.create({
      tenantId: organization.id,
      projectId: project.id,
      subjectVersionId: output.versionId,
      verifierType: "sql-shadow",
      verifierVersion: "1",
      verdict: "PASS",
      fingerprint: `sha256:${"c".repeat(64)}`,
      metrics: { safe: true },
    });
    const firstHead = await repositories.heads.compareAndSwap({
      tenantId: organization.id,
      projectId: project.id,
      logicalId: output.logicalId,
      expectedVersionId: null,
      newVersionId: output.versionId,
    });
    const conflict = await repositories.heads.compareAndSwap({
      tenantId: organization.id,
      projectId: project.id,
      logicalId: output.logicalId,
      expectedVersionId: null,
      newVersionId: output.versionId,
    });
    const intent = await repositories.effects.create({
      tenantId: organization.id,
      projectId: project.id,
      sourceOutputVersionId: output.versionId,
      connectorType: "postgres",
      connectorCapabilities: {
        supportsIdempotencyKey: true,
        supportsQueryByIdempotencyKey: true,
      },
      target: "shadow",
      resourceKey: "db/query",
      argumentsRef: output.contentRef,
      idempotencyKey: "apply-query-v1",
      reversibility: "R1",
      riskLevel: "LOW",
    });
    const replay = await repositories.effects.create({
      tenantId: organization.id,
      projectId: project.id,
      sourceOutputVersionId: output.versionId,
      connectorType: "postgres",
      connectorCapabilities: {
        supportsQueryByIdempotencyKey: true,
        supportsIdempotencyKey: true,
      },
      target: "shadow",
      resourceKey: "db/query",
      argumentsRef: output.contentRef,
      idempotencyKey: "apply-query-v1",
      reversibility: "R1",
      riskLevel: "LOW",
    });
    const receipt = await repositories.receipts.append({
      tenantId: organization.id,
      projectId: project.id,
      intentId: intent.id,
      externalStatus: "committed",
      actualEffects: { rows: 1 },
    });
    const remediation = await repositories.remediationObligations.create({
      tenantId: organization.id,
      projectId: project.id,
      intentId: intent.id,
      invalidatedOutputVersionId: output.versionId,
      status: "PENDING_APPROVAL",
      riskLevel: "HIGH",
      reason: "The source output was invalidated after the effect committed",
    });
    const apiKeyActorId = crypto.randomUUID();
    const approved = await repositories.remediationObligations.updateStatus({
      tenantId: organization.id,
      id: remediation.id,
      expectedStatus: "PENDING_APPROVAL",
      nextStatus: "IN_PROGRESS",
      approvedBy: apiKeyActorId,
      approvedByActorType: "API_KEY",
    });

    expect(evidence.subjectVersionId).toBe(output.versionId);
    expect(firstHead?.outputVersionId).toBe(output.versionId);
    expect(conflict).toBeNull();
    expect(replay.id).toBe(intent.id);
    expect(receipt.sequence).toBe(1);
    expect(approved).toMatchObject({
      status: "IN_PROGRESS",
      approvedBy: apiKeyActorId,
      approvedByActorType: "API_KEY",
    });
  });

  it("rejects stale workers through job fencing compare-and-swap", async () => {
    const executor: SqlExecutor = {
      async query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
        return database.query<Row>(text, [...values]) as unknown as Promise<QueryResult<Row>>;
      },
    };
    const repositories = createRepositories(executor);
    const organization = await repositories.organizations.create({
      name: "Worker Tenant",
      slug: "worker-tenant",
    });
    const job = await repositories.jobs.enqueue({
      tenantId: organization.id,
      jobType: "run_verifier",
      idempotencyKey: "verify-one",
      payload: { versionId: "query@v1" },
    });
    const replay = await repositories.jobs.enqueue({
      tenantId: organization.id,
      jobType: "run_verifier",
      idempotencyKey: "verify-one",
      payload: { versionId: "query@v1" },
    });
    const claimed = await repositories.jobs.claim({
      tenantId: organization.id,
      workerId: "worker-a",
      lockSeconds: 60,
    });
    expect(replay.id).toBe(job.id);
    expect(claimed?.status).toBe("RUNNING");
    expect(
      await repositories.jobs.complete({
        tenantId: organization.id,
        id: job.id,
        workerId: "worker-a",
        fencingToken: "0",
      }),
    ).toBeNull();
    const completed = await repositories.jobs.complete({
      tenantId: organization.id,
      id: job.id,
      workerId: "worker-a",
      fencingToken: claimed?.fencingToken ?? "invalid",
      result: { verified: true },
    });
    expect(completed?.status).toBe("SUCCEEDED");
  });
});

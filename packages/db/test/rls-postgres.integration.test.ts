import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_MIGRATION, createDatabase } from "../src/index.js";

const applicationUrl = process.env.ARCDB_RLS_TEST_DATABASE_URL;
const administratorUrl = process.env.ARCDB_RLS_TEST_ADMIN_DATABASE_URL;
const systemUrl = process.env.ARCDB_RLS_TEST_SYSTEM_DATABASE_URL;
const expectedApplicationRole = process.env.ARCDB_POSTGRES_APP_USER ?? "arcdb_app";
const expectedSystemRole = process.env.ARCDB_POSTGRES_SYSTEM_USER ?? "arcdb_system";
const configuredUrlCount = [applicationUrl, administratorUrl, systemUrl].filter(
  (value) => value !== undefined,
).length;
const hasRealPostgres = configuredUrlCount === 3;
const hasPartialConfiguration = configuredUrlCount > 0 && !hasRealPostgres;
if (hasPartialConfiguration) {
  throw new Error(
    "Set application, administrator, and system RLS test database URLs together, or set none",
  );
}
const describeRealPostgres = hasRealPostgres ? describe : describe.skip;

function databaseUrl(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describeRealPostgres("ArcDB application-role RLS (requires real PostgreSQL URLs)", () => {
  it("uses a constrained role and cannot see another tenant", async () => {
    if (applicationUrl === undefined || administratorUrl === undefined || systemUrl === undefined) {
      throw new Error(
        "ARCDB_RLS_TEST_DATABASE_URL, ARCDB_RLS_TEST_ADMIN_DATABASE_URL, and ARCDB_RLS_TEST_SYSTEM_DATABASE_URL are required",
      );
    }

    const administrator = new Pool({
      connectionString: administratorUrl,
      application_name: "arcdb-rls-test-admin",
      max: 1,
    });
    const application = new Pool({
      connectionString: applicationUrl,
      application_name: "arcdb-rls-test-app",
      max: 1,
    });
    const system = new Pool({
      connectionString: systemUrl,
      application_name: "arcdb-rls-test-system",
      max: 1,
    });
    const firstTenant = crypto.randomUUID();
    const secondTenant = crypto.randomUUID();
    const firstProject = crypto.randomUUID();
    const siblingProject = crypto.randomUUID();
    const secondProject = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const siblingRunId = crypto.randomUUID();
    const sharedUserId = crypto.randomUUID();
    const suffix = crypto.randomUUID().replaceAll("-", "");

    try {
      await administrator.query(
        `INSERT INTO organizations (id, name, slug)
         VALUES ($1, 'RLS first tenant', $2), ($3, 'RLS second tenant', $4)`,
        [firstTenant, `rls-first-${suffix}`, secondTenant, `rls-second-${suffix}`],
      );
      await administrator.query(
        `INSERT INTO projects (id, tenant_id, name, slug)
         VALUES ($1, $2, 'RLS first project', $3),
                ($4, $2, 'RLS sibling project', $5),
                ($6, $7, 'RLS second tenant project', $8)`,
        [
          firstProject,
          firstTenant,
          `rls-first-project-${suffix}`,
          siblingProject,
          `rls-sibling-project-${suffix}`,
          secondProject,
          secondTenant,
          `rls-second-project-${suffix}`,
        ],
      );
      await administrator.query(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'RLS shared user')`,
        [sharedUserId, `rls-shared-${suffix}@example.invalid`],
      );
      await administrator.query(
        `INSERT INTO organization_memberships (tenant_id, user_id, role)
         VALUES ($1, $3, 'MEMBER'), ($2, $3, 'MEMBER')`,
        [firstTenant, secondTenant, sharedUserId],
      );
      await administrator.query(
        `INSERT INTO artifact_manifests
           (tenant_id, project_id, digest, content_ref, byte_length, chunk_count, media_type)
         VALUES ($1, $2, $3, $4, 1, 1, 'text/plain'),
                ($1, $5, $6, $7, 1, 1, 'text/plain'),
                ($8, $9, $10, $11, 1, 1, 'text/plain')`,
        [
          firstTenant,
          firstProject,
          "a".repeat(64),
          `arcdb://${firstTenant}/${firstProject}/a`,
          siblingProject,
          "b".repeat(64),
          `arcdb://${firstTenant}/${siblingProject}/b`,
          secondTenant,
          secondProject,
          "c".repeat(64),
          `arcdb://${secondTenant}/${secondProject}/c`,
        ],
      );
      await administrator.query(
        `INSERT INTO sessions (id, tenant_id, project_id, name)
         VALUES ($1, $2, $3, 'deletion semantics')`,
        [sessionId, firstTenant, firstProject],
      );
      await administrator.query(
        `INSERT INTO runs (id, tenant_id, project_id, session_id, name)
         VALUES ($1, $2, $3, $4, 'first run'),
                ($5, $2, $6, NULL, 'sibling run')`,
        [runId, firstTenant, firstProject, sessionId, siblingRunId, siblingProject],
      );
      await administrator.query(
        `INSERT INTO outputs (
           tenant_id, project_id, logical_id, version_id, output_type,
           content_ref, content_digest, producer_run_id
         ) VALUES ($1, $2, 'deletion-check', 'deletion-check-v1', 'text', $3, $4, $5)`,
        [
          firstTenant,
          firstProject,
          `arcdb://${firstTenant}/${firstProject}/deletion-check`,
          `sha256:${"d".repeat(64)}`,
          runId,
        ],
      );
      await expect(
        administrator.query(
          `INSERT INTO traces (tenant_id, project_id, run_id, name)
           VALUES ($1, $2, $3, 'cross-project trace')`,
          [firstTenant, firstProject, siblingRunId],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await administrator.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
      expect(
        (
          await administrator.query<{ session_id: string | null }>(
            "SELECT session_id FROM runs WHERE id = $1",
            [runId],
          )
        ).rows,
      ).toEqual([{ session_id: null }]);
      await administrator.query("DELETE FROM runs WHERE id = $1", [runId]);
      expect(
        (
          await administrator.query<{ producer_run_id: string | null }>(
            "SELECT producer_run_id FROM outputs WHERE version_id = 'deletion-check-v1' AND tenant_id = $1 AND project_id = $2",
            [firstTenant, firstProject],
          )
        ).rows,
      ).toEqual([{ producer_run_id: null }]);

      const role = await application.query<{
        current_user: string;
        has_role_memberships: boolean;
        has_system_set_privilege: boolean;
        rolbypassrls: boolean;
        rolcanlogin: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolinherit: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `SELECT current_user, rolsuper, rolcreatedb, rolcreaterole,
                rolinherit, rolreplication, rolcanlogin, rolbypassrls,
                EXISTS (
                  SELECT 1 FROM pg_auth_members membership
                  WHERE membership.member = current_user::regrole
                ) AS has_role_memberships,
                pg_has_role(current_user, $1, 'SET') AS has_system_set_privilege
         FROM pg_roles
         WHERE rolname = current_user`,
        [expectedSystemRole],
      );
      expect(role.rows).toEqual([
        {
          current_user: expectedApplicationRole,
          has_role_memberships: false,
          has_system_set_privilege: false,
          rolbypassrls: false,
          rolcanlogin: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolsuper: false,
        },
      ]);

      const protection = await application.query<{
        forced: boolean;
        owner_is_current_user: boolean;
        row_security: boolean;
      }>(
        `SELECT class.relforcerowsecurity AS forced,
                class.relrowsecurity AS row_security,
                owner.rolname = current_user AS owner_is_current_user
         FROM pg_class class
         JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
         JOIN pg_roles owner ON owner.oid = class.relowner
         WHERE namespace.nspname = 'public' AND class.relname = 'organizations'`,
      );
      expect(protection.rows).toEqual([
        { forced: true, owner_is_current_user: false, row_security: true },
      ]);

      const client = await application.connect();
      try {
        await client.query("BEGIN");
        // Custom GUCs are caller-controlled and therefore must not grant authority.
        await client.query("SELECT set_config('app.bypass_rls', 'on', true)");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [firstTenant]);
        await client.query("SELECT set_config('app.project_id', $1, true)", [firstProject]);
        const visible = await client.query<{ id: string }>(
          "SELECT id FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY id",
          [[firstTenant, secondTenant]],
        );
        expect(visible.rows).toEqual([{ id: firstTenant }]);
        const visibleProjects = await client.query<{ id: string }>(
          "SELECT id FROM projects ORDER BY id",
        );
        expect(visibleProjects.rows).toEqual([{ id: firstProject }]);
        const visibleArtifacts = await client.query<{ project_id: string }>(
          "SELECT project_id FROM artifact_manifests ORDER BY project_id",
        );
        expect(visibleArtifacts.rows).toEqual([{ project_id: firstProject }]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const systemRole = await system.query<{
        current_user: string;
        has_role_memberships: boolean;
        rolbypassrls: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
        rolreplication: boolean;
        rolsuper: boolean;
      }>(
        `SELECT current_user, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls,
                EXISTS (
                  SELECT 1 FROM pg_auth_members membership
                  WHERE membership.member = current_user::regrole
                ) AS has_role_memberships
           FROM pg_roles
          WHERE rolname = current_user`,
      );
      expect(systemRole.rows).toEqual([
        {
          current_user: expectedSystemRole,
          has_role_memberships: false,
          rolbypassrls: true,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolsuper: false,
        },
      ]);
      const systemVisible = await system.query<{ id: string }>(
        "SELECT id FROM organizations WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[firstTenant, secondTenant]],
      );
      expect(systemVisible.rows).toEqual([{ id: firstTenant }, { id: secondTenant }]);
      const systemArtifacts = await system.query<{ project_id: string }>(
        "SELECT project_id FROM artifact_manifests WHERE tenant_id = ANY($1::uuid[]) ORDER BY project_id",
        [[firstTenant, secondTenant]],
      );
      expect(systemArtifacts.rows.map(({ project_id }) => project_id).sort()).toEqual(
        [firstProject, siblingProject, secondProject].sort(),
      );

      const ledgerPrivileges = await application.query<{
        can_delete: boolean;
        can_insert: boolean;
        can_select: boolean;
        can_update: boolean;
      }>(
        `SELECT has_table_privilege(current_user, 'public.arcdb_schema_migrations', 'SELECT') AS can_select,
                has_table_privilege(current_user, 'public.arcdb_schema_migrations', 'INSERT') AS can_insert,
                has_table_privilege(current_user, 'public.arcdb_schema_migrations', 'UPDATE') AS can_update,
                has_table_privilege(current_user, 'public.arcdb_schema_migrations', 'DELETE') AS can_delete`,
      );
      expect(ledgerPrivileges.rows).toEqual([
        { can_delete: false, can_insert: false, can_select: true, can_update: false },
      ]);
      await expect(
        application.query("UPDATE arcdb_schema_migrations SET checksum = checksum"),
      ).rejects.toMatchObject({ code: "42501" });

      const destructiveClient = await application.connect();
      try {
        await destructiveClient.query("BEGIN");
        await destructiveClient.query("SELECT set_config('app.tenant_id', $1, true)", [
          firstTenant,
        ]);
        await destructiveClient.query("SELECT set_config('app.project_id', $1, true)", [
          firstProject,
        ]);
        await expect(
          destructiveClient.query("DELETE FROM organizations WHERE id = $1", [firstTenant]),
        ).rejects.toMatchObject({ code: "42501" });
        await destructiveClient.query("ROLLBACK");

        await destructiveClient.query("BEGIN");
        await destructiveClient.query("SELECT set_config('app.tenant_id', $1, true)", [
          firstTenant,
        ]);
        await destructiveClient.query("SELECT set_config('app.project_id', $1, true)", [
          firstProject,
        ]);
        await expect(
          destructiveClient.query("DELETE FROM users WHERE id = $1", [sharedUserId]),
        ).rejects.toMatchObject({ code: "42501" });
        await destructiveClient.query("ROLLBACK");
      } finally {
        destructiveClient.release();
      }
      expect(
        (
          await administrator.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM organization_memberships
              WHERE user_id = $1 AND tenant_id = ANY($2::uuid[])`,
            [sharedUserId, [firstTenant, secondTenant]],
          )
        ).rows,
      ).toEqual([{ count: "2" }]);
      expect(
        (
          await administrator.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM projects WHERE id = $1",
            [siblingProject],
          )
        ).rows,
      ).toEqual([{ count: "1" }]);
    } finally {
      await administrator
        .query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [
          [firstTenant, secondTenant],
        ])
        .catch(() => undefined);
      await administrator
        .query("DELETE FROM users WHERE id = $1", [sharedUserId])
        .catch(() => undefined);
      await Promise.all([administrator.end(), application.end(), system.end()]);
    }
  });

  it("keeps readiness false for empty, stale, and split runtime databases", async () => {
    if (applicationUrl === undefined || administratorUrl === undefined || systemUrl === undefined) {
      throw new Error(
        "ARCDB_RLS_TEST_DATABASE_URL, ARCDB_RLS_TEST_ADMIN_DATABASE_URL, and ARCDB_RLS_TEST_SYSTEM_DATABASE_URL are required",
      );
    }

    const administrator = new Pool({ connectionString: administratorUrl, max: 1 });
    const databaseName = `arcdb_health_${crypto.randomUUID().replaceAll("-", "")}`;
    const quotedDatabaseName = `"${databaseName}"`;
    const ownershipTable = `arcdb_runtime_owner_${crypto.randomUUID().replaceAll("-", "")}`;
    const quotedOwnershipTable = quoteIdentifier(ownershipTable);
    let blankAdministrator: Pool | undefined;
    try {
      const healthy = createDatabase({
        connectionString: applicationUrl,
        systemConnectionString: systemUrl,
        applicationName: "arcdb-health-current-test",
        max: 1,
      });
      try {
        expect(await healthy.healthcheck()).toBe(true);
      } finally {
        await healthy.close();
      }

      await administrator.query(`CREATE TABLE public.${quotedOwnershipTable} (id integer)`);
      await administrator.query(
        `ALTER TABLE public.${quotedOwnershipTable} OWNER TO ${quoteIdentifier(expectedApplicationRole)}`,
      );
      const unsafeOwner = createDatabase({
        connectionString: applicationUrl,
        systemConnectionString: systemUrl,
        applicationName: "arcdb-health-owner-test",
        max: 1,
      });
      try {
        await expect(unsafeOwner.assertRuntimeRoleSeparation()).rejects.toMatchObject({
          code: "DATABASE_ROLE_MISCONFIGURED",
        });
        expect(await unsafeOwner.healthcheck()).toBe(false);
      } finally {
        await unsafeOwner.close();
        await administrator.query(`DROP TABLE public.${quotedOwnershipTable}`);
      }

      await administrator.query(`CREATE DATABASE ${quotedDatabaseName}`);
      const blankApplicationUrl = databaseUrl(applicationUrl, databaseName);
      const blankSystemUrl = databaseUrl(systemUrl, databaseName);
      const blankAdministratorUrl = databaseUrl(administratorUrl, databaseName);
      blankAdministrator = new Pool({ connectionString: blankAdministratorUrl, max: 1 });

      const empty = createDatabase({
        connectionString: blankApplicationUrl,
        systemConnectionString: blankSystemUrl,
        applicationName: "arcdb-health-empty-test",
        max: 1,
      });
      try {
        expect(await empty.healthcheck()).toBe(false);
      } finally {
        await empty.close();
      }

      await blankAdministrator.query(`
        CREATE TABLE arcdb_schema_migrations (
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await blankAdministrator.query(
        "INSERT INTO arcdb_schema_migrations (version, checksum) VALUES ($1, $2)",
        [CURRENT_SCHEMA_MIGRATION.version, "stale-checksum"],
      );
      await blankAdministrator.query(
        `GRANT SELECT ON arcdb_schema_migrations TO ${quoteIdentifier(expectedApplicationRole)}, ${quoteIdentifier(expectedSystemRole)}`,
      );
      const stale = createDatabase({
        connectionString: blankApplicationUrl,
        systemConnectionString: blankSystemUrl,
        applicationName: "arcdb-health-stale-test",
        max: 1,
      });
      try {
        expect(await stale.healthcheck()).toBe(false);
      } finally {
        await stale.close();
      }

      await blankAdministrator.query(
        "UPDATE arcdb_schema_migrations SET checksum = $1 WHERE version = $2",
        [CURRENT_SCHEMA_MIGRATION.checksum, CURRENT_SCHEMA_MIGRATION.version],
      );
      const split = createDatabase({
        connectionString: applicationUrl,
        systemConnectionString: blankSystemUrl,
        applicationName: "arcdb-health-split-test",
        max: 1,
      });
      try {
        expect(await split.healthcheck()).toBe(false);
      } finally {
        await split.close();
      }
    } finally {
      await blankAdministrator?.end().catch(() => undefined);
      await administrator
        .query(`DROP TABLE IF EXISTS public.${quotedOwnershipTable}`)
        .catch(() => undefined);
      await administrator.query(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
      await administrator.end();
    }
  });
});

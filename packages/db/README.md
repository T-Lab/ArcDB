# `@arcdb/db`

PostgreSQL is ArcDB's initial correctness oracle. This package owns the schema,
transaction scoping, migrations, seed data, and typed repositories.

## Tenant-safe usage

Bind repositories once, then run every request inside an explicit tenant
transaction. `withTenant` uses transaction-local PostgreSQL settings consumed by
forced row-level-security policies.

```ts
import { createDatabase, createRepositories } from "@arcdb/db";

const database = createDatabase({
  connectionString: process.env.ARCDB_DATABASE_URL!,
  systemConnectionString: process.env.ARCDB_SYSTEM_DATABASE_URL!,
});
const repositories = createRepositories(database);

const traces = await database.withTenant(tenantId, projectId, () =>
  repositories.traces.list({ tenantId, projectId, limit: 50 }),
);
```

`withSystem` is intentionally conspicuous. It uses only the separate system
connection pool, whose PostgreSQL role must have `BYPASSRLS` (or equivalent
administrator privileges). Request handlers should use it only for
pre-authentication API-key prefix lookup or trusted cross-tenant control-plane
work. The application role cannot enable a custom PostgreSQL setting to bypass
RLS. Never pass an untrusted callback to `withSystem`.

## Migrations and local seed

```bash
pnpm --filter @arcdb/db migrate
pnpm --filter @arcdb/db seed
```

Both commands require an administrator/owner connection because migrations own
the schema and the development seed performs trusted cross-tenant work. API and
worker processes require both `ARCDB_DATABASE_URL` for the constrained
application role and `ARCDB_SYSTEM_DATABASE_URL` for the trusted control plane.
The Compose role initializer at `infra/postgres/init-app-role.sh` creates the
application and system logins and maintains current/default table, sequence, and
function grants. API/worker startup verifies that the application role is
non-superuser/NOBYPASSRLS, the system role is non-superuser/BYPASSRLS, and the
two current roles differ; readiness repeats this fail-closed check.

Migrations are checksum-verified and serialized with an advisory lock. The seed
is idempotent, requires `ARCDB_ALLOW_DEV_BOOTSTRAP=true`, and refuses to run with
`NODE_ENV=production`. If no bootstrap key is supplied, it prints a newly
generated key exactly once.

Receipts, lifecycle events, and audit events are append-only at the database
layer. Output identity/content columns are immutable, logical heads use
compare-and-swap, and worker mutations require a current fencing token.

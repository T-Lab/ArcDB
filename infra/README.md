# Local infrastructure

`docker compose up --build` starts PostgreSQL, Redis, MinIO, the API, worker, and
web dashboard. Startup gates are explicit:

1. PostgreSQL and MinIO become healthy.
2. The migration container applies checksum-verified migrations and local seed with the
   administrator credential.
3. A one-shot role initializer creates or rotates the constrained runtime logins, revokes stale
   grants and memberships, and grants only the current schema allowlist.
4. The MinIO init container creates the artifact bucket.
5. API and worker start and pass readiness checks.
6. Web starts after the API is ready.

Local defaults are intentionally obvious development credentials. Override them
through environment variables before exposing the stack to another machine.
Persistent state lives in named Compose volumes.

PostgreSQL has deliberately separate credentials. `arcdb_admin` owns migrations
and seed data. Tenant-scoped API work uses `arcdb_app`, which is `NOSUPERUSER`,
`NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`.
Narrow control-plane operations and cross-tenant worker polling use a separate
`arcdb_system` login with `BYPASSRLS` but none of the other elevated role
attributes. The initializer also revokes every role membership from both runtime
roles: `NOINHERIT` alone would still permit an explicit `SET ROLE`. It refuses
runtime ownership of the database, public schema, relations, or functions, then
rebuilds a least-privilege table allowlist with identity tables read-only. API and
worker readiness independently reject retained memberships or unsafe ownership.

Override local placeholders with the `ARCDB_POSTGRES_ADMIN_*`,
`ARCDB_POSTGRES_APP_*`, and `ARCDB_POSTGRES_SYSTEM_*` variables. Passwords
embedded in Compose-generated URLs must be URI-safe; alternatively supply
complete `ARCDB_COMPOSE_ADMIN_DATABASE_URL`, `ARCDB_COMPOSE_APP_DATABASE_URL`,
and `ARCDB_COMPOSE_SYSTEM_DATABASE_URL` values. The non-Compose
`ARCDB_ADMIN_DATABASE_URL`, `ARCDB_DATABASE_URL`, and `ARCDB_SYSTEM_DATABASE_URL`
use `localhost` for root CLI commands and tests; Compose deliberately does not
reuse those host URLs. Raw runtime passwords must still match their
`ARCDB_POSTGRES_*_PASSWORD` values so the post-migration initializer can create or rotate the
logins. Run the initializer after every schema upgrade; new tables remain inaccessible until they
are deliberately added to its allowlist.

The official PostgreSQL image reads `POSTGRES_USER` and `POSTGRES_PASSWORD` only
when it creates an empty data directory. For a volume created by an older ArcDB
topology, point the administrator variables at the existing database owner and
run `docker compose run --rm postgres-role-init`; do not delete a persistent
volume merely to change roles. Back it up and migrate ownership deliberately.

For production, build the same Dockerfiles, provision tenant and control-plane
roles through your database administration workflow, run the migration image as
a one-shot release job without the seed command, inject separate administrator,
application, and system URLs from a secret manager, and place services behind
TLS. Prefer distinct least-privilege system roles for API authentication and
worker polling instead of the shared local-development role. Redis is
coordination only; PostgreSQL remains the correctness source and S3 remains the
payload source.

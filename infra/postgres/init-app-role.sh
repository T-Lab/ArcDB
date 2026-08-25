#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${ARCDB_POSTGRES_APP_USER:?ARCDB_POSTGRES_APP_USER is required}"
: "${ARCDB_POSTGRES_APP_PASSWORD:?ARCDB_POSTGRES_APP_PASSWORD is required}"
: "${ARCDB_POSTGRES_SYSTEM_USER:?ARCDB_POSTGRES_SYSTEM_USER is required}"
: "${ARCDB_POSTGRES_SYSTEM_PASSWORD:?ARCDB_POSTGRES_SYSTEM_PASSWORD is required}"

validate_role_name() {
  role_name=$1
  variable_name=$2
  case "$role_name" in
    *[!a-z0-9_]* | "" | [0-9]*)
      printf '%s\n' "$variable_name must be a lowercase PostgreSQL identifier" >&2
      exit 2
      ;;
  esac
  if [ "${#role_name}" -gt 63 ]; then
    printf '%s\n' "$variable_name must not exceed 63 bytes" >&2
    exit 2
  fi
}

validate_role_name "$ARCDB_POSTGRES_APP_USER" ARCDB_POSTGRES_APP_USER
validate_role_name "$ARCDB_POSTGRES_SYSTEM_USER" ARCDB_POSTGRES_SYSTEM_USER

if [ "$ARCDB_POSTGRES_APP_USER" = "$ARCDB_POSTGRES_SYSTEM_USER" ]; then
  printf '%s\n' "The ArcDB application and system roles must be distinct" >&2
  exit 2
fi
for runtime_role in "$ARCDB_POSTGRES_APP_USER" "$ARCDB_POSTGRES_SYSTEM_USER"; do
  if [ "$runtime_role" = "$PGUSER" ] || [ "$runtime_role" = "postgres" ]; then
    printf '%s\n' "ArcDB runtime roles must be distinct from the administrator role" >&2
    exit 2
  fi
done

# \getenv keeps secrets out of psql's argument list. Values enter SQL only
# through psql's quoted-variable forms; format(%I/%L) performs identifier/literal
# quoting before \gexec executes the generated DDL.
psql \
  --no-psqlrc \
  --set=ON_ERROR_STOP=1 <<'SQL'
\getenv app_role ARCDB_POSTGRES_APP_USER
\getenv app_password ARCDB_POSTGRES_APP_PASSWORD
\getenv system_role ARCDB_POSTGRES_SYSTEM_USER
\getenv system_password ARCDB_POSTGRES_SYSTEM_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'app_role',
  :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
  :'app_role',
  :'app_password'
) \gexec

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
  :'system_role',
  :'system_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'system_role') \gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
  :'system_role',
  :'system_password'
) \gexec

-- NOINHERIT only blocks implicit privilege inheritance: a member can still use
-- SET ROLE. Remove every direct membership so reused volumes cannot retain a
-- previously granted system or predefined PostgreSQL role.
SELECT format('REVOKE %I FROM %I', granted_role.rolname, member_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
JOIN pg_roles member_role ON member_role.oid = membership.member
WHERE member_role.rolname IN (:'app_role', :'system_role')
ORDER BY member_role.rolname, granted_role.rolname \gexec

SELECT format('ALTER ROLE %I SET row_security = on', :'app_role') \gexec
SELECT format('ALTER ROLE %I SET search_path = pg_catalog, public', :'app_role') \gexec
SELECT format('ALTER ROLE %I SET row_security = on', :'system_role') \gexec
SELECT format('ALTER ROLE %I SET search_path = pg_catalog, public', :'system_role') \gexec

-- Object owners retain implicit ALTER and grant authority even after REVOKE.
-- Refuse reused or manually modified databases instead of blessing an unsafe
-- runtime role that could disable RLS or rewrite privileges.
SELECT NOT EXISTS (
  SELECT 1
    FROM pg_database database
    JOIN pg_roles owner ON owner.oid = database.datdba
   WHERE database.datname = current_database()
     AND owner.rolname IN (:'app_role', :'system_role')
  UNION ALL
  SELECT 1
    FROM pg_namespace namespace
    JOIN pg_roles owner ON owner.oid = namespace.nspowner
   WHERE namespace.nspname = 'public'
     AND owner.rolname IN (:'app_role', :'system_role')
  UNION ALL
  SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner ON owner.oid = relation.relowner
   WHERE namespace.nspname = 'public'
     AND owner.rolname IN (:'app_role', :'system_role')
  UNION ALL
  SELECT 1
    FROM pg_proc function
    JOIN pg_namespace namespace ON namespace.oid = function.pronamespace
    JOIN pg_roles owner ON owner.oid = function.proowner
   WHERE namespace.nspname = 'public'
     AND owner.rolname IN (:'app_role', :'system_role')
) AS runtime_roles_own_nothing \gset
\if :runtime_roles_own_nothing
\else
  \echo 'ArcDB runtime roles must not own the database, public schema, relations, or functions' >&2
  \quit 3
\endif

SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), :'app_role', :'system_role') \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_role') \gexec
SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'system_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I', :'app_role', :'system_role') \gexec

-- Remove grants left by older ArcDB releases before rebuilding a fail-closed
-- allowlist. Future tables receive no runtime access until this initializer is
-- deliberately updated and rerun after migrations.
SELECT format(
  'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, %I, %I',
  :'app_role',
  :'system_role'
) \gexec

-- Table-level REVOKE does not remove grants stored on individual columns.
-- Clear every column ACL before rebuilding the narrow column allowlist below.
SELECT format(
  'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM PUBLIC, %I, %I',
  attribute.attname,
  namespace.nspname,
  relation.relname,
  :'app_role',
  :'system_role'
)
FROM pg_attribute attribute
JOIN pg_class relation ON relation.oid = attribute.attrelid
JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relkind IN ('r', 'p', 'v', 'f')
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY relation.relname, attribute.attnum \gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, %I, %I',
  current_user,
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, %I, %I',
  current_user,
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, %I, %I',
  current_user,
  :'app_role',
  :'system_role'
) \gexec
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
  current_user
) \gexec

SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
     public.sessions, public.runs, public.traces, public.spans, public.scores,
     public.outputs, public.evidence, public.logical_heads, public.lineage_edges,
     public.resource_fences, public.effect_intents, public.idempotency_records, public.jobs,
     public.recomputation_plans, public.remediation_obligations
   TO %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE public.organizations, public.users,
     public.organization_memberships, public.projects TO %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'GRANT SELECT, INSERT ON TABLE public.api_keys TO %I',
  :'app_role'
) \gexec
SELECT format(
  'GRANT UPDATE (revoked_at) ON TABLE public.api_keys TO %I',
  :'app_role'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE public.api_keys TO %I',
  :'system_role'
) \gexec
SELECT format(
  'GRANT UPDATE (last_used_at) ON TABLE public.api_keys TO %I',
  :'system_role'
) \gexec
SELECT format(
  'GRANT SELECT, INSERT ON TABLE public.artifact_manifests, public.effect_receipts,
     public.lifecycle_events, public.audit_events TO %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'GRANT SELECT ON TABLE public.arcdb_schema_migrations TO %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SELECT format(
  'GRANT EXECUTE ON FUNCTION public.arcdb_set_updated_at(), public.arcdb_deny_mutation(),
     public.arcdb_protect_output_version() TO %I, %I',
  :'app_role',
  :'system_role'
) \gexec
SQL

# ADR 0005: Tenant scope is mandatory at every data boundary

- Status: accepted
- Date: 2026-08-25

## Context

ArcDB may store source code, prompts, production changes, and external receipts. An identifier alone
must never authorize access across organizations.

## Decision

API keys are hashed at rest and resolve to an organization, optional project, role, and explicit
scopes. Every repository operation carries organization and project context. PostgreSQL row-level
security is enabled as defense in depth for tenant-owned tables. API responses never echo secret
keys after creation, and structured logs redact authorization and effect arguments.

Tenant transactions and trusted control-plane transactions use separate connection pools and
PostgreSQL roles. RLS policies never trust caller-controlled custom settings as bypass authority.
The application role is `NOBYPASSRLS`; a distinct non-superuser system role has `BYPASSRLS` for the
small set of pre-authentication and worker operations that inherently cross tenant boundaries.
Runtime startup and readiness verify that these roles are distinct and have the expected attributes.
Both runtime roles must also have no PostgreSQL role memberships and own no database, public schema,
public relation, or public function: `NOINHERIT` does not by itself prevent an explicit `SET ROLE`,
and an object owner retains implicit authority after ordinary grants are revoked. Identity tables
are application read-only; their RLS policies are `SELECT`-only so a project-scoped transaction
cannot cascade-delete sibling projects or a shared user's memberships.
Readiness verifies the exact packaged migration checksum through both pools and compares their
resolved PostgreSQL server/database identity, so a split application/system configuration cannot
report healthy merely because both endpoints accept `SELECT 1`.

The committed bootstrap key is a documented local-development placeholder and is accepted only when
the explicit development bootstrap flag is enabled.

## Consequences

Background work uses the explicit system pool to claim work, then requires the job's exact tenant
and project on every effect, receipt, fence, and dead-letter mutation. Administrative migrations, system control-plane work, and tenant request
traffic remain separate paths. A process compromise that captures the system credential remains a
cross-tenant threat, so production deployments should use service-specific least-privilege system
roles and isolate those secrets.

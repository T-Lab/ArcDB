# Production hardening

The Compose file is a development topology. A production installation must add TLS, private network
segmentation, secret management, durable storage, independent backups, and monitored resource limits.

- Disable `ARCDB_ALLOW_DEV_BOOTSTRAP` and rotate the bootstrap API key before admitting traffic.
- Rotate `ARCDB_CONSOLE_USERNAME` and `ARCDB_CONSOLE_PASSWORD`, terminate TLS before the Web
  console, and prefer an identity-aware proxy for multi-user access. The built-in Basic Auth layer
  protects a single operator console; it is not a substitute for end-user sessions or SSO.
- Give migration/seed jobs a short-lived administrator URL. Tenant queries use a distinct
  `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS` application
  pool; pre-authentication lookup and cross-tenant worker polling use a separate, non-superuser
  system pool with `BYPASSRLS`. ArcDB verifies those role classes and their separation at startup
  and readiness, including rejecting any role membership that could permit `SET ROLE` and any
  runtime role that owns the database, `public` schema, a public relation, or a public function.
  Ownership carries implicit privileges that `REVOKE` cannot remove. The role initializer also
  rebuilds an explicit table allowlist after migrations; identity tables are runtime read-only, and
  the migration ledger is read-only. Keep `withSystem` call sites small and never pass untrusted
  callbacks to them.
- Readiness checks the exact latest packaged migration version and checksum through both pools and
  verifies that both connections resolve to the same PostgreSQL server/database. A reachable empty,
  stale, modified, or split database therefore remains `503 not_ready`.
  The local stack shares one system role between API and worker for convenience; production should
  provision distinct least-privilege system roles because both processes otherwise hold the same
  cross-tenant credential.
- Compose binds published ports to `127.0.0.1` by default. In production expose only the TLS ingress;
  PostgreSQL, Redis, MinIO, the API origin, and worker health endpoints stay private.
- Use workload identities or short-lived credentials for object storage and connectors.
- Restrict connector destinations and protect against SSRF at both application and egress layers.
- Run the API and worker as non-root with a read-only root filesystem where the platform permits it.
- Set payload and request-rate limits appropriate to the tenant and redact sensitive artifact fields.
- Alert on authorization failures, queue lag, receipt gaps, reconciliation age, and remediation age.
- Treat custom verifiers and connector code as untrusted. Run them out of process in a sandbox; a
  JavaScript VM context is not a security boundary.

Human approval is mandatory for irreversible (`R3`) effects. ArcDB's receipt is evidence of an
external response, not proof that an external system is correct.

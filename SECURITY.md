# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Send a private security advisory through
the GitHub repository's **Security → Advisories → Report a vulnerability** flow. Include affected
versions, impact, reproduction steps, and any suggested mitigation. The maintainers will acknowledge
the report within three business days and coordinate a disclosure timeline after triage.

## Supported versions

Until ArcDB reaches 1.0, only the latest tagged release receives security fixes.

## Deployment baseline

- Replace all values from `.env.example`; development credentials are intentionally invalid for
  production use.
- Terminate TLS at a trusted ingress and restrict PostgreSQL, Redis, and object storage to private
  networks.
- Keep development bootstrap disabled in every shared environment.
- Use a dedicated database role and bucket, rotate API keys, and restrict connector allowlists.
- Back up PostgreSQL and object storage together and test restoration.
- Treat output content, evidence payloads, and effect arguments as potentially sensitive.

ArcDB does not claim a global transaction across external APIs. Operators must monitor
`RECONCILIATION_REQUIRED` and remediation obligations.

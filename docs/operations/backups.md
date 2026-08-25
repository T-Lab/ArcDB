# Backup and restore

ArcDB truth spans PostgreSQL and S3-compatible object storage. Back up both at a common recovery point;
Redis is not a correctness source.

## Backup

1. Pause effect-executing workers or place the deployment in maintenance mode.
2. Record the current database WAL position and object-store versioning state.
3. Take a PostgreSQL physical backup or consistent `pg_dump` including the `arcdb` schema.
4. Snapshot the artifact bucket with object versions and retention metadata.
5. Store the backup manifest, checksums, ArcDB version, and migration version separately.
6. Resume workers and monitor queue lag and reconciliation counts.

## Restore test

Restore into an isolated environment, use the same or a newer compatible ArcDB release, apply only
documented forward migrations, and verify:

- database migration and row counts;
- a sample of artifact digest-to-bytes checks;
- output heads and evidence freshness;
- receipt immutability and outstanding reconciliation/remediation work;
- a read-only dashboard smoke test.

Never restore production connector credentials into a test environment. Keep effect workers disabled
until connector allowlists and fencing state have been reviewed.

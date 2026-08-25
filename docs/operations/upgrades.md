# Upgrade guide

ArcDB follows semantic versioning before 1.0 with one caveat: minor releases may add forward-only
database migrations. Release notes call out API and migration compatibility.

For every upgrade:

1. Read the release notes and image digest; do not deploy an unpinned `latest` tag.
2. Back up PostgreSQL and the artifact bucket and test that the backup can be opened.
3. Upgrade a staging environment with production-like data volume.
4. Run migrations once using the migration command, never concurrently from every application pod.
5. Start the API in readiness-disabled mode, then workers, then the web application.
6. Verify readiness, ingestion, queue lag, lifecycle transition errors, reconciliation, and artifact
   reconstruction before admitting traffic.
7. Roll application containers back only when the migration is documented as backward compatible.
   Database rollback otherwise means restoring the coordinated backup.

ArcDB-Native and ClickHouse compatibility will be documented when those optional components ship;
they are not part of the first release.

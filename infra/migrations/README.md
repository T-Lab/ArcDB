# Deployment migrations

The canonical SQL migrations live in `packages/db/migrations` so the migration
CLI and its integration tests consume the exact same files. Deployment jobs must
run `node packages/db/dist/cli/migrate.js`; do not copy or mutate SQL here.

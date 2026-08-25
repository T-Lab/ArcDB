# ArcDB worker

This service runs BullMQ as a notification layer over the durable PostgreSQL
`jobs` table. PostgreSQL owns attempts, timeouts, leases, fencing generations,
results, failures, and dead-letter state. Redis notifications contain only a
tenant wakeup plus an optional diagnostic job hint; losing or duplicating one
does not change durable job truth because the sweeper re-notifies runnable rows
and PostgreSQL performs the atomic claim.

All job types required by `guideline.md` are represented in the durable job
contract. The default runtime registers only `reconcile_effect` and
`run_compensation`. Receiving any other type is an explicit permanent failure
and moves that durable row to `DEAD_LETTER`; it never reports silent success or
pretends an unconfigured verifier/compactor ran.

The only default connector is `manual-receipt`. It deliberately performs no
external write. It places the intent in `RECONCILIATION_REQUIRED` until a caller
with `effect:commit` permission records an immutable receipt through
`ManualReceiptService`. Fake automatic connectors live only under `test/support`
and are not production exports.

Health endpoints listen on port `4002` by default:

- `GET /health/live`
- `GET /health/ready` (database, Redis, durable stalled count, and last worker heartbeat)
- `GET /metrics`

Required environment variables are `ARCDB_DATABASE_URL`,
`ARCDB_SYSTEM_DATABASE_URL`, and `ARCDB_REDIS_URL`. Retry, polling, lease,
heartbeat, concurrency, readiness, host, and port settings are exposed with the
`ARCDB_WORKER_*` prefix.

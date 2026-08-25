# SQL change-agent example

This is an executable vertical slice of ArcDB's lifecycle:

1. create a run and a trace;
2. execute the proposed migration against an isolated PGlite PostgreSQL instance;
3. store the SQL Output and PASS Evidence, then promote it with head CAS;
4. create and promote a downstream decision Output and record selector-aware lineage;
5. prepare an irreversible, high-risk EffectIntent using the production-safe `manual-receipt`
   connector; and
6. submit the Effect to the durable worker with `commitEffect`.

```bash
export ARCDB_API_URL=http://localhost:4000
export ARCDB_API_KEY='arcdb_...'
export ARCDB_PROJECT_ID='...'
pnpm --filter @arcdb/example-sql-change-agent start | tee /tmp/arcdb-sql-demo.json
```

`commitEffect` means “accepted for asynchronous execution”, not “the production database changed”.
The default worker intentionally performs no external write. Check the durable intent, job outcome,
and append-only receipts using the returned Effect ID:

```bash
export ARCDB_EFFECT_ID='returned-effect-id'
pnpm --filter @arcdb/example-sql-change-agent inspect
```

For `manual-receipt`, an authorized operator must first apply or inspect the real external change.
Only then should they record what actually happened:

```bash
export ARCDB_EXTERNAL_STATUS=COMMITTED
export ARCDB_EXTERNAL_TRANSACTION_ID='change-ticket-1234'
export ARCDB_ACTUAL_EFFECTS_JSON='{"columnAdded":"public.accounts.risk_score"}'
pnpm --filter @arcdb/example-sql-change-agent receipt
```

To exercise selector-aware invalidation, use the source version returned by the main workflow:

```bash
export ARCDB_SOURCE_VERSION_ID='returned-source-version-id'
export ARCDB_INVALIDATION_REASON='Migration withdrawn after review'
pnpm --filter @arcdb/example-sql-change-agent invalidate
```

Invalidation computes and persists its recomputation plan and remediation obligations before the
request returns. Inspect that response and the Effect detail to review the exact affected set.
Receipts remain immutable historical facts; ArcDB creates remediation obligations instead of
rewriting history.

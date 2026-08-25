# Minimal TypeScript SDK example

This is the smallest end-to-end ArcDB workflow. It creates a run and trace, stores an immutable
text Output, attaches independently named Evidence, and promotes the version through the guarded
head compare-and-swap path.

From the repository root, start ArcDB and export the API key and project printed by the seed step:

```bash
export ARCDB_API_URL=http://localhost:4000
export ARCDB_API_KEY='arcdb_...'
export ARCDB_PROJECT_ID='...'
pnpm --filter @arcdb/example-minimal-sdk start
```

`ARCDB_DEMO_ID` is optional. Set a new value for each fresh logical Output; promotion deliberately
uses `expectedHeadVersionId: null`, so reusing a logical ID with an existing head fails safely.

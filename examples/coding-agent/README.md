# Coding-agent example

This runnable example uses a deterministic local agent to generate a unified patch. It writes the
generated JavaScript module into an isolated temporary directory, validates syntax with the current
Node executable, imports the module, and checks behavior before recording PASS Evidence. ArcDB then
promotes the immutable patch Output.

```bash
export ARCDB_API_URL=http://localhost:4000
export ARCDB_API_KEY='arcdb_...'
export ARCDB_PROJECT_ID='...'
pnpm --filter @arcdb/example-coding-agent start
```

No patch is applied to the current checkout. The executable verifier is intentionally small, but it
uses the same Output → Evidence → promotion protocol as a model-backed coding agent.

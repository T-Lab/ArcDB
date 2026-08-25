import { createClient, loadSqlConfig, required } from "./config.js";

try {
  const config = loadSqlConfig();
  const versionId = required(process.env, "ARCDB_SOURCE_VERSION_ID");
  const result = await createClient(config).invalidateOutput(versionId, {
    reason: process.env.ARCDB_INVALIDATION_REASON?.trim() || "Source migration was withdrawn",
    deltaSelectors: [{ kind: "table_column", value: "public.accounts.risk_score" }],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

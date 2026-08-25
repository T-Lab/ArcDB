import { loadSqlConfig, readApiResource, required } from "./config.js";

try {
  const config = loadSqlConfig();
  const effectId = required(process.env, "ARCDB_EFFECT_ID");
  const effect = await readApiResource(config, `/v1/effects/${encodeURIComponent(effectId)}`);
  process.stdout.write(`${JSON.stringify(effect, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

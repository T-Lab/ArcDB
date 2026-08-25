import { loadSqlConfig } from "./config.js";
import { runSqlChangeAgent } from "./workflow.js";

try {
  const result = await runSqlChangeAgent(loadSqlConfig());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(
    `Execution is asynchronous. Inspect Effect ${result.effectId} before recording a Receipt.\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

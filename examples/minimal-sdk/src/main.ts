import { loadConfig } from "./config.js";
import { runMinimalDemo } from "./workflow.js";

try {
  const result = await runMinimalDemo(loadConfig());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

import { loadCodingConfig, runCodingAgent } from "./workflow.js";

try {
  const result = await runCodingAgent(loadCodingConfig());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

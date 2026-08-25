import { ArcDB } from "@arcdb/sdk";
import { implementAdditionTask, verifyCodingArtifact } from "./agent.js";

export interface CodingExampleConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly demoId: string;
  readonly projectId: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function loadCodingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CodingExampleConfig {
  return {
    apiKey: required(environment, "ARCDB_API_KEY"),
    baseUrl: environment.ARCDB_API_URL?.trim() || "http://localhost:4000",
    demoId: environment.ARCDB_DEMO_ID?.trim() || crypto.randomUUID(),
    projectId: required(environment, "ARCDB_PROJECT_ID"),
  };
}

export async function runCodingAgent(config: CodingExampleConfig) {
  const arcdb = new ArcDB(config);
  return arcdb.withRun(
    {
      name: "coding-agent",
      input: { task: "Add an exported add(a, b) function to math.mjs" },
      metadata: { example: "coding-agent", demoId: config.demoId },
    },
    async (run) =>
      run.withTrace(
        { name: "generate-and-verify-patch", metadata: { implementation: "deterministic-local" } },
        async (trace) => {
          const artifact = implementAdditionTask();
          const verification = await verifyCodingArtifact(artifact);
          const output = await run.createOutput({
            logicalId: `examples/coding-agent/${config.demoId}/patch`,
            outputType: "code_patch",
            content: artifact.patch,
            metadata: { task: artifact.task, traceId: trace.id },
          });
          const evidence = await arcdb.addEvidence(output.versionId, {
            verifierType: "node-behavior-test",
            verifierVersion: process.version,
            verdict: verification.testPassed ? "PASS" : "FAIL",
            confidence: 1,
            metrics: {
              addResult: verification.addResult,
              syntaxValid: verification.syntaxValid,
              testPassed: verification.testPassed,
            },
            payload: { command: `${process.execPath} --check math.mjs` },
          });
          const promoted = await arcdb.promoteOutput(output.versionId, {
            expectedHeadVersionId: null,
            requiredVerifierTypes: ["node-behavior-test"],
          });
          return {
            evidenceId: evidence.id,
            outputVersionId: promoted.versionId,
            runId: run.run.id,
            state: promoted.lifecycleState,
            traceId: trace.id,
            verification,
          };
        },
      ),
  );
}

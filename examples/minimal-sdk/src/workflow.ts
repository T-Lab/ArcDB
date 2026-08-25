import { ArcDB } from "@arcdb/sdk";
import type { ExampleConfig } from "./config.js";

export interface MinimalDemoResult {
  readonly evidenceId: string;
  readonly outputVersionId: string;
  readonly runId: string;
  readonly state: string;
  readonly traceId: string;
}

/** A smallest complete lifecycle: observation, immutable Output, Evidence, and promotion. */
export async function runMinimalDemo(config: ExampleConfig): Promise<MinimalDemoResult> {
  const arcdb = new ArcDB({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    projectId: config.projectId,
  });

  return arcdb.withRun(
    {
      name: "minimal-sdk",
      input: { prompt: "Return a deterministic greeting" },
      metadata: { example: "minimal-sdk", demoId: config.demoId },
    },
    async (run) =>
      run.withTrace(
        {
          name: "generate-greeting",
          input: { language: "en" },
          output: { text: "hello from ArcDB" },
          endedAt: new Date().toISOString(),
        },
        async (trace) => {
          const output = await run.createOutput({
            logicalId: `examples/minimal/${config.demoId}`,
            outputType: "text",
            content: "hello from ArcDB",
            metadata: { traceId: trace.id },
          });
          const evidence = await arcdb.addEvidence(output.versionId, {
            verifierType: "exact-content",
            verifierVersion: "1.0.0",
            verdict: "PASS",
            confidence: 1,
            metrics: { exactMatch: true },
          });
          const promoted = await arcdb.promoteOutput(output.versionId, {
            expectedHeadVersionId: null,
            requiredVerifierTypes: ["exact-content"],
          });
          return {
            evidenceId: evidence.id,
            outputVersionId: promoted.versionId,
            runId: run.run.id,
            state: promoted.lifecycleState,
            traceId: trace.id,
          };
        },
      ),
  );
}

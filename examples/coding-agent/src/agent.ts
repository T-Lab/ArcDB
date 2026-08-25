import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface CodingArtifact {
  readonly after: string;
  readonly patch: string;
  readonly task: string;
}

export interface VerificationResult {
  readonly addResult: number;
  readonly syntaxValid: boolean;
  readonly testPassed: boolean;
}

/** A deterministic local coding agent used so this example never depends on a hosted model. */
export function implementAdditionTask(): CodingArtifact {
  const task = "Add an exported add(a, b) function to math.mjs";
  const after = [
    "/** Add two finite numbers. */",
    "export function add(a, b) {",
    "  if (!Number.isFinite(a) || !Number.isFinite(b)) {",
    '    throw new TypeError("add expects finite numbers");',
    "  }",
    "  return a + b;",
    "}",
    "",
  ].join("\n");
  const patch = [
    "diff --git a/math.mjs b/math.mjs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/math.mjs",
    "@@ -0,0 +1,7 @@",
    ...after
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`),
    "",
  ].join("\n");
  return { after, patch, task };
}

/** Materializes the generated module, asks Node to parse it, then executes a behavioral test. */
export async function verifyCodingArtifact(artifact: CodingArtifact): Promise<VerificationResult> {
  const directory = await mkdtemp(join(tmpdir(), "arcdb-coding-agent-"));
  const modulePath = join(directory, "math.mjs");
  try {
    await writeFile(modulePath, artifact.after, "utf8");
    await executeFile(process.execPath, ["--check", modulePath]);
    const module = (await import(`${pathToFileURL(modulePath).href}?run=${Date.now()}`)) as {
      add?: (left: number, right: number) => number;
    };
    if (typeof module.add !== "function") {
      throw new Error("Generated module does not export add");
    }
    const addResult = module.add(2, 3);
    if (addResult !== 5) {
      throw new Error(`Behavioral check failed: add(2, 3) returned ${addResult}`);
    }
    return { addResult, syntaxValid: true, testPassed: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

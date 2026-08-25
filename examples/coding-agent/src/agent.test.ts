import { describe, expect, it } from "vitest";
import { implementAdditionTask, verifyCodingArtifact } from "./agent.js";

describe("local coding agent", () => {
  it("produces a valid patch and proves its behavior", async () => {
    const artifact = implementAdditionTask();
    expect(artifact.patch).toContain("diff --git a/math.mjs b/math.mjs");
    await expect(verifyCodingArtifact(artifact)).resolves.toEqual({
      addResult: 5,
      syntaxValid: true,
      testPassed: true,
    });
  });
});

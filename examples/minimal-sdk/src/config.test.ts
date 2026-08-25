import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("minimal example configuration", () => {
  it("loads an explicit, reproducible configuration", () => {
    expect(
      loadConfig({
        ARCDB_API_KEY: "arcdb_example_key_long_enough",
        ARCDB_API_URL: "http://127.0.0.1:4000",
        ARCDB_DEMO_ID: "ci-42",
        ARCDB_PROJECT_ID: "project-1",
      }),
    ).toEqual({
      apiKey: "arcdb_example_key_long_enough",
      baseUrl: "http://127.0.0.1:4000",
      demoId: "ci-42",
      projectId: "project-1",
    });
  });

  it("fails before making a request when credentials are absent", () => {
    expect(() => loadConfig({ ARCDB_PROJECT_ID: "project-1" })).toThrow(
      "ARCDB_API_KEY is required",
    );
  });
});

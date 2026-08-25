import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "../../src/config.js";

const requiredEnvironment = {
  ARCDB_DATABASE_URL: "postgresql://arcdb-app:test@localhost:5432/arcdb",
  ARCDB_SYSTEM_DATABASE_URL: "postgresql://arcdb-system:test@localhost:5432/arcdb",
};

describe("worker database configuration", () => {
  it("requires separate application and system PostgreSQL URLs", () => {
    expect(readWorkerConfig(requiredEnvironment)).toMatchObject(requiredEnvironment);
    expect(() =>
      readWorkerConfig({ ARCDB_DATABASE_URL: requiredEnvironment.ARCDB_DATABASE_URL }),
    ).toThrow();
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        ARCDB_SYSTEM_DATABASE_URL: "http://localhost:5432/arcdb",
      }),
    ).toThrow();
    expect(() =>
      readWorkerConfig({
        ...requiredEnvironment,
        ARCDB_SYSTEM_DATABASE_URL: requiredEnvironment.ARCDB_DATABASE_URL,
      }),
    ).toThrow(/must be distinct/u);
  });
});

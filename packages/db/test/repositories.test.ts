import { describe, expect, it } from "vitest";
import { boundedLimit, RepositoryError } from "../src/index.js";

describe("repository boundaries", () => {
  it("bounds list sizes before constructing a query", () => {
    expect(boundedLimit(undefined)).toBe(50);
    expect(boundedLimit(500)).toBe(500);
    expect(() => boundedLimit(501)).toThrow(/between 1 and 500/u);
  });

  it("provides stable conflict error codes", () => {
    const error = new RepositoryError("head changed", "CONFLICT");
    expect(error.code).toBe("CONFLICT");
  });
});

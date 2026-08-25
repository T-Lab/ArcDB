import { describe, expect, it } from "vitest";
import { apiErrorDetails } from "../api-error";

describe("API error envelopes", () => {
  it("surfaces ArcDB's nested stable code, message, and request ID", () => {
    expect(
      apiErrorDetails(
        {
          error: { code: "FORBIDDEN", message: "Missing permission", retryable: false },
          requestId: "request-1",
        },
        403,
      ),
    ).toEqual({ code: "FORBIDDEN", message: "Missing permission", requestId: "request-1" });
  });

  it("keeps a safe fallback for malformed upstream errors", () => {
    expect(apiErrorDetails("bad gateway", 502)).toEqual({
      message: "ArcDB API returned HTTP 502.",
    });
  });
});

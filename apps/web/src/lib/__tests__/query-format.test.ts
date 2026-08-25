import { describe, expect, it } from "vitest";
import { buildApiUrl } from "../api-url";
import { formatCompactNumber, formatDuration, jsonText, shortId } from "../format";
import { firstParam, isoDateTimeParam, outputListQuery, traceListQuery, withQuery } from "../query";

describe("URL query helpers", () => {
  it("keeps project scope out of strict API query schemas", () => {
    const url = buildApiUrl("http://api:4000/", "/v1/outputs", {
      projectId: "project-secret-scope",
      lifecycleState: "STALE",
      limit: 50,
    });
    expect(url.toString()).toBe("http://api:4000/v1/outputs?lifecycleState=STALE&limit=50");
  });

  it("reads the first value and keeps server-side filters", () => {
    expect(firstParam(["first", "second"])).toBe("first");
    expect(traceListQuery({ projectId: "p-1", query: " output ", cursor: "c-2" })).toMatchObject({
      projectId: "p-1",
      query: "output",
      cursor: "c-2",
      limit: "50",
    });
    expect(outputListQuery({ status: "STALE", type: "sql" })).toMatchObject({
      lifecycleState: "STALE",
      outputType: "sql",
    });
  });

  it("updates pagination without dropping project scope", () => {
    expect(
      withQuery(
        "/outputs",
        { projectId: "p-1", status: "STALE", cursor: "old" },
        { cursor: "next" },
      ),
    ).toBe("/outputs?projectId=p-1&status=STALE&cursor=next");
  });

  it("normalizes datetime-local filters to strict ISO timestamps", () => {
    const local = "2026-08-25T12:30";
    expect(isoDateTimeParam(local)).toBe(new Date(local).toISOString());
    expect(isoDateTimeParam("not-a-date")).toBeUndefined();
  });
});

describe("display formatting", () => {
  it("formats duration ranges without masking missing data", () => {
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(125)).toBe("125 ms");
    expect(formatDuration(2_500)).toBe("2.50 s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("formats identifiers and values deterministically", () => {
    expect(shortId("1234567890abcdef", 9)).toBe("1234…cdef");
    expect(formatCompactNumber(undefined)).toBe("—");
    expect(jsonText({ state: "STALE" })).toContain('"state": "STALE"');
  });
});

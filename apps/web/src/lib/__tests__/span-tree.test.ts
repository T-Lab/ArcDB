import { describe, expect, it } from "vitest";
import { buildSpanForest, flattenSpanTree } from "../span-tree";
import type { Span } from "../types";

function span(id: string, parentSpanId?: string, startedAt = "2026-08-25T00:00:00Z"): Span {
  return {
    id,
    parentSpanId,
    name: id,
    kind: "SPAN",
    status: "SUCCESS",
    startedAt,
    endedAt: undefined,
    durationMs: undefined,
    input: undefined,
    output: undefined,
    metadata: {},
  };
}

describe("span tree", () => {
  it("creates a stable pre-order tree sorted by start time", () => {
    const roots = buildSpanForest([
      span("child-late", "root", "2026-08-25T00:00:03Z"),
      span("root"),
      span("child-early", "root", "2026-08-25T00:00:01Z"),
    ]);
    expect(flattenSpanTree(roots).map(({ span: item, depth }) => [item.id, depth])).toEqual([
      ["root", 0],
      ["child-early", 1],
      ["child-late", 1],
    ]);
  });

  it("keeps orphaned and cyclic spans visible as roots", () => {
    const rows = flattenSpanTree(
      buildSpanForest([
        span("orphan", "missing"),
        span("a", "b"),
        span("b", "a"),
        span("self", "self"),
      ]),
    );
    expect(new Set(rows.map(({ span: item }) => item.id))).toEqual(
      new Set(["orphan", "a", "b", "self"]),
    );
    expect(rows.every(({ depth }) => depth === 0)).toBe(true);
  });

  it("deduplicates repeated span IDs", () => {
    const rows = flattenSpanTree(
      buildSpanForest([span("same"), { ...span("same"), name: "duplicate" }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.span.name).toBe("same");
  });
});

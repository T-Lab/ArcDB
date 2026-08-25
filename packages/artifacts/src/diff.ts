import { isDeepStrictEqual } from "node:util";
import type { JsonDiffEntry, TextDiffHunk } from "./types.js";

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function diffJson(left: unknown, right: unknown, path = ""): readonly JsonDiffEntry[] {
  if (isDeepStrictEqual(left, right)) {
    return [];
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return [{ path: path || "/", operation: "replace", before: left, after: right }];
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  const changes: JsonDiffEntry[] = [];
  for (const key of [...keys].sort()) {
    const childPath = `${path}/${escapePointer(key)}`;
    if (!(key in leftRecord)) {
      changes.push({ path: childPath, operation: "add", after: rightRecord[key] });
    } else if (!(key in rightRecord)) {
      changes.push({ path: childPath, operation: "remove", before: leftRecord[key] });
    } else {
      changes.push(...diffJson(leftRecord[key], rightRecord[key], childPath));
    }
  }
  return changes;
}

/** A compact single-hunk diff after stripping the common prefix and suffix. */
export function diffText(left: string, right: string): readonly TextDiffHunk[] {
  if (left === right) {
    return [];
  }
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  let prefix = 0;
  while (
    prefix < leftLines.length &&
    prefix < rightLines.length &&
    leftLines[prefix] === rightLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < leftLines.length - prefix &&
    suffix < rightLines.length - prefix &&
    leftLines[leftLines.length - 1 - suffix] === rightLines[rightLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    {
      startLine: prefix + 1,
      removed: leftLines.slice(prefix, leftLines.length - suffix),
      added: rightLines.slice(prefix, rightLines.length - suffix),
    },
  ];
}

import { canonicalize, type LineageSelector, LineageSelectorSchema } from "@arcdb/contracts";

export const UNKNOWN_SELECTOR: LineageSelector = Object.freeze({ kind: "unknown", value: "*" });

function prefixTokensIntersect(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = left[index];
    const rightToken = right[index];
    if (leftToken !== "*" && rightToken !== "*" && leftToken !== rightToken) {
      return false;
    }
  }
  return true;
}

function jsonPathTokens(path: string): readonly string[] | null {
  if (!path.startsWith("$") || /\.\.|\?|:|,/u.test(path)) {
    return null;
  }
  const normalized = path
    .replace(/\[['"]([^'"\]]+)['"]\]/gu, ".$1")
    .replace(/\[(\d+|\*)\]/gu, ".$1");
  if (!/^\$(?:\.[A-Za-z0-9_$*-]+)*$/u.test(normalized)) {
    return null;
  }
  return normalized === "$" ? [] : normalized.slice(2).split(".");
}

function jsonPathsIntersect(left: string, right: string): boolean {
  const leftTokens = jsonPathTokens(left);
  const rightTokens = jsonPathTokens(right);
  // Unsupported JSONPath constructs deliberately over-approximate.
  return (
    leftTokens === null || rightTokens === null || prefixTokensIntersect(leftTokens, rightTokens)
  );
}

function normalizeFileSelector(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
}

function filesIntersect(leftValue: string, rightValue: string): boolean {
  const left = normalizeFileSelector(leftValue);
  const right = normalizeFileSelector(rightValue);
  if (/[*?[\]{}]/u.test(left) || /[*?[\]{}]/u.test(right)) {
    return true;
  }
  if (left === right) {
    return true;
  }
  const leftDirectory = left.endsWith("/") ? left : `${left}/`;
  const rightDirectory = right.endsWith("/") ? right : `${right}/`;
  return left.endsWith("/")
    ? right.startsWith(leftDirectory)
    : right.endsWith("/")
      ? left.startsWith(rightDirectory)
      : false;
}

function dottedSelectorsIntersect(left: string, right: string): boolean {
  const leftTokens = left.split(".");
  const rightTokens = right.split(".");
  if (leftTokens.length !== rightTokens.length) {
    return false;
  }
  return leftTokens.every(
    (token, index) => token === "*" || rightTokens[index] === "*" || token === rightTokens[index],
  );
}

/**
 * Component-selector intersection. Unknown and unsupported syntax always
 * returns true so impact analysis remains conservative.
 */
export function selectorsIntersect(
  unparsedLeft: LineageSelector,
  unparsedRight: LineageSelector,
): boolean {
  const left = LineageSelectorSchema.parse(unparsedLeft);
  const right = LineageSelectorSchema.parse(unparsedRight);
  if (left.kind === "unknown" || right.kind === "unknown") {
    return true;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "json_path":
      return jsonPathsIntersect(left.value, right.value);
    case "file":
      return filesIntersect(left.value, right.value);
    case "table_column":
      return dottedSelectorsIntersect(left.value, right.value);
    case "symbol":
    case "record":
      return left.value === "*" || right.value === "*" || left.value === right.value;
  }
}

export function selectorSetsIntersect(
  left: readonly LineageSelector[],
  right: readonly LineageSelector[],
): boolean {
  return left.some((leftSelector) =>
    right.some((rightSelector) => selectorsIntersect(leftSelector, rightSelector)),
  );
}

export function uniqueSelectors(selectors: readonly LineageSelector[]): readonly LineageSelector[] {
  const byCanonicalValue = new Map<string, LineageSelector>();
  for (const selector of selectors) {
    const parsed = LineageSelectorSchema.parse(selector);
    byCanonicalValue.set(canonicalize(parsed), parsed);
  }
  return [...byCanonicalValue.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, selector]) => selector);
}

import { createHash } from "node:crypto";
import type { EvidenceObject, OutputType } from "./index.js";
import type { LineageEdgeType, LineageSelector } from "./lineage.js";

export class CanonicalizationError extends TypeError {
  public readonly path: string;

  public constructor(message: string, path = "$") {
    super(`${message} at ${path}`);
    this.name = "CanonicalizationError";
    this.path = path;
  }
}

function canonicalizeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError("Non-finite numbers are not canonical JSON", path);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    case "object": {
      const objectValue = value as object;
      if (ancestors.has(objectValue)) {
        throw new CanonicalizationError("Cyclic values are not canonical JSON", path);
      }
      ancestors.add(objectValue);
      try {
        if (Array.isArray(value)) {
          const items = value.map((item, index) => {
            if (!(index in value)) {
              throw new CanonicalizationError(
                "Sparse arrays are not canonical JSON",
                `${path}[${index}]`,
              );
            }
            return canonicalizeValue(item, `${path}[${index}]`, ancestors);
          });
          return `[${items.join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new CanonicalizationError("Only plain objects are canonicalizable", path);
        }

        const entries = Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => {
            const keyPath = `${path}.${key}`;
            return `${JSON.stringify(key)}:${canonicalizeValue(child, keyPath, ancestors)}`;
          });
        return `{${entries.join(",")}}`;
      } finally {
        ancestors.delete(objectValue);
      }
    }
    case "undefined":
    case "bigint":
    case "function":
    case "symbol":
      throw new CanonicalizationError(`Unsupported ${typeof value} value`, path);
  }
  throw new CanonicalizationError("Unsupported value", path);
}

/**
 * Produces deterministic JSON using sorted object keys and ECMAScript JSON
 * primitive serialization. Unsupported or lossy JSON values are rejected.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, "$", new Set());
}

export function canonicalDigest(value: unknown, domain = "arcdb"): string {
  const hash = createHash("sha256");
  hash.update("arcdb-canonical-v1\0", "utf8");
  hash.update(domain, "utf8");
  hash.update("\0", "utf8");
  hash.update(canonicalize(value), "utf8");
  return `sha256:${hash.digest("hex")}`;
}

export interface OutputDigestInput {
  readonly content: unknown;
  readonly outputType: OutputType;
  readonly schemaId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function outputContentDigest(input: OutputDigestInput): string {
  return canonicalDigest(
    {
      content: input.content,
      metadata: input.metadata ?? {},
      outputType: input.outputType,
      schemaId: input.schemaId ?? null,
    },
    "output-content",
  );
}

export type EvidenceFingerprintInput = Pick<
  EvidenceObject,
  | "subjectVersionId"
  | "verifierType"
  | "verifierVersion"
  | "environmentDigest"
  | "dependencyDigests"
  | "policyVersion"
>;

export function evidenceFingerprint(input: EvidenceFingerprintInput): string {
  return canonicalDigest(
    {
      dependencyDigests: [...input.dependencyDigests].sort(),
      environmentDigest: input.environmentDigest ?? null,
      policyVersion: input.policyVersion ?? null,
      subjectVersionId: input.subjectVersionId,
      verifierType: input.verifierType,
      verifierVersion: input.verifierVersion,
    },
    "evidence-scope",
  );
}

export interface DependencyFingerprintPart {
  readonly sourceVersionId: string;
  readonly sourceContentDigest: string;
  readonly edgeType: LineageEdgeType;
  readonly selector?: LineageSelector;
  readonly transferFunction?: string;
}

export function dependencyFingerprint(parts: readonly DependencyFingerprintPart[]): string {
  const normalized = parts
    .map((part) => ({
      edgeType: part.edgeType,
      selector: part.selector ?? null,
      sourceContentDigest: part.sourceContentDigest,
      sourceVersionId: part.sourceVersionId,
      transferFunction: part.transferFunction ?? null,
    }))
    .sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
  return canonicalDigest(normalized, "dependency-set");
}

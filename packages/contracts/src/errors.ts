import { z } from "zod";
import { MetadataSchema } from "./primitives.js";

export const ArcDBErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "INVALID_TRANSITION",
  "IMMUTABLE_VERSION",
  "PROVENANCE_INCOMPLETE",
  "EVIDENCE_REQUIRED",
  "EVIDENCE_STALE",
  "POLICY_DENIED",
  "HEAD_CONFLICT",
  "FENCING_TOKEN_LOST",
  "DUPLICATE_EFFECT",
  "RECEIPT_IMMUTABLE",
  "RECONCILIATION_REQUIRED",
  "INVALID_SELECTOR",
  "LINEAGE_CYCLE",
]);

export type ArcDBErrorCode = z.infer<typeof ArcDBErrorCodeSchema>;

export const ArcDBErrorPayloadSchema = z
  .object({
    name: z.literal("ArcDBDomainError"),
    code: ArcDBErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: MetadataSchema,
  })
  .strict();

export type ArcDBErrorPayload = z.infer<typeof ArcDBErrorPayloadSchema>;

export class ArcDBDomainError extends Error {
  public readonly code: ArcDBErrorCode;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: ArcDBErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArcDBDomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  public toJSON(): ArcDBErrorPayload {
    return {
      name: "ArcDBDomainError",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: { ...this.details },
    };
  }
}

export class InvalidTransitionError extends ArcDBDomainError {
  public constructor(entity: "output" | "effect", from: string, to: string) {
    super("INVALID_TRANSITION", `Cannot transition ${entity} from ${from} to ${to}`, {
      details: { entity, from, to },
    });
  }
}

export class ImmutableVersionError extends ArcDBDomainError {
  public constructor(versionId: string) {
    super("IMMUTABLE_VERSION", `Output version ${versionId} is immutable after commit`, {
      details: { versionId },
    });
  }
}

export class ProvenanceIncompleteError extends ArcDBDomainError {
  public constructor(versionId: string, missingVersionIds: readonly string[]) {
    super("PROVENANCE_INCOMPLETE", `Output version ${versionId} lacks provenance closure`, {
      details: { versionId, missingVersionIds: [...missingVersionIds] },
    });
  }
}

export class EvidencePolicyError extends ArcDBDomainError {
  public constructor(
    code: "EVIDENCE_REQUIRED" | "EVIDENCE_STALE" | "POLICY_DENIED",
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(code, message, { details });
  }
}

export class HeadConflictError extends ArcDBDomainError {
  public constructor(
    logicalId: string,
    expectedHeadVersionId: string | null,
    actualHeadVersionId: string | null,
  ) {
    super("HEAD_CONFLICT", `Logical head changed while promoting ${logicalId}`, {
      retryable: true,
      details: { logicalId, expectedHeadVersionId, actualHeadVersionId },
    });
  }
}

export class FencingTokenLostError extends ArcDBDomainError {
  public constructor(resourceKey: string, presentedToken: number, currentToken: number) {
    super("FENCING_TOKEN_LOST", `Fencing token for ${resourceKey} is no longer current`, {
      retryable: true,
      details: { resourceKey, presentedToken, currentToken },
    });
  }
}

export class DuplicateEffectError extends ArcDBDomainError {
  public constructor(idempotencyKey: string, existingIntentId: string) {
    super("DUPLICATE_EFFECT", `Idempotency key already belongs to effect ${existingIntentId}`, {
      details: { idempotencyKey, existingIntentId },
    });
  }
}

export class ReceiptImmutableError extends ArcDBDomainError {
  public constructor(receiptId: string) {
    super("RECEIPT_IMMUTABLE", `Effect receipt ${receiptId} is append-only`, {
      details: { receiptId },
    });
  }
}

export function isArcDBDomainError(error: unknown): error is ArcDBDomainError {
  return error instanceof ArcDBDomainError;
}

import {
  ArcDBDomainError,
  type EvidenceObject,
  FencingTokenLostError,
  HeadConflictError,
  IdentifierSchema,
  ImmutableVersionError,
  InvalidTransitionError,
  IsoDateTimeSchema,
  type OutputLifecycleState,
  OutputLifecycleStateSchema,
  type OutputObject,
  ProvenanceIncompleteError,
} from "@arcdb/contracts";
import { z } from "zod";
import {
  assertEvidencePolicy,
  type EvidencePolicy,
  type EvidencePolicyEvaluation,
  evaluateEvidencePolicy,
} from "./evidence-policy.js";

export const OUTPUT_TRANSITIONS = {
  CREATED: ["STAGED", "REJECTED", "STALE", "INVALIDATED"],
  STAGED: ["VERIFIED", "REJECTED", "STALE", "INVALIDATED"],
  VERIFIED: ["APPROVED", "REJECTED", "STALE", "INVALIDATED"],
  APPROVED: ["COMMITTED", "REJECTED", "STALE", "INVALIDATED"],
  COMMITTED: ["CONSUMED", "PROMOTED", "STALE", "INVALIDATED", "SUPERSEDED"],
  CONSUMED: ["PROMOTED", "STALE", "INVALIDATED", "SUPERSEDED"],
  PROMOTED: ["STALE", "INVALIDATED", "SUPERSEDED"],
  REJECTED: ["SUPERSEDED"],
  STALE: ["VERIFIED", "INVALIDATED", "SUPERSEDED"],
  INVALIDATED: ["SUPERSEDED"],
  SUPERSEDED: [],
} as const satisfies Readonly<Record<OutputLifecycleState, readonly OutputLifecycleState[]>>;

export const ProvenanceClosureSchema = z
  .object({
    complete: z.boolean(),
    missingVersionIds: z.array(IdentifierSchema),
  })
  .strict()
  .superRefine((closure, context) => {
    if (closure.complete && closure.missingVersionIds.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A complete provenance closure cannot have missing versions",
        path: ["missingVersionIds"],
      });
    }
  });

export const FencingTokenSchema = z
  .object({
    resourceKey: IdentifierSchema,
    presentedToken: z.number().int().nonnegative(),
    currentToken: z.number().int().nonnegative(),
  })
  .strict();

export const HeadReservationSchema = z
  .object({
    expectedHeadVersionId: IdentifierSchema.nullable(),
    currentHeadVersionId: IdentifierSchema.nullable(),
  })
  .strict();

export const LifecycleEventSchema = z
  .object({
    id: IdentifierSchema,
    outputVersionId: IdentifierSchema,
    from: OutputLifecycleStateSchema,
    to: OutputLifecycleStateSchema,
    reason: z.string().trim().min(1).max(4096).optional(),
    evidenceIds: z.array(IdentifierSchema),
    occurredAt: IsoDateTimeSchema,
  })
  .strict();

export type ProvenanceClosure = z.infer<typeof ProvenanceClosureSchema>;
export type FencingToken = z.infer<typeof FencingTokenSchema>;
export type HeadReservation = z.infer<typeof HeadReservationSchema>;
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export function canTransitionOutput(from: OutputLifecycleState, to: OutputLifecycleState): boolean {
  return (OUTPUT_TRANSITIONS[from] as readonly OutputLifecycleState[]).includes(to);
}

export function assertOutputTransition(from: OutputLifecycleState, to: OutputLifecycleState): void {
  if (!canTransitionOutput(from, to)) {
    throw new InvalidTransitionError("output", from, to);
  }
}

export function validateHeadReservation(
  logicalId: string,
  unparsedReservation: HeadReservation,
): void {
  const reservation = HeadReservationSchema.parse(unparsedReservation);
  if (reservation.expectedHeadVersionId !== reservation.currentHeadVersionId) {
    throw new HeadConflictError(
      logicalId,
      reservation.expectedHeadVersionId,
      reservation.currentHeadVersionId,
    );
  }
}

export function validateFencingToken(unparsedFence: FencingToken): void {
  const fence = FencingTokenSchema.parse(unparsedFence);
  if (fence.presentedToken !== fence.currentToken) {
    throw new FencingTokenLostError(fence.resourceKey, fence.presentedToken, fence.currentToken);
  }
}

const CONSERVATIVELY_IMMUTABLE_STATES: ReadonlySet<OutputLifecycleState> = new Set([
  "COMMITTED",
  "CONSUMED",
  "PROMOTED",
  "STALE",
  "INVALIDATED",
  "SUPERSEDED",
]);

export function updateOutputMetadata(
  output: OutputObject,
  metadata: Readonly<Record<string, unknown>>,
  updatedAt: string,
): OutputObject {
  if (CONSERVATIVELY_IMMUTABLE_STATES.has(output.lifecycleState)) {
    throw new ImmutableVersionError(output.versionId);
  }
  const parsedUpdatedAt = IsoDateTimeSchema.parse(updatedAt);
  if (Date.parse(parsedUpdatedAt) < Date.parse(output.updatedAt)) {
    throw new ArcDBDomainError("VALIDATION_ERROR", "updatedAt cannot move backwards", {
      details: { versionId: output.versionId, previousUpdatedAt: output.updatedAt, updatedAt },
    });
  }
  return {
    ...output,
    metadata: { ...metadata },
    updatedAt: parsedUpdatedAt,
  };
}

export interface TransitionOutputInput {
  readonly eventId: string;
  readonly output: OutputObject;
  readonly to: OutputLifecycleState;
  readonly occurredAt: string;
  readonly reason?: string;
  readonly evidence?: readonly EvidenceObject[];
  readonly evidencePolicy?: EvidencePolicy;
  readonly provenance?: ProvenanceClosure;
  readonly headReservation?: HeadReservation;
  readonly fence?: FencingToken;
}

export interface TransitionOutputResult {
  readonly output: OutputObject;
  readonly event: LifecycleEvent;
  readonly policyEvaluation?: EvidencePolicyEvaluation;
}

function requireEvidencePolicy(input: TransitionOutputInput): EvidencePolicyEvaluation {
  if (input.evidencePolicy === undefined) {
    throw new ArcDBDomainError(
      "VALIDATION_ERROR",
      `Transition to ${input.to} requires an explicit Evidence policy`,
      { details: { versionId: input.output.versionId, to: input.to } },
    );
  }
  const evaluation = evaluateEvidencePolicy({
    policy: input.evidencePolicy,
    evidence: input.evidence ?? [],
    subjectVersionId: input.output.versionId,
    now: input.occurredAt,
  });
  assertEvidencePolicy(evaluation);
  return evaluation;
}

/**
 * Pure OLT state transition. Persistence layers should commit the returned
 * Output and lifecycle event atomically with their Evidence/lineage records.
 */
export function transitionOutput(input: TransitionOutputInput): TransitionOutputResult {
  assertOutputTransition(input.output.lifecycleState, input.to);
  const eventId = IdentifierSchema.parse(input.eventId);
  const occurredAt = IsoDateTimeSchema.parse(input.occurredAt);
  if (Date.parse(occurredAt) < Date.parse(input.output.updatedAt)) {
    throw new ArcDBDomainError("VALIDATION_ERROR", "Lifecycle time cannot move backwards", {
      details: {
        versionId: input.output.versionId,
        previousUpdatedAt: input.output.updatedAt,
        occurredAt,
      },
    });
  }

  let policyEvaluation: EvidencePolicyEvaluation | undefined;
  if (input.to === "VERIFIED") {
    policyEvaluation = requireEvidencePolicy(input);
  }
  if (
    (input.to === "APPROVED" || input.to === "PROMOTED") &&
    (input.output.policyVersion !== undefined || input.evidencePolicy !== undefined)
  ) {
    policyEvaluation = requireEvidencePolicy(input);
    if (
      input.output.policyVersion !== undefined &&
      policyEvaluation.policyVersion !== input.output.policyVersion
    ) {
      throw new ArcDBDomainError("POLICY_DENIED", "Output policy version does not match", {
        details: {
          versionId: input.output.versionId,
          expectedPolicyVersion: input.output.policyVersion,
          evaluatedPolicyVersion: policyEvaluation.policyVersion,
        },
      });
    }
  }

  if (input.to === "COMMITTED") {
    const provenance =
      input.provenance === undefined ? undefined : ProvenanceClosureSchema.parse(input.provenance);
    if (provenance === undefined || !provenance.complete) {
      throw new ProvenanceIncompleteError(
        input.output.versionId,
        provenance?.missingVersionIds ?? input.output.parentVersionIds,
      );
    }
    if (input.fence === undefined) {
      throw new ArcDBDomainError("VALIDATION_ERROR", "Commit requires a fencing token", {
        details: { versionId: input.output.versionId },
      });
    }
    validateFencingToken(input.fence);
  }

  if (input.to === "PROMOTED") {
    if (input.headReservation === undefined) {
      throw new ArcDBDomainError("VALIDATION_ERROR", "Promotion requires a head reservation", {
        details: { logicalId: input.output.logicalId, versionId: input.output.versionId },
      });
    }
    validateHeadReservation(input.output.logicalId, input.headReservation);
    if (input.fence === undefined) {
      throw new ArcDBDomainError("VALIDATION_ERROR", "Promotion requires a fencing token", {
        details: { versionId: input.output.versionId },
      });
    }
    validateFencingToken(input.fence);
  }

  const evidenceIds = policyEvaluation?.matchedEvidenceIds ?? [];
  const output: OutputObject = {
    ...input.output,
    lifecycleState: input.to,
    updatedAt: occurredAt,
  };
  const event: LifecycleEvent = {
    id: eventId,
    outputVersionId: input.output.versionId,
    from: input.output.lifecycleState,
    to: input.to,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    evidenceIds: [...evidenceIds],
    occurredAt,
  };

  return policyEvaluation === undefined ? { output, event } : { output, event, policyEvaluation };
}

import {
  ArcDBDomainError,
  canonicalDigest,
  DuplicateEffectError,
  type EffectIntent,
  EffectIntentSchema,
  type EffectIntentStatus,
  type EffectReceipt,
  EffectReceiptSchema,
  InvalidTransitionError,
  ReceiptImmutableError,
} from "@arcdb/contracts";

export const EFFECT_INTENT_TRANSITIONS = {
  PREPARED: ["EXECUTING", "FAILED", "RECONCILIATION_REQUIRED"],
  EXECUTING: ["COMMITTED", "FAILED", "IRREVERSIBLE_COMMITTED", "RECONCILIATION_REQUIRED"],
  COMMITTED: ["COMPENSATION_PENDING", "REMEDIATION_REQUIRED"],
  FAILED: ["EXECUTING", "RECONCILIATION_REQUIRED"],
  COMPENSATION_PENDING: ["COMPENSATED", "REMEDIATION_REQUIRED", "RECONCILIATION_REQUIRED"],
  COMPENSATED: [],
  REMEDIATION_REQUIRED: ["COMPENSATION_PENDING", "COMPENSATED"],
  IRREVERSIBLE_COMMITTED: ["REMEDIATION_REQUIRED"],
  RECONCILIATION_REQUIRED: [
    "EXECUTING",
    "COMMITTED",
    "FAILED",
    "COMPENSATION_PENDING",
    "REMEDIATION_REQUIRED",
    "IRREVERSIBLE_COMMITTED",
  ],
} as const satisfies Readonly<Record<EffectIntentStatus, readonly EffectIntentStatus[]>>;

export function canTransitionEffectIntent(
  from: EffectIntentStatus,
  to: EffectIntentStatus,
): boolean {
  return (EFFECT_INTENT_TRANSITIONS[from] as readonly EffectIntentStatus[]).includes(to);
}

export function transitionEffectIntent(intent: EffectIntent, to: EffectIntentStatus): EffectIntent {
  if (!canTransitionEffectIntent(intent.status, to)) {
    throw new InvalidTransitionError("effect", intent.status, to);
  }
  if (to === "IRREVERSIBLE_COMMITTED" && intent.reversibility !== "R3") {
    throw new ArcDBDomainError(
      "INVALID_TRANSITION",
      "Only R3 effects may enter IRREVERSIBLE_COMMITTED",
      { details: { intentId: intent.id, reversibility: intent.reversibility } },
    );
  }
  return EffectIntentSchema.parse({ ...intent, status: to });
}

function intentOperationDigest(intent: EffectIntent): string {
  return canonicalDigest(
    {
      tenantId: intent.tenantId,
      sourceOutputVersionId: intent.sourceOutputVersionId,
      connectorType: intent.connectorType,
      target: intent.target,
      resourceKey: intent.resourceKey,
      argumentsRef: intent.argumentsRef,
      preconditions: intent.preconditions,
      expectedEffects: intent.expectedEffects,
      readSet: [...intent.readSet].sort(),
      writeSet: [...intent.writeSet].sort(),
      baseResourceVersion: intent.baseResourceVersion ?? null,
      idempotencyKey: intent.idempotencyKey,
      reversibility: intent.reversibility,
      compensationHandler: intent.compensationHandler ?? null,
      riskLevel: intent.riskLevel,
    },
    "effect-operation",
  );
}

export type IdempotencyResolution =
  | { readonly kind: "NEW" }
  | { readonly kind: "REPLAY"; readonly intent: EffectIntent };

export function resolveIdempotentIntent(
  intent: EffectIntent,
  existingIntents: readonly EffectIntent[],
): IdempotencyResolution {
  const parsedIntent = EffectIntentSchema.parse(intent);
  const existing = existingIntents.find(
    (candidate) =>
      candidate.tenantId === parsedIntent.tenantId &&
      candidate.idempotencyKey === parsedIntent.idempotencyKey,
  );
  if (existing === undefined) {
    return { kind: "NEW" };
  }
  if (intentOperationDigest(existing) !== intentOperationDigest(parsedIntent)) {
    throw new DuplicateEffectError(parsedIntent.idempotencyKey, existing.id);
  }
  return { kind: "REPLAY", intent: existing };
}

/** Returns a new receipt log; existing entries are never changed or removed. */
export function appendEffectReceipt(
  receipts: readonly EffectReceipt[],
  receipt: EffectReceipt,
  intent: EffectIntent,
): readonly EffectReceipt[] {
  const parsedReceipt = EffectReceiptSchema.parse(receipt);
  if (parsedReceipt.intentId !== intent.id) {
    throw new ArcDBDomainError("VALIDATION_ERROR", "Receipt does not belong to EffectIntent", {
      details: {
        receiptId: parsedReceipt.id,
        receiptIntentId: parsedReceipt.intentId,
        expectedIntentId: intent.id,
      },
    });
  }
  const sameId = receipts.find((existing) => existing.id === parsedReceipt.id);
  if (sameId !== undefined) {
    if (
      canonicalDigest(sameId, "effect-receipt") === canonicalDigest(parsedReceipt, "effect-receipt")
    ) {
      return [...receipts];
    }
    throw new ReceiptImmutableError(parsedReceipt.id);
  }
  return [...receipts, parsedReceipt];
}

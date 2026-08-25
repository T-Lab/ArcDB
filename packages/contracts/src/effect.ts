import { z } from "zod";
import {
  addDuplicateIssue,
  DigestSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  MetadataSchema,
} from "./primitives.js";

export const ReversibilitySchema = z.enum(["R0", "R1", "R2", "R3"]);
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const EffectIntentStatusSchema = z.enum([
  "PREPARED",
  "EXECUTING",
  "COMMITTED",
  "FAILED",
  "COMPENSATION_PENDING",
  "COMPENSATED",
  "REMEDIATION_REQUIRED",
  "IRREVERSIBLE_COMMITTED",
  "RECONCILIATION_REQUIRED",
]);

export const EffectIntentSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    sourceOutputVersionId: IdentifierSchema,
    connectorType: IdentifierSchema,
    target: IdentifierSchema,
    resourceKey: IdentifierSchema,
    argumentsRef: IdentifierSchema,
    preconditions: MetadataSchema,
    expectedEffects: MetadataSchema,
    readSet: z.array(IdentifierSchema),
    writeSet: z.array(IdentifierSchema),
    baseResourceVersion: IdentifierSchema.optional(),
    idempotencyKey: IdentifierSchema,
    reversibility: ReversibilitySchema,
    compensationHandler: IdentifierSchema.optional(),
    riskLevel: RiskLevelSchema,
    status: EffectIntentStatusSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    addDuplicateIssue(intent.readSet, context, "readSet");
    addDuplicateIssue(intent.writeSet, context, "writeSet");
    if (intent.reversibility === "R0" && intent.compensationHandler === undefined) {
      context.addIssue({
        code: "custom",
        message: "R0 effects require a compensationHandler",
        path: ["compensationHandler"],
      });
    }
    if (intent.status === "IRREVERSIBLE_COMMITTED" && intent.reversibility !== "R3") {
      context.addIssue({
        code: "custom",
        message: "IRREVERSIBLE_COMMITTED is only valid for R3 effects",
        path: ["status"],
      });
    }
  });

export const EffectReceiptSchema = z
  .object({
    id: IdentifierSchema,
    intentId: IdentifierSchema,
    externalTransactionId: IdentifierSchema.optional(),
    externalStatus: z.string().trim().min(1).max(512),
    beforeDigest: DigestSchema.optional(),
    afterDigest: DigestSchema.optional(),
    actualEffects: MetadataSchema,
    rawResponseRef: IdentifierSchema.optional(),
    compensationStatus: z.string().trim().min(1).max(512).optional(),
    committedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const ConnectorCapabilitiesSchema = z
  .object({
    supportsIdempotencyKey: z.boolean(),
    supportsQueryByIdempotencyKey: z.boolean(),
    supportsQueryByExternalId: z.boolean(),
    supportsConditionalWrite: z.boolean(),
    supportsFencingToken: z.boolean(),
    supportsCompensation: z.boolean(),
    supportsStateDigests: z.boolean(),
    supportsDryRun: z.boolean(),
    supportsHumanApproval: z.boolean(),
    reversibility: ReversibilitySchema,
  })
  .strict();

/**
 * Canonical capabilities for ArcDB's production-safe manual connector.
 * Keeping this in the shared contract prevents the API and worker from
 * silently disagreeing about the security properties of the same intent.
 */
export const MANUAL_RECEIPT_CONNECTOR_CAPABILITIES = Object.freeze(
  ConnectorCapabilitiesSchema.parse({
    supportsIdempotencyKey: false,
    supportsQueryByIdempotencyKey: false,
    supportsQueryByExternalId: false,
    supportsConditionalWrite: false,
    supportsFencingToken: false,
    supportsCompensation: false,
    supportsStateDigests: false,
    supportsDryRun: true,
    supportsHumanApproval: true,
    reversibility: "R3",
  }),
);

export const RemediationStatusSchema = z.enum([
  "OPEN",
  "PENDING_APPROVAL",
  "IN_PROGRESS",
  "RESOLVED",
  "WAIVED",
]);

export const RemediationObligationSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    effectIntentId: IdentifierSchema,
    sourceOutputVersionId: IdentifierSchema,
    reason: z.string().trim().min(1).max(4096),
    riskLevel: RiskLevelSchema,
    reversibility: ReversibilitySchema,
    requiresHumanApproval: z.boolean(),
    status: RemediationStatusSchema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export type Reversibility = z.infer<typeof ReversibilitySchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type EffectIntentStatus = z.infer<typeof EffectIntentStatusSchema>;
export type EffectIntent = z.infer<typeof EffectIntentSchema>;
export type EffectReceipt = z.infer<typeof EffectReceiptSchema>;
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilitiesSchema>;
export type RemediationStatus = z.infer<typeof RemediationStatusSchema>;
export type RemediationObligation = z.infer<typeof RemediationObligationSchema>;

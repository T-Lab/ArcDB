import { z } from "zod";
import {
  addDuplicateIssue,
  DigestSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
} from "./primitives.js";

export const EvidenceVerdictSchema = z.enum(["PASS", "FAIL", "STALE", "UNKNOWN"]);
export const EvidenceMetricValueSchema = z.union([z.number().finite(), z.string(), z.boolean()]);

export const EvidenceObjectSchema = z
  .object({
    id: IdentifierSchema,
    tenantId: IdentifierSchema,
    subjectVersionId: IdentifierSchema,
    verifierType: IdentifierSchema,
    verifierVersion: IdentifierSchema,
    environmentDigest: DigestSchema.optional(),
    dependencyDigests: z.array(DigestSchema),
    policyVersion: IdentifierSchema.optional(),
    verdict: EvidenceVerdictSchema,
    confidence: z.number().min(0).max(1).optional(),
    metrics: z.record(z.string(), EvidenceMetricValueSchema),
    payloadRef: IdentifierSchema.optional(),
    fingerprint: DigestSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    addDuplicateIssue(evidence.dependencyDigests, context, "dependencyDigests");
    if (
      evidence.expiresAt !== undefined &&
      Date.parse(evidence.expiresAt) <= Date.parse(evidence.createdAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "expiresAt must be later than createdAt",
        path: ["expiresAt"],
      });
    }
  });

export type EvidenceVerdict = z.infer<typeof EvidenceVerdictSchema>;
export type EvidenceMetricValue = z.infer<typeof EvidenceMetricValueSchema>;
export type EvidenceObject = z.infer<typeof EvidenceObjectSchema>;

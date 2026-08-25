import {
  DigestSchema,
  type EvidenceObject,
  EvidencePolicyError,
  evidenceFingerprint,
  IdentifierSchema,
  IsoDateTimeSchema,
} from "@arcdb/contracts";
import { z } from "zod";

export const EvidenceFreshnessReasonSchema = z.enum([
  "EXPLICITLY_STALE",
  "FINGERPRINT_MISMATCH",
  "SUBJECT_VERSION_CHANGED",
  "VERIFIER_VERSION_CHANGED",
  "ENVIRONMENT_CHANGED",
  "DEPENDENCIES_CHANGED",
  "POLICY_CHANGED",
  "EXPIRED",
  "MAX_AGE_EXCEEDED",
  "CREATED_IN_FUTURE",
]);

export const EvidenceFreshnessScopeSchema = z
  .object({
    subjectVersionId: IdentifierSchema,
    verifierVersion: IdentifierSchema.optional(),
    environmentDigest: DigestSchema.nullable().optional(),
    dependencyDigests: z.array(DigestSchema).optional(),
    policyVersion: IdentifierSchema.nullable().optional(),
    maxAgeSeconds: z.number().int().positive().optional(),
    now: IsoDateTimeSchema,
  })
  .strict();

export const EvidenceRequirementSchema = z
  .object({
    id: IdentifierSchema,
    verifierType: IdentifierSchema,
    verifierVersion: IdentifierSchema.optional(),
    environmentDigest: DigestSchema.nullable().optional(),
    dependencyDigests: z.array(DigestSchema).optional(),
    policyVersion: IdentifierSchema.nullable().optional(),
    maxAgeSeconds: z.number().int().positive().optional(),
    minimumConfidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const EvidencePolicySchema = z
  .object({
    id: IdentifierSchema,
    version: IdentifierSchema,
    requiredEvidence: z.array(EvidenceRequirementSchema).min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.requiredEvidence.map((requirement) => requirement.id)).size !==
      policy.requiredEvidence.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence requirement ids must be unique",
        path: ["requiredEvidence"],
      });
    }
  });

export type EvidenceFreshnessReason = z.infer<typeof EvidenceFreshnessReasonSchema>;
export type EvidenceFreshnessScope = z.infer<typeof EvidenceFreshnessScopeSchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
export type EvidencePolicy = z.infer<typeof EvidencePolicySchema>;

export interface EvidenceFreshnessAssessment {
  readonly status: "FRESH" | "STALE";
  readonly reasons: readonly EvidenceFreshnessReason[];
}

function sorted(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = sorted(left);
  const sortedRight = sorted(right);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

export function assessEvidenceFreshness(
  evidence: EvidenceObject,
  unparsedScope: EvidenceFreshnessScope,
): EvidenceFreshnessAssessment {
  const scope = EvidenceFreshnessScopeSchema.parse(unparsedScope);
  const reasons: EvidenceFreshnessReason[] = [];

  if (evidence.verdict === "STALE") {
    reasons.push("EXPLICITLY_STALE");
  }
  if (evidence.fingerprint !== evidenceFingerprint(evidence)) {
    reasons.push("FINGERPRINT_MISMATCH");
  }
  if (evidence.subjectVersionId !== scope.subjectVersionId) {
    reasons.push("SUBJECT_VERSION_CHANGED");
  }
  if (scope.verifierVersion !== undefined && evidence.verifierVersion !== scope.verifierVersion) {
    reasons.push("VERIFIER_VERSION_CHANGED");
  }
  if (
    scope.environmentDigest !== undefined &&
    (evidence.environmentDigest ?? null) !== scope.environmentDigest
  ) {
    reasons.push("ENVIRONMENT_CHANGED");
  }
  if (
    scope.dependencyDigests !== undefined &&
    !equalStringSets(evidence.dependencyDigests, scope.dependencyDigests)
  ) {
    reasons.push("DEPENDENCIES_CHANGED");
  }
  if (
    scope.policyVersion !== undefined &&
    (evidence.policyVersion ?? null) !== scope.policyVersion
  ) {
    reasons.push("POLICY_CHANGED");
  }

  const now = Date.parse(scope.now);
  const createdAt = Date.parse(evidence.createdAt);
  if (createdAt > now) {
    reasons.push("CREATED_IN_FUTURE");
  }
  if (evidence.expiresAt !== undefined && Date.parse(evidence.expiresAt) <= now) {
    reasons.push("EXPIRED");
  }
  if (scope.maxAgeSeconds !== undefined && now - createdAt > scope.maxAgeSeconds * 1_000) {
    reasons.push("MAX_AGE_EXCEEDED");
  }

  return {
    status: reasons.length === 0 ? "FRESH" : "STALE",
    reasons,
  };
}

export type EvidenceRequirementFailureKind =
  | "MISSING"
  | "STALE"
  | "FAILED"
  | "UNKNOWN"
  | "LOW_CONFIDENCE";

export interface EvidenceRequirementFailure {
  readonly requirementId: string;
  readonly kind: EvidenceRequirementFailureKind;
  readonly evidenceIds: readonly string[];
  readonly freshnessReasons: readonly EvidenceFreshnessReason[];
}

export interface EvidencePolicyEvaluation {
  readonly decision: "APPROVED" | "DENIED";
  readonly policyId: string;
  readonly policyVersion: string;
  readonly subjectVersionId: string;
  readonly evaluatedAt: string;
  readonly matchedEvidenceIds: readonly string[];
  readonly failures: readonly EvidenceRequirementFailure[];
}

export interface EvaluateEvidencePolicyInput {
  readonly policy: EvidencePolicy;
  readonly evidence: readonly EvidenceObject[];
  readonly subjectVersionId: string;
  readonly now: string;
}

function scopeForRequirement(
  requirement: EvidenceRequirement,
  subjectVersionId: string,
  policy: EvidencePolicy,
  now: string,
): EvidenceFreshnessScope {
  return {
    subjectVersionId,
    ...(requirement.verifierVersion === undefined
      ? {}
      : { verifierVersion: requirement.verifierVersion }),
    ...(requirement.environmentDigest === undefined
      ? {}
      : { environmentDigest: requirement.environmentDigest }),
    ...(requirement.dependencyDigests === undefined
      ? {}
      : { dependencyDigests: requirement.dependencyDigests }),
    policyVersion:
      requirement.policyVersion === undefined ? policy.version : requirement.policyVersion,
    ...(requirement.maxAgeSeconds === undefined
      ? {}
      : { maxAgeSeconds: requirement.maxAgeSeconds }),
    now,
  };
}

export function evaluateEvidencePolicy(
  unparsedInput: EvaluateEvidencePolicyInput,
): EvidencePolicyEvaluation {
  const policy = EvidencePolicySchema.parse(unparsedInput.policy);
  const subjectVersionId = IdentifierSchema.parse(unparsedInput.subjectVersionId);
  const now = IsoDateTimeSchema.parse(unparsedInput.now);
  const evidence = unparsedInput.evidence;
  const failures: EvidenceRequirementFailure[] = [];
  const matchedEvidenceIds: string[] = [];

  for (const requirement of policy.requiredEvidence) {
    const candidates = evidence.filter(
      (candidate) =>
        candidate.subjectVersionId === subjectVersionId &&
        candidate.verifierType === requirement.verifierType,
    );
    if (candidates.length === 0) {
      failures.push({
        requirementId: requirement.id,
        kind: "MISSING",
        evidenceIds: [],
        freshnessReasons: [],
      });
      continue;
    }

    const assessments = candidates.map((candidate) => ({
      candidate,
      freshness: assessEvidenceFreshness(
        candidate,
        scopeForRequirement(requirement, subjectVersionId, policy, now),
      ),
    }));
    const fresh = assessments.filter((assessment) => assessment.freshness.status === "FRESH");
    const passing = fresh.find(
      ({ candidate }) =>
        candidate.verdict === "PASS" &&
        (requirement.minimumConfidence === undefined ||
          (candidate.confidence ?? 0) >= requirement.minimumConfidence),
    );
    if (passing !== undefined) {
      matchedEvidenceIds.push(passing.candidate.id);
      continue;
    }

    if (fresh.length === 0) {
      failures.push({
        requirementId: requirement.id,
        kind: "STALE",
        evidenceIds: candidates.map((candidate) => candidate.id),
        freshnessReasons: [...new Set(assessments.flatMap(({ freshness }) => freshness.reasons))],
      });
      continue;
    }

    const freshCandidates = fresh.map(({ candidate }) => candidate);
    const kind: EvidenceRequirementFailureKind = freshCandidates.some(
      (candidate) =>
        candidate.verdict === "PASS" &&
        requirement.minimumConfidence !== undefined &&
        (candidate.confidence ?? 0) < requirement.minimumConfidence,
    )
      ? "LOW_CONFIDENCE"
      : freshCandidates.some((candidate) => candidate.verdict === "FAIL")
        ? "FAILED"
        : "UNKNOWN";
    failures.push({
      requirementId: requirement.id,
      kind,
      evidenceIds: freshCandidates.map((candidate) => candidate.id),
      freshnessReasons: [],
    });
  }

  return {
    decision: failures.length === 0 ? "APPROVED" : "DENIED",
    policyId: policy.id,
    policyVersion: policy.version,
    subjectVersionId,
    evaluatedAt: now,
    matchedEvidenceIds,
    failures,
  };
}

export function assertEvidencePolicy(evaluation: EvidencePolicyEvaluation): void {
  if (evaluation.decision === "APPROVED") {
    return;
  }
  const failureKinds = new Set(evaluation.failures.map((failure) => failure.kind));
  const code = failureKinds.has("MISSING")
    ? "EVIDENCE_REQUIRED"
    : failureKinds.has("STALE")
      ? "EVIDENCE_STALE"
      : "POLICY_DENIED";
  throw new EvidencePolicyError(code, `Evidence policy ${evaluation.policyId} denied promotion`, {
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    subjectVersionId: evaluation.subjectVersionId,
    failures: evaluation.failures,
  });
}

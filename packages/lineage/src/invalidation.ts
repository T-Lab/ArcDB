import {
  canonicalDigest,
  type EffectIntent,
  EffectIntentSchema,
  type EffectReceipt,
  EffectReceiptSchema,
  type EvidenceObject,
  EvidenceObjectSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  type LineageEdge,
  LineageEdgeSchema,
  type OutputLifecycleState,
  type OutputObject,
  OutputObjectSchema,
  type RemediationObligation,
  RemediationObligationSchema,
} from "@arcdb/contracts";
import { z } from "zod";
import {
  type ArtifactDelta,
  ArtifactDeltaSchema,
  type ComputeImpactInput,
  computeImpact,
  type FingerprintResolver,
  type ImpactAnalysisResult,
  ImpactAnalysisResultSchema,
  type ImpactTransferFunction,
} from "./impact.js";

export const OutputInvalidationTransitionSchema = z
  .object({
    versionId: IdentifierSchema,
    from: z.enum([
      "CREATED",
      "STAGED",
      "VERIFIED",
      "APPROVED",
      "COMMITTED",
      "CONSUMED",
      "PROMOTED",
      "REJECTED",
      "STALE",
      "INVALIDATED",
      "SUPERSEDED",
    ]),
    to: z.enum(["STALE", "INVALIDATED"]),
    reason: z.string().min(1),
  })
  .strict();

export const EvidenceInvalidationTransitionSchema = z
  .object({
    evidenceId: IdentifierSchema,
    subjectVersionId: IdentifierSchema,
    from: z.enum(["PASS", "FAIL", "STALE", "UNKNOWN"]),
    to: z.literal("STALE"),
    reason: z.string().min(1),
  })
  .strict();

export const RecomputationStepSchema = z
  .object({
    versionId: IdentifierSchema,
    generation: z.number().int().positive(),
    dependsOnVersionIds: z.array(IdentifierSchema),
    reasonEdgeIds: z.array(IdentifierSchema),
  })
  .strict();

export const InvalidationPlanSchema = z
  .object({
    id: IdentifierSchema,
    sourceVersionId: IdentifierSchema,
    reason: z.string().min(1).max(4096),
    createdAt: IsoDateTimeSchema,
    impact: ImpactAnalysisResultSchema,
    outputTransitions: z.array(OutputInvalidationTransitionSchema),
    evidenceTransitions: z.array(EvidenceInvalidationTransitionSchema),
    recomputationSteps: z.array(RecomputationStepSchema),
    remediationObligations: z.array(RemediationObligationSchema),
    preservedReceiptIds: z.array(IdentifierSchema),
  })
  .strict();

export type OutputInvalidationTransition = z.infer<typeof OutputInvalidationTransitionSchema>;
export type EvidenceInvalidationTransition = z.infer<typeof EvidenceInvalidationTransitionSchema>;
export type RecomputationStep = z.infer<typeof RecomputationStepSchema>;
export type InvalidationPlan = z.infer<typeof InvalidationPlanSchema>;

export interface CreateInvalidationPlanInput {
  readonly sourceVersionId: string;
  readonly delta: ArtifactDelta;
  readonly reason: string;
  readonly createdAt: string;
  readonly edges: readonly LineageEdge[];
  readonly outputs: readonly OutputObject[];
  readonly evidence: readonly EvidenceObject[];
  readonly effectIntents: readonly EffectIntent[];
  readonly receipts: readonly EffectReceipt[];
  readonly transferFunctions?: Readonly<Record<string, ImpactTransferFunction>>;
  readonly currentFingerprints?: Readonly<Record<string, string>>;
  readonly fingerprintResolver?: FingerprintResolver;
}

const EXTERNAL_REALITY_STATUSES: ReadonlySet<EffectIntent["status"]> = new Set([
  "COMMITTED",
  "COMPENSATION_PENDING",
  "COMPENSATED",
  "REMEDIATION_REQUIRED",
  "IRREVERSIBLE_COMMITTED",
  "RECONCILIATION_REQUIRED",
]);

function remediationId(intent: EffectIntent, sourceVersionId: string, reason: string): string {
  return `remediation_${canonicalDigest(
    { intentId: intent.id, sourceVersionId, reason },
    "remediation-obligation",
  ).slice("sha256:".length, "sha256:".length + 32)}`;
}

function remediationFor(
  intent: EffectIntent,
  sourceVersionId: string,
  reason: string,
  createdAt: string,
): RemediationObligation {
  const requiresHumanApproval =
    intent.reversibility === "R3" || intent.riskLevel === "HIGH" || intent.riskLevel === "CRITICAL";
  return RemediationObligationSchema.parse({
    id: remediationId(intent, sourceVersionId, reason),
    tenantId: intent.tenantId,
    effectIntentId: intent.id,
    sourceOutputVersionId: intent.sourceOutputVersionId,
    reason,
    riskLevel: intent.riskLevel,
    reversibility: intent.reversibility,
    requiresHumanApproval,
    status: requiresHumanApproval ? "PENDING_APPROVAL" : "OPEN",
    createdAt,
  });
}

function transitionTargetState(
  versionId: string,
  sourceVersionId: string,
  current: OutputLifecycleState,
): "STALE" | "INVALIDATED" | null {
  if (current === "SUPERSEDED" || current === "REJECTED" || current === "INVALIDATED") {
    return null;
  }
  const target = versionId === sourceVersionId ? "INVALIDATED" : "STALE";
  return current === target ? null : target;
}

function buildImpactInput(
  input: CreateInvalidationPlanInput,
  sourceVersionId: string,
  delta: ArtifactDelta,
  edges: readonly LineageEdge[],
): ComputeImpactInput {
  return {
    sourceVersionId,
    delta,
    edges,
    ...(input.transferFunctions === undefined
      ? {}
      : { transferFunctions: input.transferFunctions }),
    ...(input.currentFingerprints === undefined
      ? {}
      : { currentFingerprints: input.currentFingerprints }),
    ...(input.fingerprintResolver === undefined
      ? {}
      : { fingerprintResolver: input.fingerprintResolver }),
  };
}

export function createInvalidationPlan(input: CreateInvalidationPlanInput): InvalidationPlan {
  const sourceVersionId = IdentifierSchema.parse(input.sourceVersionId);
  const delta = ArtifactDeltaSchema.parse(input.delta);
  const createdAt = IsoDateTimeSchema.parse(input.createdAt);
  const reason = z.string().trim().min(1).max(4096).parse(input.reason);
  const edges = input.edges.map((edge) => LineageEdgeSchema.parse(edge));
  const outputs = input.outputs.map((output) => OutputObjectSchema.parse(output));
  const evidence = input.evidence.map((record) => EvidenceObjectSchema.parse(record));
  const effectIntents = input.effectIntents.map((intent) => EffectIntentSchema.parse(intent));
  const receipts = input.receipts.map((receipt) => EffectReceiptSchema.parse(receipt));

  const impact = computeImpact(buildImpactInput(input, sourceVersionId, delta, edges));
  const affectedIds = new Set(impact.affectedNodes.map((node) => node.versionId));
  const outputsByVersion = new Map(outputs.map((output) => [output.versionId, output]));

  const outputTransitions: OutputInvalidationTransition[] = [];
  for (const node of impact.affectedNodes) {
    const output = outputsByVersion.get(node.versionId);
    if (output === undefined) {
      continue;
    }
    const to = transitionTargetState(node.versionId, sourceVersionId, output.lifecycleState);
    if (to === null) {
      continue;
    }
    outputTransitions.push({
      versionId: output.versionId,
      from: output.lifecycleState,
      to,
      reason,
    });
  }

  const evidenceTransitions: EvidenceInvalidationTransition[] = evidence
    .filter((record) => affectedIds.has(record.subjectVersionId) && record.verdict !== "STALE")
    .map((record) => ({
      evidenceId: record.id,
      subjectVersionId: record.subjectVersionId,
      from: record.verdict,
      to: "STALE" as const,
      reason,
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));

  const affectedEdgesByTarget = new Map<string, LineageEdge[]>();
  for (const edge of edges) {
    if (affectedIds.has(edge.sourceVersionId) && affectedIds.has(edge.targetVersionId)) {
      const current = affectedEdgesByTarget.get(edge.targetVersionId) ?? [];
      current.push(edge);
      affectedEdgesByTarget.set(edge.targetVersionId, current);
    }
  }
  const recomputationSteps: RecomputationStep[] = impact.affectedNodes
    .filter((node) => node.versionId !== sourceVersionId && outputsByVersion.has(node.versionId))
    .map((node) => {
      const incoming = affectedEdgesByTarget.get(node.versionId) ?? [];
      return {
        versionId: node.versionId,
        generation: Math.max(1, node.generation),
        dependsOnVersionIds: [...new Set(incoming.map((edge) => edge.sourceVersionId))].sort(),
        reasonEdgeIds: [...new Set(incoming.map((edge) => edge.id))].sort(),
      };
    })
    .sort(
      (left, right) =>
        left.generation - right.generation || left.versionId.localeCompare(right.versionId),
    );

  const affectedIntents = effectIntents.filter((intent) =>
    affectedIds.has(intent.sourceOutputVersionId),
  );
  const remediationObligations = affectedIntents
    .filter((intent) => EXTERNAL_REALITY_STATUSES.has(intent.status))
    .map((intent) => remediationFor(intent, sourceVersionId, reason, createdAt))
    .sort((left, right) => left.id.localeCompare(right.id));
  const affectedIntentIds = new Set(affectedIntents.map((intent) => intent.id));
  const preservedReceiptIds = receipts
    .filter((receipt) => affectedIntentIds.has(receipt.intentId))
    .map((receipt) => receipt.id)
    .sort();

  const planPayload = {
    sourceVersionId,
    delta,
    reason,
    affectedVersionIds: [...affectedIds].sort(),
  };
  const id = `invalidation_${canonicalDigest(planPayload, "invalidation-plan").slice(
    "sha256:".length,
    "sha256:".length + 32,
  )}`;

  return InvalidationPlanSchema.parse({
    id,
    sourceVersionId,
    reason,
    createdAt,
    impact,
    outputTransitions,
    evidenceTransitions,
    recomputationSteps,
    remediationObligations,
    preservedReceiptIds,
  });
}

export function applyInvalidationPlan(
  plan: InvalidationPlan,
  outputs: readonly OutputObject[],
  evidence: readonly EvidenceObject[],
): { readonly outputs: readonly OutputObject[]; readonly evidence: readonly EvidenceObject[] } {
  const parsedPlan = InvalidationPlanSchema.parse(plan);
  const outputTransitions = new Map(
    parsedPlan.outputTransitions.map((transition) => [transition.versionId, transition]),
  );
  const evidenceTransitions = new Set(
    parsedPlan.evidenceTransitions.map((transition) => transition.evidenceId),
  );
  return {
    outputs: outputs.map((unparsedOutput) => {
      const output = OutputObjectSchema.parse(unparsedOutput);
      const transition = outputTransitions.get(output.versionId);
      return transition === undefined
        ? output
        : OutputObjectSchema.parse({
            ...output,
            lifecycleState: transition.to,
            updatedAt: parsedPlan.createdAt,
          });
    }),
    evidence: evidence.map((unparsedEvidence) => {
      const record = EvidenceObjectSchema.parse(unparsedEvidence);
      return evidenceTransitions.has(record.id)
        ? EvidenceObjectSchema.parse({ ...record, verdict: "STALE" })
        : record;
    }),
  };
}

export function explainImpact(plan: InvalidationPlan, versionId: string): readonly string[] {
  const parsedPlan = InvalidationPlanSchema.parse(plan);
  const target = IdentifierSchema.parse(versionId);
  if (target === parsedPlan.sourceVersionId) {
    return [`${target} is the invalidation source: ${parsedPlan.reason}`];
  }
  const predecessors = new Map<string, typeof parsedPlan.impact.reasonGraph>();
  for (const edge of parsedPlan.impact.reasonGraph.filter(
    (reasonEdge) => reasonEdge.disposition === "AFFECTED",
  )) {
    const current = predecessors.get(edge.targetVersionId) ?? [];
    current.push(edge);
    predecessors.set(edge.targetVersionId, current);
  }
  const explanations: string[] = [];
  const queue: Array<{ readonly versionId: string; readonly path: readonly string[] }> = [
    { versionId: target, path: [] },
  ];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.versionId)) {
      continue;
    }
    visited.add(current.versionId);
    for (const edge of predecessors.get(current.versionId) ?? []) {
      const step = `${edge.sourceVersionId} -[${edge.edgeId}:${edge.reason}]-> ${edge.targetVersionId}`;
      const path = [step, ...current.path];
      if (edge.sourceVersionId === parsedPlan.sourceVersionId) {
        explanations.push(path.join(" | "));
      } else {
        queue.push({ versionId: edge.sourceVersionId, path });
      }
    }
  }
  return explanations.sort();
}

export type { ImpactAnalysisResult };

import {
  canonicalize,
  DigestSchema,
  IdentifierSchema,
  type LineageEdge,
  LineageEdgeSchema,
  type LineageSelector,
  LineageSelectorSchema,
} from "@arcdb/contracts";
import { z } from "zod";
import { selectorSetsIntersect, UNKNOWN_SELECTOR, uniqueSelectors } from "./selectors.js";

export const ArtifactDeltaSchema = z
  .object({
    selectors: z.array(LineageSelectorSchema).min(1),
    beforeDigest: DigestSchema.optional(),
    afterDigest: DigestSchema.optional(),
  })
  .strict()
  .superRefine((delta, context) => {
    if (
      delta.beforeDigest !== undefined &&
      delta.afterDigest !== undefined &&
      delta.beforeDigest === delta.afterDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "A Delta cannot have identical before and after digests",
        path: ["afterDigest"],
      });
    }
  });

export const ImpactReasonCodeSchema = z.enum([
  "SOURCE_DELTA",
  "SELECTOR_INTERSECTION",
  "UNKNOWN_SELECTOR",
  "TRANSFER_FUNCTION",
  "MISSING_TRANSFER_FUNCTION",
  "SELECTOR_DISJOINT",
  "TRANSFER_REJECTED",
  "FINGERPRINT_UNCHANGED",
]);

export const ImpactReasonEdgeSchema = z
  .object({
    edgeId: IdentifierSchema,
    sourceVersionId: IdentifierSchema,
    targetVersionId: IdentifierSchema,
    disposition: z.enum(["AFFECTED", "SKIPPED"]),
    reason: ImpactReasonCodeSchema,
    detail: z.string().min(1),
  })
  .strict();

export const AffectedNodeSchema = z
  .object({
    versionId: IdentifierSchema,
    generation: z.number().int().nonnegative(),
    selectors: z.array(LineageSelectorSchema).min(1),
    viaEdgeIds: z.array(IdentifierSchema),
  })
  .strict();

export const SkippedNodeSchema = z
  .object({
    versionId: IdentifierSchema,
    viaEdgeIds: z.array(IdentifierSchema),
    reasons: z.array(ImpactReasonCodeSchema).min(1),
  })
  .strict();

export const ImpactAnalysisResultSchema = z
  .object({
    sourceVersionId: IdentifierSchema,
    affectedNodes: z.array(AffectedNodeSchema),
    skippedNodes: z.array(SkippedNodeSchema),
    reasonGraph: z.array(ImpactReasonEdgeSchema),
    visitedEdgeCount: z.number().int().nonnegative(),
  })
  .strict();

export type ArtifactDelta = z.infer<typeof ArtifactDeltaSchema>;
export type ImpactReasonCode = z.infer<typeof ImpactReasonCodeSchema>;
export type ImpactReasonEdge = z.infer<typeof ImpactReasonEdgeSchema>;
export type AffectedNode = z.infer<typeof AffectedNodeSchema>;
export type SkippedNode = z.infer<typeof SkippedNodeSchema>;
export type ImpactAnalysisResult = z.infer<typeof ImpactAnalysisResultSchema>;

export interface TransferFunctionContext {
  readonly edge: LineageEdge;
  readonly sourceSelectors: readonly LineageSelector[];
}

export interface TransferFunctionResult {
  readonly affected: boolean;
  readonly selectors?: readonly LineageSelector[];
  readonly detail?: string;
}

export type ImpactTransferFunction = (context: TransferFunctionContext) => TransferFunctionResult;

export interface FingerprintResolverContext {
  readonly targetVersionId: string;
  readonly edge: LineageEdge;
  readonly selectors: readonly LineageSelector[];
  readonly previousFingerprint: string | undefined;
}

export type FingerprintResolver = (context: FingerprintResolverContext) => string;

export interface ComputeImpactInput {
  readonly sourceVersionId: string;
  readonly delta: ArtifactDelta;
  readonly edges: readonly LineageEdge[];
  readonly transferFunctions?: Readonly<Record<string, ImpactTransferFunction>>;
  readonly currentFingerprints?: Readonly<Record<string, string>>;
  readonly fingerprintResolver?: FingerprintResolver;
}

interface MutableAffectedNode {
  readonly versionId: string;
  generation: number;
  selectors: LineageSelector[];
  readonly viaEdgeIds: Set<string>;
}

interface MutableSkippedNode {
  readonly versionId: string;
  readonly viaEdgeIds: Set<string>;
  readonly reasons: Set<ImpactReasonCode>;
}

function addSkipped(
  skipped: Map<string, MutableSkippedNode>,
  edge: LineageEdge,
  reason: ImpactReasonCode,
): void {
  const node = skipped.get(edge.targetVersionId) ?? {
    versionId: edge.targetVersionId,
    viaEdgeIds: new Set<string>(),
    reasons: new Set<ImpactReasonCode>(),
  };
  node.viaEdgeIds.add(edge.id);
  node.reasons.add(reason);
  skipped.set(edge.targetVersionId, node);
}

function selectorKey(selector: LineageSelector): string {
  return canonicalize(selector);
}

export function computeImpact(unparsedInput: ComputeImpactInput): ImpactAnalysisResult {
  const sourceVersionId = IdentifierSchema.parse(unparsedInput.sourceVersionId);
  const delta = ArtifactDeltaSchema.parse(unparsedInput.delta);
  const edges = unparsedInput.edges.map((edge) => LineageEdgeSchema.parse(edge));
  const outgoing = new Map<string, LineageEdge[]>();
  for (const edge of edges) {
    const current = outgoing.get(edge.sourceVersionId) ?? [];
    current.push(edge);
    outgoing.set(edge.sourceVersionId, current);
  }
  for (const current of outgoing.values()) {
    current.sort((left, right) => left.id.localeCompare(right.id));
  }

  const affected = new Map<string, MutableAffectedNode>();
  const skipped = new Map<string, MutableSkippedNode>();
  const sourceSelectors = uniqueSelectors(delta.selectors);
  affected.set(sourceVersionId, {
    versionId: sourceVersionId,
    generation: 0,
    selectors: [...sourceSelectors],
    viaEdgeIds: new Set(),
  });

  const queue: string[] = [sourceVersionId];
  const propagatedSelectorKeys = new Map<string, Set<string>>();
  const reasonGraph: ImpactReasonEdge[] = [];
  let visitedEdgeCount = 0;

  while (queue.length > 0) {
    const source = queue.shift();
    if (source === undefined) {
      break;
    }
    const sourceNode = affected.get(source);
    if (sourceNode === undefined) {
      continue;
    }
    const alreadyPropagated = propagatedSelectorKeys.get(source) ?? new Set<string>();
    const newSelectors = sourceNode.selectors.filter(
      (selector) => !alreadyPropagated.has(selectorKey(selector)),
    );
    if (newSelectors.length === 0) {
      continue;
    }
    for (const selector of newSelectors) {
      alreadyPropagated.add(selectorKey(selector));
    }
    propagatedSelectorKeys.set(source, alreadyPropagated);

    for (const edge of outgoing.get(source) ?? []) {
      visitedEdgeCount += 1;
      const dependencySelectors = [edge.selector ?? UNKNOWN_SELECTOR];
      if (!selectorSetsIntersect(newSelectors, dependencySelectors)) {
        addSkipped(skipped, edge, "SELECTOR_DISJOINT");
        reasonGraph.push({
          edgeId: edge.id,
          sourceVersionId: edge.sourceVersionId,
          targetVersionId: edge.targetVersionId,
          disposition: "SKIPPED",
          reason: "SELECTOR_DISJOINT",
          detail: "Changed components do not intersect the dependency selector",
        });
        continue;
      }

      let propagatedSelectors: readonly LineageSelector[] = [UNKNOWN_SELECTOR];
      let affectedReason: ImpactReasonCode =
        edge.selector?.kind === "unknown" || edge.selector === undefined
          ? "UNKNOWN_SELECTOR"
          : "SELECTOR_INTERSECTION";
      let detail =
        edge.selector === undefined
          ? "Unscoped dependency conservatively matches every Delta"
          : "Delta intersects the dependency selector";

      if (edge.transferFunction !== undefined) {
        const transfer = unparsedInput.transferFunctions?.[edge.transferFunction];
        if (transfer === undefined) {
          affectedReason = "MISSING_TRANSFER_FUNCTION";
          detail = `Transfer function ${edge.transferFunction} is unavailable; propagating conservatively`;
        } else {
          const result = transfer({ edge, sourceSelectors: newSelectors });
          if (!result.affected) {
            addSkipped(skipped, edge, "TRANSFER_REJECTED");
            reasonGraph.push({
              edgeId: edge.id,
              sourceVersionId: edge.sourceVersionId,
              targetVersionId: edge.targetVersionId,
              disposition: "SKIPPED",
              reason: "TRANSFER_REJECTED",
              detail:
                result.detail ?? `Transfer function ${edge.transferFunction} proved no impact`,
            });
            continue;
          }
          propagatedSelectors = uniqueSelectors(result.selectors ?? [UNKNOWN_SELECTOR]);
          affectedReason = "TRANSFER_FUNCTION";
          detail =
            result.detail ?? `Transfer function ${edge.transferFunction} propagated the Delta`;
        }
      }

      if (unparsedInput.fingerprintResolver !== undefined) {
        const previousFingerprint = unparsedInput.currentFingerprints?.[edge.targetVersionId];
        const nextFingerprint = unparsedInput.fingerprintResolver({
          targetVersionId: edge.targetVersionId,
          edge,
          selectors: propagatedSelectors,
          previousFingerprint,
        });
        if (previousFingerprint !== undefined && nextFingerprint === previousFingerprint) {
          addSkipped(skipped, edge, "FINGERPRINT_UNCHANGED");
          reasonGraph.push({
            edgeId: edge.id,
            sourceVersionId: edge.sourceVersionId,
            targetVersionId: edge.targetVersionId,
            disposition: "SKIPPED",
            reason: "FINGERPRINT_UNCHANGED",
            detail: "Recomputed dependency fingerprint is unchanged",
          });
          continue;
        }
      }

      const target = affected.get(edge.targetVersionId) ?? {
        versionId: edge.targetVersionId,
        generation: sourceNode.generation + 1,
        selectors: [],
        viaEdgeIds: new Set<string>(),
      };
      target.generation = Math.min(target.generation, sourceNode.generation + 1);
      target.viaEdgeIds.add(edge.id);
      const existingSelectorKeys = new Set(target.selectors.map(selectorKey));
      const hasNewSelector = propagatedSelectors.some(
        (selector) => !existingSelectorKeys.has(selectorKey(selector)),
      );
      target.selectors = [...uniqueSelectors([...target.selectors, ...propagatedSelectors])];
      affected.set(edge.targetVersionId, target);
      skipped.delete(edge.targetVersionId);
      reasonGraph.push({
        edgeId: edge.id,
        sourceVersionId: edge.sourceVersionId,
        targetVersionId: edge.targetVersionId,
        disposition: "AFFECTED",
        reason: affectedReason,
        detail,
      });
      if (hasNewSelector || !propagatedSelectorKeys.has(edge.targetVersionId)) {
        queue.push(edge.targetVersionId);
      }
    }
  }

  const affectedNodes = [...affected.values()]
    .sort(
      (left, right) =>
        left.generation - right.generation || left.versionId.localeCompare(right.versionId),
    )
    .map((node) => ({
      versionId: node.versionId,
      generation: node.generation,
      selectors: [...uniqueSelectors(node.selectors)],
      viaEdgeIds: [...node.viaEdgeIds].sort(),
    }));
  const skippedNodes = [...skipped.values()]
    .filter((node) => !affected.has(node.versionId))
    .sort((left, right) => left.versionId.localeCompare(right.versionId))
    .map((node) => ({
      versionId: node.versionId,
      viaEdgeIds: [...node.viaEdgeIds].sort(),
      reasons: [...node.reasons].sort(),
    }));

  return ImpactAnalysisResultSchema.parse({
    sourceVersionId,
    affectedNodes,
    skippedNodes,
    reasonGraph,
    visitedEdgeCount,
  });
}

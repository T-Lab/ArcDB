import {
  ArcDBDomainError,
  CreateLineageSchema,
  type EffectIntent,
  type EffectReceipt,
  type EvidenceObject,
  ImpactQuerySchema,
  InvalidateOutputSchema,
  type LineageEdge,
  LineageSelectorSchema,
  type OutputObject,
} from "@arcdb/contracts";
import {
  createRepositories,
  type Database,
  type EffectIntentRecord,
  type EffectReceiptRecord,
  type EvidenceRecord,
  type LineageEdgeRecord,
  normalizeRows,
  type OutputRecord,
  type RawRow,
  type SqlExecutor,
} from "@arcdb/db";
import { computeImpact, createInvalidationPlan } from "@arcdb/lineage";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePermission, requireProject } from "../auth.js";
import { appendAuditEvent, appendLifecycleEvent } from "../events.js";
import { ApiHttpError } from "../http-error.js";
import { idempotentMutation } from "../idempotency.js";

const ImpactBodySchema = z
  .object({
    sourceVersionId: z.string().trim().min(1).max(512),
    deltaSelectors: z.array(LineageSelectorSchema).min(1),
    beforeDigest: z.string().optional(),
    afterDigest: z.string().optional(),
  })
  .strict();
const VersionParamsSchema = z.object({ versionId: z.string().trim().min(1).max(512) }).strict();

function toLineageEdge(record: LineageEdgeRecord): LineageEdge {
  return {
    id: record.id,
    sourceVersionId: record.sourceVersionId,
    targetVersionId: record.targetVersionId,
    edgeType: record.edgeType,
    ...(record.selector === undefined
      ? {}
      : {
          selector: LineageSelectorSchema.parse(record.selector),
        }),
    ...(record.transferFunction === undefined ? {} : { transferFunction: record.transferFunction }),
    inferred: record.inferred,
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    createdAt: record.createdAt,
  };
}

function toOutput(record: OutputRecord): OutputObject {
  return {
    id: record.id,
    tenantId: record.tenantId,
    projectId: record.projectId,
    logicalId: record.logicalId,
    versionId: record.versionId,
    outputType: record.outputType,
    ...(record.schemaId === undefined ? {} : { schemaId: record.schemaId }),
    contentRef: record.contentRef,
    contentDigest: record.contentDigest,
    ...(record.producerRunId === undefined ? {} : { producerRunId: record.producerRunId }),
    ...(record.producerAgentId === undefined ? {} : { producerAgentId: record.producerAgentId }),
    parentVersionIds: [...record.parentVersionIds],
    ...(record.policyVersion === undefined ? {} : { policyVersion: record.policyVersion }),
    lifecycleState: record.lifecycleState,
    metadata: record.metadata,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toEvidence(record: EvidenceRecord): EvidenceObject {
  return {
    id: record.id,
    tenantId: record.tenantId,
    subjectVersionId: record.subjectVersionId,
    verifierType: record.verifierType,
    verifierVersion: record.verifierVersion,
    ...(record.environmentDigest === undefined
      ? {}
      : { environmentDigest: record.environmentDigest }),
    dependencyDigests: [...record.dependencyDigests],
    ...(record.policyVersion === undefined ? {} : { policyVersion: record.policyVersion }),
    verdict: record.verdict,
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    metrics: record.metrics as Record<string, number | string | boolean>,
    ...(record.payloadRef === undefined ? {} : { payloadRef: record.payloadRef }),
    fingerprint: record.fingerprint,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    createdAt: record.createdAt,
  };
}

function toEffect(record: EffectIntentRecord): EffectIntent {
  return {
    id: record.id,
    tenantId: record.tenantId,
    sourceOutputVersionId: record.sourceOutputVersionId,
    connectorType: record.connectorType,
    target: record.target,
    resourceKey: record.resourceKey,
    argumentsRef: record.argumentsRef,
    preconditions: record.preconditions,
    expectedEffects: record.expectedEffects,
    readSet: [...record.readSet],
    writeSet: [...record.writeSet],
    ...(record.baseResourceVersion === undefined
      ? {}
      : { baseResourceVersion: record.baseResourceVersion }),
    idempotencyKey: record.idempotencyKey,
    reversibility: record.reversibility,
    ...(record.compensationHandler === undefined
      ? {}
      : { compensationHandler: record.compensationHandler }),
    riskLevel: record.riskLevel,
    status: record.status,
    createdAt: record.createdAt,
  };
}

function toReceipt(record: EffectReceiptRecord): EffectReceipt {
  return {
    id: record.id,
    intentId: record.intentId,
    ...(record.externalTransactionId === undefined
      ? {}
      : { externalTransactionId: record.externalTransactionId }),
    externalStatus: record.externalStatus,
    ...(record.beforeDigest === undefined ? {} : { beforeDigest: record.beforeDigest }),
    ...(record.afterDigest === undefined ? {} : { afterDigest: record.afterDigest }),
    actualEffects: record.actualEffects,
    ...(record.rawResponseRef === undefined ? {} : { rawResponseRef: record.rawResponseRef }),
    ...(record.compensationStatus === undefined
      ? {}
      : { compensationStatus: record.compensationStatus }),
    ...(record.committedAt === undefined ? {} : { committedAt: record.committedAt }),
    createdAt: record.createdAt,
  };
}

async function reachableEdges(
  executor: SqlExecutor,
  tenantId: string,
  projectId: string,
  sourceVersionId: string,
): Promise<readonly LineageEdgeRecord[]> {
  const repositories = createRepositories(executor);
  const queue = [sourceVersionId];
  const expanded = new Set<string>();
  const edges = new Map<string, LineageEdgeRecord>();
  while (queue.length > 0) {
    const source = queue.shift();
    if (source === undefined || expanded.has(source)) continue;
    expanded.add(source);
    const outgoing = await repositories.lineage.listOutgoing({
      tenantId,
      projectId,
      sourceVersionId: source,
    });
    for (const edge of outgoing) {
      edges.set(edge.id, edge);
      if (!expanded.has(edge.targetVersionId)) queue.push(edge.targetVersionId);
    }
    if (edges.size > 10_000) {
      throw new ApiHttpError(
        "INVALID_REQUEST",
        413,
        "Impact graph exceeds the 10,000-edge synchronous limit",
      );
    }
  }
  return [...edges.values()];
}

function selectorsFromQuery(value: string | undefined) {
  if (value === undefined) return [{ kind: "unknown" as const, value: "*" }];
  try {
    return z.array(LineageSelectorSchema).min(1).parse(JSON.parse(value));
  } catch (error) {
    throw new ApiHttpError(
      "INVALID_REQUEST",
      400,
      "selectors must be a JSON array of lineage selectors",
      { cause: error },
    );
  }
}

async function allAffectedRecords(
  executor: SqlExecutor,
  tenantId: string,
  projectId: string,
  versionIds: readonly string[],
): Promise<{
  outputs: readonly OutputRecord[];
  evidence: readonly EvidenceRecord[];
  effects: readonly EffectIntentRecord[];
  receipts: readonly EffectReceiptRecord[];
}> {
  const [outputs, evidence, effects, receipts] = await Promise.all([
    executor.query<RawRow>(
      "SELECT * FROM outputs WHERE tenant_id = $1 AND project_id = $2 AND version_id = ANY($3::text[])",
      [tenantId, projectId, versionIds],
    ),
    executor.query<RawRow>(
      "SELECT * FROM evidence WHERE tenant_id = $1 AND project_id = $2 AND subject_version_id = ANY($3::text[])",
      [tenantId, projectId, versionIds],
    ),
    executor.query<RawRow>(
      "SELECT * FROM effect_intents WHERE tenant_id = $1 AND project_id = $2 AND source_output_version_id = ANY($3::text[])",
      [tenantId, projectId, versionIds],
    ),
    executor.query<RawRow>(
      `SELECT receipt.* FROM effect_receipts receipt
        JOIN effect_intents intent ON intent.tenant_id = receipt.tenant_id AND intent.id = receipt.intent_id
       WHERE receipt.tenant_id = $1 AND receipt.project_id = $2
         AND intent.source_output_version_id = ANY($3::text[])`,
      [tenantId, projectId, versionIds],
    ),
  ]);
  return {
    outputs: normalizeRows<OutputRecord>(outputs.rows),
    evidence: normalizeRows<EvidenceRecord>(evidence.rows),
    effects: normalizeRows<EffectIntentRecord>(effects.rows),
    receipts: normalizeRows<EffectReceiptRecord>(receipts.rows),
  };
}

export async function registerLineageRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post("/v1/lineage", { schema: { body: CreateLineageSchema } }, async (request, reply) => {
    requirePermission(request, "output:write");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const result = await idempotentMutation(database, request, request.body, async (executor) => {
      const repositories = createRepositories(executor);
      const [source, target] = await Promise.all([
        repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.body.sourceVersionId,
        }),
        repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.body.targetVersionId,
        }),
      ]);
      if (source === null || target === null) {
        throw new ApiHttpError("NOT_FOUND", 404, "Lineage source or target Output was not found");
      }
      const descendants = await repositories.lineage.listDescendants({
        tenantId,
        projectId,
        sourceVersionId: request.body.targetVersionId,
      });
      if (descendants.some(({ versionId }) => versionId === request.body.sourceVersionId)) {
        throw new ArcDBDomainError("LINEAGE_CYCLE", "Lineage edge would create a cycle", {
          details: {
            sourceVersionId: request.body.sourceVersionId,
            targetVersionId: request.body.targetVersionId,
          },
        });
      }
      const edge = await repositories.lineage.create({
        tenantId,
        projectId,
        sourceVersionId: request.body.sourceVersionId,
        targetVersionId: request.body.targetVersionId,
        edgeType: request.body.edgeType,
        inferred: request.body.inferred,
        ...(request.body.selector === undefined ? {} : { selector: request.body.selector }),
        ...(request.body.transferFunction === undefined
          ? {}
          : { transferFunction: request.body.transferFunction }),
        ...(request.body.confidence === undefined ? {} : { confidence: request.body.confidence }),
      });
      await appendLifecycleEvent(executor, {
        tenantId,
        projectId,
        aggregateType: "output",
        aggregateId: request.body.targetVersionId,
        eventType: "lineage.created",
        actorType: "API_KEY",
        actorId: request.principal.subjectId,
        requestId: request.id,
        payload: {
          edgeId: edge.id,
          sourceVersionId: edge.sourceVersionId,
          edgeType: edge.edgeType,
          selector: edge.selector,
        },
      });
      return { status: 201, data: edge };
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });

  api.get("/v1/lineage/impact", { schema: { querystring: ImpactQuerySchema } }, async (request) => {
    requirePermission(request, "output:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const data = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const output = await createRepositories(executor).outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.query.sourceVersionId,
        });
        if (output === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
        const records = await reachableEdges(
          executor,
          tenantId,
          projectId,
          request.query.sourceVersionId,
        );
        return computeImpact({
          sourceVersionId: request.query.sourceVersionId,
          delta: { selectors: selectorsFromQuery(request.query.selectors) },
          edges: records.map(toLineageEdge),
        });
      },
      { readOnly: true },
    );
    return { data, requestId: request.id };
  });

  api.post("/v1/lineage/impact", { schema: { body: ImpactBodySchema } }, async (request) => {
    requirePermission(request, "output:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const data = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const records = await reachableEdges(
          executor,
          tenantId,
          projectId,
          request.body.sourceVersionId,
        );
        return computeImpact({
          sourceVersionId: request.body.sourceVersionId,
          delta: {
            selectors: request.body.deltaSelectors,
            ...(request.body.beforeDigest === undefined
              ? {}
              : { beforeDigest: request.body.beforeDigest }),
            ...(request.body.afterDigest === undefined
              ? {}
              : { afterDigest: request.body.afterDigest }),
          },
          edges: records.map(toLineageEdge),
        });
      },
      { readOnly: true },
    );
    return { data, requestId: request.id };
  });

  api.post(
    "/v1/outputs/:versionId/invalidate",
    { schema: { params: VersionParamsSchema, body: InvalidateOutputSchema } },
    async (request, reply) => {
      requirePermission(request, "output:promote");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        const repositories = createRepositories(executor);
        const source = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.params.versionId,
        });
        if (source === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
        const edgeRecords = await reachableEdges(executor, tenantId, projectId, source.versionId);
        const impact = computeImpact({
          sourceVersionId: source.versionId,
          delta: {
            selectors: request.body.deltaSelectors,
            ...(request.body.beforeDigest === undefined
              ? {}
              : { beforeDigest: request.body.beforeDigest }),
            ...(request.body.afterDigest === undefined
              ? {}
              : { afterDigest: request.body.afterDigest }),
          },
          edges: edgeRecords.map(toLineageEdge),
        });
        const affectedIds = impact.affectedNodes.map(({ versionId }) => versionId);
        const records = await allAffectedRecords(executor, tenantId, projectId, affectedIds);
        const plan = createInvalidationPlan({
          sourceVersionId: source.versionId,
          delta: {
            selectors: request.body.deltaSelectors,
            ...(request.body.beforeDigest === undefined
              ? {}
              : { beforeDigest: request.body.beforeDigest }),
            ...(request.body.afterDigest === undefined
              ? {}
              : { afterDigest: request.body.afterDigest }),
          },
          reason: request.body.reason,
          createdAt: new Date().toISOString(),
          edges: edgeRecords.map(toLineageEdge),
          outputs: records.outputs.map(toOutput),
          evidence: records.evidence.map(toEvidence),
          effectIntents: records.effects.map(toEffect),
          receipts: records.receipts.map(toReceipt),
        });
        for (const transition of plan.outputTransitions) {
          const updated = await repositories.outputs.updateLifecycleState({
            tenantId,
            projectId,
            versionId: transition.versionId,
            expectedState: transition.from,
            nextState: transition.to,
          });
          if (updated === null) {
            throw new ApiHttpError(
              "INVALID_TRANSITION",
              409,
              `Output ${transition.versionId} changed during invalidation`,
              { retryable: true },
            );
          }
          await appendLifecycleEvent(executor, {
            tenantId,
            projectId,
            aggregateType: "output",
            aggregateId: transition.versionId,
            eventType: `output.${transition.to.toLowerCase()}`,
            actorType: "API_KEY",
            actorId: request.principal.subjectId,
            requestId: request.id,
            payload: { from: transition.from, to: transition.to, reason: transition.reason },
          });
        }
        for (const transition of plan.evidenceTransitions) {
          await repositories.evidence.markStale({
            tenantId,
            projectId,
            subjectVersionId: transition.subjectVersionId,
            reason: transition.reason,
          });
        }
        const recomputation = await repositories.recomputationPlans.create({
          tenantId,
          projectId,
          rootOutputVersionId: source.versionId,
          reason: request.body.reason,
          affectedNodes: plan.impact.affectedNodes,
          skippedNodes: plan.impact.skippedNodes,
          explanationGraph: {
            planId: plan.id,
            reasonGraph: plan.impact.reasonGraph,
            recomputationSteps: plan.recomputationSteps,
            preservedReceiptIds: plan.preservedReceiptIds,
          },
        });
        const remediations = [];
        for (const obligation of plan.remediationObligations) {
          const created = await repositories.remediationObligations.create({
            tenantId,
            projectId,
            intentId: obligation.effectIntentId,
            invalidatedOutputVersionId: obligation.sourceOutputVersionId,
            status: obligation.requiresHumanApproval ? "PENDING_APPROVAL" : "OPEN",
            riskLevel: obligation.riskLevel,
            reason: obligation.reason,
          });
          remediations.push(created);
          const intent = records.effects.find(({ id }) => id === obligation.effectIntentId);
          if (
            intent !== undefined &&
            intent.status !== "REMEDIATION_REQUIRED" &&
            intent.status !== "COMPENSATED"
          ) {
            await repositories.effects.updateStatus({
              tenantId,
              projectId,
              id: intent.id,
              expectedStatus: intent.status,
              nextStatus: "REMEDIATION_REQUIRED",
            });
          }
        }
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "output.invalidated",
          resourceType: "output",
          resourceId: source.versionId,
          requestId: request.id,
          metadata: {
            planId: plan.id,
            affectedCount: plan.impact.affectedNodes.length,
            remediationCount: remediations.length,
            preservedReceiptIds: plan.preservedReceiptIds,
          },
        });
        return {
          status: 200,
          data: { ...plan, recomputationPlanId: recomputation.id, remediations },
        };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );
}

import type { ArtifactStore } from "@arcdb/artifacts";
import {
  ApiDataEnvelopeSchema,
  canonicalDigest,
  type EffectIntent,
  EffectIntentSchema,
  isRemediationTransitionAllowed,
  PaginationQuerySchema,
  PrepareEffectSchema,
  RecordReceiptSchema,
  RemediationObligationRecordSchema,
  TransitionRemediationSchema,
} from "@arcdb/contracts";
import {
  createRepositories,
  type Database,
  type RemediationObligationRecord as DatabaseRemediationObligationRecord,
  type EffectIntentRecord,
  type JobRecord,
  normalizeRows,
  type RawRow,
} from "@arcdb/db";
import { resolveIdempotentIntent, transitionEffectIntent } from "@arcdb/lifecycle";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { readArtifact, storeArtifact } from "../artifact-helpers.js";
import { requirePermission, requireProject } from "../auth.js";
import {
  type EffectConnectorDefinition,
  EffectConnectorPolicyError,
  EffectConnectorRegistry,
} from "../effect-connectors.js";
import { appendAuditEvent, appendLifecycleEvent } from "../events.js";
import { ApiHttpError } from "../http-error.js";
import { idempotentMutation } from "../idempotency.js";
import { decodeCursor, encodeCursor } from "../pagination.js";

const EffectStatusSchema = z.enum([
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
const EffectListQuerySchema = PaginationQuerySchema.extend({
  status: EffectStatusSchema.optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  query: z.string().trim().min(1).max(256).optional(),
  from: z.iso.datetime().optional(),
});
const EffectParamsSchema = z.object({ id: z.uuid() }).strict();
const RemediationParamsSchema = z
  .object({
    id: z.uuid(),
    remediationId: z.uuid(),
  })
  .strict();

type ReconcileResponse = {
  readonly intent: EffectIntentRecord;
  readonly job: JobRecord | null;
};

export type EffectRoutesOptions = {
  readonly allowedConnectors?: readonly string[];
};

function connectorPolicyError(error: EffectConnectorPolicyError): ApiHttpError {
  return new ApiHttpError(
    error.reason === "CAPABILITIES_MISMATCH" ? "INVALID_REQUEST" : "POLICY_DENIED",
    422,
    error.message,
    {
      details: {
        connectorType: error.connectorType,
        reason: error.reason,
      },
    },
  );
}

function resolveForPreparation(
  registry: EffectConnectorRegistry,
  input: {
    readonly connectorType: string;
    readonly connectorCapabilities: unknown;
    readonly reversibility: EffectIntentRecord["reversibility"];
    readonly baseResourceVersion?: string;
    readonly compensationHandler?: string;
    readonly riskLevel: EffectIntentRecord["riskLevel"];
  },
): EffectConnectorDefinition {
  try {
    return registry.resolveForPreparation({
      connectorType: input.connectorType,
      claimedCapabilities: input.connectorCapabilities,
      reversibility: input.reversibility,
      ...(input.baseResourceVersion === undefined
        ? {}
        : { baseResourceVersion: input.baseResourceVersion }),
      ...(input.compensationHandler === undefined
        ? {}
        : { compensationHandler: input.compensationHandler }),
      riskLevel: input.riskLevel,
    });
  } catch (error) {
    if (error instanceof EffectConnectorPolicyError) throw connectorPolicyError(error);
    throw error;
  }
}

function resolveForStoredIntent(
  registry: EffectConnectorRegistry,
  intent: EffectIntentRecord,
): EffectConnectorDefinition {
  try {
    return registry.resolveForStoredIntent(intent);
  } catch (error) {
    if (error instanceof EffectConnectorPolicyError) throw connectorPolicyError(error);
    throw error;
  }
}

function resolveForManualReceipt(
  registry: EffectConnectorRegistry,
  intent: EffectIntentRecord,
): EffectConnectorDefinition {
  try {
    return registry.resolveForManualReceipt(intent);
  } catch (error) {
    if (error instanceof EffectConnectorPolicyError) throw connectorPolicyError(error);
    throw error;
  }
}

function toEffectIntent(record: EffectIntentRecord): EffectIntent {
  return EffectIntentSchema.parse({
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
  });
}

function receiptOutcome(status: string): "COMMITTED" | "FAILED" | "RECONCILIATION_REQUIRED" {
  const normalized = status.trim().toUpperCase();
  if (["OK", "SUCCESS", "SUCCEEDED", "COMMITTED", "APPLIED"].includes(normalized)) {
    return "COMMITTED";
  }
  if (["UNKNOWN", "PENDING", "TIMEOUT", "UNCERTAIN"].includes(normalized)) {
    return "RECONCILIATION_REQUIRED";
  }
  return "FAILED";
}

function assertRemediationTransition(
  currentStatus: DatabaseRemediationObligationRecord["status"],
  nextStatus: DatabaseRemediationObligationRecord["status"],
): void {
  if (!isRemediationTransitionAllowed(currentStatus, nextStatus)) {
    throw new ApiHttpError(
      "INVALID_TRANSITION",
      409,
      `Remediation obligation cannot transition from ${currentStatus} to ${nextStatus}`,
      {
        details: { currentStatus, nextStatus },
      },
    );
  }
}

export async function registerEffectRoutes(
  app: FastifyInstance,
  database: Database,
  artifacts: ArtifactStore,
  options: EffectRoutesOptions = {},
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const connectorRegistry = new EffectConnectorRegistry(options.allowedConnectors);

  api.post("/v1/effects", { schema: { body: PrepareEffectSchema } }, async (request, reply) => {
    requirePermission(request, "effect:prepare");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const connector = resolveForPreparation(connectorRegistry, {
      connectorType: request.body.connectorType,
      connectorCapabilities: request.body.connectorCapabilities,
      reversibility: request.body.reversibility,
      ...(request.body.baseResourceVersion === undefined
        ? {}
        : { baseResourceVersion: request.body.baseResourceVersion }),
      ...(request.body.compensationHandler === undefined
        ? {}
        : { compensationHandler: request.body.compensationHandler }),
      riskLevel: request.body.riskLevel,
    });
    const headerKey = request.headers["idempotency-key"];
    if (typeof headerKey === "string" && headerKey !== request.body.idempotencyKey) {
      throw new ApiHttpError(
        "INVALID_REQUEST",
        409,
        "Header and EffectIntent idempotency keys must match",
      );
    }
    const canonicalRequestBody = {
      ...request.body,
      connectorCapabilities: connector.capabilities,
    };
    const argumentsArtifact = await storeArtifact(artifacts, {
      tenantId,
      logicalName: `effect-arguments/${request.body.idempotencyKey}`,
      outputType: "json",
      content: request.body.arguments,
    });
    const result = await idempotentMutation(
      database,
      request,
      canonicalRequestBody,
      async (executor) => {
        const repositories = createRepositories(executor);
        const source = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.body.sourceOutputVersionId,
        });
        if (source === null) throw new ApiHttpError("NOT_FOUND", 404, "Source Output not found");
        if (!["COMMITTED", "CONSUMED", "PROMOTED"].includes(source.lifecycleState)) {
          throw new ApiHttpError(
            "INVALID_TRANSITION",
            409,
            `Effects require a committed source Output, not ${source.lifecycleState}`,
          );
        }
        const existing = await repositories.effects.findByIdempotencyKey({
          tenantId,
          projectId,
          connectorType: request.body.connectorType,
          idempotencyKey: request.body.idempotencyKey,
        });
        const candidate = EffectIntentSchema.parse({
          id: crypto.randomUUID(),
          tenantId,
          sourceOutputVersionId: request.body.sourceOutputVersionId,
          connectorType: request.body.connectorType,
          target: request.body.target,
          resourceKey: request.body.resourceKey,
          argumentsRef: argumentsArtifact.ref,
          preconditions: request.body.preconditions,
          expectedEffects: request.body.expectedEffects,
          readSet: request.body.readSet,
          writeSet: request.body.writeSet,
          ...(request.body.baseResourceVersion === undefined
            ? {}
            : { baseResourceVersion: request.body.baseResourceVersion }),
          idempotencyKey: request.body.idempotencyKey,
          reversibility: request.body.reversibility,
          ...(request.body.compensationHandler === undefined
            ? {}
            : { compensationHandler: request.body.compensationHandler }),
          riskLevel: request.body.riskLevel,
          status: "PREPARED",
          createdAt: new Date().toISOString(),
        });
        if (existing !== null) {
          resolveForStoredIntent(connectorRegistry, existing);
          const resolution = resolveIdempotentIntent(candidate, [toEffectIntent(existing)]);
          if (resolution.kind === "REPLAY") return { status: 200, data: existing };
        }
        const fence = await repositories.resourceFences.acquire({
          tenantId,
          projectId,
          resourceKey: request.body.resourceKey,
          leaseOwner: request.id,
        });
        const intent = await repositories.effects.create({
          id: candidate.id,
          tenantId,
          projectId,
          sourceOutputVersionId: request.body.sourceOutputVersionId,
          connectorType: request.body.connectorType,
          connectorCapabilities: connector.capabilities,
          target: request.body.target,
          resourceKey: request.body.resourceKey,
          argumentsRef: argumentsArtifact.ref,
          preconditions: request.body.preconditions,
          expectedEffects: request.body.expectedEffects,
          readSet: request.body.readSet,
          writeSet: request.body.writeSet,
          ...(request.body.baseResourceVersion === undefined
            ? {}
            : { baseResourceVersion: request.body.baseResourceVersion }),
          idempotencyKey: request.body.idempotencyKey,
          fencingToken: fence.fencingToken,
          reversibility: request.body.reversibility,
          ...(request.body.compensationHandler === undefined
            ? {}
            : { compensationHandler: request.body.compensationHandler }),
          riskLevel: request.body.riskLevel,
        });
        await appendLifecycleEvent(executor, {
          tenantId,
          projectId,
          aggregateType: "effect",
          aggregateId: intent.id,
          eventType: "effect.prepared",
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          requestId: request.id,
          payload: {
            sourceOutputVersionId: intent.sourceOutputVersionId,
            connectorType: intent.connectorType,
            resourceKey: intent.resourceKey,
            fencingToken: intent.fencingToken,
          },
        });
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "effect.prepared",
          resourceType: "effect",
          resourceId: intent.id,
          requestId: request.id,
          metadata: { connectorType: intent.connectorType, riskLevel: intent.riskLevel },
        });
        return { status: 201, data: intent };
      },
    );
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });

  api.get("/v1/effects", { schema: { querystring: EffectListQuerySchema } }, async (request) => {
    requirePermission(request, "effect:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const cursor = decodeCursor(request.query.cursor);
    const rows = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const result = await executor.query<RawRow>(
          `SELECT * FROM effect_intents
              WHERE tenant_id = $1 AND project_id = $2
                AND ($3::text IS NULL OR status = $3)
                AND ($4::text IS NULL OR risk_level = $4)
                AND ($5::timestamptz IS NULL OR created_at >= $5)
                AND ($6::text IS NULL OR connector_type ILIKE '%' || $6 || '%'
                  OR target ILIKE '%' || $6 || '%'
                  OR resource_key ILIKE '%' || $6 || '%'
                  OR source_output_version_id ILIKE '%' || $6 || '%')
                AND ($7::timestamptz IS NULL OR
                  (created_at, id) < ($7::timestamptz, $8::uuid))
              ORDER BY created_at DESC, id DESC
              LIMIT $9`,
          [
            tenantId,
            projectId,
            request.query.status ?? null,
            request.query.riskLevel ?? null,
            request.query.from ?? null,
            request.query.query ?? null,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            request.query.limit + 1,
          ],
        );
        return normalizeRows<EffectIntentRecord>(result.rows);
      },
      { readOnly: true },
    );
    const hasMore = rows.length > request.query.limit;
    const selected = rows.slice(0, request.query.limit);
    const last = selected.at(-1);
    return {
      data: selected,
      page: {
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      },
      requestId: request.id,
    };
  });

  api.get("/v1/effects/:id", { schema: { params: EffectParamsSchema } }, async (request) => {
    requirePermission(request, "effect:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const data = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const repositories = createRepositories(executor);
        const intent = await repositories.effects.get({
          tenantId,
          projectId,
          id: request.params.id,
        });
        if (intent === null) {
          throw new ApiHttpError("NOT_FOUND", 404, "EffectIntent not found");
        }
        const [receipts, remediations] = await Promise.all([
          repositories.receipts.listByIntent({ tenantId, projectId, intentId: intent.id }),
          executor.query(
            `SELECT * FROM remediation_obligations
                WHERE tenant_id = $1 AND project_id = $2 AND intent_id = $3
                ORDER BY created_at`,
            [tenantId, projectId, intent.id],
          ),
        ]);
        return { ...intent, receipts, remediations: normalizeRows(remediations.rows) };
      },
      { readOnly: true },
    );
    const rawArguments = await readArtifact(artifacts, data.argumentsRef);
    let effectArguments: unknown = rawArguments;
    try {
      effectArguments = JSON.parse(rawArguments) as unknown;
    } catch {
      // The raw representation remains available for non-JSON connector payloads.
    }
    return {
      data: { ...data, arguments: effectArguments, rawArguments },
      requestId: request.id,
    };
  });

  api.post(
    "/v1/effects/:id/commit",
    { schema: { params: EffectParamsSchema, body: z.object({}).strict() } },
    async (request, reply) => {
      requirePermission(request, "effect:commit");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const result = await idempotentMutation<ReconcileResponse>(
        database,
        request,
        {},
        async (executor) => {
          const repositories = createRepositories(executor);
          const intent = await repositories.effects.get({
            tenantId,
            projectId,
            id: request.params.id,
          });
          if (intent === null) {
            throw new ApiHttpError("NOT_FOUND", 404, "EffectIntent not found");
          }
          resolveForStoredIntent(connectorRegistry, intent);
          if (intent.status !== "PREPARED" && intent.status !== "FAILED") {
            throw new ApiHttpError(
              "INVALID_TRANSITION",
              409,
              `Effect in ${intent.status} cannot be submitted for execution`,
            );
          }
          const job = await repositories.jobs.enqueue({
            tenantId,
            projectId,
            jobType: "reconcile_effect",
            idempotencyKey: `effect:${intent.id}:execute`,
            payload: { intentId: intent.id },
            maxAttempts: 5,
            timeoutMs: 60_000,
            traceContext: { requestId: request.id },
          });
          await appendLifecycleEvent(executor, {
            tenantId,
            projectId,
            aggregateType: "effect",
            aggregateId: intent.id,
            eventType: "effect.execution_requested",
            actorType: "API_KEY",
            actorId: request.principal.subjectId,
            requestId: request.id,
            payload: { jobId: job.id },
          });
          return { status: 202, data: { intent, job } };
        },
      );
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.post(
    "/v1/effects/:id/receipts",
    { schema: { params: EffectParamsSchema, body: RecordReceiptSchema } },
    async (request, reply) => {
      requirePermission(request, "effect:commit");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        const repositories = createRepositories(executor);
        const intent = await repositories.effects.get({
          tenantId,
          projectId,
          id: request.params.id,
        });
        if (intent === null) {
          throw new ApiHttpError("NOT_FOUND", 404, "EffectIntent not found");
        }
        resolveForManualReceipt(connectorRegistry, intent);
        const rawResponse =
          request.body.rawResponse === undefined
            ? undefined
            : await storeArtifact(artifacts, {
                tenantId,
                logicalName: `effect-receipt/${request.params.id}`,
                outputType: "json",
                content: request.body.rawResponse,
              });
        const receipt = await repositories.receipts.append({
          tenantId,
          projectId,
          intentId: intent.id,
          externalStatus: request.body.externalStatus,
          actualEffects: request.body.actualEffects,
          ...(request.body.externalTransactionId === undefined
            ? {}
            : { externalTransactionId: request.body.externalTransactionId }),
          ...(request.body.beforeDigest === undefined
            ? {}
            : { beforeDigest: request.body.beforeDigest }),
          ...(request.body.afterDigest === undefined
            ? {}
            : { afterDigest: request.body.afterDigest }),
          ...(rawResponse === undefined ? {} : { rawResponseRef: rawResponse.ref }),
          ...(request.body.compensationStatus === undefined
            ? {}
            : { compensationStatus: request.body.compensationStatus }),
          ...(request.body.committedAt === undefined
            ? {}
            : { committedAt: request.body.committedAt }),
        });
        const outcome = receiptOutcome(request.body.externalStatus);
        let nextStatus: EffectIntentRecord["status"] = outcome;
        if (outcome === "COMMITTED" && intent.reversibility === "R3") {
          nextStatus = "IRREVERSIBLE_COMMITTED";
        }
        let currentIntent = intent;
        if (
          currentIntent.status !== nextStatus &&
          (currentIntent.status === "PREPARED" || currentIntent.status === "FAILED")
        ) {
          transitionEffectIntent(toEffectIntent(currentIntent), "EXECUTING");
          const executing = await repositories.effects.updateStatus({
            tenantId,
            projectId,
            id: currentIntent.id,
            expectedStatus: currentIntent.status,
            nextStatus: "EXECUTING",
          });
          if (executing === null) {
            throw new ApiHttpError(
              "INVALID_TRANSITION",
              409,
              "Effect status changed before Receipt execution",
              { retryable: true },
            );
          }
          currentIntent = executing;
        }
        if (currentIntent.status !== nextStatus) {
          transitionEffectIntent(toEffectIntent(currentIntent), nextStatus);
          const updated = await repositories.effects.updateStatus({
            tenantId,
            projectId,
            id: currentIntent.id,
            expectedStatus: currentIntent.status,
            nextStatus,
          });
          if (updated === null) {
            throw new ApiHttpError(
              "INVALID_TRANSITION",
              409,
              "Effect status changed before Receipt commit",
              { retryable: true },
            );
          }
        }
        await appendLifecycleEvent(executor, {
          tenantId,
          projectId,
          aggregateType: "effect",
          aggregateId: currentIntent.id,
          eventType: "effect.receipt_recorded",
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          requestId: request.id,
          payload: {
            receiptId: receipt.id,
            externalStatus: receipt.externalStatus,
            nextStatus,
          },
        });
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "effect.receipt_recorded",
          resourceType: "effect_receipt",
          resourceId: receipt.id,
          requestId: request.id,
          metadata: { intentId: currentIntent.id, externalStatus: receipt.externalStatus },
        });
        return { status: 201, data: receipt };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.post(
    "/v1/effects/:id/reconcile",
    { schema: { params: EffectParamsSchema, body: z.object({}).strict() } },
    async (request, reply) => {
      requirePermission(request, "effect:commit");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const result = await idempotentMutation<ReconcileResponse>(
        database,
        request,
        {},
        async (executor) => {
          const repositories = createRepositories(executor);
          const intent = await repositories.effects.get({
            tenantId,
            projectId,
            id: request.params.id,
          });
          if (intent === null) {
            throw new ApiHttpError("NOT_FOUND", 404, "EffectIntent not found");
          }
          resolveForStoredIntent(connectorRegistry, intent);
          if (["COMMITTED", "IRREVERSIBLE_COMMITTED", "COMPENSATED"].includes(intent.status)) {
            return { status: 200, data: { intent, job: null } };
          }
          if (intent.status !== "RECONCILIATION_REQUIRED") {
            transitionEffectIntent(toEffectIntent(intent), "RECONCILIATION_REQUIRED");
            const updated = await repositories.effects.updateStatus({
              tenantId,
              projectId,
              id: intent.id,
              expectedStatus: intent.status,
              nextStatus: "RECONCILIATION_REQUIRED",
            });
            if (updated === null) {
              throw new ApiHttpError("INVALID_TRANSITION", 409, "Effect status changed", {
                retryable: true,
              });
            }
          }
          const job = await repositories.jobs.enqueue({
            tenantId,
            projectId,
            jobType: "reconcile_effect",
            idempotencyKey: `effect:${intent.id}:reconcile:${canonicalDigest(
              {
                requestKey:
                  typeof request.headers["idempotency-key"] === "string"
                    ? request.headers["idempotency-key"]
                    : request.id,
              },
              "effect-reconcile-request",
            ).slice("sha256:".length, "sha256:".length + 24)}`,
            payload: { intentId: intent.id },
            maxAttempts: 8,
            timeoutMs: 60_000,
            traceContext: { requestId: request.id },
          });
          const pending: EffectIntentRecord = {
            ...intent,
            status: "RECONCILIATION_REQUIRED",
          };
          return { status: 202, data: { intent: pending, job } };
        },
      );
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.post(
    "/v1/effects/:id/remediations/:remediationId/transition",
    {
      schema: {
        params: RemediationParamsSchema,
        body: TransitionRemediationSchema,
        response: { 200: ApiDataEnvelopeSchema(RemediationObligationRecordSchema) },
      },
    },
    async (request) => {
      requirePermission(request, "effect:remediate");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const obligation = await database.withTenant(tenantId, projectId, async (executor) => {
        const selected = await executor.query<RawRow>(
          `SELECT * FROM remediation_obligations
            WHERE tenant_id = $1 AND project_id = $2 AND intent_id = $3 AND id = $4`,
          [tenantId, projectId, request.params.id, request.params.remediationId],
        );
        const current = normalizeRows<DatabaseRemediationObligationRecord>(selected.rows)[0];
        if (current === undefined) {
          throw new ApiHttpError("NOT_FOUND", 404, "Remediation obligation not found");
        }
        if (current.status !== request.body.expectedStatus) {
          throw new ApiHttpError(
            "INVALID_TRANSITION",
            409,
            "Remediation obligation status changed",
            {
              retryable: true,
              details: {
                remediationId: current.id,
                expectedStatus: request.body.expectedStatus,
                currentStatus: current.status,
              },
            },
          );
        }
        assertRemediationTransition(current.status, request.body.nextStatus);

        const approvalRecorded =
          current.status === "PENDING_APPROVAL" &&
          (request.body.nextStatus === "IN_PROGRESS" || request.body.nextStatus === "WAIVED");
        const repositories = createRepositories(executor);
        const updated = await repositories.remediationObligations.updateStatus({
          tenantId,
          id: current.id,
          expectedStatus: request.body.expectedStatus,
          nextStatus: request.body.nextStatus,
          ...(request.body.resolution === undefined ? {} : { resolution: request.body.resolution }),
          ...(approvalRecorded
            ? {
                approvedBy: request.principal.subjectId,
                approvedByActorType: request.principal.subjectType,
              }
            : {}),
        });
        if (updated === null) {
          throw new ApiHttpError(
            "INVALID_TRANSITION",
            409,
            "Remediation obligation status changed during transition",
            {
              retryable: true,
              details: {
                remediationId: current.id,
                expectedStatus: request.body.expectedStatus,
              },
            },
          );
        }

        await appendLifecycleEvent(executor, {
          tenantId,
          projectId,
          aggregateType: "remediation",
          aggregateId: updated.id,
          eventType: `remediation.${updated.status.toLowerCase()}`,
          actorType: request.principal.subjectType,
          actorId: request.principal.subjectId,
          requestId: request.id,
          payload: {
            effectIntentId: updated.intentId,
            from: current.status,
            to: updated.status,
            ...(approvalRecorded
              ? {
                  approvedBy: request.principal.subjectId,
                  approvedByActorType: request.principal.subjectType,
                }
              : {}),
            ...(request.body.resolution === undefined
              ? {}
              : { resolution: request.body.resolution }),
          },
        });
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: request.principal.subjectType,
          actorId: request.principal.subjectId,
          action: "remediation.transitioned",
          resourceType: "remediation_obligation",
          resourceId: updated.id,
          requestId: request.id,
          metadata: {
            effectIntentId: updated.intentId,
            from: current.status,
            to: updated.status,
            approvalRecorded,
          },
        });
        return updated;
      });
      return {
        data: RemediationObligationRecordSchema.parse(obligation),
        requestId: request.id,
      };
    },
  );
}

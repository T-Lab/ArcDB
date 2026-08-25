import type { ArtifactStore } from "@arcdb/artifacts";
import {
  AddEvidenceSchema,
  CreateOutputSchema,
  canonicalDigest,
  type EvidenceObject,
  evidenceFingerprint,
  HeadConflictError,
  OutputLifecycleStateSchema,
  type OutputObject,
  outputContentDigest,
  PaginationQuerySchema,
  PromoteOutputSchema,
} from "@arcdb/contracts";
import {
  createRepositories,
  type Database,
  type EvidenceRecord,
  normalizeRows,
  type OutputRecord,
  type RawRow,
  type SqlExecutor,
} from "@arcdb/db";
import {
  assessEvidenceFreshness,
  type EvidencePolicy,
  transitionOutput,
  validateFencingToken,
} from "@arcdb/lifecycle";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { readArtifact, storeArtifact } from "../artifact-helpers.js";
import { requirePermission, requireProject } from "../auth.js";
import { appendAuditEvent, appendLifecycleEvent } from "../events.js";
import { ApiHttpError } from "../http-error.js";
import { idempotentMutation } from "../idempotency.js";
import { decodeCursor, encodeCursor } from "../pagination.js";

const OutputListQuerySchema = PaginationQuerySchema.extend({
  query: z.string().trim().min(1).max(256).optional(),
  lifecycleState: OutputLifecycleStateSchema.optional(),
  outputType: z
    .enum([
      "text",
      "json",
      "markdown",
      "code_patch",
      "file_tree",
      "sql",
      "tool_plan",
      "decision",
      "dataset_record",
    ])
    .optional(),
  from: z.iso.datetime().optional(),
});

const VersionParamsSchema = z.object({ versionId: z.string().trim().min(1).max(512) }).strict();
const DiffQuerySchema = z.object({ against: z.string().trim().min(1).max(512) }).strict();

function toOutputObject(record: OutputRecord): OutputObject {
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

function toEvidenceObject(record: EvidenceRecord): EvidenceObject {
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

function responseContent(output: OutputRecord, raw: string): unknown {
  if (
    output.outputType === "json" ||
    output.outputType === "file_tree" ||
    output.outputType === "tool_plan" ||
    output.outputType === "decision" ||
    output.outputType === "dataset_record"
  ) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function promotionPolicy(
  output: OutputRecord,
  body: z.infer<typeof PromoteOutputSchema>,
): EvidencePolicy {
  const policyVersion = body.policyVersion ?? output.policyVersion ?? "unversioned";
  return {
    id: `promotion:${output.logicalId}`,
    version: policyVersion,
    requiredEvidence: body.requiredVerifierTypes.map((verifierType) => ({
      id: verifierType,
      verifierType,
      policyVersion: body.policyVersion ?? output.policyVersion ?? null,
    })),
  };
}

async function appendOutputTransition(
  executor: SqlExecutor,
  request: FastifyRequest,
  output: OutputObject,
  to: OutputObject["lifecycleState"],
  options: Omit<Parameters<typeof transitionOutput>[0], "eventId" | "output" | "to" | "occurredAt">,
): Promise<OutputObject> {
  const repositories = createRepositories(executor);
  const occurredAt = new Date().toISOString();
  const transition = transitionOutput({
    eventId: crypto.randomUUID(),
    output,
    to,
    occurredAt,
    ...options,
  });
  const persisted = await repositories.outputs.updateLifecycleState({
    tenantId: output.tenantId,
    projectId: output.projectId,
    versionId: output.versionId,
    expectedState: output.lifecycleState,
    nextState: to,
  });
  if (persisted === null) {
    throw new ApiHttpError(
      "INVALID_TRANSITION",
      409,
      `Output state changed while transitioning to ${to}`,
      { retryable: true },
    );
  }
  await appendLifecycleEvent(executor, {
    tenantId: output.tenantId,
    projectId: output.projectId,
    aggregateType: "output",
    aggregateId: output.versionId,
    eventType: `output.${to.toLowerCase()}`,
    actorType: "API_KEY",
    actorId: request.principal.subjectId,
    requestId: request.id,
    payload: {
      from: output.lifecycleState,
      to,
      evidenceIds: transition.event.evidenceIds,
      ...(transition.event.reason === undefined ? {} : { reason: transition.event.reason }),
    },
  });
  return transition.output;
}

async function currentFence(
  executor: SqlExecutor,
  tenantId: string,
  projectId: string,
  resourceKey: string,
): Promise<number> {
  const row = (
    await executor.query<{ fencing_token: string }>(
      `SELECT fencing_token FROM resource_fences
        WHERE tenant_id = $1 AND project_id = $2 AND resource_key = $3`,
      [tenantId, projectId, resourceKey],
    )
  ).rows[0];
  return Number(row?.fencing_token ?? 0);
}

export async function registerOutputRoutes(
  app: FastifyInstance,
  database: Database,
  artifacts: ArtifactStore,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post("/v1/outputs", { schema: { body: CreateOutputSchema } }, async (request, reply) => {
    requirePermission(request, "output:write");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const stored = await storeArtifact(artifacts, {
      tenantId,
      logicalName: request.body.logicalId,
      outputType: request.body.outputType,
      content: request.body.content,
      ...(request.body.schemaId === undefined ? {} : { schemaId: request.body.schemaId }),
      metadata: { projectId, branch: request.body.branch },
    });
    const requestKey =
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : crypto.randomUUID();
    const versionId =
      request.body.versionId ??
      `v_${canonicalDigest(
        {
          tenantId,
          projectId,
          logicalId: request.body.logicalId,
          idempotencyKey: requestKey,
        },
        "output-version",
      ).slice("sha256:".length, "sha256:".length + 32)}`;
    const body = { ...request.body, versionId };
    const result = await idempotentMutation(database, request, body, async (executor) => {
      const repositories = createRepositories(executor);
      if (request.body.producerRunId !== undefined) {
        const producer = await executor.query<{ id: string }>(
          `SELECT id FROM runs
            WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
          [tenantId, projectId, request.body.producerRunId],
        );
        if (producer.rows[0] === undefined) {
          throw new ApiHttpError("NOT_FOUND", 404, "Producer Run not found in this project");
        }
      }
      if (request.body.parentVersionIds.length > 0) {
        const parents = await executor.query<{ version_id: string }>(
          `SELECT version_id FROM outputs
            WHERE tenant_id = $1 AND project_id = $2 AND version_id = ANY($3::text[])`,
          [tenantId, projectId, request.body.parentVersionIds],
        );
        if (parents.rows.length !== new Set(request.body.parentVersionIds).size) {
          throw new ApiHttpError("NOT_FOUND", 404, "A parent Output was not found in this project");
        }
      }
      const digest = outputContentDigest({
        content: request.body.content,
        outputType: request.body.outputType,
        ...(request.body.schemaId === undefined ? {} : { schemaId: request.body.schemaId }),
        metadata: request.body.metadata,
      });
      const created = await repositories.outputs.create({
        tenantId,
        projectId,
        logicalId: request.body.logicalId,
        versionId,
        outputType: request.body.outputType,
        contentRef: stored.ref,
        contentDigest: digest,
        ...(request.body.schemaId === undefined ? {} : { schemaId: request.body.schemaId }),
        ...(request.body.producerRunId === undefined
          ? {}
          : { producerRunId: request.body.producerRunId }),
        ...(request.body.producerAgentId === undefined
          ? {}
          : { producerAgentId: request.body.producerAgentId }),
        parentVersionIds: request.body.parentVersionIds,
        ...(request.body.policyVersion === undefined
          ? {}
          : { policyVersion: request.body.policyVersion }),
        metadata: { ...request.body.metadata, branch: request.body.branch },
      });
      const manifestDigest = stored.ref.split("/").at(-1);
      if (manifestDigest !== undefined) {
        await executor.query(
          `INSERT INTO artifact_manifests
             (tenant_id, project_id, digest, content_ref, byte_length, chunk_count, media_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, project_id, digest) DO NOTHING`,
          [
            tenantId,
            projectId,
            manifestDigest,
            stored.ref,
            stored.byteLength,
            stored.chunkCount,
            stored.mediaType,
          ],
        );
      }
      let output = toOutputObject(created);
      output = await appendOutputTransition(executor, request, output, "STAGED", {
        reason: "Artifact bytes and manifest finalized",
      });
      await appendAuditEvent(executor, {
        tenantId,
        projectId,
        actorType: "API_KEY",
        actorId: request.principal.subjectId,
        action: "output.created",
        resourceType: "output",
        resourceId: versionId,
        requestId: request.id,
        metadata: { logicalId: request.body.logicalId, contentDigest: digest },
      });
      const persisted = await repositories.outputs.getByVersion({ tenantId, projectId, versionId });
      return { status: 201, data: persisted ?? created };
    });
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });

  api.post(
    "/v1/outputs/:versionId/finalize",
    { schema: { params: VersionParamsSchema, body: z.object({}).strict() } },
    async (request, reply) => {
      requirePermission(request, "output:write");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const candidate = await database.withTenant(
        tenantId,
        projectId,
        (executor) =>
          createRepositories(executor).outputs.getByVersion({
            tenantId,
            projectId,
            versionId: request.params.versionId,
          }),
        { readOnly: true },
      );
      if (candidate === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
      if (candidate.lifecycleState === "CREATED") {
        // Reading verifies the manifest, every chunk digest, and the reconstructed content digest.
        await readArtifact(artifacts, candidate.contentRef);
      }
      const result = await idempotentMutation(database, request, {}, async (executor) => {
        const repositories = createRepositories(executor);
        const current = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.params.versionId,
        });
        if (current === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
        if (current.lifecycleState !== "CREATED") {
          return { status: 200, data: current };
        }
        const staged = await appendOutputTransition(
          executor,
          request,
          toOutputObject(current),
          "STAGED",
          { reason: "Artifact manifest and reconstructed content verified" },
        );
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "output.finalized",
          resourceType: "output",
          resourceId: staged.versionId,
          requestId: request.id,
          metadata: { contentDigest: staged.contentDigest },
        });
        const persisted = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: staged.versionId,
        });
        return { status: 200, data: persisted ?? current };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.get("/v1/outputs", { schema: { querystring: OutputListQuerySchema } }, async (request) => {
    requirePermission(request, "output:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const cursor = decodeCursor(request.query.cursor);
    const rows = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const result = await executor.query<RawRow>(
          `SELECT * FROM outputs
              WHERE tenant_id = $1 AND project_id = $2
                AND ($3::text IS NULL OR lifecycle_state = $3)
                AND ($4::text IS NULL OR output_type = $4)
                AND ($5::timestamptz IS NULL OR created_at >= $5)
                AND ($6::text IS NULL OR logical_id ILIKE '%' || $6 || '%'
                  OR version_id ILIKE '%' || $6 || '%'
                  OR metadata::text ILIKE '%' || $6 || '%')
                AND ($7::timestamptz IS NULL OR
                  (created_at, id) < ($7::timestamptz, $8::uuid))
              ORDER BY created_at DESC, id DESC
              LIMIT $9`,
          [
            tenantId,
            projectId,
            request.query.lifecycleState ?? null,
            request.query.outputType ?? null,
            request.query.from ?? null,
            request.query.query ?? null,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            request.query.limit + 1,
          ],
        );
        return normalizeRows<OutputRecord>(result.rows);
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

  api.get(
    "/v1/outputs/:versionId",
    { schema: { params: VersionParamsSchema } },
    async (request) => {
      requirePermission(request, "output:read");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const data = await database.withTenant(
        tenantId,
        projectId,
        async (executor) => {
          const repositories = createRepositories(executor);
          const output = await repositories.outputs.getByVersion({
            tenantId,
            projectId,
            versionId: request.params.versionId,
          });
          if (output === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
          const [evidence, versions, head, effects] = await Promise.all([
            repositories.evidence.listBySubject({
              tenantId,
              projectId,
              subjectVersionId: output.versionId,
            }),
            repositories.outputs.list({
              tenantId,
              projectId,
              logicalId: output.logicalId,
              limit: 100,
            }),
            repositories.heads.get({
              tenantId,
              projectId,
              logicalId: output.logicalId,
              branch: typeof output.metadata.branch === "string" ? output.metadata.branch : "main",
            }),
            executor.query(
              `SELECT id, connector_type, target, risk_level, status, created_at
                 FROM effect_intents
                WHERE tenant_id = $1 AND project_id = $2 AND source_output_version_id = $3
                ORDER BY created_at DESC`,
              [tenantId, projectId, output.versionId],
            ),
          ]);
          return {
            ...output,
            evidence: evidence.map((record) => ({
              ...record,
              freshness: assessEvidenceFreshness(toEvidenceObject(record), {
                subjectVersionId: output.versionId,
                now: new Date().toISOString(),
              }),
            })),
            versions,
            head,
            effects: normalizeRows(effects.rows),
          };
        },
        { readOnly: true },
      );
      const raw = await readArtifact(artifacts, data.contentRef);
      return {
        data: { ...data, content: responseContent(data, raw), rawContent: raw },
        requestId: request.id,
      };
    },
  );

  api.get(
    "/v1/outputs/:versionId/diff",
    { schema: { params: VersionParamsSchema, querystring: DiffQuerySchema } },
    async (request) => {
      requirePermission(request, "output:read");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const [current, other] = await database.withTenant(
        tenantId,
        projectId,
        async (executor) => {
          const outputs = createRepositories(executor).outputs;
          return Promise.all([
            outputs.getByVersion({ tenantId, projectId, versionId: request.params.versionId }),
            outputs.getByVersion({ tenantId, projectId, versionId: request.query.against }),
          ]);
        },
        { readOnly: true },
      );
      if (current === null || other === null) {
        throw new ApiHttpError("NOT_FOUND", 404, "One or both output versions were not found");
      }
      const diff = await artifacts.diff(other.contentRef, current.contentRef);
      return { data: diff, requestId: request.id };
    },
  );

  api.post(
    "/v1/outputs/:versionId/evidence",
    { schema: { params: VersionParamsSchema, body: AddEvidenceSchema } },
    async (request, reply) => {
      requirePermission(request, "evidence:write");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const payload =
        request.body.payload === undefined
          ? undefined
          : await storeArtifact(artifacts, {
              tenantId,
              logicalName: `evidence/${request.params.versionId}/${request.body.verifierType}`,
              outputType: "json",
              content: request.body.payload,
            });
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        const repositories = createRepositories(executor);
        const output = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.params.versionId,
        });
        if (output === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
        const fingerprint = evidenceFingerprint({
          subjectVersionId: output.versionId,
          verifierType: request.body.verifierType,
          verifierVersion: request.body.verifierVersion,
          dependencyDigests: request.body.dependencyDigests,
          ...(request.body.environmentDigest === undefined
            ? {}
            : { environmentDigest: request.body.environmentDigest }),
          ...(request.body.policyVersion === undefined
            ? {}
            : { policyVersion: request.body.policyVersion }),
        });
        const evidence = await repositories.evidence.create({
          tenantId,
          projectId,
          subjectVersionId: output.versionId,
          verifierType: request.body.verifierType,
          verifierVersion: request.body.verifierVersion,
          dependencyDigests: request.body.dependencyDigests,
          verdict: request.body.verdict,
          metrics: request.body.metrics,
          fingerprint,
          ...(request.body.environmentDigest === undefined
            ? {}
            : { environmentDigest: request.body.environmentDigest }),
          ...(request.body.policyVersion === undefined
            ? {}
            : { policyVersion: request.body.policyVersion }),
          ...(request.body.confidence === undefined ? {} : { confidence: request.body.confidence }),
          ...(payload === undefined ? {} : { payloadRef: payload.ref }),
          ...(request.body.expiresAt === undefined ? {} : { expiresAt: request.body.expiresAt }),
        });
        await appendLifecycleEvent(executor, {
          tenantId,
          projectId,
          aggregateType: "output",
          aggregateId: output.versionId,
          eventType: "evidence.recorded",
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          requestId: request.id,
          payload: { evidenceId: evidence.id, verdict: evidence.verdict, fingerprint },
        });
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "evidence.created",
          resourceType: "evidence",
          resourceId: evidence.id,
          requestId: request.id,
          metadata: { subjectVersionId: output.versionId, verifierType: evidence.verifierType },
        });
        return { status: 201, data: evidence };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.post(
    "/v1/outputs/:versionId/promote",
    { schema: { params: VersionParamsSchema, body: PromoteOutputSchema } },
    async (request, reply) => {
      requirePermission(request, "output:promote");
      const tenantId = request.principal.tenantId;
      const projectId = requireProject(request);
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        const repositories = createRepositories(executor);
        const record = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: request.params.versionId,
        });
        if (record === null) throw new ApiHttpError("NOT_FOUND", 404, "Output not found");
        if (record.lifecycleState === "PROMOTED") return { status: 200, data: record };
        const head = await repositories.heads.get({
          tenantId,
          projectId,
          logicalId: record.logicalId,
          branch: request.body.branch,
        });
        const actualHead = head?.outputVersionId ?? null;
        if (actualHead !== request.body.expectedHeadVersionId) {
          throw new HeadConflictError(
            record.logicalId,
            request.body.expectedHeadVersionId,
            actualHead,
          );
        }
        const resourceKey = `head:${projectId}:${record.logicalId}:${request.body.branch}`;
        let fencingToken: number;
        if (request.body.fencingToken === undefined) {
          const fence = await repositories.resourceFences.acquire({
            tenantId,
            projectId,
            resourceKey,
            leaseOwner: request.id,
          });
          fencingToken = Number(fence.fencingToken);
        } else {
          fencingToken = request.body.fencingToken;
          const current = await currentFence(executor, tenantId, projectId, resourceKey);
          validateFencingToken({
            resourceKey,
            presentedToken: fencingToken,
            currentToken: current,
          });
          if (
            !(await repositories.resourceFences.isCurrent({
              tenantId,
              projectId,
              resourceKey,
              fencingToken,
            }))
          ) {
            validateFencingToken({
              resourceKey,
              presentedToken: fencingToken,
              currentToken: current + 1,
            });
          }
        }
        const evidenceRecords = await repositories.evidence.listBySubject({
          tenantId,
          projectId,
          subjectVersionId: record.versionId,
        });
        const evidence = evidenceRecords.map(toEvidenceObject);
        const policy = promotionPolicy(record, request.body);
        let output = toOutputObject(record);
        if (output.lifecycleState === "CREATED") {
          output = await appendOutputTransition(executor, request, output, "STAGED", {
            reason: "Promotion preparation",
          });
        }
        if (output.lifecycleState === "STAGED" || output.lifecycleState === "STALE") {
          output = await appendOutputTransition(executor, request, output, "VERIFIED", {
            evidence,
            evidencePolicy: policy,
            reason: "Required Evidence is fresh and passing",
          });
        }
        if (output.lifecycleState === "VERIFIED") {
          output = await appendOutputTransition(executor, request, output, "APPROVED", {
            evidence,
            evidencePolicy: policy,
            reason: `Policy ${policy.id}@${policy.version} approved`,
          });
        }
        if (output.lifecycleState === "APPROVED") {
          const missing: string[] = [];
          for (const parentVersionId of output.parentVersionIds) {
            if (
              (await repositories.outputs.getByVersion({
                tenantId,
                projectId,
                versionId: parentVersionId,
              })) === null
            ) {
              missing.push(parentVersionId);
            }
          }
          output = await appendOutputTransition(executor, request, output, "COMMITTED", {
            provenance: { complete: missing.length === 0, missingVersionIds: missing },
            fence: { resourceKey, presentedToken: fencingToken, currentToken: fencingToken },
            reason: "Provenance closure and logical-head fence validated",
          });
        }
        if (output.lifecycleState !== "COMMITTED" && output.lifecycleState !== "CONSUMED") {
          throw new ApiHttpError(
            "INVALID_TRANSITION",
            409,
            `Output in ${output.lifecycleState} cannot be promoted`,
          );
        }
        const reserved = await repositories.heads.compareAndSwap({
          tenantId,
          projectId,
          logicalId: output.logicalId,
          branch: request.body.branch,
          expectedVersionId: request.body.expectedHeadVersionId,
          newVersionId: output.versionId,
        });
        if (reserved === null) {
          const changed = await repositories.heads.get({
            tenantId,
            projectId,
            logicalId: output.logicalId,
            branch: request.body.branch,
          });
          throw new HeadConflictError(
            output.logicalId,
            request.body.expectedHeadVersionId,
            changed?.outputVersionId ?? null,
          );
        }
        output = await appendOutputTransition(executor, request, output, "PROMOTED", {
          evidence,
          evidencePolicy: policy,
          headReservation: {
            expectedHeadVersionId: request.body.expectedHeadVersionId,
            currentHeadVersionId: actualHead,
          },
          fence: { resourceKey, presentedToken: fencingToken, currentToken: fencingToken },
          reason: `Promoted to ${request.body.branch} generation ${reserved.generation}`,
        });
        await appendAuditEvent(executor, {
          tenantId,
          projectId,
          actorType: "API_KEY",
          actorId: request.principal.subjectId,
          action: "output.promoted",
          resourceType: "output",
          resourceId: output.versionId,
          requestId: request.id,
          metadata: {
            logicalId: output.logicalId,
            branch: request.body.branch,
            generation: reserved.generation,
            evidenceIds: evidence.map(({ id }) => id),
          },
        });
        const persisted = await repositories.outputs.getByVersion({
          tenantId,
          projectId,
          versionId: output.versionId,
        });
        if (persisted === null) throw new ApiHttpError("INTERNAL_ERROR", 500, "Output disappeared");
        return { status: 200, data: persisted };
      });
      if (result.replayed) reply.header("Idempotency-Replayed", "true");
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );
}

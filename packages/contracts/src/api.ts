import { z } from "zod";
import {
  ConnectorCapabilitiesSchema,
  type RemediationStatus,
  RemediationStatusSchema,
  ReversibilitySchema,
  RiskLevelSchema,
} from "./effect.js";
import { EvidenceMetricValueSchema, EvidenceVerdictSchema } from "./evidence.js";
import { LineageEdgeTypeSchema, LineageSelectorSchema } from "./lineage.js";
import { OutputTypeSchema } from "./output.js";
import {
  DigestSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MetadataSchema,
} from "./primitives.js";

export const PaginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).max(2048).optional(),
  })
  .strict();

export const PageInfoSchema = z
  .object({
    nextCursor: z.string().min(1).nullable(),
    hasMore: z.boolean(),
  })
  .strict();

export function PaginatedResponseSchema<ItemSchema extends z.ZodType>(item: ItemSchema) {
  return z
    .object({
      data: z.array(item),
      page: PageInfoSchema,
    })
    .strict();
}

export const ApiErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "INTERNAL_ERROR",
  "DATABASE_ERROR",
  "VALIDATION_ERROR",
  "INVALID_TRANSITION",
  "IMMUTABLE_VERSION",
  "PROVENANCE_INCOMPLETE",
  "EVIDENCE_REQUIRED",
  "EVIDENCE_STALE",
  "POLICY_DENIED",
  "HEAD_CONFLICT",
  "FENCING_TOKEN_LOST",
  "DUPLICATE_EFFECT",
  "RECEIPT_IMMUTABLE",
  "RECONCILIATION_REQUIRED",
  "INVALID_SELECTOR",
  "LINEAGE_CYCLE",
]);

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    details: MetadataSchema.optional(),
  })
  .strict();

export const ApiErrorEnvelopeSchema = z
  .object({
    error: ApiErrorSchema,
    requestId: IdentifierSchema,
  })
  .strict();

export function ApiDataEnvelopeSchema<DataSchema extends z.ZodType>(data: DataSchema) {
  return z
    .object({
      data,
      requestId: IdentifierSchema,
    })
    .strict();
}

export const SpanKindSchema = z.enum([
  "SPAN",
  "GENERATION",
  "TOOL_CALL",
  "EVENT",
  "EVALUATOR",
  "AGENT",
]);
export const ObservationStatusSchema = z.enum(["UNSET", "OK", "ERROR"]);

export const CreateRunSchema = z
  .object({
    id: z.uuid().optional(),
    externalId: z.string().trim().min(1).max(256).optional(),
    name: z.string().trim().min(1).max(256),
    input: JsonValueSchema.optional(),
    metadata: MetadataSchema.default({}),
    startedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const CreateTraceSchema = z
  .object({
    id: z.uuid().optional(),
    runId: z.uuid().optional(),
    externalId: z.string().trim().min(1).max(256).optional(),
    name: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    userId: z.string().trim().min(1).max(256).optional(),
    input: JsonValueSchema.optional(),
    output: JsonValueSchema.optional(),
    metadata: MetadataSchema.default({}),
    startedAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((trace, context) => {
    if (
      trace.startedAt !== undefined &&
      trace.endedAt !== undefined &&
      Date.parse(trace.endedAt) < Date.parse(trace.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "endedAt cannot precede startedAt",
        path: ["endedAt"],
      });
    }
  });

export const CreateSpanSchema = z
  .object({
    id: z.uuid().optional(),
    parentSpanId: z.uuid().optional(),
    externalId: z.string().trim().min(1).max(256).optional(),
    name: z.string().trim().min(1).max(256),
    kind: SpanKindSchema,
    model: z.string().trim().min(1).max(256).optional(),
    input: JsonValueSchema.optional(),
    output: JsonValueSchema.optional(),
    metadata: MetadataSchema.default({}),
    startedAt: IsoDateTimeSchema.optional(),
    endedAt: IsoDateTimeSchema.optional(),
    status: ObservationStatusSchema.default("UNSET"),
  })
  .strict()
  .superRefine((span, context) => {
    if (
      span.startedAt !== undefined &&
      span.endedAt !== undefined &&
      Date.parse(span.endedAt) < Date.parse(span.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "endedAt cannot precede startedAt",
        path: ["endedAt"],
      });
    }
  });

export const CreateScoreSchema = z
  .object({
    id: z.uuid().optional(),
    traceId: z.uuid().optional(),
    spanId: z.uuid().optional(),
    runId: z.uuid().optional(),
    name: z.string().trim().min(1).max(200),
    value: z.union([z.number().finite(), z.boolean(), z.string().trim().min(1).max(4_096)]),
    comment: z.string().trim().min(1).max(4_096).optional(),
    source: z.enum(["API", "EVALUATOR", "HUMAN"]).default("API"),
    metadata: MetadataSchema.default({}),
  })
  .strict()
  .superRefine((score, context) => {
    const subjects = [score.traceId, score.spanId, score.runId].filter(
      (value) => value !== undefined,
    );
    if (subjects.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Exactly one of traceId, spanId, or runId is required",
        path: ["traceId"],
      });
    }
  });

export const IngestionEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.create"), body: CreateRunSchema }).strict(),
  z.object({ type: z.literal("trace.create"), body: CreateTraceSchema }).strict(),
  z
    .object({
      type: z.literal("span.create"),
      traceId: z.uuid(),
      body: CreateSpanSchema,
    })
    .strict(),
]);

export const IngestionBatchSchema = z
  .object({
    batchId: z.string().trim().min(1).max(256),
    events: z.array(IngestionEventSchema).min(1).max(500),
  })
  .strict();

export const CreateOutputSchema = z
  .object({
    logicalId: IdentifierSchema,
    versionId: IdentifierSchema.optional(),
    branch: z.string().trim().min(1).max(128).default("main"),
    outputType: OutputTypeSchema,
    content: JsonValueSchema,
    schemaId: z.string().trim().min(1).max(256).optional(),
    producerRunId: z.uuid().optional(),
    producerAgentId: z.string().trim().min(1).max(256).optional(),
    parentVersionIds: z.array(IdentifierSchema).max(100).default([]),
    policyVersion: z.string().trim().min(1).max(256).optional(),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const AddEvidenceSchema = z
  .object({
    verifierType: z.string().trim().min(1).max(256),
    verifierVersion: z.string().trim().min(1).max(256),
    environmentDigest: DigestSchema.optional(),
    dependencyDigests: z.array(DigestSchema).max(1_000).default([]),
    policyVersion: z.string().trim().min(1).max(256).optional(),
    verdict: EvidenceVerdictSchema,
    confidence: z.number().min(0).max(1).optional(),
    metrics: z.record(z.string(), EvidenceMetricValueSchema).default({}),
    payload: JsonValueSchema.optional(),
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const PromoteOutputSchema = z
  .object({
    expectedHeadVersionId: IdentifierSchema.nullable(),
    branch: z.string().trim().min(1).max(128).default("main"),
    requiredVerifierTypes: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .default(["shadow-sql"]),
    policyVersion: z.string().trim().min(1).max(256).optional(),
    fencingToken: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CreateLineageSchema = z
  .object({
    sourceVersionId: IdentifierSchema,
    targetVersionId: IdentifierSchema,
    edgeType: LineageEdgeTypeSchema,
    selector: LineageSelectorSchema.optional(),
    transferFunction: z.string().trim().min(1).max(512).optional(),
    inferred: z.boolean().default(false),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((edge, context) => {
    if (!edge.inferred && edge.confidence !== undefined) {
      context.addIssue({
        code: "custom",
        message: "confidence is only valid for inferred lineage",
        path: ["confidence"],
      });
    }
  });

export const ImpactQuerySchema = z
  .object({
    sourceVersionId: IdentifierSchema,
    selectors: z.string().optional(),
  })
  .strict();

export const ImpactAnalysisRequestSchema = z
  .object({
    sourceVersionId: IdentifierSchema,
    deltaSelectors: z.array(LineageSelectorSchema).min(1),
    beforeDigest: DigestSchema.optional(),
    afterDigest: DigestSchema.optional(),
  })
  .strict();

export const InvalidateOutputSchema = z
  .object({
    reason: z.string().trim().min(1).max(4096),
    deltaSelectors: z.array(LineageSelectorSchema).default([{ kind: "unknown", value: "*" }]),
    beforeDigest: DigestSchema.optional(),
    afterDigest: DigestSchema.optional(),
  })
  .strict();

export const PrepareEffectSchema = z
  .object({
    sourceOutputVersionId: IdentifierSchema,
    connectorType: z.string().trim().min(1).max(256),
    target: z.string().trim().min(1).max(2048),
    resourceKey: IdentifierSchema,
    arguments: MetadataSchema,
    preconditions: MetadataSchema.default({}),
    expectedEffects: MetadataSchema.default({}),
    readSet: z.array(IdentifierSchema).max(1_000).default([]),
    writeSet: z.array(IdentifierSchema).max(1_000).default([]),
    baseResourceVersion: IdentifierSchema.optional(),
    idempotencyKey: z.string().trim().min(8).max(256),
    reversibility: ReversibilitySchema,
    compensationHandler: z.string().trim().min(1).max(256).optional(),
    riskLevel: RiskLevelSchema,
    connectorCapabilities: ConnectorCapabilitiesSchema,
  })
  .strict();

export const RecordReceiptSchema = z
  .object({
    externalTransactionId: IdentifierSchema.optional(),
    externalStatus: z.string().trim().min(1).max(512),
    beforeDigest: DigestSchema.optional(),
    afterDigest: DigestSchema.optional(),
    actualEffects: MetadataSchema,
    rawResponse: JsonValueSchema.optional(),
    compensationStatus: z.string().trim().min(1).max(512).optional(),
    committedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const RemediationResolutionReferenceSchema = z
  .object({
    kind: z.enum(["EVIDENCE", "RECEIPT", "TICKET", "URL", "OTHER"]),
    reference: z.string().trim().min(1).max(2048),
  })
  .strict();

export const RemediationResolutionSchema = z
  .object({
    summary: z.string().trim().min(1).max(4096),
    references: z.array(RemediationResolutionReferenceSchema).max(100).default([]),
    metadata: MetadataSchema.default({}),
  })
  .strict();

export const REMEDIATION_STATUS_TRANSITIONS = Object.freeze({
  OPEN: Object.freeze(["PENDING_APPROVAL", "IN_PROGRESS", "WAIVED"] as const),
  PENDING_APPROVAL: Object.freeze(["IN_PROGRESS", "WAIVED"] as const),
  IN_PROGRESS: Object.freeze(["PENDING_APPROVAL", "RESOLVED", "WAIVED"] as const),
  RESOLVED: Object.freeze([] as const),
  WAIVED: Object.freeze([] as const),
}) satisfies Readonly<Record<RemediationStatus, readonly RemediationStatus[]>>;

export function isRemediationTransitionAllowed(
  currentStatus: RemediationStatus,
  nextStatus: RemediationStatus,
): boolean {
  const allowed = REMEDIATION_STATUS_TRANSITIONS[currentStatus] as readonly RemediationStatus[];
  return allowed.includes(nextStatus);
}

export const TransitionRemediationSchema = z
  .object({
    expectedStatus: RemediationStatusSchema,
    nextStatus: RemediationStatusSchema,
    resolution: RemediationResolutionSchema.optional(),
  })
  .strict()
  .superRefine((transition, context) => {
    const terminal = transition.nextStatus === "RESOLVED" || transition.nextStatus === "WAIVED";
    if (terminal && transition.resolution === undefined) {
      context.addIssue({
        code: "custom",
        message: `${transition.nextStatus} requires a structured resolution`,
        path: ["resolution"],
      });
    }
    if (!terminal && transition.resolution !== undefined) {
      context.addIssue({
        code: "custom",
        message: "resolution is only valid for RESOLVED or WAIVED transitions",
        path: ["resolution"],
      });
    }
  });

export const RemediationActorTypeSchema = z.enum(["API_KEY", "USER", "WORKER", "SYSTEM"]);

export const RemediationObligationRecordSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    projectId: z.uuid(),
    intentId: z.uuid(),
    invalidatedOutputVersionId: IdentifierSchema,
    status: RemediationStatusSchema,
    riskLevel: RiskLevelSchema,
    reason: z.string().trim().min(1).max(4096),
    resolution: RemediationResolutionSchema.optional(),
    approvedBy: IdentifierSchema.optional(),
    approvedByActorType: RemediationActorTypeSchema.optional(),
    resolvedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((obligation, context) => {
    if ((obligation.approvedBy === undefined) !== (obligation.approvedByActorType === undefined)) {
      context.addIssue({
        code: "custom",
        message: "approvedBy and approvedByActorType must be present together",
        path: ["approvedBy"],
      });
    }
    const terminal = obligation.status === "RESOLVED" || obligation.status === "WAIVED";
    if (terminal && (obligation.resolution === undefined || obligation.resolvedAt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Terminal remediation obligations require resolution and resolvedAt",
        path: ["resolution"],
      });
    }
    if (!terminal && (obligation.resolution !== undefined || obligation.resolvedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Non-terminal remediation obligations cannot contain terminal resolution fields",
        path: ["resolution"],
      });
    }
  });

export const ApiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]).default("MEMBER"),
    scopes: z.array(z.string().trim().min(1).max(128)).min(1),
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export type CreateRunRequest = z.infer<typeof CreateRunSchema>;
export type CreateTraceRequest = z.infer<typeof CreateTraceSchema>;
export type CreateSpanRequest = z.infer<typeof CreateSpanSchema>;
export type CreateScoreRequest = z.infer<typeof CreateScoreSchema>;
export type IngestionEvent = z.infer<typeof IngestionEventSchema>;
export type IngestionBatchRequest = z.infer<typeof IngestionBatchSchema>;
export type CreateOutputRequest = z.infer<typeof CreateOutputSchema>;
export type AddEvidenceRequest = z.infer<typeof AddEvidenceSchema>;
export type PromoteOutputRequest = z.infer<typeof PromoteOutputSchema>;
export type CreateLineageRequest = z.infer<typeof CreateLineageSchema>;
export type ImpactQuery = z.infer<typeof ImpactQuerySchema>;
export type ImpactAnalysisRequest = z.infer<typeof ImpactAnalysisRequestSchema>;
export type InvalidateOutputRequest = z.infer<typeof InvalidateOutputSchema>;
export type PrepareEffectRequest = z.infer<typeof PrepareEffectSchema>;
export type RecordReceiptRequest = z.infer<typeof RecordReceiptSchema>;
export type RemediationResolutionReference = z.infer<typeof RemediationResolutionReferenceSchema>;
export type RemediationResolution = z.infer<typeof RemediationResolutionSchema>;
export type TransitionRemediationRequest = z.infer<typeof TransitionRemediationSchema>;
export type RemediationActorType = z.infer<typeof RemediationActorTypeSchema>;
export type RemediationObligationRecord = z.infer<typeof RemediationObligationRecordSchema>;
export type ApiKeyCreateRequest = z.infer<typeof ApiKeyCreateSchema>;

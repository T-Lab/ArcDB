export type JsonObject = Readonly<Record<string, unknown>>;
export type SecurityLabel = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
export type OrganizationRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
export type RunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type TraceStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export type SpanStatus = "UNSET" | "RUNNING" | "OK" | "ERROR" | "CANCELLED";
export type SpanKind = "SPAN" | "GENERATION" | "TOOL_CALL" | "EVENT" | "EVALUATOR" | "AGENT";
export type OutputType =
  | "text"
  | "json"
  | "markdown"
  | "code_patch"
  | "file_tree"
  | "sql"
  | "tool_plan"
  | "decision"
  | "dataset_record";
export type OutputLifecycleState =
  | "CREATED"
  | "STAGED"
  | "VERIFIED"
  | "APPROVED"
  | "COMMITTED"
  | "CONSUMED"
  | "PROMOTED"
  | "REJECTED"
  | "STALE"
  | "INVALIDATED"
  | "SUPERSEDED";
export type EvidenceVerdict = "PASS" | "FAIL" | "STALE" | "UNKNOWN";
export type LineageEdgeType =
  | "PRODUCED_BY"
  | "DERIVED_FROM"
  | "READ_FROM"
  | "VERIFIED_BY"
  | "CONSUMED_BY"
  | "CAUSED"
  | "SUPERSEDES"
  | "COMPENSATED_BY"
  | "REMEDIATED_BY";
export type EffectStatus =
  | "PREPARED"
  | "EXECUTING"
  | "COMMITTED"
  | "FAILED"
  | "COMPENSATION_PENDING"
  | "COMPENSATED"
  | "REMEDIATION_REQUIRED"
  | "IRREVERSIBLE_COMMITTED"
  | "RECONCILIATION_REQUIRED";
export type JobType =
  | "process_ingestion_batch"
  | "run_verifier"
  | "evaluate_policy"
  | "compute_impact"
  | "propagate_invalidation"
  | "materialize_dataset_view"
  | "compact_artifacts"
  | "garbage_collect_chunks"
  | "reconcile_effect"
  | "run_compensation"
  | "create_remediation_obligation"
  | "publish_analytics_projection";

export interface OrganizationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly settings: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash?: string;
  readonly disabledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MembershipRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly role: OrganizationRole;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly retentionDays?: number;
  readonly settings: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly name: string;
  readonly prefix: string;
  readonly keyHash: string;
  readonly lastFour: string;
  readonly permissions: readonly string[];
  readonly createdBy?: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly revokedAt?: string;
  readonly createdAt: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly externalId?: string;
  readonly name?: string;
  readonly userId?: string;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sessionId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly environment?: string;
  readonly agentId?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly metadata: JsonObject;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TraceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly status: TraceStatus;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata: JsonObject;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpanRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly externalId?: string;
  readonly kind: SpanKind;
  readonly name: string;
  readonly status: SpanStatus;
  readonly model?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly metadata: JsonObject;
  readonly usage: JsonObject;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScoreRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly runId?: string;
  readonly name: string;
  readonly dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  readonly numericValue?: number;
  readonly stringValue?: string;
  readonly comment?: string;
  readonly source: "API" | "EVALUATOR" | "HUMAN";
  readonly metadata: JsonObject;
  readonly createdAt: string;
}

export interface OutputRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalId: string;
  readonly versionId: string;
  readonly outputType: OutputType;
  readonly schemaId?: string;
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly producerRunId?: string;
  readonly producerAgentId?: string;
  readonly parentVersionIds: readonly string[];
  readonly policyVersion?: string;
  readonly lifecycleState: OutputLifecycleState;
  readonly securityLabel: SecurityLabel;
  readonly metadata: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EvidenceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly subjectVersionId: string;
  readonly verifierType: string;
  readonly verifierVersion: string;
  readonly environmentDigest?: string;
  readonly dependencyDigests: readonly string[];
  readonly policyVersion?: string;
  readonly verdict: EvidenceVerdict;
  readonly confidence?: number;
  readonly metrics: JsonObject;
  readonly payloadRef?: string;
  readonly fingerprint: string;
  readonly securityLabel: SecurityLabel;
  readonly expiresAt?: string;
  readonly createdAt: string;
}

export interface LogicalHeadRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly logicalId: string;
  readonly branch: string;
  readonly outputVersionId: string;
  readonly generation: string;
  readonly updatedBy?: string;
  readonly updatedAt: string;
}

export interface LineageEdgeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sourceVersionId: string;
  readonly targetVersionId: string;
  readonly edgeType: LineageEdgeType;
  readonly selector?: { readonly kind: string; readonly value: string };
  readonly transferFunction?: string;
  readonly inferred: boolean;
  readonly confidence?: number;
  readonly dependencyFingerprint?: string;
  readonly createdAt: string;
}

export interface EffectIntentRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly sourceOutputVersionId: string;
  readonly connectorType: string;
  readonly connectorCapabilities: JsonObject;
  readonly target: string;
  readonly resourceKey: string;
  readonly argumentsRef: string;
  readonly preconditions: JsonObject;
  readonly expectedEffects: JsonObject;
  readonly readSet: readonly string[];
  readonly writeSet: readonly string[];
  readonly baseResourceVersion?: string;
  readonly idempotencyKey: string;
  readonly fencingToken?: string;
  readonly reversibility: "R0" | "R1" | "R2" | "R3";
  readonly compensationHandler?: string;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly status: EffectStatus;
  readonly securityLabel: SecurityLabel;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EffectReceiptRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly sequence: number;
  readonly externalTransactionId?: string;
  readonly externalStatus: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly actualEffects: JsonObject;
  readonly rawResponseRef?: string;
  readonly compensationStatus?: string;
  readonly committedAt?: string;
  readonly createdAt: string;
}

export interface JobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly jobType: JobType;
  readonly idempotencyKey: string;
  readonly status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD_LETTER";
  readonly payload: JsonObject;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly availableAt: string;
  readonly lockedBy?: string;
  readonly lockExpiresAt?: string;
  readonly fencingToken: string;
  readonly traceContext: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LifecycleEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly sequence: string;
  readonly actorType: "USER" | "API_KEY" | "WORKER" | "SYSTEM";
  readonly actorId?: string;
  readonly requestId?: string;
  readonly traceContext: JsonObject;
  readonly payload: JsonObject;
  readonly createdAt: string;
}

export interface AuditEventRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly actorType: "USER" | "API_KEY" | "WORKER" | "SYSTEM";
  readonly actorId?: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly requestId?: string;
  readonly ipHash?: string;
  readonly userAgentHash?: string;
  readonly metadata: JsonObject;
  readonly previousHash?: string;
  readonly eventHash: string;
  readonly createdAt: string;
}

export interface RecomputePlanRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly rootOutputVersionId: string;
  readonly status: "PLANNED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  readonly reason: string;
  readonly affectedNodes: readonly unknown[];
  readonly skippedNodes: readonly unknown[];
  readonly explanationGraph: JsonObject;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RemediationObligationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly invalidatedOutputVersionId: string;
  readonly status: "OPEN" | "PENDING_APPROVAL" | "IN_PROGRESS" | "RESOLVED" | "WAIVED";
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly reason: string;
  readonly resolution?: unknown;
  readonly approvedBy?: string;
  readonly approvedByActorType?: "API_KEY" | "USER" | "WORKER" | "SYSTEM";
  readonly resolvedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QueueStats {
  readonly pending: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLetter: number;
  readonly oldestAvailableAt?: string;
}

export interface PageOptions {
  readonly limit?: number;
  readonly before?: string;
  readonly beforeId?: string;
}

import { createHash } from "node:crypto";
import type {
  AuditEventRecord,
  JobRecord,
  JobType,
  JsonObject,
  LifecycleEventRecord,
  QueueStats,
  RecomputePlanRecord,
  RemediationObligationRecord,
} from "../types.js";
import {
  boundedLimit,
  json,
  normalizeRows,
  optionalRow,
  type RawRow,
  Repository,
  RepositoryError,
  requiredRow,
} from "./helpers.js";

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Audit metadata must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Audit metadata cannot contain ${typeof value}`);
}

export interface EnqueueJobInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly jobType: JobType;
  readonly idempotencyKey: string;
  readonly payload?: JsonObject;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly availableAt?: string;
  readonly traceContext?: JsonObject;
}

export class JobsRepository extends Repository {
  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO jobs (
         id, tenant_id, project_id, job_type, idempotency_key, payload,
         max_attempts, timeout_ms, available_at, trace_context
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb,
         $7, $8, COALESCE($9::timestamptz, now()), $10::jsonb
       )
       ON CONFLICT (tenant_id, project_id, job_type, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId ?? null,
        input.jobType,
        input.idempotencyKey,
        json(input.payload),
        input.maxAttempts ?? 5,
        input.timeoutMs ?? 30_000,
        input.availableAt ?? null,
        json(input.traceContext),
      ],
    );
    const inserted = optionalRow<JobRecord>(result.rows);
    if (inserted !== null) {
      return inserted;
    }
    const existing = await this.executor.query<RawRow>(
      `SELECT * FROM jobs
       WHERE tenant_id = $1 AND project_id IS NOT DISTINCT FROM $2::uuid
         AND job_type = $3 AND idempotency_key = $4`,
      [input.tenantId, input.projectId ?? null, input.jobType, input.idempotencyKey],
    );
    const replay = requiredRow<JobRecord>(existing.rows, "job");
    if (
      replay.projectId !== input.projectId ||
      canonical(replay.payload) !== canonical(input.payload ?? {})
    ) {
      throw new RepositoryError(
        "Job idempotency key was already used with a different payload",
        "CONFLICT",
      );
    }
    return replay;
  }

  public async get(input: {
    readonly tenantId: string;
    readonly id: string;
  }): Promise<JobRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM jobs WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return optionalRow(result.rows);
  }

  /** Atomically claims one available job and advances its monotonic fencing token. */
  public async claim(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly jobTypes?: readonly JobType[];
    readonly lockSeconds?: number;
  }): Promise<JobRecord | null> {
    const lockSeconds = input.lockSeconds ?? 60;
    if (!Number.isInteger(lockSeconds) || lockSeconds < 1 || lockSeconds > 3_600) {
      throw new TypeError("lockSeconds must be an integer between 1 and 3600");
    }
    const result = await this.executor.query<RawRow>(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE tenant_id = $1
           AND status IN ('PENDING', 'FAILED')
           AND available_at <= now()
           AND attempt_count < max_attempts
           AND ($2::text[] IS NULL OR job_type = ANY($2::text[]))
         ORDER BY available_at, created_at, id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE jobs SET
         status = 'RUNNING', attempt_count = attempt_count + 1,
         locked_by = $3, lock_expires_at = now() + make_interval(secs => $4),
         fencing_token = fencing_token + 1, error = NULL
       FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.*`,
      [
        input.tenantId,
        input.jobTypes === undefined ? null : [...input.jobTypes],
        input.workerId,
        lockSeconds,
      ],
    );
    return optionalRow(result.rows);
  }

  /** Renews only the lease held by the same worker and fencing generation. */
  public async heartbeat(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly workerId: string;
    readonly fencingToken: string | number;
    readonly extendSeconds?: number;
  }): Promise<boolean> {
    const extendSeconds = input.extendSeconds ?? 60;
    if (!Number.isInteger(extendSeconds) || extendSeconds < 1 || extendSeconds > 3_600) {
      throw new TypeError("extendSeconds must be an integer between 1 and 3600");
    }
    const result = await this.executor.query(
      `UPDATE jobs SET lock_expires_at = now() + make_interval(secs => $5)
       WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'
         AND locked_by = $3 AND fencing_token = $4 AND lock_expires_at > now()`,
      [input.tenantId, input.id, input.workerId, input.fencingToken, extendSeconds],
    );
    return result.rowCount === 1;
  }

  public async complete(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly workerId: string;
    readonly fencingToken: string | number;
    readonly result?: unknown;
  }): Promise<JobRecord | null> {
    const completed = await this.executor.query<RawRow>(
      `UPDATE jobs SET status = 'SUCCEEDED', result = $5::jsonb,
         locked_by = NULL, lock_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'
         AND locked_by = $3 AND fencing_token = $4 AND lock_expires_at > now()
       RETURNING *`,
      [
        input.tenantId,
        input.id,
        input.workerId,
        input.fencingToken,
        input.result === undefined ? null : json(input.result),
      ],
    );
    return optionalRow(completed.rows);
  }

  public async fail(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly workerId: string;
    readonly fencingToken: string | number;
    readonly error: JsonObject;
    readonly retryAt?: string;
  }): Promise<JobRecord | null> {
    const failed = await this.executor.query<RawRow>(
      `UPDATE jobs SET
         status = CASE WHEN attempt_count >= max_attempts THEN 'DEAD_LETTER' ELSE 'FAILED' END,
         error = $5::jsonb,
         available_at = CASE WHEN attempt_count >= max_attempts THEN available_at
           ELSE COALESCE($6::timestamptz, now()) END,
         locked_by = NULL, lock_expires_at = NULL
       WHERE tenant_id = $1 AND id = $2 AND status = 'RUNNING'
         AND locked_by = $3 AND fencing_token = $4 AND lock_expires_at > now()
       RETURNING *`,
      [
        input.tenantId,
        input.id,
        input.workerId,
        input.fencingToken,
        json(input.error),
        input.retryAt ?? null,
      ],
    );
    return optionalRow(failed.rows);
  }

  /** Converts expired leases into an explicit retry or dead-letter state. */
  public async recoverStalled(input: {
    readonly tenantId: string;
    readonly limit?: number;
  }): Promise<readonly JobRecord[]> {
    const result = await this.executor.query<RawRow>(
      `WITH stalled AS (
         SELECT id FROM jobs
         WHERE tenant_id = $1 AND status = 'RUNNING' AND lock_expires_at <= now()
         ORDER BY lock_expires_at FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE jobs SET
         status = CASE WHEN attempt_count >= max_attempts THEN 'DEAD_LETTER' ELSE 'FAILED' END,
         error = jsonb_build_object('code', 'WORKER_LEASE_EXPIRED', 'retryable', attempt_count < max_attempts),
         available_at = now(), locked_by = NULL, lock_expires_at = NULL
       FROM stalled WHERE jobs.id = stalled.id RETURNING jobs.*`,
      [input.tenantId, boundedLimit(input.limit)],
    );
    return normalizeRows(result.rows);
  }

  public async stats(tenantId: string): Promise<QueueStats> {
    const result = await this.executor.query<RawRow>(
      `SELECT
         count(*) FILTER (WHERE status = 'PENDING')::integer AS pending,
         count(*) FILTER (WHERE status = 'RUNNING')::integer AS running,
         count(*) FILTER (WHERE status = 'SUCCEEDED')::integer AS succeeded,
         count(*) FILTER (WHERE status = 'FAILED')::integer AS failed,
         count(*) FILTER (WHERE status = 'DEAD_LETTER')::integer AS dead_letter,
         min(available_at) FILTER (WHERE status IN ('PENDING', 'FAILED')) AS oldest_available_at
       FROM jobs WHERE tenant_id = $1`,
      [tenantId],
    );
    return requiredRow(result.rows, "queue stats");
  }
}

export interface AppendLifecycleEventInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly actorType: "USER" | "API_KEY" | "WORKER" | "SYSTEM";
  readonly actorId?: string;
  readonly requestId?: string;
  readonly traceContext?: JsonObject;
  readonly payload?: JsonObject;
}

export class LifecycleEventsRepository extends Repository {
  public async append(input: AppendLifecycleEventInput): Promise<LifecycleEventRecord> {
    await this.executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `${input.tenantId}:${input.projectId}:${input.aggregateType}:${input.aggregateId}`,
    ]);
    const result = await this.executor.query<RawRow>(
      `INSERT INTO lifecycle_events (
         id, tenant_id, project_id, aggregate_type, aggregate_id, event_type,
         sequence, actor_type, actor_id, request_id, trace_context, payload
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
         COALESCE((SELECT max(sequence) + 1 FROM lifecycle_events
           WHERE tenant_id = $2 AND project_id = $3
             AND aggregate_type = $4 AND aggregate_id = $5), 1),
         $7, $8, $9, $10::jsonb, $11::jsonb
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        input.actorType,
        input.actorId ?? null,
        input.requestId ?? null,
        json(input.traceContext),
        json(input.payload),
      ],
    );
    return requiredRow(result.rows, "lifecycle event");
  }

  public async list(input: {
    readonly tenantId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
  }): Promise<readonly LifecycleEventRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM lifecycle_events
       WHERE tenant_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
       ORDER BY sequence`,
      [input.tenantId, input.aggregateType, input.aggregateId],
    );
    return normalizeRows(result.rows);
  }
}

export interface AppendAuditEventInput {
  readonly id?: string;
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
  readonly metadata?: JsonObject;
}

export class AuditRepository extends Repository {
  public async append(input: AppendAuditEventInput): Promise<AuditEventRecord> {
    await this.executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      input.tenantId,
    ]);
    const previous = await this.executor.query<{ event_hash: string }>(
      "SELECT event_hash FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [input.tenantId],
    );
    const previousHash = previous.rows[0]?.event_hash;
    const createdAt = new Date().toISOString();
    const hashPayload = {
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      metadata: input.metadata ?? {},
      previousHash: previousHash ?? null,
      createdAt,
    };
    const eventHash = createHash("sha256").update(canonical(hashPayload), "utf8").digest("hex");
    const result = await this.executor.query<RawRow>(
      `INSERT INTO audit_events (
         id, tenant_id, project_id, actor_type, actor_id, action, resource_type,
         resource_id, request_id, ip_hash, user_agent_hash, metadata,
         previous_hash, event_hash, created_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12::jsonb, $13, $14, $15
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId ?? null,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.requestId ?? null,
        input.ipHash ?? null,
        input.userAgentHash ?? null,
        json(input.metadata),
        previousHash ?? null,
        eventHash,
        createdAt,
      ],
    );
    return requiredRow(result.rows, "audit event");
  }

  public async list(input: {
    readonly tenantId: string;
    readonly projectId?: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly before?: string;
    readonly limit?: number;
  }): Promise<readonly AuditEventRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM audit_events
       WHERE tenant_id = $1
         AND ($2::uuid IS NULL OR project_id = $2)
         AND ($3::text IS NULL OR resource_type = $3)
         AND ($4::text IS NULL OR resource_id = $4)
         AND ($5::timestamptz IS NULL OR created_at < $5)
       ORDER BY created_at DESC, id DESC LIMIT $6`,
      [
        input.tenantId,
        input.projectId ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.before ?? null,
        boundedLimit(input.limit),
      ],
    );
    return normalizeRows(result.rows);
  }
}

export class RecomputePlansRepository extends Repository {
  public async create(input: {
    readonly id?: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly rootOutputVersionId: string;
    readonly reason: string;
    readonly affectedNodes?: readonly unknown[];
    readonly skippedNodes?: readonly unknown[];
    readonly explanationGraph?: JsonObject;
  }): Promise<RecomputePlanRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO recomputation_plans (
         id, tenant_id, project_id, root_output_version_id, reason,
         affected_nodes, skipped_nodes, explanation_graph
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5,
         $6::jsonb, $7::jsonb, $8::jsonb
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.rootOutputVersionId,
        input.reason,
        json(input.affectedNodes ?? []),
        json(input.skippedNodes ?? []),
        json(input.explanationGraph),
      ],
    );
    return requiredRow(result.rows, "recomputation plan");
  }

  public async get(input: {
    readonly tenantId: string;
    readonly id: string;
  }): Promise<RecomputePlanRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM recomputation_plans WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async updateStatus(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly expectedStatus: RecomputePlanRecord["status"];
    readonly nextStatus: RecomputePlanRecord["status"];
  }): Promise<RecomputePlanRecord | null> {
    const result = await this.executor.query<RawRow>(
      `UPDATE recomputation_plans SET status = $4
       WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING *`,
      [input.tenantId, input.id, input.expectedStatus, input.nextStatus],
    );
    return optionalRow(result.rows);
  }
}

export class RemediationObligationsRepository extends Repository {
  public async create(input: {
    readonly id?: string;
    readonly tenantId: string;
    readonly projectId: string;
    readonly intentId: string;
    readonly invalidatedOutputVersionId: string;
    readonly status?: RemediationObligationRecord["status"];
    readonly riskLevel: RemediationObligationRecord["riskLevel"];
    readonly reason: string;
  }): Promise<RemediationObligationRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO remediation_obligations (
         id, tenant_id, project_id, intent_id, invalidated_output_version_id,
         status, risk_level, reason
       ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, project_id, intent_id, invalidated_output_version_id) DO UPDATE SET
         reason = EXCLUDED.reason, risk_level = EXCLUDED.risk_level
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.intentId,
        input.invalidatedOutputVersionId,
        input.status ??
          (input.riskLevel === "HIGH" || input.riskLevel === "CRITICAL"
            ? "PENDING_APPROVAL"
            : "OPEN"),
        input.riskLevel,
        input.reason,
      ],
    );
    return requiredRow(result.rows, "remediation obligation");
  }

  public async listOpen(input: {
    readonly tenantId: string;
    readonly projectId: string;
  }): Promise<readonly RemediationObligationRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM remediation_obligations
       WHERE tenant_id = $1 AND project_id = $2
         AND status IN ('OPEN', 'PENDING_APPROVAL', 'IN_PROGRESS')
       ORDER BY risk_level DESC, created_at`,
      [input.tenantId, input.projectId],
    );
    return normalizeRows(result.rows);
  }

  public async updateStatus(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly expectedStatus: RemediationObligationRecord["status"];
    readonly nextStatus: RemediationObligationRecord["status"];
    readonly resolution?: unknown;
    readonly approvedBy?: string;
    readonly approvedByActorType?: NonNullable<RemediationObligationRecord["approvedByActorType"]>;
  }): Promise<RemediationObligationRecord | null> {
    if ((input.approvedBy === undefined) !== (input.approvedByActorType === undefined)) {
      throw new TypeError("approvedBy and approvedByActorType must be supplied together");
    }
    const result = await this.executor.query<RawRow>(
      `UPDATE remediation_obligations SET status = $4,
         resolution = CASE WHEN $5::boolean THEN $6::jsonb ELSE resolution END,
         approved_by = COALESCE($7::text, approved_by),
         approved_by_actor_type = COALESCE($8::text, approved_by_actor_type),
         resolved_at = CASE WHEN $4 IN ('RESOLVED', 'WAIVED') THEN now() ELSE resolved_at END
       WHERE tenant_id = $1 AND id = $2 AND status = $3 RETURNING *`,
      [
        input.tenantId,
        input.id,
        input.expectedStatus,
        input.nextStatus,
        input.resolution !== undefined,
        input.resolution === undefined ? null : json(input.resolution),
        input.approvedBy ?? null,
        input.approvedByActorType ?? null,
      ],
    );
    return optionalRow(result.rows);
  }
}

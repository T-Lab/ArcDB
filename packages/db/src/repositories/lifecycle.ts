import type {
  EffectIntentRecord,
  EffectReceiptRecord,
  EffectStatus,
  EvidenceRecord,
  EvidenceVerdict,
  JsonObject,
  LineageEdgeRecord,
  LineageEdgeType,
  LogicalHeadRecord,
  OutputLifecycleState,
  OutputRecord,
  OutputType,
  PageOptions,
  SecurityLabel,
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

interface TenantProject {
  readonly tenantId: string;
  readonly projectId: string;
}

function canonicalComparable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalComparable).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalComparable(child)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Cannot compare ${typeof value} in an idempotent write`);
}

export interface CreateOutputInput extends TenantProject {
  readonly id?: string;
  readonly logicalId: string;
  readonly versionId: string;
  readonly outputType: OutputType;
  readonly schemaId?: string;
  readonly contentRef: string;
  readonly contentDigest: string;
  readonly producerRunId?: string;
  readonly producerAgentId?: string;
  readonly parentVersionIds?: readonly string[];
  readonly policyVersion?: string;
  readonly lifecycleState?: OutputLifecycleState;
  readonly securityLabel?: SecurityLabel;
  readonly metadata?: JsonObject;
}

export class OutputsRepository extends Repository {
  public async create(input: CreateOutputInput): Promise<OutputRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO outputs (
         id, tenant_id, project_id, logical_id, version_id, output_type, schema_id,
         content_ref, content_digest, producer_run_id, producer_agent_id,
         parent_version_ids, policy_version, lifecycle_state, security_label, metadata
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.logicalId,
        input.versionId,
        input.outputType,
        input.schemaId ?? null,
        input.contentRef,
        input.contentDigest,
        input.producerRunId ?? null,
        input.producerAgentId ?? null,
        [...(input.parentVersionIds ?? [])],
        input.policyVersion ?? null,
        input.lifecycleState ?? "CREATED",
        input.securityLabel ?? "INTERNAL",
        json(input.metadata),
      ],
    );
    return requiredRow(result.rows, "output");
  }

  public async get(input: {
    readonly tenantId: string;
    readonly id: string;
  }): Promise<OutputRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM outputs WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async getByVersion(
    input: TenantProject & { readonly versionId: string },
  ): Promise<OutputRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM outputs WHERE tenant_id = $1 AND project_id = $2 AND version_id = $3",
      [input.tenantId, input.projectId, input.versionId],
    );
    return optionalRow(result.rows);
  }

  public async list(
    input: TenantProject &
      PageOptions & {
        readonly logicalId?: string;
        readonly lifecycleState?: OutputLifecycleState;
      },
  ): Promise<readonly OutputRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM outputs
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR logical_id = $3)
         AND ($4::text IS NULL OR lifecycle_state = $4)
         AND ($5::timestamptz IS NULL OR created_at < $5 OR
           (created_at = $5 AND $6::uuid IS NOT NULL AND id < $6))
       ORDER BY created_at DESC, id DESC LIMIT $7`,
      [
        input.tenantId,
        input.projectId,
        input.logicalId ?? null,
        input.lifecycleState ?? null,
        input.before ?? null,
        input.beforeId ?? null,
        boundedLimit(input.limit),
      ],
    );
    return normalizeRows(result.rows);
  }

  public async updateLifecycleState(
    input: TenantProject & {
      readonly versionId: string;
      readonly expectedState: OutputLifecycleState | readonly OutputLifecycleState[];
      readonly nextState: OutputLifecycleState;
      readonly metadataPatch?: JsonObject;
    },
  ): Promise<OutputRecord | null> {
    const expected =
      typeof input.expectedState === "string" ? [input.expectedState] : input.expectedState;
    const result = await this.executor.query<RawRow>(
      `UPDATE outputs SET lifecycle_state = $5, metadata = metadata || $6::jsonb
       WHERE tenant_id = $1 AND project_id = $2 AND version_id = $3
         AND lifecycle_state = ANY($4::text[])
       RETURNING *`,
      [
        input.tenantId,
        input.projectId,
        input.versionId,
        [...expected],
        input.nextState,
        json(input.metadataPatch),
      ],
    );
    return optionalRow(result.rows);
  }
}

export interface CreateEvidenceInput extends TenantProject {
  readonly id?: string;
  readonly subjectVersionId: string;
  readonly verifierType: string;
  readonly verifierVersion: string;
  readonly environmentDigest?: string;
  readonly dependencyDigests?: readonly string[];
  readonly policyVersion?: string;
  readonly verdict: EvidenceVerdict;
  readonly confidence?: number;
  readonly metrics?: JsonObject;
  readonly payloadRef?: string;
  readonly fingerprint: string;
  readonly securityLabel?: SecurityLabel;
  readonly expiresAt?: string;
}

export class EvidenceRepository extends Repository {
  public async create(input: CreateEvidenceInput): Promise<EvidenceRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO evidence (
         id, tenant_id, project_id, subject_version_id, verifier_type, verifier_version,
         environment_digest, dependency_digests, policy_version, verdict, confidence,
         metrics, payload_ref, fingerprint, security_label, expires_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.subjectVersionId,
        input.verifierType,
        input.verifierVersion,
        input.environmentDigest ?? null,
        [...(input.dependencyDigests ?? [])],
        input.policyVersion ?? null,
        input.verdict,
        input.confidence ?? null,
        json(input.metrics),
        input.payloadRef ?? null,
        input.fingerprint,
        input.securityLabel ?? "INTERNAL",
        input.expiresAt ?? null,
      ],
    );
    return requiredRow(result.rows, "evidence");
  }

  public async get(input: {
    readonly tenantId: string;
    readonly id: string;
  }): Promise<EvidenceRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM evidence WHERE tenant_id = $1 AND id = $2",
      [input.tenantId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async listBySubject(
    input: TenantProject & {
      readonly subjectVersionId: string;
    },
  ): Promise<readonly EvidenceRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM evidence
       WHERE tenant_id = $1 AND project_id = $2 AND subject_version_id = $3
       ORDER BY created_at DESC`,
      [input.tenantId, input.projectId, input.subjectVersionId],
    );
    return normalizeRows(result.rows);
  }

  public async findFresh(
    input: TenantProject & {
      readonly subjectVersionId: string;
      readonly verifierType?: string;
      readonly policyVersion?: string;
      readonly at?: string;
    },
  ): Promise<readonly EvidenceRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM evidence
       WHERE tenant_id = $1 AND project_id = $2 AND subject_version_id = $3
         AND verdict <> 'STALE'
         AND ($4::text IS NULL OR verifier_type = $4)
         AND ($5::text IS NULL OR policy_version = $5)
         AND (expires_at IS NULL OR expires_at > COALESCE($6::timestamptz, now()))
       ORDER BY created_at DESC`,
      [
        input.tenantId,
        input.projectId,
        input.subjectVersionId,
        input.verifierType ?? null,
        input.policyVersion ?? null,
        input.at ?? null,
      ],
    );
    return normalizeRows(result.rows);
  }

  public async markStale(
    input: TenantProject & {
      readonly subjectVersionId: string;
      readonly reason?: string;
    },
  ): Promise<number> {
    const result = await this.executor.query(
      `UPDATE evidence SET verdict = 'STALE',
         metrics = metrics || jsonb_build_object('staleReason', COALESCE($4, 'dependency changed'))
       WHERE tenant_id = $1 AND project_id = $2 AND subject_version_id = $3 AND verdict <> 'STALE'`,
      [input.tenantId, input.projectId, input.subjectVersionId, input.reason ?? null],
    );
    return result.rowCount ?? 0;
  }
}

export class HeadsRepository extends Repository {
  public async get(
    input: TenantProject & {
      readonly logicalId: string;
      readonly branch?: string;
    },
  ): Promise<LogicalHeadRecord | null> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM logical_heads
       WHERE tenant_id = $1 AND project_id = $2 AND logical_id = $3 AND branch = $4`,
      [input.tenantId, input.projectId, input.logicalId, input.branch ?? "main"],
    );
    return optionalRow(result.rows);
  }

  /** Returns null when the expected head no longer matches. */
  public async compareAndSwap(
    input: TenantProject & {
      readonly logicalId: string;
      readonly branch?: string;
      readonly expectedVersionId: string | null;
      readonly newVersionId: string;
      readonly updatedBy?: string;
    },
  ): Promise<LogicalHeadRecord | null> {
    if (input.expectedVersionId === null) {
      const inserted = await this.executor.query<RawRow>(
        `INSERT INTO logical_heads (
           tenant_id, project_id, logical_id, branch, output_version_id, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, project_id, logical_id, branch) DO NOTHING
         RETURNING *`,
        [
          input.tenantId,
          input.projectId,
          input.logicalId,
          input.branch ?? "main",
          input.newVersionId,
          input.updatedBy ?? null,
        ],
      );
      return optionalRow(inserted.rows);
    }
    const updated = await this.executor.query<RawRow>(
      `UPDATE logical_heads SET output_version_id = $6, generation = generation + 1,
         updated_by = $7, updated_at = now()
       WHERE tenant_id = $1 AND project_id = $2 AND logical_id = $3 AND branch = $4
         AND output_version_id = $5
       RETURNING *`,
      [
        input.tenantId,
        input.projectId,
        input.logicalId,
        input.branch ?? "main",
        input.expectedVersionId,
        input.newVersionId,
        input.updatedBy ?? null,
      ],
    );
    return optionalRow(updated.rows);
  }
}

export interface CreateLineageEdgeInput extends TenantProject {
  readonly id?: string;
  readonly sourceVersionId: string;
  readonly targetVersionId: string;
  readonly edgeType: LineageEdgeType;
  readonly selector?: { readonly kind: string; readonly value: string };
  readonly transferFunction?: string;
  readonly inferred?: boolean;
  readonly confidence?: number;
  readonly dependencyFingerprint?: string;
}

export interface ImpactNode {
  readonly versionId: string;
  readonly depth: number;
  readonly viaEdgeType: LineageEdgeType;
}

export class LineageRepository extends Repository {
  public async create(input: CreateLineageEdgeInput): Promise<LineageEdgeRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO lineage_edges (
         id, tenant_id, project_id, source_version_id, target_version_id, edge_type,
         selector, transfer_function, inferred, confidence, dependency_fingerprint
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
         $7::jsonb, $8, $9, $10, $11
       )
       ON CONFLICT (tenant_id, project_id, source_version_id, target_version_id, edge_type, selector)
       DO UPDATE SET transfer_function = EXCLUDED.transfer_function,
         inferred = EXCLUDED.inferred, confidence = EXCLUDED.confidence,
         dependency_fingerprint = EXCLUDED.dependency_fingerprint
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.sourceVersionId,
        input.targetVersionId,
        input.edgeType,
        input.selector === undefined ? null : json(input.selector),
        input.transferFunction ?? null,
        input.inferred ?? false,
        input.confidence ?? null,
        input.dependencyFingerprint ?? null,
      ],
    );
    return requiredRow(result.rows, "lineage edge");
  }

  public async listOutgoing(
    input: TenantProject & {
      readonly sourceVersionId: string;
    },
  ): Promise<readonly LineageEdgeRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM lineage_edges
       WHERE tenant_id = $1 AND project_id = $2 AND source_version_id = $3
       ORDER BY created_at, id`,
      [input.tenantId, input.projectId, input.sourceVersionId],
    );
    return normalizeRows(result.rows);
  }

  public async listIncoming(
    input: TenantProject & {
      readonly targetVersionId: string;
    },
  ): Promise<readonly LineageEdgeRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM lineage_edges
       WHERE tenant_id = $1 AND project_id = $2 AND target_version_id = $3
       ORDER BY created_at, id`,
      [input.tenantId, input.projectId, input.targetVersionId],
    );
    return normalizeRows(result.rows);
  }

  public async listDescendants(
    input: TenantProject & {
      readonly sourceVersionId: string;
      readonly maxDepth?: number;
    },
  ): Promise<readonly ImpactNode[]> {
    const maxDepth = input.maxDepth ?? 100;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 1_000) {
      throw new TypeError("maxDepth must be an integer between 1 and 1000");
    }
    const result = await this.executor.query<RawRow>(
      `WITH RECURSIVE impact(version_id, depth, via_edge_type, path) AS (
         SELECT target_version_id, 1, edge_type, ARRAY[source_version_id, target_version_id]
         FROM lineage_edges
         WHERE tenant_id = $1 AND project_id = $2 AND source_version_id = $3
         UNION ALL
         SELECT edge.target_version_id, impact.depth + 1, edge.edge_type,
           impact.path || edge.target_version_id
         FROM impact
         JOIN lineage_edges edge
           ON edge.tenant_id = $1 AND edge.project_id = $2
          AND edge.source_version_id = impact.version_id
         WHERE impact.depth < $4 AND NOT edge.target_version_id = ANY(impact.path)
       )
       SELECT version_id, min(depth)::integer AS depth,
         (array_agg(via_edge_type ORDER BY depth))[1] AS via_edge_type
       FROM impact GROUP BY version_id ORDER BY min(depth), version_id`,
      [input.tenantId, input.projectId, input.sourceVersionId, maxDepth],
    );
    return normalizeRows(result.rows);
  }
}

export interface CreateEffectIntentInput extends TenantProject {
  readonly id?: string;
  readonly sourceOutputVersionId: string;
  readonly connectorType: string;
  readonly connectorCapabilities: JsonObject;
  readonly target: string;
  readonly resourceKey: string;
  readonly argumentsRef: string;
  readonly preconditions?: JsonObject;
  readonly expectedEffects?: JsonObject;
  readonly readSet?: readonly string[];
  readonly writeSet?: readonly string[];
  readonly baseResourceVersion?: string;
  readonly idempotencyKey: string;
  readonly fencingToken?: string | number;
  readonly reversibility: "R0" | "R1" | "R2" | "R3";
  readonly compensationHandler?: string;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  readonly status?: EffectStatus;
  readonly securityLabel?: SecurityLabel;
}

export class EffectsRepository extends Repository {
  public async create(input: CreateEffectIntentInput): Promise<EffectIntentRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO effect_intents (
         id, tenant_id, project_id, source_output_version_id, connector_type,
         connector_capabilities, target,
         resource_key, arguments_ref, preconditions, expected_effects, read_set,
         write_set, base_resource_version, idempotency_key, fencing_token,
         reversibility, compensation_handler, risk_level, status, security_label
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb, $7,
         $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16,
         $17, $18, $19, $20, $21
       )
       ON CONFLICT (tenant_id, project_id, connector_type, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.sourceOutputVersionId,
        input.connectorType,
        json(input.connectorCapabilities),
        input.target,
        input.resourceKey,
        input.argumentsRef,
        json(input.preconditions),
        json(input.expectedEffects),
        [...(input.readSet ?? [])],
        [...(input.writeSet ?? [])],
        input.baseResourceVersion ?? null,
        input.idempotencyKey,
        input.fencingToken ?? null,
        input.reversibility,
        input.compensationHandler ?? null,
        input.riskLevel,
        input.status ?? "PREPARED",
        input.securityLabel ?? "INTERNAL",
      ],
    );
    if (result.rows[0] !== undefined) {
      return requiredRow(result.rows, "effect intent");
    }
    const existing = await this.findByIdempotencyKey({
      tenantId: input.tenantId,
      projectId: input.projectId,
      connectorType: input.connectorType,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing === null) {
      throw new RepositoryError("Effect intent conflict disappeared", "CONFLICT");
    }
    const sameIntent =
      existing.projectId === input.projectId &&
      existing.sourceOutputVersionId === input.sourceOutputVersionId &&
      existing.target === input.target &&
      existing.resourceKey === input.resourceKey &&
      existing.argumentsRef === input.argumentsRef &&
      existing.reversibility === input.reversibility &&
      existing.riskLevel === input.riskLevel &&
      canonicalComparable(existing.connectorCapabilities) ===
        canonicalComparable(input.connectorCapabilities) &&
      canonicalComparable([...existing.readSet].sort()) ===
        canonicalComparable([...(input.readSet ?? [])].sort()) &&
      canonicalComparable([...existing.writeSet].sort()) ===
        canonicalComparable([...(input.writeSet ?? [])].sort());
    if (!sameIntent) {
      throw new RepositoryError(
        "Effect idempotency key was already used with a different intent",
        "CONFLICT",
      );
    }
    return existing;
  }

  public async get(
    input: TenantProject & { readonly id: string },
  ): Promise<EffectIntentRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM effect_intents WHERE tenant_id = $1 AND project_id = $2 AND id = $3",
      [input.tenantId, input.projectId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async findByIdempotencyKey(
    input: TenantProject & {
      readonly connectorType: string;
      readonly idempotencyKey: string;
    },
  ): Promise<EffectIntentRecord | null> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM effect_intents
       WHERE tenant_id = $1 AND project_id = $2
         AND connector_type = $3 AND idempotency_key = $4`,
      [input.tenantId, input.projectId, input.connectorType, input.idempotencyKey],
    );
    return optionalRow(result.rows);
  }

  public async list(
    input: TenantProject & PageOptions & { readonly status?: EffectStatus },
  ): Promise<readonly EffectIntentRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM effect_intents
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR status = $3)
         AND ($4::timestamptz IS NULL OR created_at < $4 OR
           (created_at = $4 AND $5::uuid IS NOT NULL AND id < $5))
       ORDER BY created_at DESC, id DESC LIMIT $6`,
      [
        input.tenantId,
        input.projectId,
        input.status ?? null,
        input.before ?? null,
        input.beforeId ?? null,
        boundedLimit(input.limit),
      ],
    );
    return normalizeRows(result.rows);
  }

  public async updateStatus(
    input: TenantProject & {
      readonly id: string;
      readonly expectedStatus: EffectStatus | readonly EffectStatus[];
      readonly nextStatus: EffectStatus;
    },
  ): Promise<EffectIntentRecord | null> {
    const expected =
      typeof input.expectedStatus === "string" ? [input.expectedStatus] : input.expectedStatus;
    const result = await this.executor.query<RawRow>(
      `UPDATE effect_intents SET status = $5
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = ANY($4::text[])
       RETURNING *`,
      [input.tenantId, input.projectId, input.id, [...expected], input.nextStatus],
    );
    return optionalRow(result.rows);
  }

  /** Effect status CAS that also proves the resource fencing lease is current. */
  public async updateStatusWithFence(
    input: TenantProject & {
      readonly id: string;
      readonly expectedStatus: EffectStatus | readonly EffectStatus[];
      readonly nextStatus: EffectStatus;
      readonly fencingToken: string | number;
    },
  ): Promise<EffectIntentRecord | null> {
    const expected =
      typeof input.expectedStatus === "string" ? [input.expectedStatus] : input.expectedStatus;
    const result = await this.executor.query<RawRow>(
      `UPDATE effect_intents intent SET status = $5
       WHERE intent.tenant_id = $1 AND intent.project_id = $2
         AND intent.id = $3 AND intent.status = ANY($4::text[])
         AND intent.fencing_token = $6
         AND EXISTS (
           SELECT 1 FROM resource_fences fence
           WHERE fence.tenant_id = intent.tenant_id
             AND fence.project_id = intent.project_id
             AND fence.resource_key = intent.resource_key
             AND fence.fencing_token = $6
             AND fence.lease_expires_at > now()
         )
       RETURNING intent.*`,
      [
        input.tenantId,
        input.projectId,
        input.id,
        [...expected],
        input.nextStatus,
        input.fencingToken,
      ],
    );
    return optionalRow(result.rows);
  }
}

export interface AppendReceiptInput extends TenantProject {
  readonly id?: string;
  readonly intentId: string;
  readonly externalTransactionId?: string;
  readonly externalStatus: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly actualEffects?: JsonObject;
  readonly rawResponseRef?: string;
  readonly compensationStatus?: string;
  readonly committedAt?: string;
}

export class ReceiptsRepository extends Repository {
  public async append(input: AppendReceiptInput): Promise<EffectReceiptRecord> {
    const result = await this.executor.query<RawRow>(
      `WITH locked_intent AS MATERIALIZED (
         SELECT id FROM effect_intents
         WHERE tenant_id = $2 AND project_id = $3 AND id = $4 FOR UPDATE
       ), next_sequence AS (
         SELECT COALESCE(max(sequence), 0) + 1 AS value
         FROM effect_receipts WHERE tenant_id = $2 AND project_id = $3 AND intent_id = $4
           AND EXISTS (SELECT 1 FROM locked_intent)
       )
       INSERT INTO effect_receipts (
         id, tenant_id, project_id, intent_id, sequence, external_transaction_id,
         external_status, before_digest, after_digest, actual_effects,
         raw_response_ref, compensation_status, committed_at
       ) SELECT
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, next_sequence.value, $5,
         $6, $7, $8, $9::jsonb, $10, $11, $12
       FROM next_sequence
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.intentId,
        input.externalTransactionId ?? null,
        input.externalStatus,
        input.beforeDigest ?? null,
        input.afterDigest ?? null,
        json(input.actualEffects),
        input.rawResponseRef ?? null,
        input.compensationStatus ?? null,
        input.committedAt ?? null,
      ],
    );
    return requiredRow(result.rows, "effect receipt");
  }

  public async listByIntent(
    input: TenantProject & { readonly intentId: string },
  ): Promise<readonly EffectReceiptRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM effect_receipts
       WHERE tenant_id = $1 AND project_id = $2 AND intent_id = $3 ORDER BY sequence`,
      [input.tenantId, input.projectId, input.intentId],
    );
    return normalizeRows(result.rows);
  }
}

export class ResourceFencesRepository extends Repository {
  public async acquire(
    input: TenantProject & {
      readonly resourceKey: string;
      readonly leaseOwner: string;
      readonly leaseSeconds?: number;
    },
  ): Promise<{ readonly fencingToken: string; readonly leaseExpiresAt: string }> {
    const leaseSeconds = input.leaseSeconds ?? 30;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
      throw new TypeError("leaseSeconds must be an integer between 1 and 3600");
    }
    const result = await this.executor.query<RawRow>(
      `INSERT INTO resource_fences (
         tenant_id, project_id, resource_key, fencing_token, lease_owner, lease_expires_at
       ) VALUES ($1, $2, $3, 1, $4, now() + make_interval(secs => $5))
       ON CONFLICT (tenant_id, project_id, resource_key) DO UPDATE SET
         fencing_token = resource_fences.fencing_token + 1,
         lease_owner = EXCLUDED.lease_owner,
         lease_expires_at = EXCLUDED.lease_expires_at,
         updated_at = now()
       RETURNING fencing_token, lease_expires_at`,
      [input.tenantId, input.projectId, input.resourceKey, input.leaseOwner, leaseSeconds],
    );
    return requiredRow(result.rows, "resource fence");
  }

  public async isCurrent(
    input: TenantProject & {
      readonly resourceKey: string;
      readonly fencingToken: string | number;
      readonly leaseOwner?: string;
    },
  ): Promise<boolean> {
    const result = await this.executor.query<{ current: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM resource_fences
         WHERE tenant_id = $1 AND project_id = $2
           AND resource_key = $3 AND fencing_token = $4
           AND lease_expires_at > now() AND ($5::text IS NULL OR lease_owner = $5)
       ) AS current`,
      [
        input.tenantId,
        input.projectId,
        input.resourceKey,
        input.fencingToken,
        input.leaseOwner ?? null,
      ],
    );
    return result.rows[0]?.current === true;
  }
}

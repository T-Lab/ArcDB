import type {
  JsonObject,
  PageOptions,
  RunRecord,
  RunStatus,
  ScoreRecord,
  SessionRecord,
  SpanKind,
  SpanRecord,
  SpanStatus,
  TraceRecord,
  TraceStatus,
} from "../types.js";
import {
  boundedLimit,
  json,
  normalizeRows,
  optionalRow,
  type RawRow,
  Repository,
  requiredRow,
} from "./helpers.js";

interface TenantProject {
  readonly tenantId: string;
  readonly projectId: string;
}

export interface CreateSessionInput extends TenantProject {
  readonly id?: string;
  readonly externalId?: string;
  readonly name?: string;
  readonly userId?: string;
  readonly metadata?: JsonObject;
}

export class SessionsRepository extends Repository {
  public async create(input: CreateSessionInput): Promise<SessionRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO sessions (id, tenant_id, project_id, external_id, name, user_id, metadata)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (tenant_id, project_id, external_id)
       DO UPDATE SET name = EXCLUDED.name, user_id = EXCLUDED.user_id,
         metadata = sessions.metadata || EXCLUDED.metadata
       RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.externalId ?? null,
        input.name ?? null,
        input.userId ?? null,
        json(input.metadata),
      ],
    );
    return requiredRow(result.rows, "session");
  }

  public async get(input: TenantProject & { readonly id: string }): Promise<SessionRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM sessions WHERE tenant_id = $1 AND project_id = $2 AND id = $3",
      [input.tenantId, input.projectId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async list(input: TenantProject & PageOptions): Promise<readonly SessionRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM sessions
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::timestamptz IS NULL OR updated_at < $3)
       ORDER BY updated_at DESC, id DESC LIMIT $4`,
      [input.tenantId, input.projectId, input.before ?? null, boundedLimit(input.limit)],
    );
    return normalizeRows(result.rows);
  }
}

export interface CreateRunInput extends TenantProject {
  readonly id?: string;
  readonly sessionId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly status?: RunStatus;
  readonly environment?: string;
  readonly agentId?: string;
  readonly input?: unknown;
  readonly metadata?: JsonObject;
  readonly startedAt?: string;
}

export class RunsRepository extends Repository {
  public async create(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO runs (
         id, tenant_id, project_id, session_id, external_id, name, status,
         environment, agent_id, input, metadata, started_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10::jsonb, $11::jsonb, COALESCE($12::timestamptz, now())
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.sessionId ?? null,
        input.externalId ?? null,
        input.name,
        input.status ?? "RUNNING",
        input.environment ?? null,
        input.agentId ?? null,
        input.input === undefined ? null : json(input.input),
        json(input.metadata),
        input.startedAt ?? null,
      ],
    );
    return requiredRow(result.rows, "run");
  }

  public async get(input: TenantProject & { readonly id: string }): Promise<RunRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM runs WHERE tenant_id = $1 AND project_id = $2 AND id = $3",
      [input.tenantId, input.projectId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async list(
    input: TenantProject &
      PageOptions & { readonly status?: RunStatus; readonly sessionId?: string },
  ): Promise<readonly RunRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM runs
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR status = $3)
         AND ($4::uuid IS NULL OR session_id = $4)
         AND ($5::timestamptz IS NULL OR started_at < $5 OR
           (started_at = $5 AND $6::uuid IS NOT NULL AND id < $6))
       ORDER BY started_at DESC, id DESC LIMIT $7`,
      [
        input.tenantId,
        input.projectId,
        input.status ?? null,
        input.sessionId ?? null,
        input.before ?? null,
        input.beforeId ?? null,
        boundedLimit(input.limit),
      ],
    );
    return normalizeRows(result.rows);
  }

  public async updateStatus(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly id: string;
    readonly status: RunStatus;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly endedAt?: string;
  }): Promise<RunRecord | null> {
    const result = await this.executor.query<RawRow>(
      `UPDATE runs SET status = $4,
         output = CASE WHEN $5::boolean THEN $6::jsonb ELSE output END,
         error = CASE WHEN $7::boolean THEN $8::jsonb ELSE error END,
         ended_at = CASE
           WHEN $4 IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN COALESCE($9::timestamptz, now())
           ELSE ended_at
         END
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [
        input.tenantId,
        input.projectId,
        input.id,
        input.status,
        input.output !== undefined,
        input.output === undefined ? null : json(input.output),
        input.error !== undefined,
        input.error === undefined ? null : json(input.error),
        input.endedAt ?? null,
      ],
    );
    return optionalRow(result.rows);
  }
}

export interface CreateTraceInput extends TenantProject {
  readonly id?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly status?: TraceStatus;
  readonly input?: unknown;
  readonly metadata?: JsonObject;
  readonly startedAt?: string;
}

export class TracesRepository extends Repository {
  public async create(input: CreateTraceInput): Promise<TraceRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO traces (
         id, tenant_id, project_id, run_id, session_id, external_id, name,
         status, input, metadata, started_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9::jsonb, $10::jsonb, COALESCE($11::timestamptz, now())
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.runId ?? null,
        input.sessionId ?? null,
        input.externalId ?? null,
        input.name,
        input.status ?? "RUNNING",
        input.input === undefined ? null : json(input.input),
        json(input.metadata),
        input.startedAt ?? null,
      ],
    );
    return requiredRow(result.rows, "trace");
  }

  public async get(input: TenantProject & { readonly id: string }): Promise<TraceRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM traces WHERE tenant_id = $1 AND project_id = $2 AND id = $3",
      [input.tenantId, input.projectId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async list(
    input: TenantProject & PageOptions & { readonly status?: TraceStatus; readonly runId?: string },
  ): Promise<readonly TraceRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM traces
       WHERE tenant_id = $1 AND project_id = $2
         AND ($3::text IS NULL OR status = $3)
         AND ($4::uuid IS NULL OR run_id = $4)
         AND ($5::timestamptz IS NULL OR started_at < $5 OR
           (started_at = $5 AND $6::uuid IS NOT NULL AND id < $6))
       ORDER BY started_at DESC, id DESC LIMIT $7`,
      [
        input.tenantId,
        input.projectId,
        input.status ?? null,
        input.runId ?? null,
        input.before ?? null,
        input.beforeId ?? null,
        boundedLimit(input.limit),
      ],
    );
    return normalizeRows(result.rows);
  }

  public async updateStatus(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly id: string;
    readonly status: TraceStatus;
    readonly output?: unknown;
    readonly endedAt?: string;
  }): Promise<TraceRecord | null> {
    const result = await this.executor.query<RawRow>(
      `UPDATE traces SET status = $4,
         output = CASE WHEN $5::boolean THEN $6::jsonb ELSE output END,
         ended_at = CASE
           WHEN $4 IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN COALESCE($7::timestamptz, now())
           ELSE ended_at
         END
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [
        input.tenantId,
        input.projectId,
        input.id,
        input.status,
        input.output !== undefined,
        input.output === undefined ? null : json(input.output),
        input.endedAt ?? null,
      ],
    );
    return optionalRow(result.rows);
  }
}

export interface CreateSpanInput extends TenantProject {
  readonly id?: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly externalId?: string;
  readonly kind?: SpanKind;
  readonly name: string;
  readonly status?: SpanStatus;
  readonly model?: string;
  readonly input?: unknown;
  readonly metadata?: JsonObject;
  readonly usage?: JsonObject;
  readonly startedAt?: string;
}

export class SpansRepository extends Repository {
  public async create(input: CreateSpanInput): Promise<SpanRecord> {
    const result = await this.executor.query<RawRow>(
      `INSERT INTO spans (
         id, tenant_id, project_id, trace_id, parent_span_id, external_id, kind,
         name, status, model, input, metadata, usage, started_at
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, COALESCE($14::timestamptz, now())
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.traceId,
        input.parentSpanId ?? null,
        input.externalId ?? null,
        input.kind ?? "SPAN",
        input.name,
        input.status ?? "UNSET",
        input.model ?? null,
        input.input === undefined ? null : json(input.input),
        json(input.metadata),
        json(input.usage),
        input.startedAt ?? null,
      ],
    );
    return requiredRow(result.rows, "span");
  }

  public async get(input: TenantProject & { readonly id: string }): Promise<SpanRecord | null> {
    const result = await this.executor.query<RawRow>(
      "SELECT * FROM spans WHERE tenant_id = $1 AND project_id = $2 AND id = $3",
      [input.tenantId, input.projectId, input.id],
    );
    return optionalRow(result.rows);
  }

  public async listByTrace(
    input: TenantProject & { readonly traceId: string },
  ): Promise<readonly SpanRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM spans
       WHERE tenant_id = $1 AND project_id = $2 AND trace_id = $3
       ORDER BY started_at, id`,
      [input.tenantId, input.projectId, input.traceId],
    );
    return normalizeRows(result.rows);
  }

  public async updateStatus(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly id: string;
    readonly status: SpanStatus;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly usage?: JsonObject;
    readonly endedAt?: string;
  }): Promise<SpanRecord | null> {
    const result = await this.executor.query<RawRow>(
      `UPDATE spans SET status = $4,
         output = CASE WHEN $5::boolean THEN $6::jsonb ELSE output END,
         error = CASE WHEN $7::boolean THEN $8::jsonb ELSE error END,
         usage = CASE WHEN $9::boolean THEN $10::jsonb ELSE usage END,
         ended_at = CASE WHEN $4 <> 'RUNNING' THEN COALESCE($11::timestamptz, now()) ELSE ended_at END
       WHERE tenant_id = $1 AND project_id = $2 AND id = $3 RETURNING *`,
      [
        input.tenantId,
        input.projectId,
        input.id,
        input.status,
        input.output !== undefined,
        input.output === undefined ? null : json(input.output),
        input.error !== undefined,
        input.error === undefined ? null : json(input.error),
        input.usage !== undefined,
        json(input.usage),
        input.endedAt ?? null,
      ],
    );
    return optionalRow(result.rows);
  }
}

export interface CreateScoreInput extends TenantProject {
  readonly id?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly runId?: string;
  readonly name: string;
  readonly value: number | boolean | string;
  readonly comment?: string;
  readonly source?: "API" | "EVALUATOR" | "HUMAN";
  readonly metadata?: JsonObject;
}

export class ScoresRepository extends Repository {
  public async create(input: CreateScoreInput): Promise<ScoreRecord> {
    const dataType =
      typeof input.value === "number"
        ? "NUMERIC"
        : typeof input.value === "boolean"
          ? "BOOLEAN"
          : "CATEGORICAL";
    const result = await this.executor.query<RawRow>(
      `INSERT INTO scores (
         id, tenant_id, project_id, trace_id, span_id, run_id, name, data_type,
         numeric_value, string_value, comment, source, metadata
       ) VALUES (
         COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13::jsonb
       ) RETURNING *`,
      [
        input.id ?? null,
        input.tenantId,
        input.projectId,
        input.traceId ?? null,
        input.spanId ?? null,
        input.runId ?? null,
        input.name,
        dataType,
        typeof input.value === "number" ? input.value : null,
        typeof input.value === "number" ? null : String(input.value),
        input.comment ?? null,
        input.source ?? "API",
        json(input.metadata),
      ],
    );
    return requiredRow(result.rows, "score");
  }

  public async listByTrace(
    input: TenantProject & { readonly traceId: string },
  ): Promise<readonly ScoreRecord[]> {
    const result = await this.executor.query<RawRow>(
      `SELECT * FROM scores
       WHERE tenant_id = $1 AND project_id = $2 AND trace_id = $3
       ORDER BY created_at DESC, id DESC`,
      [input.tenantId, input.projectId, input.traceId],
    );
    return normalizeRows(result.rows);
  }
}

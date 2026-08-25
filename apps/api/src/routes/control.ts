import { assertKnownPermissions, generateApiKey, hashApiKey, ROLE_PERMISSIONS } from "@arcdb/auth";
import { ApiKeyCreateSchema, PaginationQuerySchema } from "@arcdb/contracts";
import type { Database } from "@arcdb/db";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePermission, requireProject } from "../auth.js";
import { appendAuditEvent } from "../events.js";
import { ApiHttpError } from "../http-error.js";
import { decodeCursor, encodeCursor } from "../pagination.js";

type ProjectRow = {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  retention_days: number | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type ApiKeyRow = {
  id: string;
  project_id: string | null;
  name: string;
  prefix: string;
  last_four: string;
  permissions: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

type AuditRow = {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  event_hash: string;
  created_at: Date;
};

type DashboardAggregateRow = {
  runs_24h: string;
  traces_24h: string;
  outputs_total: string;
  verified_outputs: string;
  stale_outputs: string;
  open_effects: string;
  reconciliation_required: string;
  open_remediations: string;
};

type DashboardTraceRow = {
  id: string;
  name: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  duration_ms: string | null;
  span_count: string;
  output_count: string;
  agent_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
};

type DashboardOutputRow = {
  id: string;
  logical_id: string;
  version_id: string;
  output_type: string;
  lifecycle_state: string;
  content_ref: string;
  content_digest: string;
  producer_run_id: string | null;
  producer_agent_id: string | null;
  policy_version: string | null;
  parent_version_ids: string[];
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type DashboardActivityRow = {
  label: string;
  value: string;
};

const DASHBOARD_RECENT_LIMIT = 8;

const AuditQuerySchema = PaginationQuerySchema.extend({
  query: z.string().trim().min(1).max(256).optional(),
  actor: z.string().trim().min(1).max(256).optional(),
  action: z.string().trim().min(1).max(256).optional(),
  from: z.iso.datetime().optional(),
});

function projectJson(row: ProjectRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    slug: row.slug,
    retentionDays: row.retention_days,
    settings: row.settings,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function apiKeyJson(row: ApiKeyRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    lastFour: row.last_four,
    permissions: row.permissions,
    expiresAt: row.expires_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function registerControlRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get("/v1/projects", async (request) => {
    requirePermission(request, "project:read");
    const tenantId = request.principal.tenantId;
    // Organization-scoped keys may list projects without selecting one first,
    // so this narrow control-plane lookup cannot use project-mandatory RLS.
    const rows = await database.withSystem(
      async (executor) => {
        const values: unknown[] = [tenantId];
        let projectFilter = "";
        if (request.projectId !== undefined) {
          values.push(request.projectId);
          projectFilter = "AND id = $2";
        }
        return (
          await executor.query<ProjectRow>(
            `SELECT id, tenant_id, name, slug, retention_days, settings, created_at, updated_at
               FROM projects
              WHERE tenant_id = $1 ${projectFilter}
              ORDER BY name, id`,
            values,
          )
        ).rows;
      },
      { readOnly: true },
    );
    return { data: rows.map(projectJson), requestId: request.id };
  });

  api.get("/v1/dashboard", async (request) => {
    requirePermission(request, "project:read");
    const projectId = requireProject(request);
    const tenantId = request.principal.tenantId;
    const data = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const aggregateResult = await executor.query<DashboardAggregateRow>(
          `SELECT
             (SELECT count(*) FROM runs WHERE tenant_id = $1 AND project_id = $2 AND started_at >= now() - interval '24 hours') AS runs_24h,
             (SELECT count(*) FROM traces WHERE tenant_id = $1 AND project_id = $2 AND started_at >= now() - interval '24 hours') AS traces_24h,
             (SELECT count(*) FROM outputs WHERE tenant_id = $1 AND project_id = $2) AS outputs_total,
             (SELECT count(*) FROM outputs
               WHERE tenant_id = $1 AND project_id = $2
                 AND lifecycle_state IN ('VERIFIED', 'APPROVED', 'COMMITTED', 'CONSUMED', 'PROMOTED')) AS verified_outputs,
             (SELECT count(*) FROM outputs WHERE tenant_id = $1 AND project_id = $2 AND lifecycle_state IN ('STALE', 'INVALIDATED')) AS stale_outputs,
             (SELECT count(*) FROM effect_intents WHERE tenant_id = $1 AND project_id = $2 AND status IN ('PREPARED', 'EXECUTING')) AS open_effects,
             (SELECT count(*) FROM effect_intents WHERE tenant_id = $1 AND project_id = $2 AND status = 'RECONCILIATION_REQUIRED') AS reconciliation_required,
             (SELECT count(*) FROM remediation_obligations WHERE tenant_id = $1 AND project_id = $2 AND status IN ('OPEN', 'PENDING_APPROVAL', 'IN_PROGRESS')) AS open_remediations`,
          [tenantId, projectId],
        );
        const row = aggregateResult.rows[0];
        if (row === undefined) throw new Error("Dashboard aggregation returned no row");

        const recentTraceResult = await executor.query<DashboardTraceRow>(
          `SELECT trace.id, trace.name, trace.status, trace.started_at, trace.ended_at,
                  CASE
                    WHEN trace.ended_at IS NULL THEN NULL
                    ELSE floor(extract(epoch FROM (trace.ended_at - trace.started_at)) * 1000)::bigint
                  END AS duration_ms,
                  (SELECT count(*) FROM spans
                    WHERE tenant_id = $1 AND project_id = $2 AND trace_id = trace.id) AS span_count,
                  (SELECT count(*) FROM outputs
                    WHERE tenant_id = $1 AND project_id = $2
                      AND producer_run_id = trace.run_id) AS output_count,
                  run.agent_id, trace.session_id, trace.metadata
             FROM traces trace
             LEFT JOIN runs run
               ON run.tenant_id = trace.tenant_id
              AND run.project_id = trace.project_id
              AND run.id = trace.run_id
            WHERE trace.tenant_id = $1 AND trace.project_id = $2
            ORDER BY trace.started_at DESC, trace.id DESC
            LIMIT ${DASHBOARD_RECENT_LIMIT}`,
          [tenantId, projectId],
        );

        const recentOutputResult = await executor.query<DashboardOutputRow>(
          `SELECT id, logical_id, version_id, output_type, lifecycle_state, content_ref,
                  content_digest, producer_run_id, producer_agent_id, policy_version,
                  parent_version_ids, metadata, created_at, updated_at
             FROM outputs
            WHERE tenant_id = $1 AND project_id = $2
            ORDER BY created_at DESC, id DESC
            LIMIT ${DASHBOARD_RECENT_LIMIT}`,
          [tenantId, projectId],
        );

        const activityResult = await executor.query<DashboardActivityRow>(
          `WITH buckets AS (
             SELECT generate_series(
               date_trunc('day', now() AT TIME ZONE 'UTC') - interval '6 days',
               date_trunc('day', now() AT TIME ZONE 'UTC'),
               interval '1 day'
             ) AS bucket_start
           )
           SELECT to_char(bucket.bucket_start, 'YYYY-MM-DD') AS label,
                  count(trace.id) AS value
             FROM buckets bucket
             LEFT JOIN traces trace
               ON trace.tenant_id = $1
              AND trace.project_id = $2
              AND trace.started_at >= bucket.bucket_start AT TIME ZONE 'UTC'
              AND trace.started_at < (bucket.bucket_start + interval '1 day') AT TIME ZONE 'UTC'
            GROUP BY bucket.bucket_start
            ORDER BY bucket.bucket_start ASC`,
          [tenantId, projectId],
        );

        return {
          runs24h: Number(row.runs_24h),
          traces24h: Number(row.traces_24h),
          outputsTotal: Number(row.outputs_total),
          verifiedOutputs: Number(row.verified_outputs),
          staleOutputs: Number(row.stale_outputs),
          openEffects: Number(row.open_effects),
          reconciliationRequired: Number(row.reconciliation_required),
          openRemediations: Number(row.open_remediations),
          recentTraces: recentTraceResult.rows.slice(0, DASHBOARD_RECENT_LIMIT).map((trace) => ({
            id: trace.id,
            name: trace.name,
            status: trace.status,
            startedAt: trace.started_at.toISOString(),
            endedAt: trace.ended_at?.toISOString() ?? null,
            durationMs: trace.duration_ms === null ? null : Number(trace.duration_ms),
            spanCount: Number(trace.span_count),
            outputCount: Number(trace.output_count),
            agentId: trace.agent_id,
            sessionId: trace.session_id,
            metadata: trace.metadata,
          })),
          recentOutputs: recentOutputResult.rows.slice(0, DASHBOARD_RECENT_LIMIT).map((output) => ({
            id: output.id,
            logicalId: output.logical_id,
            versionId: output.version_id,
            outputType: output.output_type,
            lifecycleState: output.lifecycle_state,
            contentRef: output.content_ref,
            contentDigest: output.content_digest,
            producerRunId: output.producer_run_id,
            producerAgentId: output.producer_agent_id,
            policyVersion: output.policy_version,
            parentVersionIds: output.parent_version_ids,
            metadata: output.metadata,
            createdAt: output.created_at.toISOString(),
            updatedAt: output.updated_at.toISOString(),
          })),
          activity: activityResult.rows.map((activity) => ({
            label: activity.label,
            value: Number(activity.value),
          })),
        };
      },
      { readOnly: true },
    );
    return { data, requestId: request.id };
  });

  api.get("/v1/api-keys", async (request) => {
    requirePermission(request, "api_key:manage");
    const projectId = requireProject(request);
    const tenantId = request.principal.tenantId;
    const rows = await database.withTenant(
      tenantId,
      projectId,
      async (executor) =>
        (
          await executor.query<ApiKeyRow>(
            `SELECT id, project_id, name, prefix, last_four, permissions, expires_at,
                    last_used_at, revoked_at, created_at
               FROM api_keys
              WHERE tenant_id = $1 AND project_id = $2
              ORDER BY created_at DESC`,
            [tenantId, projectId],
          )
        ).rows,
      { readOnly: true },
    );
    return { data: rows.map(apiKeyJson), requestId: request.id };
  });

  api.post("/v1/api-keys", { schema: { body: ApiKeyCreateSchema } }, async (request, reply) => {
    requirePermission(request, "api_key:manage");
    const projectId = requireProject(request);
    const tenantId = request.principal.tenantId;
    const requested = request.body.scopes;
    assertKnownPermissions(requested);
    const rolePermissions = new Set<string>(ROLE_PERMISSIONS[request.body.role]);
    const unauthorized = requested.find((permission) => !rolePermissions.has(permission));
    if (unauthorized !== undefined) {
      throw new ApiHttpError(
        "FORBIDDEN",
        403,
        `Role ${request.body.role} cannot grant ${unauthorized}`,
      );
    }
    const callerPermissions = new Set(request.principal.permissions);
    const escalated = requested.find((permission) => !callerPermissions.has(permission));
    if (escalated !== undefined) {
      throw new ApiHttpError("FORBIDDEN", 403, `The current API key cannot grant ${escalated}`);
    }
    const generated = generateApiKey();
    const keyHash = await hashApiKey(generated.plaintext);
    const row = await database.withTenant(tenantId, projectId, async (executor) => {
      const result = await executor.query<ApiKeyRow>(
        `INSERT INTO api_keys
             (tenant_id, project_id, name, prefix, key_hash, last_four, permissions, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, project_id, name, prefix, last_four, permissions, expires_at,
                     last_used_at, revoked_at, created_at`,
        [
          tenantId,
          projectId,
          request.body.name,
          generated.prefix,
          keyHash,
          generated.lastFour,
          requested,
          request.body.expiresAt ?? null,
        ],
      );
      const created = result.rows[0];
      if (created === undefined) throw new Error("API key insert returned no row");
      await appendAuditEvent(executor, {
        tenantId,
        projectId,
        actorType: "API_KEY",
        actorId: request.principal.subjectId,
        action: "api_key.created",
        resourceType: "api_key",
        resourceId: created.id,
        requestId: request.id,
        metadata: { name: request.body.name, permissions: requested },
      });
      return created;
    });
    return reply.status(201).send({
      data: { ...apiKeyJson(row), plaintext: generated.plaintext },
      requestId: request.id,
    });
  });

  api.delete(
    "/v1/api-keys/:id",
    { schema: { params: z.object({ id: z.uuid() }).strict() } },
    async (request, reply) => {
      requirePermission(request, "api_key:manage");
      const projectId = requireProject(request);
      const tenantId = request.principal.tenantId;
      if (request.params.id === request.principal.subjectId) {
        throw new ApiHttpError("FORBIDDEN", 403, "An API key cannot revoke itself");
      }
      const revoked = await database.withTenant(tenantId, projectId, async (executor) => {
        const result = await executor.query<{ id: string }>(
          `UPDATE api_keys SET revoked_at = now()
            WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND revoked_at IS NULL
          RETURNING id`,
          [tenantId, projectId, request.params.id],
        );
        const row = result.rows[0];
        if (row !== undefined) {
          await appendAuditEvent(executor, {
            tenantId,
            projectId,
            actorType: "API_KEY",
            actorId: request.principal.subjectId,
            action: "api_key.revoked",
            resourceType: "api_key",
            resourceId: row.id,
            requestId: request.id,
            metadata: {},
          });
        }
        return row;
      });
      if (revoked === undefined) throw new ApiHttpError("NOT_FOUND", 404, "API key not found");
      return reply.status(204).send();
    },
  );

  api.get("/v1/audit-events", { schema: { querystring: AuditQuerySchema } }, async (request) => {
    requirePermission(request, "audit:read");
    const projectId = requireProject(request);
    const tenantId = request.principal.tenantId;
    const cursor = decodeCursor(request.query.cursor);
    const rows = await database.withTenant(
      tenantId,
      projectId,
      async (executor) =>
        (
          await executor.query<AuditRow>(
            `SELECT id, actor_type, actor_id, action, resource_type, resource_id,
                      request_id, metadata, event_hash, created_at
                 FROM audit_events
                WHERE tenant_id = $1 AND project_id = $2
                  AND ($3::timestamptz IS NULL OR created_at >= $3)
                  AND ($4::text IS NULL OR actor_type = $4 OR actor_id = $4)
                  AND ($5::text IS NULL OR action ILIKE '%' || $5 || '%')
                  AND ($6::text IS NULL OR action ILIKE '%' || $6 || '%'
                    OR resource_type ILIKE '%' || $6 || '%'
                    OR resource_id ILIKE '%' || $6 || '%'
                    OR metadata::text ILIKE '%' || $6 || '%')
                  AND ($7::timestamptz IS NULL OR
                    (created_at, id) < ($7::timestamptz, $8::uuid))
                ORDER BY created_at DESC, id DESC
                LIMIT $9`,
            [
              tenantId,
              projectId,
              request.query.from ?? null,
              request.query.actor ?? null,
              request.query.action ?? null,
              request.query.query ?? null,
              cursor?.createdAt ?? null,
              cursor?.id ?? null,
              request.query.limit + 1,
            ],
          )
        ).rows,
      { readOnly: true },
    );
    const hasMore = rows.length > request.query.limit;
    const selected = rows.slice(0, request.query.limit);
    const last = selected.at(-1);
    return {
      data: selected.map((row) => ({
        id: row.id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        requestId: row.request_id,
        metadata: row.metadata,
        eventHash: row.event_hash,
        createdAt: row.created_at.toISOString(),
      })),
      page: {
        hasMore,
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
            : null,
      },
      requestId: request.id,
    };
  });
}

import { canonicalDigest } from "@arcdb/contracts";
import type { SqlExecutor } from "@arcdb/db";

export async function appendAuditEvent(
  executor: SqlExecutor,
  input: {
    readonly tenantId: string;
    readonly projectId?: string;
    readonly actorType: "USER" | "API_KEY" | "WORKER" | "SYSTEM";
    readonly actorId?: string;
    readonly action: string;
    readonly resourceType: string;
    readonly resourceId?: string;
    readonly requestId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `arcdb:audit:${input.tenantId}`,
  ]);
  const previous = (
    await executor.query<{ event_hash: string }>(
      "SELECT event_hash FROM audit_events WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
      [input.tenantId],
    )
  ).rows[0]?.event_hash;
  const metadata = { ...(input.metadata ?? {}) };
  const eventHash = canonicalDigest(
    {
      previousHash: previous ?? null,
      tenantId: input.tenantId,
      projectId: input.projectId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      metadata,
    },
    "audit-event",
  );
  await executor.query(
    `INSERT INTO audit_events
       (tenant_id, project_id, actor_type, actor_id, action, resource_type,
        resource_id, request_id, metadata, previous_hash, event_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
    [
      input.tenantId,
      input.projectId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.requestId ?? null,
      JSON.stringify(metadata),
      previous ?? null,
      eventHash,
    ],
  );
}

export async function appendLifecycleEvent(
  executor: SqlExecutor,
  input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventType: string;
    readonly actorType: "USER" | "API_KEY" | "WORKER" | "SYSTEM";
    readonly actorId?: string;
    readonly requestId?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `arcdb:lifecycle:${input.tenantId}:${input.aggregateType}:${input.aggregateId}`,
  ]);
  await executor.query(
    `INSERT INTO lifecycle_events
       (tenant_id, project_id, aggregate_type, aggregate_id, event_type, sequence,
        actor_type, actor_id, request_id, payload)
     SELECT $1, $2, $3, $4, $5,
            COALESCE(max(sequence), 0) + 1, $6, $7, $8, $9::jsonb
       FROM lifecycle_events
      WHERE tenant_id = $1 AND aggregate_type = $3 AND aggregate_id = $4`,
    [
      input.tenantId,
      input.projectId,
      input.aggregateType,
      input.aggregateId,
      input.eventType,
      input.actorType,
      input.actorId ?? null,
      input.requestId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

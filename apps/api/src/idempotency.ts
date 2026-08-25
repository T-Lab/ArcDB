import { canonicalDigest } from "@arcdb/contracts";
import type { Database, SqlExecutor } from "@arcdb/db";
import type { FastifyRequest } from "fastify";
import { ApiHttpError } from "./http-error.js";

type IdempotencyRow = {
  method: string;
  path: string;
  request_hash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
};

export type MutationResult<T> = {
  readonly status: number;
  readonly data: T;
  readonly replayed: boolean;
};

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers["idempotency-key"];
  if (Array.isArray(value)) {
    throw new ApiHttpError("INVALID_REQUEST", 400, "Only one Idempotency-Key is allowed");
  }
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 512) {
    throw new ApiHttpError(
      "INVALID_REQUEST",
      400,
      "Idempotency-Key must contain between 8 and 512 characters",
    );
  }
  return normalized;
}

function routePath(request: FastifyRequest): string {
  const pathname = request.url.split("?", 1)[0] ?? "/unknown";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

async function runOperation<T>(
  executor: SqlExecutor,
  operation: (executor: SqlExecutor) => Promise<{ readonly status: number; readonly data: T }>,
): Promise<MutationResult<T>> {
  const result = await operation(executor);
  return { ...result, replayed: false };
}

/**
 * Executes a mutation and persists its response in the same tenant transaction. A rolled-back
 * operation cannot leave a completed idempotency record, and a replay with a different request body
 * is rejected.
 */
export async function idempotentMutation<T>(
  database: Database,
  request: FastifyRequest,
  body: unknown,
  operation: (executor: SqlExecutor) => Promise<{ readonly status: number; readonly data: T }>,
): Promise<MutationResult<T>> {
  const key = idempotencyKey(request);
  const tenantId = request.principal.tenantId;
  const projectId = request.projectId;
  if (projectId === undefined) {
    throw new ApiHttpError("INVALID_REQUEST", 400, "A project is required for this mutation");
  }

  return database.withTenant(tenantId, projectId, async (executor) => {
    if (key === undefined) return runOperation(executor, operation);

    const method = request.method.toUpperCase();
    const path = routePath(request);
    const requestHash = canonicalDigest({ body, method, path }, "http-idempotency");
    const inserted = await executor.query<{ id: string }>(
      `INSERT INTO idempotency_records
         (tenant_id, project_id, idempotency_key, method, path, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '24 hours')
       ON CONFLICT (tenant_id, project_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [tenantId, projectId, key, method, path, requestHash],
    );

    if (inserted.rows[0] === undefined) {
      const existing = (
        await executor.query<IdempotencyRow>(
          `SELECT method, path, request_hash, state, response_status, response_body
             FROM idempotency_records
            WHERE tenant_id = $1 AND project_id = $2 AND idempotency_key = $3
            FOR UPDATE`,
          [tenantId, projectId, key],
        )
      ).rows[0];
      if (existing === undefined) {
        throw new ApiHttpError("INTERNAL_ERROR", 500, "Idempotency record disappeared");
      }
      if (
        existing.method !== method ||
        existing.path !== path ||
        existing.request_hash !== requestHash
      ) {
        throw new ApiHttpError(
          "INVALID_REQUEST",
          409,
          "Idempotency-Key was already used for a different request",
          { details: { idempotencyKey: key } },
        );
      }
      if (existing.state !== "COMPLETED" || existing.response_status === null) {
        throw new ApiHttpError(
          "INVALID_REQUEST",
          409,
          "An operation with this Idempotency-Key is still in progress",
          { retryable: true, details: { idempotencyKey: key } },
        );
      }
      return {
        status: existing.response_status,
        data: existing.response_body as T,
        replayed: true,
      };
    }

    const result = await runOperation(executor, operation);
    await executor.query(
      `UPDATE idempotency_records
          SET state = 'COMPLETED', response_status = $4, response_body = $5::jsonb,
              updated_at = now()
        WHERE tenant_id = $1 AND project_id = $2 AND idempotency_key = $3`,
      [tenantId, projectId, key, result.status, JSON.stringify(result.data)],
    );
    return result;
  });
}

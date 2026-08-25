import {
  CreateRunSchema,
  CreateScoreSchema,
  CreateSpanSchema,
  CreateTraceSchema,
  IngestionBatchSchema,
  PaginationQuerySchema,
} from "@arcdb/contracts";
import {
  createRepositories,
  type Database,
  DatabaseError,
  normalizeRows,
  type RawRow,
  type SqlExecutor,
  type TraceRecord,
} from "@arcdb/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requirePermission, requireProject } from "../auth.js";
import { ApiHttpError } from "../http-error.js";
import { idempotentMutation } from "../idempotency.js";
import { decodeCursor, encodeCursor } from "../pagination.js";

const TraceListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
  runId: z.uuid().optional(),
  type: z.enum(["SPAN", "GENERATION", "TOOL_CALL", "EVENT", "EVALUATOR", "AGENT"]).optional(),
  query: z.string().trim().min(1).max(256).optional(),
  from: z.iso.datetime().optional(),
});

const RunListQuerySchema = PaginationQuerySchema.extend({
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).optional(),
  sessionId: z.uuid().optional(),
});

const IdParamsSchema = z.object({ id: z.uuid() }).strict();
const TraceIdParamsSchema = z.object({ traceId: z.uuid() }).strict();

function mutationHeaders(
  reply: { header(name: string, value: string): unknown },
  replayed: boolean,
): void {
  if (replayed) reply.header("Idempotency-Replayed", "true");
}

function rethrowProjectReferenceError(error: unknown, message: string): never {
  if (error instanceof DatabaseError && error.code === "23503") {
    throw new ApiHttpError("INVALID_REQUEST", 422, message, { cause: error });
  }
  throw error;
}

async function createRun(
  executor: SqlExecutor,
  request: FastifyRequest,
  body: z.infer<typeof CreateRunSchema>,
) {
  const repositories = createRepositories(executor);
  return repositories.runs.create({
    tenantId: request.principal.tenantId,
    projectId: requireProject(request),
    name: body.name,
    ...(body.id === undefined ? {} : { id: body.id }),
    ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
    ...(body.input === undefined ? {} : { input: body.input }),
    metadata: body.metadata,
    ...(body.startedAt === undefined ? {} : { startedAt: body.startedAt }),
  });
}

async function createTrace(
  executor: SqlExecutor,
  request: FastifyRequest,
  body: z.infer<typeof CreateTraceSchema>,
) {
  const repositories = createRepositories(executor);
  const tenantId = request.principal.tenantId;
  const projectId = requireProject(request);
  if (body.runId !== undefined) {
    const run = await repositories.runs.get({ tenantId, projectId, id: body.runId });
    if (run === null) throw new ApiHttpError("NOT_FOUND", 404, "Run not found");
  }
  const session =
    body.sessionId === undefined
      ? undefined
      : await repositories.sessions.create({
          tenantId,
          projectId,
          externalId: body.sessionId,
          name: body.sessionId,
          ...(body.userId === undefined ? {} : { userId: body.userId }),
        });
  let trace = await repositories.traces
    .create({
      tenantId,
      projectId,
      name: body.name,
      ...(body.id === undefined ? {} : { id: body.id }),
      ...(body.runId === undefined ? {} : { runId: body.runId }),
      ...(session === undefined ? {} : { sessionId: session.id }),
      ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
      ...(body.input === undefined ? {} : { input: body.input }),
      metadata: body.metadata,
      ...(body.startedAt === undefined ? {} : { startedAt: body.startedAt }),
      ...(body.endedAt === undefined ? {} : { status: "SUCCEEDED" }),
    })
    .catch((error: unknown) =>
      rethrowProjectReferenceError(
        error,
        "Trace references a run or session that is not available in this project",
      ),
    );
  if (body.output !== undefined || body.endedAt !== undefined) {
    trace =
      (await repositories.traces.updateStatus({
        tenantId,
        projectId,
        id: trace.id,
        status: body.endedAt === undefined ? "RUNNING" : "SUCCEEDED",
        ...(body.output === undefined ? {} : { output: body.output }),
        ...(body.endedAt === undefined ? {} : { endedAt: body.endedAt }),
      })) ?? trace;
  }
  return trace;
}

async function createSpan(
  executor: SqlExecutor,
  request: FastifyRequest,
  traceId: string,
  body: z.infer<typeof CreateSpanSchema>,
) {
  const repositories = createRepositories(executor);
  const tenantId = request.principal.tenantId;
  const projectId = requireProject(request);
  const trace = await repositories.traces.get({ tenantId, projectId, id: traceId });
  if (trace === null) {
    throw new ApiHttpError("NOT_FOUND", 404, "Trace not found");
  }
  if (body.parentSpanId !== undefined) {
    const parent = await repositories.spans.get({
      tenantId,
      projectId,
      id: body.parentSpanId,
    });
    if (parent === null) throw new ApiHttpError("NOT_FOUND", 404, "Parent span not found");
    if (parent.traceId !== traceId) {
      throw new ApiHttpError("INVALID_REQUEST", 422, "Parent span must belong to the target trace");
    }
  }
  let span = await repositories.spans
    .create({
      tenantId,
      projectId,
      traceId,
      name: body.name,
      kind: body.kind,
      status: body.status,
      ...(body.id === undefined ? {} : { id: body.id }),
      ...(body.parentSpanId === undefined ? {} : { parentSpanId: body.parentSpanId }),
      ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.input === undefined ? {} : { input: body.input }),
      metadata: body.metadata,
      ...(body.startedAt === undefined ? {} : { startedAt: body.startedAt }),
    })
    .catch((error: unknown) =>
      rethrowProjectReferenceError(
        error,
        "Span references a trace or parent span that is not available in this project",
      ),
    );
  if (body.output !== undefined || body.endedAt !== undefined || body.status !== "UNSET") {
    span =
      (await repositories.spans.updateStatus({
        tenantId,
        projectId,
        id: span.id,
        status: body.status,
        ...(body.output === undefined ? {} : { output: body.output }),
        ...(body.endedAt === undefined ? {} : { endedAt: body.endedAt }),
      })) ?? span;
  }
  return span;
}

export async function registerTelemetryRoutes(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  const api = app.withTypeProvider<ZodTypeProvider>();

  api.post("/v1/runs", { schema: { body: CreateRunSchema } }, async (request, reply) => {
    requirePermission(request, "run:write");
    const result = await idempotentMutation(database, request, request.body, async (executor) => ({
      status: 201,
      data: await createRun(executor, request, request.body),
    }));
    mutationHeaders(reply, result.replayed);
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });

  api.get("/v1/runs", { schema: { querystring: RunListQuerySchema } }, async (request) => {
    requirePermission(request, "run:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const cursor = decodeCursor(request.query.cursor);
    const rows = await database.withTenant(
      tenantId,
      projectId,
      (executor) =>
        createRepositories(executor).runs.list({
          tenantId,
          projectId,
          limit: request.query.limit + 1,
          ...(cursor === undefined ? {} : { before: cursor.createdAt, beforeId: cursor.id }),
          ...(request.query.status === undefined ? {} : { status: request.query.status }),
          ...(request.query.sessionId === undefined ? {} : { sessionId: request.query.sessionId }),
        }),
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
            ? encodeCursor({ createdAt: last.startedAt, id: last.id })
            : null,
      },
      requestId: request.id,
    };
  });

  api.get("/v1/runs/:id", { schema: { params: IdParamsSchema } }, async (request) => {
    requirePermission(request, "run:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const run = await database.withTenant(
      tenantId,
      projectId,
      (executor) =>
        createRepositories(executor).runs.get({ tenantId, projectId, id: request.params.id }),
      { readOnly: true },
    );
    if (run === null) {
      throw new ApiHttpError("NOT_FOUND", 404, "Run not found");
    }
    return { data: run, requestId: request.id };
  });

  api.post("/v1/traces", { schema: { body: CreateTraceSchema } }, async (request, reply) => {
    requirePermission(request, "run:write");
    const result = await idempotentMutation(database, request, request.body, async (executor) => ({
      status: 201,
      data: await createTrace(executor, request, request.body),
    }));
    mutationHeaders(reply, result.replayed);
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });

  api.get("/v1/traces", { schema: { querystring: TraceListQuerySchema } }, async (request) => {
    requirePermission(request, "run:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const cursor = decodeCursor(request.query.cursor);
    const rows = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const result = await executor.query<RawRow>(
          `SELECT trace.* FROM traces trace
              WHERE trace.tenant_id = $1 AND trace.project_id = $2
                AND ($3::text IS NULL OR trace.status = $3)
                AND ($4::uuid IS NULL OR trace.run_id = $4)
                AND ($5::timestamptz IS NULL OR trace.started_at >= $5)
                AND ($6::text IS NULL OR trace.name ILIKE '%' || $6 || '%'
                  OR trace.external_id ILIKE '%' || $6 || '%'
                  OR trace.metadata::text ILIKE '%' || $6 || '%')
                AND ($7::text IS NULL OR EXISTS (
                  SELECT 1 FROM spans span
                   WHERE span.tenant_id = trace.tenant_id
                     AND span.project_id = trace.project_id AND span.trace_id = trace.id
                     AND span.kind = $7
                ))
                AND ($8::timestamptz IS NULL OR
                  (trace.started_at, trace.id) < ($8::timestamptz, $9::uuid))
              ORDER BY trace.started_at DESC, trace.id DESC
              LIMIT $10`,
          [
            tenantId,
            projectId,
            request.query.status ?? null,
            request.query.runId ?? null,
            request.query.from ?? null,
            request.query.query ?? null,
            request.query.type ?? null,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            request.query.limit + 1,
          ],
        );
        return normalizeRows<TraceRecord>(result.rows);
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
            ? encodeCursor({ createdAt: last.startedAt, id: last.id })
            : null,
      },
      requestId: request.id,
    };
  });

  api.get("/v1/traces/:id", { schema: { params: IdParamsSchema } }, async (request) => {
    requirePermission(request, "run:read");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const data = await database.withTenant(
      tenantId,
      projectId,
      async (executor) => {
        const repositories = createRepositories(executor);
        const trace = await repositories.traces.get({
          tenantId,
          projectId,
          id: request.params.id,
        });
        if (trace === null) {
          throw new ApiHttpError("NOT_FOUND", 404, "Trace not found");
        }
        const [spans, scores] = await Promise.all([
          repositories.spans.listByTrace({ tenantId, projectId, traceId: trace.id }),
          repositories.scores.listByTrace({ tenantId, projectId, traceId: trace.id }),
        ]);
        return { ...trace, spans, scores };
      },
      { readOnly: true },
    );
    return { data, requestId: request.id };
  });

  api.post(
    "/v1/traces/:traceId/spans",
    { schema: { params: TraceIdParamsSchema, body: CreateSpanSchema } },
    async (request, reply) => {
      requirePermission(request, "run:write");
      const idempotencyBody = { traceId: request.params.traceId, ...request.body };
      const result = await idempotentMutation(
        database,
        request,
        idempotencyBody,
        async (executor) => ({
          status: 201,
          data: await createSpan(executor, request, request.params.traceId, request.body),
        }),
      );
      mutationHeaders(reply, result.replayed);
      return reply.status(result.status).send({ data: result.data, requestId: request.id });
    },
  );

  api.post(
    "/v1/ingestion/batch",
    { schema: { body: IngestionBatchSchema } },
    async (request, reply) => {
      requirePermission(request, "run:write");
      const result = await idempotentMutation(database, request, request.body, async (executor) => {
        const outputs: unknown[] = [];
        for (const event of request.body.events) {
          if (event.type === "run.create")
            outputs.push(await createRun(executor, request, event.body));
          else if (event.type === "trace.create") {
            outputs.push(await createTrace(executor, request, event.body));
          } else {
            outputs.push(await createSpan(executor, request, event.traceId, event.body));
          }
        }
        return {
          status: 202,
          data: { batchId: request.body.batchId, accepted: outputs.length, results: outputs },
        };
      });
      mutationHeaders(reply, result.replayed);
      return reply.status(result.status).send({
        data: { ...result.data, duplicate: result.replayed },
        requestId: request.id,
      });
    },
  );

  api.post("/v1/scores", { schema: { body: CreateScoreSchema } }, async (request, reply) => {
    requirePermission(request, "run:write");
    const tenantId = request.principal.tenantId;
    const projectId = requireProject(request);
    const result = await idempotentMutation(database, request, request.body, async (executor) => {
      const repositories = createRepositories(executor);
      if (request.body.traceId !== undefined) {
        const trace = await repositories.traces.get({
          tenantId,
          projectId,
          id: request.body.traceId,
        });
        if (trace === null) throw new ApiHttpError("NOT_FOUND", 404, "Trace not found");
      } else if (request.body.spanId !== undefined) {
        const span = await repositories.spans.get({
          tenantId,
          projectId,
          id: request.body.spanId,
        });
        if (span === null) throw new ApiHttpError("NOT_FOUND", 404, "Span not found");
      } else if (request.body.runId !== undefined) {
        const run = await repositories.runs.get({
          tenantId,
          projectId,
          id: request.body.runId,
        });
        if (run === null) throw new ApiHttpError("NOT_FOUND", 404, "Run not found");
      }
      const score = await repositories.scores
        .create({
          tenantId,
          projectId,
          name: request.body.name,
          value: request.body.value,
          ...(request.body.id === undefined ? {} : { id: request.body.id }),
          ...(request.body.traceId === undefined ? {} : { traceId: request.body.traceId }),
          ...(request.body.spanId === undefined ? {} : { spanId: request.body.spanId }),
          ...(request.body.runId === undefined ? {} : { runId: request.body.runId }),
          ...(request.body.comment === undefined ? {} : { comment: request.body.comment }),
          source: request.body.source,
          metadata: request.body.metadata,
        })
        .catch((error: unknown) =>
          rethrowProjectReferenceError(error, "Score subject is not available in this project"),
        );
      return { status: 201, data: score };
    });
    mutationHeaders(reply, result.replayed);
    return reply.status(result.status).send({ data: result.data, requestId: request.id });
  });
}

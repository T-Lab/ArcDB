import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4_400);
const projectId = "019c91e8-43a6-7ec0-a000-000000000002";
const traceId = "019c91e8-43a6-7ec0-a000-000000000011";
const requestId = "e2e-request";

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/health/live") {
    send(response, 200, { status: "ok" });
    return;
  }
  if (request.headers.authorization !== "Bearer arcdb_e2e_server_only_credential") {
    send(response, 401, {
      error: { code: "UNAUTHENTICATED", message: "Bearer key required", retryable: false },
      requestId,
    });
    return;
  }
  if (url.pathname === "/v1/projects") {
    send(response, 200, {
      data: [
        {
          id: projectId,
          tenantId: "019c91e8-43a6-7ec0-a000-000000000001",
          name: "SQL Change Agent",
          slug: "sql-change-agent",
          createdAt: "2026-08-25T00:00:00.000Z",
        },
      ],
      requestId,
    });
    return;
  }
  if (request.headers["x-arcdb-project-id"] !== projectId) {
    send(response, 403, {
      error: { code: "FORBIDDEN", message: "Project header required", retryable: false },
      requestId,
    });
    return;
  }
  if (url.pathname === "/v1/dashboard") {
    send(response, 200, {
      data: {
        runs24h: 3,
        traces24h: 2,
        outputsTotal: 4,
        staleOutputs: 1,
        openEffects: 1,
        reconciliationRequired: 1,
        openRemediations: 1,
      },
      requestId,
    });
    return;
  }
  if (url.pathname === "/v1/traces") {
    send(response, 200, {
      data: [
        {
          id: traceId,
          name: "shadow-database-verification",
          status: "SUCCEEDED",
          startedAt: "2026-08-25T00:00:00.000Z",
          endedAt: "2026-08-25T00:00:01.000Z",
        },
      ],
      page: { hasMore: false, nextCursor: null },
      requestId,
    });
    return;
  }
  if (url.pathname === `/v1/traces/${traceId}`) {
    send(response, 200, {
      data: {
        id: traceId,
        name: "shadow-database-verification",
        status: "SUCCEEDED",
        startedAt: "2026-08-25T00:00:00.000Z",
        endedAt: "2026-08-25T00:00:01.000Z",
        spans: [
          {
            id: "019c91e8-43a6-7ec0-a000-000000000012",
            traceId,
            name: "apply migration in shadow",
            kind: "TOOL_CALL",
            status: "OK",
            startedAt: "2026-08-25T00:00:00.100Z",
            endedAt: "2026-08-25T00:00:00.900Z",
            metadata: {},
          },
        ],
        scores: [],
        metadata: {},
      },
      requestId,
    });
    return;
  }
  send(response, 404, {
    error: { code: "NOT_FOUND", message: `No fixture for ${url.pathname}`, retryable: false },
    requestId,
  });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

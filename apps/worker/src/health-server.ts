import { createServer, type Server } from "node:http";
import type { ArcDBMetrics } from "@arcdb/observability";
import type { WorkerConfig } from "./config.js";
import type { JobLogger } from "./job-types.js";
import type { WorkerServiceRuntime } from "./runtime.js";

function jsonResponse(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

export class WorkerHealthServer {
  readonly #server: Server;
  readonly #config: WorkerConfig;

  public constructor(options: {
    readonly config: WorkerConfig;
    readonly runtime: WorkerServiceRuntime;
    readonly metrics: ArcDBMetrics;
    readonly logger: JobLogger;
  }) {
    this.#config = options.config;
    this.#server = createServer(async (request, response) => {
      const started = process.hrtime.bigint();
      const path = request.url?.split("?", 1)[0] ?? "/";
      let statusCode = 404;
      try {
        if (request.method !== "GET") {
          statusCode = 405;
          response.setHeader("allow", "GET");
          jsonResponse(response, statusCode, { error: "method_not_allowed" });
          return;
        }
        if (path === "/health/live") {
          statusCode = 200;
          jsonResponse(response, statusCode, { status: "ok" });
          return;
        }
        if (path === "/health/ready") {
          const readiness = await options.runtime.readiness();
          statusCode = readiness.status === "ready" ? 200 : 503;
          jsonResponse(response, statusCode, readiness);
          return;
        }
        if (path === "/metrics") {
          const rendered = await options.metrics.render();
          statusCode = 200;
          response.writeHead(statusCode, {
            "content-type": rendered.contentType,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(rendered.body);
          return;
        }
        jsonResponse(response, statusCode, { error: "not_found" });
      } catch (error) {
        statusCode = 503;
        options.logger.error({ err: error, path }, "worker health request failed");
        if (!response.headersSent) jsonResponse(response, statusCode, { status: "not_ready" });
        else response.end();
      } finally {
        options.metrics.observeHttp({
          method: request.method ?? "UNKNOWN",
          route: path,
          statusCode,
          durationSeconds: Number(process.hrtime.bigint() - started) / 1_000_000_000,
        });
      }
    });
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#config.ARCDB_WORKER_PORT, this.#config.ARCDB_WORKER_HOST, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}

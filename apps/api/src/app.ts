import type { ArtifactStore } from "@arcdb/artifacts";
import type { Database } from "@arcdb/db";
import { type ArcDBMetrics, metricsHandler } from "@arcdb/observability";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { registerAuthentication } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { apiErrorHandler } from "./http-error.js";
import { registerControlRoutes } from "./routes/control.js";
import { registerEffectRoutes } from "./routes/effects.js";
import { registerLineageRoutes } from "./routes/lineage.js";
import { registerOtlpRoutes } from "./routes/otlp.js";
import { registerOutputRoutes } from "./routes/outputs.js";
import { registerTelemetryRoutes } from "./routes/telemetry.js";

export type ApiDependencies = {
  readonly config: ApiConfig;
  readonly database: Database;
  readonly artifactStore: ArtifactStore;
  readonly metrics: ArcDBMetrics;
};

export async function buildApp(dependencies: ApiDependencies): Promise<FastifyInstance> {
  const { config, database, metrics } = dependencies;
  const requestStarts = new WeakMap<object, bigint>();
  const app = Fastify({
    bodyLimit: config.ARCDB_MAX_PAYLOAD_BYTES,
    trustProxy: false,
    logger: {
      level: config.ARCDB_LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-arcdb-api-key",
          "headers.authorization",
          "body.arguments",
          "body.rawResponse",
        ],
        censor: "[REDACTED]",
      },
    },
    requestIdHeader: "x-request-id",
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(apiErrorHandler);
  app.addHook("onRequest", async (request) => {
    requestStarts.set(request, process.hrtime.bigint());
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStarts.get(request);
    if (startedAt === undefined) return;
    metrics.observeHttp({
      method: request.method,
      route: request.routeOptions.url ?? request.url.split("?", 1)[0] ?? "unknown",
      statusCode: reply.statusCode,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
    });
  });

  await app.register(helmet, {
    contentSecurityPolicy: config.NODE_ENV === "production",
  });
  await app.register(cors, {
    origin: [config.ARCDB_PUBLIC_URL],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-ArcDB-API-Key",
      "X-ArcDB-Project-Id",
      "X-Request-Id",
    ],
  });
  await app.register(rateLimit, {
    max: config.ARCDB_RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "ArcDB API",
        version: "0.1.0",
        description: "Versioned output, evidence, lineage, effect, and receipt lifecycle API.",
      },
      servers: [{ url: config.ARCDB_API_PUBLIC_URL }],
      components: {
        securitySchemes: {
          apiKey: { type: "http", scheme: "bearer", bearerFormat: "ArcDB API key" },
        },
      },
      security: [{ apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
  });

  app.get("/health/live", { schema: { hide: true } }, async () => ({ status: "ok" }));
  app.get("/health/ready", { schema: { hide: true } }, async (_request, reply) => {
    const databaseReady = await database.healthcheck();
    if (!databaseReady) return reply.status(503).send({ status: "not_ready", database: false });
    return { status: "ready", database: true };
  });
  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());
  app.get("/metrics", { schema: { hide: true } }, async (_request, reply) => {
    const rendered = await metricsHandler(metrics);
    return reply.type(rendered.contentType).send(rendered.body);
  });

  await registerAuthentication(app, database);
  await registerControlRoutes(app, database);
  await registerTelemetryRoutes(app, database);
  await registerOtlpRoutes(app, database);
  await registerOutputRoutes(app, database, dependencies.artifactStore);
  await registerEffectRoutes(app, database, dependencies.artifactStore, {
    allowedConnectors: config.ARCDB_ALLOWED_CONNECTORS,
  });
  await registerLineageRoutes(app, database);

  return app;
}

import {
  type ApiKeyCredential,
  type ApiKeyPrincipal,
  AuthenticationError,
  authenticateApiKey,
  authorize,
  type Permission,
} from "@arcdb/auth";
import type { Database, SqlExecutor } from "@arcdb/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    principal: ApiKeyPrincipal;
    projectId: string | undefined;
  }
}

type ApiKeyRow = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  key_hash: string;
  permissions: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const PUBLIC_PATHS = new Set(["/health/live", "/health/ready", "/metrics", "/openapi.json"]);

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ") === true) return authorization.slice(7).trim();
  const explicit = request.headers["x-arcdb-api-key"];
  if (typeof explicit === "string") return explicit.trim();
  throw new AuthenticationError("A Bearer API key is required");
}

function requestedProject(request: FastifyRequest, principal: ApiKeyPrincipal): string | undefined {
  const header = request.headers["x-arcdb-project-id"];
  const selected = typeof header === "string" ? header : principal.projectId;
  if (selected !== undefined && !UUID_PATTERN.test(selected)) {
    throw new AuthenticationError("X-ArcDB-Project-Id must be a valid UUID");
  }
  if (principal.projectId !== undefined && principal.projectId !== selected) {
    throw new AuthenticationError("The API key is not valid for the requested project");
  }
  return selected;
}

async function findCredential(
  executor: SqlExecutor,
  prefix: string,
): Promise<ApiKeyCredential | null> {
  const result = await executor.query<ApiKeyRow>(
    `SELECT id, tenant_id, project_id, key_hash, permissions, expires_at, revoked_at
       FROM api_keys
      WHERE prefix = $1`,
    [prefix],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    keyHash: row.key_hash,
    permissions: row.permissions,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export async function registerAuthentication(
  app: FastifyInstance,
  database: Database,
): Promise<void> {
  app.decorateRequest("principal");
  app.decorateRequest("projectId");

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (PUBLIC_PATHS.has(path) || path === "/docs" || path.startsWith("/docs/")) return;

    const token = bearerToken(request);
    const principal = await database.withSystem(async (executor) =>
      authenticateApiKey(token, (prefix) => findCredential(executor, prefix), {
        onAuthenticated: async (credential) => {
          await executor.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [
            credential.id,
          ]);
        },
      }),
    );
    request.principal = principal;
    request.projectId = requestedProject(request, principal);
  });
}

export function requirePermission(request: FastifyRequest, permission: Permission): void {
  authorize(request.principal, permission, {
    tenantId: request.principal.tenantId,
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
  });
}

export function requireProject(request: FastifyRequest): string {
  if (request.projectId === undefined) {
    throw new AuthenticationError("X-ArcDB-Project-Id is required for this endpoint");
  }
  return request.projectId;
}

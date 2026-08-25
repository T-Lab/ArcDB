import "server-only";

import { apiErrorDetails } from "./api-error";
import { type ApiQuery, buildApiUrl } from "./api-url";

export class ArcDbApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(options: {
    message: string;
    status: number;
    code?: string | undefined;
    requestId?: string | undefined;
  }) {
    super(options.message);
    this.name = "ArcDbApiError";
    this.status = options.status;
    this.code = options.code ?? "ARCDB_API_ERROR";
    this.requestId = options.requestId;
  }
}

export class ArcDbConfigurationError extends Error {
  constructor(variable: "ARCDB_API_URL" | "ARCDB_API_KEY") {
    super(`${variable} is not configured for the ArcDB web server.`);
    this.name = "ArcDbConfigurationError";
  }
}

export type ApiMutationMethod = "DELETE" | "PATCH" | "POST" | "PUT";

export type ApiMutationOptions = {
  method?: ApiMutationMethod;
  projectId: string;
  body?: unknown;
  idempotencyKey?: string;
};

function apiConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.ARCDB_API_URL?.trim();
  const apiKey = process.env.ARCDB_API_KEY?.trim();
  if (!baseUrl) throw new ArcDbConfigurationError("ARCDB_API_URL");
  if (!apiKey) throw new ArcDbConfigurationError("ARCDB_API_KEY");
  return { baseUrl: baseUrl.replace(/\/$/u, ""), apiKey };
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArcDbApiError({
      status: 502,
      code: "INVALID_API_RESPONSE",
      message: "ArcDB API returned malformed JSON.",
      ...(response.headers.get("x-request-id")
        ? { requestId: response.headers.get("x-request-id") ?? undefined }
        : {}),
    });
  }
}

export async function apiGet<T>(path: string, query: ApiQuery = {}): Promise<T> {
  const { baseUrl, apiKey } = apiConfig();
  let response: Response;
  try {
    response = await fetch(buildApiUrl(baseUrl, path, query), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(typeof query.projectId === "string" ? { "x-arcdb-project-id": query.projectId } : {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown network failure";
    throw new ArcDbApiError({
      status: 503,
      code: "API_UNAVAILABLE",
      message: `ArcDB API is unavailable: ${detail}`,
    });
  }

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const details = apiErrorDetails(body, response.status);
    throw new ArcDbApiError({
      status: response.status,
      message: details.message,
      ...(details.code ? { code: details.code } : {}),
      ...((details.requestId ?? response.headers.get("x-request-id"))
        ? { requestId: details.requestId ?? response.headers.get("x-request-id") ?? undefined }
        : {}),
    });
  }
  return body as T;
}

/**
 * Server-only mutation transport for the operator console. The API credential is
 * resolved here, never accepted from FormData, and therefore never crosses the
 * React Server Component boundary.
 */
export async function apiMutation<T>(path: string, options: ApiMutationOptions): Promise<T> {
  const { baseUrl, apiKey } = apiConfig();
  let response: Response;
  try {
    response = await fetch(buildApiUrl(baseUrl, path), {
      method: options.method ?? "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-arcdb-project-id": options.projectId,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { "idempotency-key": options.idempotencyKey }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ArcDbApiError({
      status: 503,
      code: "API_UNAVAILABLE",
      message: "ArcDB API is unavailable.",
    });
  }

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const details = apiErrorDetails(body, response.status);
    throw new ArcDbApiError({
      status: response.status,
      message: details.message,
      ...(details.code ? { code: details.code } : {}),
      ...((details.requestId ?? response.headers.get("x-request-id"))
        ? { requestId: details.requestId ?? response.headers.get("x-request-id") ?? undefined }
        : {}),
    });
  }
  return body as T;
}

export type RemoteError = {
  status: number;
  code: string;
  message: string;
  requestId: string | undefined;
};

export type RemoteResult<T> = { ok: true; data: T } | { ok: false; error: RemoteError };

export async function asRemoteResult<T>(request: Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, data: await request };
  } catch (error) {
    if (error instanceof ArcDbApiError) {
      return {
        ok: false,
        error: {
          status: error.status,
          code: error.code,
          message: error.message,
          requestId: error.requestId,
        },
      };
    }
    if (error instanceof ArcDbConfigurationError) {
      return {
        ok: false,
        error: {
          status: 500,
          code: "WEB_CONFIGURATION_ERROR",
          message: error.message,
          requestId: undefined,
        },
      };
    }
    throw error;
  }
}

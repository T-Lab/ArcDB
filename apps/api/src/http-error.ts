import { AuthenticationError, AuthorizationError } from "@arcdb/auth";
import { type ApiErrorCode, ArcDBDomainError } from "@arcdb/contracts";
import { DatabaseError } from "@arcdb/db";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  AUTHENTICATION_REQUIRED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  HEAD_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  EVIDENCE_REQUIRED: 422,
  EVIDENCE_STALE: 422,
  POLICY_DENIED: 422,
  DUPLICATE_EFFECT: 409,
  FENCING_TOKEN_LOST: 409,
  RECEIPT_IMMUTABLE: 409,
};

export class ApiHttpError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: ApiErrorCode,
    statusCode: number,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiHttpError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = options.retryable ?? false;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof ArcDBDomainError) {
    return error.details;
  }
  if (error instanceof ApiHttpError) {
    return error.details;
  }
  if (error instanceof ZodError) {
    return { issues: error.issues };
  }
  return undefined;
}

export function apiErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const validationError = error instanceof ZodError || "validation" in error;
  const domainCode = error instanceof ArcDBDomainError ? error.code : undefined;
  const httpError = error instanceof ApiHttpError ? error : undefined;
  const authenticationError = error instanceof AuthenticationError;
  const authorizationError = error instanceof AuthorizationError;
  const databaseError = error instanceof DatabaseError;
  const statusCode =
    httpError?.statusCode ??
    (domainCode === undefined ? undefined : DOMAIN_STATUS[domainCode]) ??
    (authenticationError ? 401 : undefined) ??
    (authorizationError ? 403 : undefined) ??
    (validationError ? 400 : undefined) ??
    ("statusCode" in error && typeof error.statusCode === "number"
      ? Math.min(Math.max(error.statusCode, 400), 599)
      : 500);
  const code: ApiErrorCode =
    httpError?.code ??
    domainCode ??
    (authenticationError ? "UNAUTHENTICATED" : undefined) ??
    (authorizationError ? "FORBIDDEN" : undefined) ??
    (databaseError ? "DATABASE_ERROR" : undefined) ??
    (validationError ? "INVALID_REQUEST" : "INTERNAL_ERROR");
  const retryable =
    httpError?.retryable ??
    (error instanceof ArcDBDomainError ? error.retryable : undefined) ??
    (databaseError ? error.retryable : false);
  const publicMessage = statusCode >= 500 ? "An unexpected error occurred" : error.message;

  if (statusCode >= 500) {
    request.log.error({ err: error, code }, "request failed");
  } else {
    request.log.info({ err: error, code }, "request rejected");
  }

  void reply.status(statusCode).send({
    error: {
      code,
      message: publicMessage,
      retryable,
      ...(errorDetails(error) === undefined ? {} : { details: errorDetails(error) }),
    },
    requestId: request.id,
  });
}

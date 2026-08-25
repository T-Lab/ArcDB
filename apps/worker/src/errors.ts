export type ExternalOutcomeCertainty = "NOT_EXTERNAL" | "KNOWN" | "UNKNOWN";

export class WorkerRuntimeError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly externalOutcome: ExternalOutcomeCertainty;

  public constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly externalOutcome?: ExternalOutcomeCertainty;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkerRuntimeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.externalOutcome = options.externalOutcome ?? "NOT_EXTERNAL";
  }
}

export class MissingJobHandlerError extends WorkerRuntimeError {
  public constructor(jobType: string) {
    super("JOB_HANDLER_NOT_CONFIGURED", `No handler is configured for job type ${jobType}`);
    this.name = "MissingJobHandlerError";
  }
}

export class JobTimeoutError extends WorkerRuntimeError {
  public constructor(jobId: string, timeoutMs: number) {
    super("JOB_TIMEOUT", `Job ${jobId} exceeded its ${timeoutMs}ms timeout`, {
      retryable: true,
      // A generic handler may have crossed an external boundary before it
      // stopped observing cancellation. Never claim that no effect occurred.
      externalOutcome: "UNKNOWN",
    });
    this.name = "JobTimeoutError";
  }
}

export class JobFenceLostError extends WorkerRuntimeError {
  public constructor(jobId: string) {
    super("JOB_FENCE_LOST", `Job ${jobId} lost its fencing token`, { retryable: true });
    this.name = "JobFenceLostError";
  }
}

export class UnsafeConnectorError extends WorkerRuntimeError {
  public constructor(connectorType: string, reason: string) {
    super(
      "UNSAFE_CONNECTOR_CAPABILITIES",
      `Connector ${connectorType} cannot execute this effect automatically: ${reason}`,
    );
    this.name = "UnsafeConnectorError";
  }
}

export class ConnectorOperationError extends WorkerRuntimeError {
  public constructor(
    connectorType: string,
    operation: string,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly externalOutcome?: ExternalOutcomeCertainty;
      readonly cause?: unknown;
    } = {},
  ) {
    super("CONNECTOR_OPERATION_FAILED", `${connectorType}.${operation}: ${message}`, options);
    this.name = "ConnectorOperationError";
  }
}

export interface PersistedJobError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly externalOutcome: ExternalOutcomeCertainty;
  readonly occurredAt: string;
}

/** Deliberately excludes stack traces and causes, which may contain connector secrets. */
export function persistedJobError(error: unknown, occurredAt = new Date()): PersistedJobError {
  if (error instanceof WorkerRuntimeError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      externalOutcome: error.externalOutcome,
      occurredAt: occurredAt.toISOString(),
    };
  }
  if (error instanceof Error) {
    return {
      code: "UNEXPECTED_JOB_ERROR",
      // Unknown errors may embed request payloads or connector responses.
      message: "An unexpected job error occurred",
      retryable: false,
      externalOutcome: "NOT_EXTERNAL",
      occurredAt: occurredAt.toISOString(),
    };
  }
  return {
    code: "UNEXPECTED_JOB_ERROR",
    message: "A non-Error value was thrown",
    retryable: false,
    externalOutcome: "NOT_EXTERNAL",
    occurredAt: occurredAt.toISOString(),
  };
}

export function isRetryableError(error: unknown): boolean {
  return error instanceof WorkerRuntimeError && error.retryable;
}

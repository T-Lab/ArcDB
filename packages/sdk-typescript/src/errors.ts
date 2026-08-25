export type ArcDBErrorBody = {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly requestId?: string;
};

export class ArcDBApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly requestId: string | undefined;
  public readonly details: Readonly<Record<string, unknown>>;
  public readonly retryable: boolean;

  public constructor(options: {
    message: string;
    code: string;
    status: number;
    requestId?: string;
    details?: Readonly<Record<string, unknown>>;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArcDBApiError";
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.details = Object.freeze({ ...(options.details ?? {}) });
    this.retryable = options.retryable ?? false;
  }
}

export class ArcDBNetworkError extends ArcDBApiError {
  public constructor(message: string, cause: unknown) {
    super({
      message,
      code: "NETWORK_ERROR",
      status: 0,
      retryable: true,
      cause,
    });
    this.name = "ArcDBNetworkError";
  }
}

export class ArcDBBufferedError extends ArcDBApiError {
  public readonly operationId: string;

  public constructor(operationId: string, cause: unknown) {
    super({
      message: `Request was buffered for retry as ${operationId}`,
      code: "BUFFERED_OFFLINE",
      status: 0,
      retryable: true,
      cause,
      details: { operationId },
    });
    this.name = "ArcDBBufferedError";
    this.operationId = operationId;
  }
}

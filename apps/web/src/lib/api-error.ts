export type ApiErrorDetails = {
  readonly message: string;
  readonly code?: string;
  readonly requestId?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function apiErrorDetails(body: unknown, status: number): ApiErrorDetails {
  const envelope = record(body) ?? {};
  const nested = record(envelope.error);
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof envelope.message === "string"
        ? envelope.message
        : typeof envelope.error === "string"
          ? envelope.error
          : `ArcDB API returned HTTP ${status}.`;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof envelope.code === "string"
        ? envelope.code
        : undefined;
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(typeof envelope.requestId === "string" ? { requestId: envelope.requestId } : {}),
  };
}

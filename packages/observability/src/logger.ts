import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { getLogContext, type LogContext } from "./context.js";

export interface CreateLoggerOptions {
  readonly service: string;
  readonly version?: string;
  readonly environment?: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
  readonly base?: Readonly<Record<string, unknown>>;
}

const REDACTED_PATHS = [
  "authorization",
  "headers.authorization",
  "headers.cookie",
  "headers.set-cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "apiKey",
  "plaintext",
  "password",
  "passwordHash",
  "secret",
  "secretAccessKey",
  "effectArguments",
] as const;

export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? process.env.ARCDB_LOG_LEVEL ?? "info",
    base: {
      service: options.service,
      ...(options.version === undefined ? {} : { version: options.version }),
      environment: options.environment ?? process.env.NODE_ENV ?? "development",
      ...(options.base ?? {}),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
      request: (request: unknown) => request,
    },
    mixin(): LogContext {
      return getLogContext();
    },
  };
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
}

export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}

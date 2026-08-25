import { AsyncLocalStorage } from "node:async_hooks";

export interface LogContext {
  readonly requestId?: string;
  readonly tenantId?: string;
  readonly projectId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly jobId?: string;
  readonly workerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(context: LogContext, callback: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, callback);
}

export function getLogContext(): LogContext {
  return storage.getStore() ?? {};
}

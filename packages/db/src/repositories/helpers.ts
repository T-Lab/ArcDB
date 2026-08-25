import type { QueryResultRow } from "pg";
import type { SqlExecutor } from "../database.js";

export type RawRow = QueryResultRow & Record<string, unknown>;

function camelCase(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

export function normalizeRow<T>(raw: RawRow): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) {
      output[camelCase(key)] = normalizeValue(value);
    }
  }
  return output as T;
}

export function requiredRow<T>(rows: readonly RawRow[], entity: string): T {
  const first = rows[0];
  if (first === undefined) {
    throw new RepositoryError(`${entity} was not returned`, "NOT_FOUND");
  }
  return normalizeRow<T>(first);
}

export function optionalRow<T>(rows: readonly RawRow[]): T | null {
  const first = rows[0];
  return first === undefined ? null : normalizeRow<T>(first);
}

export function normalizeRows<T>(rows: readonly RawRow[]): readonly T[] {
  return rows.map((row) => normalizeRow<T>(row));
}

export function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("limit must be an integer between 1 and 500");
  }
  return limit;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export class RepositoryError extends Error {
  public readonly code: "NOT_FOUND" | "CONFLICT" | "STALE_FENCE";

  public constructor(message: string, code: "NOT_FOUND" | "CONFLICT" | "STALE_FENCE") {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
  }
}

export abstract class Repository {
  protected readonly executor: SqlExecutor;

  public constructor(executor: SqlExecutor) {
    this.executor = executor;
  }
}

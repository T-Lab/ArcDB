import type { Database, SqlExecutor } from "@arcdb/db";
import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { idempotentMutation } from "../../src/idempotency.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

type StoredRecord = {
  method: string;
  path: string;
  request_hash: string;
  state: "IN_PROGRESS" | "COMPLETED";
  response_status: number | null;
  response_body: unknown;
};

function request(url: string): FastifyRequest {
  return {
    headers: { "idempotency-key": "same-key-across-resources" },
    method: "POST",
    principal: { tenantId },
    projectId,
    routeOptions: { url: "/v1/effects/:id/commit" },
    url,
  } as unknown as FastifyRequest;
}

describe("HTTP mutation idempotency", () => {
  it("binds a key to the concrete resource pathname, not the route template", async () => {
    let stored: StoredRecord | undefined;
    const executor: SqlExecutor = {
      query: async (sql, values = []) => {
        if (sql.includes("INSERT INTO idempotency_records")) {
          if (stored !== undefined) return { rows: [] } as never;
          stored = {
            method: String(values[3]),
            path: String(values[4]),
            request_hash: String(values[5]),
            state: "IN_PROGRESS",
            response_status: null,
            response_body: null,
          };
          return { rows: [{ id: crypto.randomUUID() }] } as never;
        }
        if (sql.includes("FROM idempotency_records")) {
          return { rows: stored === undefined ? [] : [stored] } as never;
        }
        if (sql.includes("UPDATE idempotency_records")) {
          if (stored === undefined) throw new Error("idempotency record was not inserted");
          stored = {
            ...stored,
            state: "COMPLETED",
            response_status: Number(values[3]),
            response_body: JSON.parse(String(values[4])) as unknown,
          };
          return { rows: [] } as never;
        }
        throw new Error(`Unexpected idempotency query: ${sql}`);
      },
    };
    const database = {
      withTenant: async (
        selectedTenantId: string,
        selectedProjectId: string,
        callback: (selectedExecutor: SqlExecutor) => Promise<unknown>,
      ) => {
        expect(selectedTenantId).toBe(tenantId);
        expect(selectedProjectId).toBe(projectId);
        return callback(executor);
      },
    } as unknown as Database;
    const firstOperation = vi.fn(async () => ({ status: 202, data: { effectId: "effect-a" } }));
    const secondOperation = vi.fn(async () => ({ status: 202, data: { effectId: "effect-b" } }));

    await expect(
      idempotentMutation(
        database,
        request("/v1/effects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commit"),
        {},
        firstOperation,
      ),
    ).resolves.toMatchObject({ data: { effectId: "effect-a" }, replayed: false });
    await expect(
      idempotentMutation(
        database,
        request("/v1/effects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/commit"),
        {},
        secondOperation,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      statusCode: 409,
    });
    expect(firstOperation).toHaveBeenCalledOnce();
    expect(secondOperation).not.toHaveBeenCalled();
    expect(stored?.path).toBe("/v1/effects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commit");
  });
});

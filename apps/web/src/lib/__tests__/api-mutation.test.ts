import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ArcDbApiError, apiMutation } from "../api";

describe("server-only API mutations", () => {
  beforeEach(() => {
    vi.stubEnv("ARCDB_API_URL", "https://api.arcdb.test/");
    vi.stubEnv("ARCDB_API_KEY", "server-secret-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends project scope, API authorization, JSON, and idempotency only upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "created-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await apiMutation<{ data: { id: string } }>("/v1/outputs", {
      projectId: "8f3af96c-5e32-4d0e-b3ac-18ca675a8718",
      body: { logicalId: "report" },
      idempotencyKey: "request-1",
    });

    expect(response.data.id).toBe("created-1");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.arcdb.test/v1/outputs");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ logicalId: "report" }),
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: "Bearer server-secret-key",
        "content-type": "application/json",
        "idempotency-key": "request-1",
        "x-arcdb-project-id": "8f3af96c-5e32-4d0e-b3ac-18ca675a8718",
      },
    });
  });

  it("supports bodyless DELETE requests without a content-type header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      apiMutation("/v1/api-keys/5bf65056-57d3-4784-a784-b71117a0bf75", {
        method: "DELETE",
        projectId: "8f3af96c-5e32-4d0e-b3ac-18ca675a8718",
      }),
    ).resolves.toBeNull();

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).not.toHaveProperty("content-type");
  });

  it("preserves bounded API error metadata for safe action mapping", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "HEAD_CONFLICT", message: "Head changed" },
          requestId: "req-safe-1",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );

    const error = await apiMutation("/v1/outputs/v1/promote", {
      projectId: "8f3af96c-5e32-4d0e-b3ac-18ca675a8718",
      body: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArcDbApiError);
    expect(error).toMatchObject({ status: 409, code: "HEAD_CONFLICT", requestId: "req-safe-1" });
  });

  it("does not copy network exception details into mutation errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connect failed with server-secret-key"),
    );

    const error = await apiMutation("/v1/effects", {
      projectId: "8f3af96c-5e32-4d0e-b3ac-18ca675a8718",
      body: {},
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ArcDbApiError);
    expect(error).toMatchObject({ status: 503, code: "API_UNAVAILABLE" });
    expect((error as Error).message).not.toContain("server-secret-key");
  });
});

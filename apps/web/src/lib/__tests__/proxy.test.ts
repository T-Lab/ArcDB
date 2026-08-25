import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, proxy } from "../../../proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

function productionCredentials(): void {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("ARCDB_CONSOLE_USERNAME", "operator");
  vi.stubEnv("ARCDB_CONSOLE_PASSWORD", "a-long-console-password");
}

describe("console proxy route boundary", () => {
  it("allows only the exact liveness route without authentication", () => {
    productionCredentials();
    expect(proxy(new NextRequest("http://arcdb.test/health/live")).status).toBe(200);
    expect(proxy(new NextRequest("http://arcdb.test/health/livex")).status).toBe(401);
    expect(proxy(new NextRequest("http://arcdb.test/health/live/anything")).status).toBe(401);
  });

  it("runs Proxy for every application-looking path, including near-prefix attacks", () => {
    for (const url of [
      "/overview",
      "/health/livex",
      "/favicon.icox",
      "/_next/imagex",
      "/_next/staticx",
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
  });

  it("challenges a page and accepts the configured Basic credential", () => {
    productionCredentials();
    expect(proxy(new NextRequest("http://arcdb.test/overview")).status).toBe(401);
    const request = new NextRequest("http://arcdb.test/overview", {
      headers: {
        authorization: `Basic ${Buffer.from("operator:a-long-console-password", "utf8").toString(
          "base64",
        )}`,
      },
    });
    expect(proxy(request).status).toBe(200);
  });
});

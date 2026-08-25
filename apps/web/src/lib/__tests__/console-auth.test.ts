import { describe, expect, it } from "vitest";
import { authorizeConsoleRequest } from "../console-auth";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("console perimeter authentication", () => {
  it("allows an unconfigured development server", () => {
    expect(authorizeConsoleRequest(null, { NODE_ENV: "development" })).toEqual({ kind: "ALLOW" });
  });

  it("fails closed when production credentials are absent or partial", () => {
    expect(authorizeConsoleRequest(null, { NODE_ENV: "production" })).toEqual({
      kind: "MISCONFIGURED",
    });
    expect(
      authorizeConsoleRequest(null, {
        NODE_ENV: "production",
        ARCDB_CONSOLE_USERNAME: "operator",
      }),
    ).toEqual({ kind: "MISCONFIGURED" });
  });

  it("accepts only the exact configured Basic credential", () => {
    const environment = {
      NODE_ENV: "production",
      ARCDB_CONSOLE_USERNAME: "operator",
      ARCDB_CONSOLE_PASSWORD: "a-long-console-password",
    };
    expect(
      authorizeConsoleRequest(basic("operator", "a-long-console-password"), environment),
    ).toEqual({ kind: "ALLOW" });
    expect(authorizeConsoleRequest(basic("operator", "wrong-password-value"), environment)).toEqual(
      { kind: "CHALLENGE" },
    );
    expect(authorizeConsoleRequest("Bearer not-basic", environment)).toEqual({ kind: "CHALLENGE" });
  });

  it("rejects ambiguous usernames and short passwords as configuration errors", () => {
    expect(
      authorizeConsoleRequest(null, {
        NODE_ENV: "production",
        ARCDB_CONSOLE_USERNAME: "bad:name",
        ARCDB_CONSOLE_PASSWORD: "a-long-console-password",
      }),
    ).toEqual({ kind: "MISCONFIGURED" });
    expect(
      authorizeConsoleRequest(null, {
        NODE_ENV: "production",
        ARCDB_CONSOLE_USERNAME: "operator",
        ARCDB_CONSOLE_PASSWORD: "short",
      }),
    ).toEqual({ kind: "MISCONFIGURED" });
  });
});

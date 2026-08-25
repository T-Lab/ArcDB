import { describe, expect, it } from "vitest";
import {
  ConsoleActionAuthorizationError,
  requireConsoleActionAuthorization,
} from "../operator-auth";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("operator Server Action authentication", () => {
  const environment = {
    NODE_ENV: "production",
    ARCDB_CONSOLE_USERNAME: "operator",
    ARCDB_CONSOLE_PASSWORD: "a-long-console-password",
  };

  it("allows the exact perimeter credential", () => {
    expect(() =>
      requireConsoleActionAuthorization(basic("operator", "a-long-console-password"), environment),
    ).not.toThrow();
  });

  it("rejects a directly invoked action without valid authorization", () => {
    expect(() => requireConsoleActionAuthorization(null, environment)).toThrowError(
      expect.objectContaining<Partial<ConsoleActionAuthorizationError>>({
        code: "CONSOLE_AUTH_REQUIRED",
      }),
    );
    expect(() =>
      requireConsoleActionAuthorization(basic("operator", "wrong-password-value"), environment),
    ).toThrowError(ConsoleActionAuthorizationError);
  });

  it("fails closed when production perimeter configuration is absent", () => {
    expect(() => requireConsoleActionAuthorization(null, { NODE_ENV: "production" })).toThrowError(
      expect.objectContaining<Partial<ConsoleActionAuthorizationError>>({
        code: "CONSOLE_AUTH_MISCONFIGURED",
      }),
    );
  });
});

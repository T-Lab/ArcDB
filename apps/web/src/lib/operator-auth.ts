import { authorizeConsoleRequest } from "./console-auth";

export class ConsoleActionAuthorizationError extends Error {
  readonly code: "CONSOLE_AUTH_MISCONFIGURED" | "CONSOLE_AUTH_REQUIRED";

  constructor(code: "CONSOLE_AUTH_MISCONFIGURED" | "CONSOLE_AUTH_REQUIRED") {
    super(
      code === "CONSOLE_AUTH_MISCONFIGURED"
        ? "Console authentication is not configured."
        : "Console authentication is required.",
    );
    this.name = "ConsoleActionAuthorizationError";
    this.code = code;
  }
}

/**
 * Server Actions are independently callable endpoints. Repeating the console
 * perimeter decision here keeps mutations protected even if Proxy matching is
 * changed or bypassed by a framework routing regression.
 */
export function requireConsoleActionAuthorization(
  authorization: string | null,
  environment: Parameters<typeof authorizeConsoleRequest>[1] = process.env,
): void {
  const decision = authorizeConsoleRequest(authorization, environment);
  if (decision.kind === "ALLOW") return;
  throw new ConsoleActionAuthorizationError(
    decision.kind === "MISCONFIGURED" ? "CONSOLE_AUTH_MISCONFIGURED" : "CONSOLE_AUTH_REQUIRED",
  );
}

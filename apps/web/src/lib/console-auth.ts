import { createHash, timingSafeEqual } from "node:crypto";

type ConsoleAuthEnvironment = {
  readonly ARCDB_CONSOLE_PASSWORD?: string | undefined;
  readonly ARCDB_CONSOLE_USERNAME?: string | undefined;
  readonly NODE_ENV?: string | undefined;
};

export type ConsoleAuthDecision =
  | { readonly kind: "ALLOW" }
  | { readonly kind: "CHALLENGE" }
  | { readonly kind: "MISCONFIGURED" };

function matchesSecret(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function decodeBasicCredentials(
  header: string | null,
): { username: string; password: string } | null {
  if (header === null) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/u.exec(header);
  if (match?.[1] === undefined) return null;
  try {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

/**
 * The v0.1 console is an operator surface backed by one server-side API key.
 * This perimeter credential prevents an unauthenticated browser from inheriting
 * that authority. Production fails closed when the perimeter is not configured.
 */
export function authorizeConsoleRequest(
  authorization: string | null,
  environment: ConsoleAuthEnvironment = process.env,
): ConsoleAuthDecision {
  const username = environment.ARCDB_CONSOLE_USERNAME;
  const password = environment.ARCDB_CONSOLE_PASSWORD;
  if (username === undefined && password === undefined) {
    return environment.NODE_ENV === "production" ? { kind: "MISCONFIGURED" } : { kind: "ALLOW" };
  }
  if (
    username === undefined ||
    password === undefined ||
    username.length === 0 ||
    username.includes(":") ||
    password.length < 16
  ) {
    return { kind: "MISCONFIGURED" };
  }

  const credentials = decodeBasicCredentials(authorization);
  if (credentials === null) return { kind: "CHALLENGE" };
  const usernameMatches = matchesSecret(credentials.username, username);
  const passwordMatches = matchesSecret(credentials.password, password);
  return usernameMatches && passwordMatches ? { kind: "ALLOW" } : { kind: "CHALLENGE" };
}

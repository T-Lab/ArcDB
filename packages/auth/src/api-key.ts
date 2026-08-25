import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "arcdb_";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DUMMY_SALT = Buffer.alloc(16, 0xa5);

export interface GeneratedApiKey {
  /** The only copy of the credential that should ever be shown to a caller. */
  readonly plaintext: string;
  /** Non-secret lookup prefix persisted alongside the hash. */
  readonly prefix: string;
  readonly lastFour: string;
}

export interface ApiKeyCredential {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId?: string | null;
  readonly keyHash: string;
  readonly permissions: readonly string[];
  readonly expiresAt?: string | Date | null;
  readonly revokedAt?: string | Date | null;
}

export interface ApiKeyPrincipal {
  readonly subjectType: "API_KEY";
  readonly subjectId: string;
  readonly tenantId: string;
  readonly projectId?: string;
  readonly permissions: readonly string[];
}

export type ApiKeyLookup = (prefix: string) => Promise<ApiKeyCredential | null>;

export class AuthenticationError extends Error {
  public readonly code = "UNAUTHENTICATED";

  public constructor(message = "Invalid API key") {
    super(message);
    this.name = "AuthenticationError";
  }
}

function derive(
  secret: string,
  salt: Buffer,
  parameters: { readonly n: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      SCRYPT_LENGTH,
      {
        N: parameters.n,
        r: parameters.r,
        p: parameters.p,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(key);
      },
    );
  });
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(12).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${KEY_PREFIX}${prefix}.${secret}`;
  return { plaintext, prefix, lastFour: secret.slice(-4) };
}

/**
 * Returns the public lookup prefix. Legacy/bootstrap credentials without the
 * structured format receive a deterministic SHA-256-derived prefix.
 */
export function getApiKeyPrefix(plaintext: string): string {
  const match = /^arcdb_([A-Za-z0-9_-]{8,64})\.[A-Za-z0-9_-]{16,}$/u.exec(plaintext);
  if (match?.[1] !== undefined) {
    return match[1];
  }
  return createHash("sha256").update(plaintext, "utf8").digest("hex").slice(0, 24);
}

export async function hashApiKey(plaintext: string): Promise<string> {
  if (plaintext.length < 24 || plaintext.length > 512) {
    throw new TypeError("API keys must contain between 24 and 512 characters");
  }
  const salt = randomBytes(16);
  const derived = await derive(plaintext, salt, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyApiKey(plaintext: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltPart = parts[4];
  const hashPart = parts[5];
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    n < 2 ||
    n > SCRYPT_N ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    saltPart === undefined ||
    hashPart === undefined
  ) {
    return false;
  }
  try {
    const salt = Buffer.from(saltPart, "base64url");
    const expected = Buffer.from(hashPart, "base64url");
    if (salt.byteLength < 16 || expected.byteLength !== SCRYPT_LENGTH) {
      return false;
    }
    const actual = await derive(plaintext, salt, { n, r, p });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function isPast(value: string | Date | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const epoch = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(epoch) || epoch <= Date.now();
}

export async function authenticateApiKey(
  plaintext: string,
  lookupByPrefix: ApiKeyLookup,
  options: { readonly onAuthenticated?: (credential: ApiKeyCredential) => Promise<void> } = {},
): Promise<ApiKeyPrincipal> {
  const prefix = getApiKeyPrefix(plaintext);
  const credential = await lookupByPrefix(prefix);
  if (credential === null) {
    // Equalize the expensive portion of the absent-key and wrong-key paths.
    await derive(plaintext, DUMMY_SALT, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    throw new AuthenticationError();
  }
  const valid = await verifyApiKey(plaintext, credential.keyHash);
  if (
    !valid ||
    (credential.revokedAt !== null && credential.revokedAt !== undefined) ||
    isPast(credential.expiresAt)
  ) {
    throw new AuthenticationError();
  }
  await options.onAuthenticated?.(credential);
  return {
    subjectType: "API_KEY",
    subjectId: credential.id,
    tenantId: credential.tenantId,
    ...(credential.projectId === null || credential.projectId === undefined
      ? {}
      : { projectId: credential.projectId }),
    permissions: [...credential.permissions],
  };
}

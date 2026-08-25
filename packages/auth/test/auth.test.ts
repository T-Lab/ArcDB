import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  authorize,
  generateApiKey,
  getApiKeyPrefix,
  hashApiKey,
  permissionsForRole,
  verifyApiKey,
} from "../src/index.js";

describe("API key credentials", () => {
  it("generates lookup-safe keys and verifies only the original secret", async () => {
    const generated = generateApiKey();
    const encoded = await hashApiKey(generated.plaintext);

    expect(getApiKeyPrefix(generated.plaintext)).toBe(generated.prefix);
    await expect(verifyApiKey(generated.plaintext, encoded)).resolves.toBe(true);
    await expect(verifyApiKey(`${generated.plaintext}x`, encoded)).resolves.toBe(false);
    expect(encoded).not.toContain(generated.plaintext);
  });

  it("does not grant project-scoped keys access to another project", () => {
    const principal = {
      tenantId: "tenant-1",
      projectId: "project-1",
      permissions: permissionsForRole("ADMIN"),
    };
    expect(() =>
      authorize(principal, "run:read", { tenantId: "tenant-1", projectId: "project-2" }),
    ).toThrow(/Missing permission/u);
  });

  it("uses one generic authentication error", () => {
    const error = new AuthenticationError();
    expect(error.message).not.toMatch(/revoked|missing|expired/iu);
    expect(vi.isMockFunction(authorize)).toBe(false);
  });
});

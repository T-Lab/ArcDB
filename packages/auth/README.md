# `@arcdb/auth`

ArcDB authentication and authorization primitives:

- API keys with a non-secret lookup prefix and scrypt hash;
- constant-time hash comparison and a timing-equalized missing-key path;
- organization roles mapped to explicit permissions;
- tenant and project scope checks;
- generic authentication failures that do not disclose whether a key exists,
  expired, or was revoked.

Persist only `prefix`, `lastFour`, and `keyHash`. The `plaintext` returned by
`generateApiKey()` is shown once and must never be logged.

```ts
const principal = await authenticateApiKey(rawKey, (prefix) =>
  database.withSystem(() => repositories.apiKeys.findByPrefix(prefix)),
);
authorize(principal, "output:write", { tenantId, projectId });
```

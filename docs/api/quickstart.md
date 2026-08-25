# API quickstart

Start the local stack, apply migrations, and seed the development project as described in the root
README. The seed command prints the project ID; the API key comes from your local `.env`.

```bash
export ARCDB_KEY=arcdb_dev_change_me_32_characters
export ARCDB_URL=http://localhost:4000

curl --fail-with-body \
  -H "Authorization: Bearer ${ARCDB_KEY}" \
  "${ARCDB_URL}/v1/projects"
```

The interactive OpenAPI explorer is available at `http://localhost:4000/docs`; the machine-readable
document is `http://localhost:4000/openapi.json`.

All mutating lifecycle endpoints accept `Idempotency-Key`. Reusing a key with a different body is an
error. List endpoints use bounded `limit` and opaque `cursor` values. Errors have one stable shape:

Optional client-supplied UUID identifiers are globally unique within an ArcDB deployment. Generate
a fresh UUID for every object and never reuse one across tenants or projects. OTLP trace and span
identifiers are deterministically namespaced by project before storage.

```json
{
  "error": {
    "code": "HEAD_CONFLICT",
    "message": "The logical head changed",
    "retryable": true,
    "details": {}
  },
  "requestId": "req_..."
}
```

Use the TypeScript SDK for retries and trace context instead of hand-rolling effect retry behavior.
In particular, never retry an effect whose outcome is unknown unless the connector can reconcile it
by idempotency key.

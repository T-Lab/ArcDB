# `@arcdb/artifacts`

ArcStore's reference implementation on S3-compatible storage. It works with AWS
S3 in production and MinIO in local Compose.

Uploads preserve original bytes, split them into SHA-256-addressed immutable
chunks, and finalize a canonical manifest. A crash between chunk upload and
manifest finalization leaves only unreachable chunks; conservative garbage
collection removes them after an age threshold. Reads verify every chunk and
the root content digest.

```ts
const store = createS3ArtifactStore({
  bucket,
  region,
  endpoint,
  accessKeyId,
  secretAccessKey,
  forcePathStyle: true,
});

const ref = await putBytes(store, bytes, {
  tenantId,
  artifactType: "sql",
});
```

Content references and object keys are tenant-namespaced to avoid cross-tenant
deduplication oracles. `collectGarbage` defaults to dry-run and never deletes a
finalized manifest.

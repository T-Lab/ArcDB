# @arcdb/sdk

Typed Node.js SDK for ArcDB. It propagates run and trace context, reuses idempotency keys across
bounded retries, exposes stable API errors, and can buffer ingestion while the network is unavailable.

```ts
import { ArcDB, FileOfflineBuffer } from "@arcdb/sdk";

const arcdb = new ArcDB({
  baseUrl: process.env.ARCDB_API_URL!,
  apiKey: process.env.ARCDB_API_KEY!,
  projectId: process.env.ARCDB_PROJECT_ID!,
  offlineBuffer: new FileOfflineBuffer("./data/arcdb-offline.json"),
});
```

Effect execution is submitted with `commitEffect`. The installed connector determines whether a
capability-aware worker can perform an external operation. ArcDB v0.1 installs only
`manual-receipt`, which performs no write and waits in `RECONCILIATION_REQUIRED` for an authorized
operator to record the append-only receipt. Use `reconcileEffect` for an uncertain automatic
connector once such a connector has been separately implemented and allowlisted.

Remediation updates use an explicit compare-and-swap status. Terminal transitions require a
structured resolution, and high-risk obligations created in `PENDING_APPROVAL` record the
approving actor when execution starts or the obligation is waived.

```ts
await arcdb.transitionRemediation(effectIntentId, remediationId, {
  expectedStatus: "PENDING_APPROVAL",
  nextStatus: "IN_PROGRESS",
});

await arcdb.transitionRemediation(effectIntentId, remediationId, {
  expectedStatus: "IN_PROGRESS",
  nextStatus: "RESOLVED",
  resolution: {
    summary: "Corrected the external resource and verified the resulting state.",
    references: [{ kind: "TICKET", reference: "OPS-142" }],
  },
});
```

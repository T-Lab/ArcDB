import type { EffectIntentRecord } from "@arcdb/db";
import { describe, expect, it } from "vitest";
import { ManualReceiptConnector } from "../../src/connectors/manual-receipt.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import { ManualReceiptService } from "../../src/manual-receipt-service.js";
import { InMemoryEffectStore } from "../support/in-memory-effect-store.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const INTENT_ID = "00000000-0000-4000-8000-000000000003";

describe("ManualReceiptService", () => {
  it("requires effect:commit and commits an immutable manual receipt", async () => {
    const connector = new ManualReceiptConnector();
    const store = new InMemoryEffectStore();
    store.addIntent({
      id: INTENT_ID,
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      sourceOutputVersionId: "output-v1",
      connectorType: connector.type,
      connectorCapabilities: connector.capabilities,
      target: "urn:manual:target",
      resourceKey: "manual:target",
      argumentsRef: "artifact:manual",
      preconditions: {},
      expectedEffects: {},
      readSet: [],
      writeSet: [],
      idempotencyKey: "manual:one",
      reversibility: "R3",
      riskLevel: "CRITICAL",
      status: "RECONCILIATION_REQUIRED",
      securityLabel: "INTERNAL",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    } satisfies EffectIntentRecord);
    const service = new ManualReceiptService({
      store,
      connectors: new ConnectorRegistry().register(connector),
      now: () => new Date("2026-08-25T01:00:00.000Z"),
    });
    const input = {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      intentId: INTENT_ID,
      receiptId: "00000000-0000-4000-8000-000000000005",
      externalTransactionId: "00000000-0000-4000-8000-000000000006",
      externalStatus: "confirmed_by_operator",
      actualEffects: { confirmed: true },
    } as const;

    await expect(
      service.record(
        { tenantId: TENANT_ID, projectId: PROJECT_ID, permissions: ["effect:read"] },
        input,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const receipt = await service.record(
      { tenantId: TENANT_ID, projectId: PROJECT_ID, permissions: ["effect:commit"] },
      input,
    );
    expect(receipt.id).toBe(input.receiptId);
    expect((await store.getIntent(TENANT_ID, PROJECT_ID, INTENT_ID))?.status).toBe(
      "IRREVERSIBLE_COMMITTED",
    );
    await expect(
      service.record(
        { tenantId: TENANT_ID, projectId: PROJECT_ID, permissions: ["effect:commit"] },
        input,
      ),
    ).resolves.toMatchObject({ id: input.receiptId });
  });
});

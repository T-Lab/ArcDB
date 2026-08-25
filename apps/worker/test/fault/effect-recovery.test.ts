import type { EffectIntentRecord, JobRecord } from "@arcdb/db";
import { describe, expect, it, vi } from "vitest";
import { ManualReceiptConnector } from "../../src/connectors/manual-receipt.js";
import { ConnectorRegistry } from "../../src/connectors/registry.js";
import { EffectRuntime } from "../../src/effects.js";
import { ConnectorOperationError } from "../../src/errors.js";
import type { JobExecutionContext } from "../../src/job-types.js";
import { TestOnlyConnector } from "../support/fake-connector.js";
import { InMemoryEffectStore } from "../support/in-memory-effect-store.js";
import { silentLogger } from "../support/logger.js";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const INTENT_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_PROJECT_ID = "00000000-0000-4000-8000-000000000005";

function automaticIntent(
  connector: TestOnlyConnector,
  status: EffectIntentRecord["status"] = "PREPARED",
): EffectIntentRecord {
  return {
    id: INTENT_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    sourceOutputVersionId: "output-v1",
    connectorType: connector.type,
    connectorCapabilities: connector.capabilities,
    target: "urn:test:target",
    resourceKey: "resource:test",
    argumentsRef: "artifact:arguments",
    preconditions: {},
    expectedEffects: {},
    readSet: [],
    writeSet: ["resource:test"],
    idempotencyKey: "effect:test:one",
    fencingToken: "7",
    reversibility: "R0",
    compensationHandler: "test.compensate",
    riskLevel: "LOW",
    status,
    securityLabel: "INTERNAL",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function context(jobType: "reconcile_effect" | "run_compensation"): JobExecutionContext {
  const job: JobRecord = {
    id: "00000000-0000-4000-8000-000000000004",
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    jobType,
    idempotencyKey: `${jobType}:one`,
    status: "RUNNING",
    payload: { intentId: INTENT_ID },
    attemptCount: 1,
    maxAttempts: 5,
    timeoutMs: 30_000,
    availableAt: "2026-08-25T00:00:00.000Z",
    lockedBy: "worker-a",
    lockExpiresAt: "2099-01-01T00:00:00.000Z",
    fencingToken: "11",
    traceContext: {},
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  return {
    job,
    signal: new AbortController().signal,
    logger: silentLogger,
    assertCurrentFence: async () => undefined,
  };
}

describe("external effect fault recovery", () => {
  it("rejects an unscoped effect job before looking up an intent", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.addIntent(automaticIntent(connector));
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });
    const scoped = context("reconcile_effect");
    const { projectId: _projectId, ...unscopedJob } = scoped.job;
    const getIntent = vi.spyOn(store, "getIntent");

    await expect(runtime.reconcileEffect({ ...scoped, job: unscopedJob })).rejects.toMatchObject({
      code: "EFFECT_SCOPE_MISMATCH",
    });
    const compensation = context("run_compensation");
    const { projectId: _compensationProjectId, ...unscopedCompensationJob } = compensation.job;
    await expect(
      runtime.runCompensation({ ...compensation, job: unscopedCompensationJob }),
    ).rejects.toMatchObject({ code: "EFFECT_SCOPE_MISMATCH" });
    expect(getIntent).not.toHaveBeenCalled();
    expect(connector.executeCalls).toBe(0);
    expect(connector.reconcileCalls).toBe(0);
  });

  it("does not resolve an intent from a sibling project", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.addIntent({ ...automaticIntent(connector), projectId: OTHER_PROJECT_ID });
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).rejects.toMatchObject({
      code: "EFFECT_INTENT_NOT_FOUND",
    });
    expect((await store.getIntent(TENANT_ID, OTHER_PROJECT_ID, INTENT_ID))?.status).toBe(
      "PREPARED",
    );
    expect(await store.listReceipts(TENANT_ID, OTHER_PROJECT_ID, INTENT_ID)).toHaveLength(0);
    expect(connector.executeCalls).toBe(0);
    expect(connector.reconcileCalls).toBe(0);
  });

  it("recovers external success after a crash before receipt without executing twice", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.addIntent(automaticIntent(connector));
    let crash = true;
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
      hooks: {
        afterExternalSuccess: async () => {
          if (crash) {
            crash = false;
            throw new Error("injected process crash after external success");
          }
        },
      },
    });

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).rejects.toBeInstanceOf(
      ConnectorOperationError,
    );
    expect(connector.executeCalls).toBe(1);
    expect((await store.getIntent(TENANT_ID, PROJECT_ID, INTENT_ID))?.status).toBe(
      "RECONCILIATION_REQUIRED",
    );
    expect(await store.listReceipts(TENANT_ID, PROJECT_ID, INTENT_ID)).toHaveLength(0);

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).resolves.toMatchObject({
      status: "COMMITTED",
      recovered: true,
    });
    expect(connector.executeCalls).toBe(1);
    expect(connector.reconcileCalls).toBe(1);
    expect(await store.listReceipts(TENANT_ID, PROJECT_ID, INTENT_ID)).toHaveLength(1);
  });

  it("finalizes an already persisted receipt after a crash before status commit", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.addIntent(automaticIntent(connector));
    let crash = true;
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
      hooks: {
        afterReceiptPersisted: async () => {
          if (crash) {
            crash = false;
            throw new Error("injected process crash after receipt persistence");
          }
        },
      },
    });

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).rejects.toBeInstanceOf(
      ConnectorOperationError,
    );
    expect(await store.listReceipts(TENANT_ID, PROJECT_ID, INTENT_ID)).toHaveLength(1);
    expect((await store.getIntent(TENANT_ID, PROJECT_ID, INTENT_ID))?.status).toBe(
      "RECONCILIATION_REQUIRED",
    );

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).resolves.toMatchObject({
      status: "COMMITTED",
      recovered: true,
    });
    expect(connector.externalWrites).toBe(1);
    expect(await store.listReceipts(TENANT_ID, PROJECT_ID, INTENT_ID)).toHaveLength(1);
  });

  it("does not blindly execute when reconciliation remains unknown", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    connector.forceUnknownReconciliation = true;
    store.addIntent(automaticIntent(connector, "EXECUTING"));
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });

    await expect(runtime.reconcileEffect(context("reconcile_effect"))).resolves.toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      externalOutcome: "unknown",
    });
    expect(connector.executeCalls).toBe(0);
    expect(connector.reconcileCalls).toBe(1);
  });

  it("recovers a compensation success after the pre-receipt crash window", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.addIntent(automaticIntent(connector, "COMMITTED"));
    let crash = true;
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
      hooks: {
        afterCompensationSuccess: async () => {
          if (crash) {
            crash = false;
            throw new Error("injected compensation crash");
          }
        },
      },
    });

    await expect(runtime.runCompensation(context("run_compensation"))).rejects.toBeInstanceOf(
      ConnectorOperationError,
    );
    await expect(runtime.runCompensation(context("run_compensation"))).resolves.toMatchObject({
      status: "COMPENSATED",
      recovered: true,
    });
    expect(connector.compensateCalls).toBe(1);
    expect(connector.reconcileCompensationCalls).toBe(1);
  });

  it("refreshes an expired prepare fence immediately before delayed execution", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    store.resourceFenceCurrent = false;
    store.addIntent(automaticIntent(connector));
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });
    await expect(runtime.reconcileEffect(context("reconcile_effect"))).resolves.toMatchObject({
      status: "COMMITTED",
    });
    expect(connector.externalWrites).toBe(1);
    expect(connector.lastFencingToken).toBe("8");
  });

  it("does not write if the refreshed resource fence is lost before the connector call", async () => {
    const store = new InMemoryEffectStore();
    const connector = new TestOnlyConnector();
    connector.beforeExecute = () => {
      store.resourceFenceCurrent = false;
    };
    store.addIntent(automaticIntent(connector));
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });
    await expect(runtime.reconcileEffect(context("reconcile_effect"))).rejects.toBeInstanceOf(
      ConnectorOperationError,
    );
    expect(connector.externalWrites).toBe(0);
    expect((await store.getIntent(TENANT_ID, PROJECT_ID, INTENT_ID))?.status).toBe(
      "RECONCILIATION_REQUIRED",
    );
  });

  it("manual-receipt never performs an external write", async () => {
    const store = new InMemoryEffectStore();
    const connector = new ManualReceiptConnector();
    store.addIntent({
      ...automaticIntent(new TestOnlyConnector()),
      connectorType: connector.type,
      connectorCapabilities: connector.capabilities,
      fencingToken: undefined,
      reversibility: "R3",
      compensationHandler: undefined,
      status: "PREPARED",
    } as EffectIntentRecord);
    const runtime = new EffectRuntime({
      store,
      connectors: new ConnectorRegistry().register(connector),
    });
    await expect(runtime.reconcileEffect(context("reconcile_effect"))).resolves.toMatchObject({
      status: "RECONCILIATION_REQUIRED",
      waitingForManualReceipt: true,
    });
    expect(await store.listReceipts(TENANT_ID, PROJECT_ID, INTENT_ID)).toHaveLength(0);
  });
});

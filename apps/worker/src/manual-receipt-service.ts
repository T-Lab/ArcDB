import type { AuthorizablePrincipal } from "@arcdb/auth";
import { authorize } from "@arcdb/auth";
import {
  canonicalDigest,
  type EffectReceipt,
  EffectReceiptSchema,
  ReceiptImmutableError,
} from "@arcdb/contracts";
import type { EffectReceiptRecord } from "@arcdb/db";
import type { ConnectorRegistry } from "./connectors/registry.js";
import type { ManualReceiptInput } from "./connectors/types.js";
import type { EffectStore } from "./effect-store.js";
import { UnsafeConnectorError, WorkerRuntimeError } from "./errors.js";

export class ManualReceiptService {
  readonly #store: EffectStore;
  readonly #connectors: ConnectorRegistry;
  readonly #now: () => Date;

  public constructor(options: {
    readonly store: EffectStore;
    readonly connectors: ConnectorRegistry;
    readonly now?: () => Date;
  }) {
    this.#store = options.store;
    this.#connectors = options.connectors;
    this.#now = options.now ?? (() => new Date());
  }

  public async record(
    principal: AuthorizablePrincipal,
    input: ManualReceiptInput,
  ): Promise<EffectReceiptRecord> {
    authorize(principal, "effect:commit", {
      tenantId: input.tenantId,
      projectId: input.projectId,
    });
    const intent = await this.#store.getIntent(input.tenantId, input.projectId, input.intentId);
    if (intent === null || intent.projectId !== input.projectId) {
      throw new WorkerRuntimeError("EFFECT_INTENT_NOT_FOUND", "Effect intent was not found");
    }
    const connector = this.#connectors.resolveForIntent(intent);
    if (connector.mode !== "manual-receipt") {
      throw new UnsafeConnectorError(connector.type, "only manual connectors accept user receipts");
    }
    const createdAt = this.#now().toISOString();
    const receipt: EffectReceipt = EffectReceiptSchema.parse({
      id: input.receiptId,
      intentId: intent.id,
      ...(input.externalTransactionId === undefined
        ? {}
        : { externalTransactionId: input.externalTransactionId }),
      externalStatus: input.externalStatus,
      ...(input.beforeDigest === undefined ? {} : { beforeDigest: input.beforeDigest }),
      ...(input.afterDigest === undefined ? {} : { afterDigest: input.afterDigest }),
      actualEffects: input.actualEffects,
      ...(input.rawResponseRef === undefined ? {} : { rawResponseRef: input.rawResponseRef }),
      committedAt: input.committedAt ?? createdAt,
      createdAt,
    });
    const existing = (
      await this.#store.listReceipts(input.tenantId, input.projectId, intent.id)
    ).find((candidate) => candidate.id === receipt.id);
    if (existing !== undefined) {
      const same =
        existing.externalTransactionId === receipt.externalTransactionId &&
        existing.externalStatus === receipt.externalStatus &&
        existing.beforeDigest === receipt.beforeDigest &&
        existing.afterDigest === receipt.afterDigest &&
        canonicalDigest(existing.actualEffects, "receipt-effects") ===
          canonicalDigest(receipt.actualEffects, "receipt-effects") &&
        existing.rawResponseRef === receipt.rawResponseRef;
      if (!same) throw new ReceiptImmutableError(receipt.id);
      return existing;
    }
    if (!["PREPARED", "EXECUTING", "FAILED", "RECONCILIATION_REQUIRED"].includes(intent.status)) {
      throw new WorkerRuntimeError(
        "EFFECT_STATE_NOT_RECEIPTABLE",
        `Effect ${intent.id} cannot accept a manual receipt from ${intent.status}`,
      );
    }
    return this.#store.recordManualReceipt(
      {
        id: receipt.id,
        tenantId: input.tenantId,
        projectId: input.projectId,
        intentId: receipt.intentId,
        ...(receipt.externalTransactionId === undefined
          ? {}
          : { externalTransactionId: receipt.externalTransactionId }),
        externalStatus: receipt.externalStatus,
        ...(receipt.beforeDigest === undefined ? {} : { beforeDigest: receipt.beforeDigest }),
        ...(receipt.afterDigest === undefined ? {} : { afterDigest: receipt.afterDigest }),
        actualEffects: receipt.actualEffects,
        ...(receipt.rawResponseRef === undefined ? {} : { rawResponseRef: receipt.rawResponseRef }),
        ...(receipt.committedAt === undefined ? {} : { committedAt: receipt.committedAt }),
      },
      intent.status,
      intent.reversibility === "R3" ? "IRREVERSIBLE_COMMITTED" : "COMMITTED",
    );
  }
}

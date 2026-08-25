import type {
  AppendReceiptInput,
  EffectIntentRecord,
  EffectReceiptRecord,
  EffectStatus,
} from "@arcdb/db";
import type { EffectMutationFence, EffectStore } from "../../src/effect-store.js";
import { JobFenceLostError } from "../../src/errors.js";

export class InMemoryEffectStore implements EffectStore {
  readonly #intents = new Map<string, EffectIntentRecord>();
  readonly #receipts = new Map<string, EffectReceiptRecord[]>();
  public jobFenceCurrent = true;
  public resourceFenceCurrent = true;

  public addIntent(intent: EffectIntentRecord): void {
    this.#intents.set(intent.id, intent);
  }

  public async getIntent(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<EffectIntentRecord | null> {
    const intent = this.#intents.get(intentId);
    return intent?.tenantId === tenantId && intent.projectId === projectId ? intent : null;
  }

  public async listReceipts(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<readonly EffectReceiptRecord[]> {
    const intent = this.#intents.get(intentId);
    return intent?.tenantId === tenantId && intent.projectId === projectId
      ? [...(this.#receipts.get(intentId) ?? [])]
      : [];
  }

  public async beginExternalOperation(
    intentId: string,
    expectedStatus: EffectStatus,
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
  ): Promise<EffectIntentRecord | null> {
    this.#assertFence(fence);
    const intent = this.#intents.get(intentId);
    if (
      intent === undefined ||
      intent.tenantId !== fence.tenantId ||
      intent.projectId !== fence.projectId ||
      intent.status !== expectedStatus
    ) {
      return null;
    }
    this.resourceFenceCurrent = true;
    const updated: EffectIntentRecord = {
      ...intent,
      status: nextStatus,
      fencingToken: String(BigInt(intent.fencingToken ?? "0") + 1n),
      updatedAt: new Date().toISOString(),
    };
    this.#intents.set(intent.id, updated);
    return updated;
  }

  public async transition(
    intentId: string,
    expectedStatus: EffectStatus | readonly EffectStatus[],
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
  ): Promise<EffectIntentRecord | null> {
    this.#assertFence(fence);
    const intent = this.#intents.get(intentId);
    const expected = typeof expectedStatus === "string" ? [expectedStatus] : expectedStatus;
    if (
      intent === undefined ||
      intent.tenantId !== fence.tenantId ||
      intent.projectId !== fence.projectId ||
      !expected.includes(intent.status)
    ) {
      return null;
    }
    const updated: EffectIntentRecord = {
      ...intent,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    this.#intents.set(intentId, updated);
    return updated;
  }

  public async appendReceipt(
    input: AppendReceiptInput,
    fence: EffectMutationFence,
  ): Promise<EffectReceiptRecord> {
    this.#assertFence(fence);
    if (input.tenantId !== fence.tenantId || input.projectId !== fence.projectId) {
      throw new TypeError("Receipt tenant/project does not match job fence");
    }
    return this.#append(input);
  }

  public async isResourceFenceCurrent(): Promise<boolean> {
    return this.resourceFenceCurrent;
  }

  public async recordManualReceipt(
    input: AppendReceiptInput,
    _expectedStatus: EffectStatus,
    terminalStatus: EffectStatus,
  ): Promise<EffectReceiptRecord> {
    const existing = this.#receipts.get(input.intentId)?.find((receipt) => receipt.id === input.id);
    if (existing !== undefined) return existing;
    const receipt = this.#append(input);
    const intent = this.#intents.get(input.intentId);
    if (intent === undefined) throw new Error("intent not found");
    this.#intents.set(intent.id, { ...intent, status: terminalStatus });
    return receipt;
  }

  #append(input: AppendReceiptInput): EffectReceiptRecord {
    const existing = this.#receipts.get(input.intentId) ?? [];
    const receipt: EffectReceiptRecord = {
      id: input.id ?? crypto.randomUUID(),
      tenantId: input.tenantId,
      projectId: input.projectId,
      intentId: input.intentId,
      sequence: existing.length + 1,
      ...(input.externalTransactionId === undefined
        ? {}
        : { externalTransactionId: input.externalTransactionId }),
      externalStatus: input.externalStatus,
      ...(input.beforeDigest === undefined ? {} : { beforeDigest: input.beforeDigest }),
      ...(input.afterDigest === undefined ? {} : { afterDigest: input.afterDigest }),
      actualEffects: input.actualEffects ?? {},
      ...(input.rawResponseRef === undefined ? {} : { rawResponseRef: input.rawResponseRef }),
      ...(input.compensationStatus === undefined
        ? {}
        : { compensationStatus: input.compensationStatus }),
      ...(input.committedAt === undefined ? {} : { committedAt: input.committedAt }),
      createdAt: new Date().toISOString(),
    };
    this.#receipts.set(input.intentId, [...existing, receipt]);
    return receipt;
  }

  #assertFence(fence: EffectMutationFence): void {
    if (!this.jobFenceCurrent) throw new JobFenceLostError(fence.jobId);
  }
}

import type { ConnectorReceiptDraft, EffectConnector } from "../../src/connectors/types.js";

export class TestOnlyConnector implements EffectConnector {
  public readonly type = "test-only";
  public readonly mode = "automatic-write" as const;
  public readonly capabilities = Object.freeze({
    supportsIdempotencyKey: true,
    supportsQueryByIdempotencyKey: true,
    supportsQueryByExternalId: true,
    supportsConditionalWrite: true,
    supportsFencingToken: true,
    supportsCompensation: true,
    supportsStateDigests: true,
    supportsDryRun: true,
    supportsHumanApproval: true,
    reversibility: "R0" as const,
  });
  readonly #executed = new Map<string, ConnectorReceiptDraft>();
  readonly #compensated = new Map<string, ConnectorReceiptDraft>();
  public executeCalls = 0;
  public externalWrites = 0;
  public reconcileCalls = 0;
  public compensateCalls = 0;
  public reconcileCompensationCalls = 0;
  public forceUnknownReconciliation = false;
  public beforeExecute: (() => void) | undefined;
  public lastFencingToken: string | undefined;

  public async execute(context: Parameters<EffectConnector["execute"]>[0]) {
    this.executeCalls += 1;
    this.beforeExecute?.();
    await context.assertCurrentFence();
    this.externalWrites += 1;
    this.lastFencingToken = context.fencingToken;
    const receipt: ConnectorReceiptDraft = {
      externalTransactionId: crypto.randomUUID(),
      externalStatus: "committed",
      actualEffects: { target: context.intent.target },
    };
    this.#executed.set(context.intent.idempotencyKey, receipt);
    return { kind: "SUCCEEDED" as const, receipt };
  }

  public async reconcile(context: Parameters<EffectConnector["reconcile"]>[0]) {
    this.reconcileCalls += 1;
    if (this.forceUnknownReconciliation) {
      return { kind: "UNKNOWN" as const, reason: "test injected ambiguity" };
    }
    const receipt = this.#executed.get(context.intent.idempotencyKey);
    return receipt === undefined
      ? { kind: "NOT_FOUND" as const, definitive: true }
      : { kind: "FOUND" as const, receipt };
  }

  public async compensate(context: Parameters<NonNullable<EffectConnector["compensate"]>>[0]) {
    this.compensateCalls += 1;
    await context.assertCurrentFence();
    const receipt: ConnectorReceiptDraft = {
      externalTransactionId: crypto.randomUUID(),
      externalStatus: "compensated",
      actualEffects: { target: context.intent.target },
    };
    this.#compensated.set(context.intent.idempotencyKey, receipt);
    return { kind: "SUCCEEDED" as const, receipt };
  }

  public async reconcileCompensation(
    context: Parameters<NonNullable<EffectConnector["reconcileCompensation"]>>[0],
  ) {
    this.reconcileCompensationCalls += 1;
    const receipt = this.#compensated.get(context.intent.idempotencyKey);
    return receipt === undefined
      ? { kind: "NOT_FOUND" as const, definitive: true }
      : { kind: "FOUND" as const, receipt };
  }
}

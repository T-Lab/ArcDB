import { createHash } from "node:crypto";
import type { EffectIntentStatus } from "@arcdb/contracts";
import type { EffectIntentRecord, EffectReceiptRecord, EffectStatus } from "@arcdb/db";
import { canTransitionEffectIntent } from "@arcdb/lifecycle";
import { z } from "zod";
import type { ConnectorRegistry } from "./connectors/registry.js";
import type {
  CompensateEffectOutcome,
  ConnectorOperationContext,
  ConnectorReceiptDraft,
  EffectConnector,
  ExecuteEffectOutcome,
  ReconcileEffectOutcome,
} from "./connectors/types.js";
import type { EffectMutationFence, EffectStore } from "./effect-store.js";
import { ConnectorOperationError, UnsafeConnectorError, WorkerRuntimeError } from "./errors.js";
import type { JobExecutionContext, JobResult } from "./job-types.js";
import type { JobHandlerRegistry } from "./registry.js";
import { NOOP_WORKER_TELEMETRY, type WorkerTelemetry } from "./telemetry.js";

const EffectJobPayloadSchema = z.object({ intentId: z.string().uuid() }).strict();

export interface EffectRuntimeFaultHooks {
  /** Fault-injection seam for the external-success / pre-receipt crash window. */
  readonly afterExternalSuccess?: (intent: EffectIntentRecord) => Promise<void>;
  /** Fault-injection seam for the receipt / pre-status crash window. */
  readonly afterReceiptPersisted?: (
    intent: EffectIntentRecord,
    receipt: EffectReceiptRecord,
  ) => Promise<void>;
  readonly afterCompensationSuccess?: (intent: EffectIntentRecord) => Promise<void>;
}

export interface EffectRuntimeOptions {
  readonly store: EffectStore;
  readonly connectors: ConnectorRegistry;
  readonly telemetry?: WorkerTelemetry;
  readonly hooks?: EffectRuntimeFaultHooks;
  readonly approvalGuard?: (intent: EffectIntentRecord) => Promise<boolean>;
  readonly now?: () => Date;
  readonly receiptId?: (
    intent: EffectIntentRecord,
    outcome: "EXECUTED" | "COMPENSATED",
    draft: ConnectorReceiptDraft,
  ) => string;
}

function deterministicReceiptId(
  intent: EffectIntentRecord,
  outcome: "EXECUTED" | "COMPENSATED",
  draft: ConnectorReceiptDraft,
): string {
  const hex = createHash("sha256")
    .update(
      `${intent.tenantId}\u0000${intent.id}\u0000${outcome}\u0000${draft.externalTransactionId ?? intent.idempotencyKey}`,
    )
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function executionReceipt(receipt: EffectReceiptRecord): boolean {
  return receipt.actualEffects.arcdbOutcome === "EXECUTED";
}

function compensationReceipt(receipt: EffectReceiptRecord): boolean {
  return (
    receipt.actualEffects.arcdbOutcome === "COMPENSATED" ||
    receipt.compensationStatus === "COMPENSATED"
  );
}

function terminalStatus(intent: EffectIntentRecord): EffectStatus {
  return intent.reversibility === "R3" ? "IRREVERSIBLE_COMMITTED" : "COMMITTED";
}

function assertProject(job: JobExecutionContext["job"], intent: EffectIntentRecord): void {
  if (job.tenantId !== intent.tenantId || job.projectId !== intent.projectId) {
    throw new WorkerRuntimeError(
      "EFFECT_SCOPE_MISMATCH",
      "Effect intent does not belong to the durable job tenant/project",
    );
  }
}

function requireEffectProject(job: JobExecutionContext["job"]): string {
  if (job.projectId === undefined) {
    throw new WorkerRuntimeError(
      "EFFECT_SCOPE_MISMATCH",
      "Effect jobs require an explicit project scope",
    );
  }
  return job.projectId;
}

export class EffectRuntime {
  readonly #store: EffectStore;
  readonly #connectors: ConnectorRegistry;
  readonly #telemetry: WorkerTelemetry;
  readonly #hooks: EffectRuntimeFaultHooks;
  readonly #approvalGuard: ((intent: EffectIntentRecord) => Promise<boolean>) | undefined;
  readonly #now: () => Date;
  readonly #receiptId: (
    intent: EffectIntentRecord,
    outcome: "EXECUTED" | "COMPENSATED",
    draft: ConnectorReceiptDraft,
  ) => string;

  public constructor(options: EffectRuntimeOptions) {
    this.#store = options.store;
    this.#connectors = options.connectors;
    this.#telemetry = options.telemetry ?? NOOP_WORKER_TELEMETRY;
    this.#hooks = options.hooks ?? {};
    this.#approvalGuard = options.approvalGuard;
    this.#now = options.now ?? (() => new Date());
    this.#receiptId = options.receiptId ?? deterministicReceiptId;
  }

  public readonly reconcileEffect = async (context: JobExecutionContext): Promise<JobResult> => {
    const payload = EffectJobPayloadSchema.parse(context.job.payload);
    const projectId = requireEffectProject(context.job);
    let intent = await this.#requireIntent(context.job.tenantId, projectId, payload.intentId);
    assertProject(context.job, intent);
    const connector = await this.#resolveConnectorOrMarkReconciliation(context, intent);
    const receipts = await this.#store.listReceipts(intent.tenantId, intent.projectId, intent.id);
    const recovered = receipts.find(executionReceipt);
    if (recovered !== undefined) {
      intent = await this.#finalizeExecutionReceipt(context, intent);
      this.#telemetry.reconciliation(connector.type, "receipt_already_persisted");
      return { intentId: intent.id, status: intent.status, recovered: true };
    }

    if (
      intent.status === "COMMITTED" ||
      intent.status === "IRREVERSIBLE_COMMITTED" ||
      intent.status === "COMPENSATED" ||
      intent.status === "REMEDIATION_REQUIRED"
    ) {
      return { intentId: intent.id, status: intent.status, idempotent: true };
    }

    if (connector.mode === "manual-receipt") {
      if (intent.status !== "RECONCILIATION_REQUIRED") {
        const outcome = await connector.execute(this.#connectorContext(context, intent, false));
        if (outcome.kind !== "WAITING_FOR_MANUAL_RECEIPT") {
          throw new UnsafeConnectorError(
            connector.type,
            "manual connector attempted automatic work",
          );
        }
        intent = await this.#moveToReconciliation(context, intent);
      }
      this.#telemetry.reconciliation(connector.type, "waiting_for_manual_receipt");
      return {
        intentId: intent.id,
        status: intent.status,
        waitingForManualReceipt: true,
      };
    }

    if (intent.status === "EXECUTING" || intent.status === "RECONCILIATION_REQUIRED") {
      return this.#reconcileUnknownExecution(context, intent, connector);
    }
    if (intent.status !== "PREPARED" && intent.status !== "FAILED") {
      throw new WorkerRuntimeError(
        "EFFECT_STATE_NOT_EXECUTABLE",
        `Effect ${intent.id} cannot execute from ${intent.status}`,
      );
    }
    return this.#executePrepared(context, intent, connector);
  };

  public readonly runCompensation = async (context: JobExecutionContext): Promise<JobResult> => {
    const payload = EffectJobPayloadSchema.parse(context.job.payload);
    const projectId = requireEffectProject(context.job);
    let intent = await this.#requireIntent(context.job.tenantId, projectId, payload.intentId);
    assertProject(context.job, intent);
    const connector = await this.#resolveConnectorOrMarkReconciliation(context, intent);
    if (!connector.capabilities.supportsCompensation || connector.compensate === undefined) {
      if (intent.status !== "REMEDIATION_REQUIRED") {
        intent = await this.#transition(context, intent, "REMEDIATION_REQUIRED");
      }
      return { intentId: intent.id, status: intent.status, compensationSupported: false };
    }
    if (intent.compensationHandler === undefined) {
      if (intent.status !== "REMEDIATION_REQUIRED") {
        intent = await this.#transition(context, intent, "REMEDIATION_REQUIRED");
      }
      return { intentId: intent.id, status: intent.status, compensationHandler: false };
    }

    const receipts = await this.#store.listReceipts(intent.tenantId, intent.projectId, intent.id);
    const recovered = receipts.find(compensationReceipt);
    if (recovered !== undefined) {
      intent = await this.#finalizeCompensationReceipt(context, intent);
      this.#telemetry.reconciliation(connector.type, "compensation_receipt_already_persisted");
      return { intentId: intent.id, status: intent.status, recovered: true };
    }
    if (intent.status === "COMPENSATED") {
      return { intentId: intent.id, status: intent.status, idempotent: true };
    }

    let firstAttempt = false;
    if (intent.status === "COMMITTED" || intent.status === "REMEDIATION_REQUIRED") {
      intent = await this.#beginExternalOperation(context, intent, "COMPENSATION_PENDING");
      firstAttempt = true;
    }
    if (intent.status === "RECONCILIATION_REQUIRED") {
      return this.#reconcileUnknownCompensation(context, intent, connector);
    }
    if (intent.status !== "COMPENSATION_PENDING") {
      throw new WorkerRuntimeError(
        "EFFECT_STATE_NOT_COMPENSATABLE",
        `Effect ${intent.id} cannot compensate from ${intent.status}`,
      );
    }
    if (!firstAttempt) return this.#reconcileUnknownCompensation(context, intent, connector);
    return this.#compensate(context, intent, connector);
  };

  async #requireIntent(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<EffectIntentRecord> {
    const intent = await this.#store.getIntent(tenantId, projectId, intentId);
    if (intent === null) {
      throw new WorkerRuntimeError(
        "EFFECT_INTENT_NOT_FOUND",
        `Effect intent ${intentId} was not found`,
      );
    }
    return intent;
  }

  async #resolveConnectorOrMarkReconciliation(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
  ): Promise<EffectConnector> {
    try {
      return this.#connectors.resolveForIntent(intent);
    } catch (error) {
      if (
        intent.status === "PREPARED" ||
        intent.status === "EXECUTING" ||
        intent.status === "FAILED" ||
        intent.status === "COMPENSATION_PENDING"
      ) {
        await this.#moveToReconciliation(context, intent);
      }
      throw error;
    }
  }

  #mutationFence(context: JobExecutionContext, intent: EffectIntentRecord): EffectMutationFence {
    return {
      tenantId: intent.tenantId,
      projectId: intent.projectId,
      jobId: context.job.id,
      workerId: context.job.lockedBy ?? "",
      jobFencingToken: context.job.fencingToken,
    };
  }

  async #transition(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    nextStatus: EffectStatus,
  ): Promise<EffectIntentRecord> {
    if (intent.status === nextStatus) return intent;
    if (
      !canTransitionEffectIntent(
        intent.status as EffectIntentStatus,
        nextStatus as EffectIntentStatus,
      )
    ) {
      throw new WorkerRuntimeError(
        "INVALID_EFFECT_TRANSITION",
        `Effect ${intent.id} cannot transition from ${intent.status} to ${nextStatus}`,
      );
    }
    await context.assertCurrentFence();
    const updated = await this.#store.transition(
      intent.id,
      intent.status,
      nextStatus,
      this.#mutationFence(context, intent),
    );
    if (updated === null) {
      throw new WorkerRuntimeError(
        "EFFECT_STATE_CONFLICT",
        `Effect ${intent.id} changed concurrently from ${intent.status}`,
        { retryable: true },
      );
    }
    return updated;
  }

  async #beginExternalOperation(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    nextStatus: EffectStatus,
  ): Promise<EffectIntentRecord> {
    if (
      !canTransitionEffectIntent(
        intent.status as EffectIntentStatus,
        nextStatus as EffectIntentStatus,
      )
    ) {
      throw new WorkerRuntimeError(
        "INVALID_EFFECT_TRANSITION",
        `Effect ${intent.id} cannot transition from ${intent.status} to ${nextStatus}`,
      );
    }
    await context.assertCurrentFence();
    const leaseSeconds = Math.min(
      3_600,
      Math.max(30, Math.ceil((context.job.timeoutMs + 30_000) / 1_000)),
    );
    const updated = await this.#store.beginExternalOperation(
      intent.id,
      intent.status,
      nextStatus,
      this.#mutationFence(context, intent),
      leaseSeconds,
    );
    if (updated === null) {
      throw new WorkerRuntimeError(
        "EFFECT_STATE_CONFLICT",
        `Effect ${intent.id} changed concurrently from ${intent.status}`,
        { retryable: true },
      );
    }
    return updated;
  }

  async #moveToReconciliation(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
  ): Promise<EffectIntentRecord> {
    if (intent.status === "RECONCILIATION_REQUIRED") return intent;
    return this.#transition(context, intent, "RECONCILIATION_REQUIRED");
  }

  async #assertExternalFence(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
  ): Promise<void> {
    await context.assertCurrentFence();
    if (intent.fencingToken === undefined) {
      throw new UnsafeConnectorError(intent.connectorType, "resource fencing token is absent");
    }
    const resourceCurrent = await this.#store.isResourceFenceCurrent(
      intent.tenantId,
      intent.projectId,
      intent.resourceKey,
      intent.fencingToken,
    );
    if (!resourceCurrent) {
      throw new WorkerRuntimeError(
        "RESOURCE_FENCE_LOST",
        `Effect ${intent.id} lost resource fence ${intent.fencingToken}`,
        { retryable: true },
      );
    }
  }

  #connectorContext(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    requireResourceFence: boolean,
  ): ConnectorOperationContext {
    return {
      intent,
      signal: context.signal,
      ...(intent.fencingToken === undefined ? {} : { fencingToken: intent.fencingToken }),
      assertCurrentFence: async () => {
        if (requireResourceFence) await this.#assertExternalFence(context, intent);
        else await context.assertCurrentFence();
      },
    };
  }

  async #executePrepared(
    context: JobExecutionContext,
    original: EffectIntentRecord,
    connector: EffectConnector,
  ): Promise<JobResult> {
    if (original.reversibility === "R3") {
      const approved = (await this.#approvalGuard?.(original)) ?? false;
      if (!approved) {
        await this.#moveToReconciliation(context, original);
        throw new UnsafeConnectorError(
          connector.type,
          "R3 automatic execution requires a verified human approval",
        );
      }
    }
    let intent = await this.#beginExternalOperation(context, original, "EXECUTING");
    try {
      const outcome = await connector.execute(this.#connectorContext(context, intent, true));
      await this.#assertExternalFence(context, intent);
      return await this.#handleExecutionOutcome(context, intent, connector, outcome);
    } catch (error) {
      if (error instanceof ConnectorOperationError) throw error;
      intent = await this.#moveToReconciliation(context, intent);
      throw new ConnectorOperationError(connector.type, "execute", "external outcome is unknown", {
        retryable: true,
        externalOutcome: "UNKNOWN",
        cause: error,
      });
    }
  }

  async #handleExecutionOutcome(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    connector: EffectConnector,
    outcome: ExecuteEffectOutcome,
  ): Promise<JobResult> {
    if (outcome.kind === "SUCCEEDED") {
      await this.#hooks.afterExternalSuccess?.(intent);
      const receipt = await this.#persistReceipt(context, intent, outcome.receipt, "EXECUTED");
      await this.#hooks.afterReceiptPersisted?.(intent, receipt);
      const finalized = await this.#finalizeExecutionReceipt(context, intent);
      this.#telemetry.reconciliation(connector.type, "executed");
      return { intentId: finalized.id, status: finalized.status, recovered: false };
    }
    if (outcome.kind === "WAITING_FOR_MANUAL_RECEIPT") {
      const waiting = await this.#moveToReconciliation(context, intent);
      return { intentId: waiting.id, status: waiting.status, waitingForManualReceipt: true };
    }
    if (outcome.kind === "UNKNOWN") {
      const unknown = await this.#moveToReconciliation(context, intent);
      this.#telemetry.reconciliation(connector.type, "unknown");
      return { intentId: unknown.id, status: unknown.status, externalOutcome: "unknown" };
    }
    const failed = await this.#transition(context, intent, "FAILED");
    if (outcome.retryable) {
      throw new ConnectorOperationError(
        connector.type,
        "execute",
        "connector reported a definitive failure",
        {
          retryable: true,
          externalOutcome: "KNOWN",
        },
      );
    }
    return { intentId: failed.id, status: failed.status, retryable: false };
  }

  async #reconcileUnknownExecution(
    context: JobExecutionContext,
    original: EffectIntentRecord,
    connector: EffectConnector,
  ): Promise<JobResult> {
    let intent = await this.#moveToReconciliation(context, original);
    if (
      !connector.capabilities.supportsQueryByIdempotencyKey &&
      !connector.capabilities.supportsQueryByExternalId
    ) {
      this.#telemetry.reconciliation(connector.type, "unsupported");
      return { intentId: intent.id, status: intent.status, externalOutcome: "unknown" };
    }
    let outcome: ReconcileEffectOutcome;
    try {
      outcome = await connector.reconcile(this.#connectorContext(context, intent, false));
      await context.assertCurrentFence();
    } catch (error) {
      throw new ConnectorOperationError(connector.type, "reconcile", "query failed", {
        retryable: true,
        externalOutcome: "UNKNOWN",
        cause: error,
      });
    }
    if (outcome.kind === "FOUND") {
      await this.#persistReceipt(context, intent, outcome.receipt, "EXECUTED");
      intent = await this.#finalizeExecutionReceipt(context, intent);
      this.#telemetry.reconciliation(connector.type, "found");
      return { intentId: intent.id, status: intent.status, recovered: true };
    }
    if (
      outcome.kind === "NOT_FOUND" &&
      outcome.definitive &&
      connector.capabilities.supportsIdempotencyKey
    ) {
      intent = await this.#transition(context, intent, "FAILED");
      this.#telemetry.reconciliation(connector.type, "definitive_not_found");
      throw new ConnectorOperationError(
        connector.type,
        "reconcile",
        "effect was definitively not found",
        {
          retryable: true,
          externalOutcome: "KNOWN",
        },
      );
    }
    this.#telemetry.reconciliation(connector.type, "unknown");
    return { intentId: intent.id, status: intent.status, externalOutcome: "unknown" };
  }

  async #persistReceipt(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    draft: ConnectorReceiptDraft,
    arcdbOutcome: "EXECUTED" | "COMPENSATED",
  ): Promise<EffectReceiptRecord> {
    await context.assertCurrentFence();
    return this.#store.appendReceipt(
      {
        id: this.#receiptId(intent, arcdbOutcome, draft),
        tenantId: intent.tenantId,
        projectId: intent.projectId,
        intentId: intent.id,
        ...(draft.externalTransactionId === undefined
          ? {}
          : { externalTransactionId: draft.externalTransactionId }),
        externalStatus: draft.externalStatus,
        ...(draft.beforeDigest === undefined ? {} : { beforeDigest: draft.beforeDigest }),
        ...(draft.afterDigest === undefined ? {} : { afterDigest: draft.afterDigest }),
        actualEffects: { ...draft.actualEffects, arcdbOutcome },
        ...(draft.rawResponseRef === undefined ? {} : { rawResponseRef: draft.rawResponseRef }),
        ...(arcdbOutcome === "COMPENSATED" ? { compensationStatus: "COMPENSATED" } : {}),
        committedAt: draft.committedAt ?? this.#now().toISOString(),
      },
      this.#mutationFence(context, intent),
    );
  }

  async #finalizeExecutionReceipt(
    context: JobExecutionContext,
    original: EffectIntentRecord,
  ): Promise<EffectIntentRecord> {
    const desired = terminalStatus(original);
    let intent = original;
    if (intent.status === desired) return intent;
    if (
      !canTransitionEffectIntent(intent.status as EffectIntentStatus, desired as EffectIntentStatus)
    ) {
      intent = await this.#moveToReconciliation(context, intent);
    }
    return this.#transition(context, intent, desired);
  }

  async #compensate(
    context: JobExecutionContext,
    original: EffectIntentRecord,
    connector: EffectConnector,
  ): Promise<JobResult> {
    if (connector.compensate === undefined) {
      throw new UnsafeConnectorError(connector.type, "compensation handler is absent");
    }
    let intent = original;
    try {
      await this.#assertExternalFence(context, intent);
      const outcome = await connector.compensate(this.#connectorContext(context, intent, true));
      await this.#assertExternalFence(context, intent);
      if (outcome.kind === "SUCCEEDED") {
        await this.#hooks.afterCompensationSuccess?.(intent);
        await this.#persistReceipt(context, intent, outcome.receipt, "COMPENSATED");
        intent = await this.#finalizeCompensationReceipt(context, intent);
        return { intentId: intent.id, status: intent.status };
      }
      return this.#handleCompensationFailure(context, intent, connector, outcome);
    } catch (error) {
      if (error instanceof ConnectorOperationError) throw error;
      intent = await this.#moveToReconciliation(context, intent);
      throw new ConnectorOperationError(
        connector.type,
        "compensate",
        "external outcome is unknown",
        {
          retryable: true,
          externalOutcome: "UNKNOWN",
          cause: error,
        },
      );
    }
  }

  async #handleCompensationFailure(
    context: JobExecutionContext,
    intent: EffectIntentRecord,
    connector: EffectConnector,
    outcome: Exclude<CompensateEffectOutcome, { readonly kind: "SUCCEEDED" }>,
  ): Promise<JobResult> {
    if (outcome.kind === "UNKNOWN") {
      const unknown = await this.#moveToReconciliation(context, intent);
      return { intentId: unknown.id, status: unknown.status, externalOutcome: "unknown" };
    }
    const remediation = await this.#transition(context, intent, "REMEDIATION_REQUIRED");
    if (outcome.retryable) {
      throw new ConnectorOperationError(
        connector.type,
        "compensate",
        "connector reported a definitive failure",
        {
          retryable: true,
          externalOutcome: "KNOWN",
        },
      );
    }
    return { intentId: remediation.id, status: remediation.status, retryable: false };
  }

  async #reconcileUnknownCompensation(
    context: JobExecutionContext,
    original: EffectIntentRecord,
    connector: EffectConnector,
  ): Promise<JobResult> {
    let intent = await this.#moveToReconciliation(context, original);
    if (connector.reconcileCompensation === undefined) {
      return { intentId: intent.id, status: intent.status, externalOutcome: "unknown" };
    }
    let outcome: ReconcileEffectOutcome;
    try {
      outcome = await connector.reconcileCompensation(
        this.#connectorContext(context, intent, false),
      );
      await context.assertCurrentFence();
    } catch (error) {
      throw new ConnectorOperationError(connector.type, "reconcileCompensation", "query failed", {
        retryable: true,
        externalOutcome: "UNKNOWN",
        cause: error,
      });
    }
    if (outcome.kind === "FOUND") {
      await this.#persistReceipt(context, intent, outcome.receipt, "COMPENSATED");
      intent = await this.#finalizeCompensationReceipt(context, intent);
      return { intentId: intent.id, status: intent.status, recovered: true };
    }
    if (
      outcome.kind === "NOT_FOUND" &&
      outcome.definitive &&
      connector.capabilities.supportsIdempotencyKey
    ) {
      intent = await this.#beginExternalOperation(context, intent, "COMPENSATION_PENDING");
      return this.#compensate(context, intent, connector);
    }
    return { intentId: intent.id, status: intent.status, externalOutcome: "unknown" };
  }

  async #finalizeCompensationReceipt(
    context: JobExecutionContext,
    original: EffectIntentRecord,
  ): Promise<EffectIntentRecord> {
    let intent = original;
    if (intent.status === "COMPENSATED") return intent;
    if (intent.status === "RECONCILIATION_REQUIRED") {
      intent = await this.#transition(context, intent, "COMPENSATION_PENDING");
    }
    return this.#transition(context, intent, "COMPENSATED");
  }
}

export function registerEffectJobHandlers(
  registry: JobHandlerRegistry,
  runtime: EffectRuntime,
): JobHandlerRegistry {
  registry.register("reconcile_effect", runtime.reconcileEffect);
  registry.register("run_compensation", runtime.runCompensation);
  return registry;
}

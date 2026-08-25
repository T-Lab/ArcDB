import type {
  ConnectorCapabilities,
  EffectIntentStatus,
  Reversibility,
  RiskLevel,
} from "@arcdb/contracts";
import type { EffectIntentRecord, JsonObject } from "@arcdb/db";

export type ConnectorMode = "automatic-write" | "manual-receipt";

export interface ConnectorReceiptDraft {
  readonly externalTransactionId?: string;
  readonly externalStatus: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly actualEffects: JsonObject;
  readonly rawResponseRef?: string;
  readonly committedAt?: string;
}

export type ExecuteEffectOutcome =
  | { readonly kind: "SUCCEEDED"; readonly receipt: ConnectorReceiptDraft }
  | { readonly kind: "WAITING_FOR_MANUAL_RECEIPT"; readonly reason: string }
  | { readonly kind: "DEFINITIVE_FAILURE"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "UNKNOWN"; readonly reason: string };

export type ReconcileEffectOutcome =
  | { readonly kind: "FOUND"; readonly receipt: ConnectorReceiptDraft }
  | { readonly kind: "NOT_FOUND"; readonly definitive: boolean; readonly reason?: string }
  | { readonly kind: "UNKNOWN"; readonly reason: string };

export type CompensateEffectOutcome =
  | { readonly kind: "SUCCEEDED"; readonly receipt: ConnectorReceiptDraft }
  | { readonly kind: "DEFINITIVE_FAILURE"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "UNKNOWN"; readonly reason: string };

export interface ConnectorOperationContext {
  readonly intent: EffectIntentRecord;
  readonly signal: AbortSignal;
  readonly fencingToken?: string;
  readonly assertCurrentFence: () => Promise<void>;
}

export interface EffectConnector {
  readonly type: string;
  readonly mode: ConnectorMode;
  readonly capabilities: ConnectorCapabilities;
  execute(context: ConnectorOperationContext): Promise<ExecuteEffectOutcome>;
  reconcile(context: ConnectorOperationContext): Promise<ReconcileEffectOutcome>;
  compensate?(context: ConnectorOperationContext): Promise<CompensateEffectOutcome>;
  reconcileCompensation?(context: ConnectorOperationContext): Promise<ReconcileEffectOutcome>;
}

export interface ManualReceiptInput {
  readonly tenantId: string;
  readonly projectId: string;
  readonly intentId: string;
  readonly receiptId: string;
  readonly externalTransactionId?: string;
  readonly externalStatus: string;
  readonly beforeDigest?: string;
  readonly afterDigest?: string;
  readonly actualEffects: JsonObject;
  readonly rawResponseRef?: string;
  readonly committedAt?: string;
}

export type EffectSummary = {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly connectorType: string;
  readonly reversibility: Reversibility;
  readonly riskLevel: RiskLevel;
  readonly status: EffectIntentStatus;
};

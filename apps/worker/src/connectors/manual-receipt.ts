import { MANUAL_RECEIPT_CONNECTOR_CAPABILITIES } from "@arcdb/contracts";
import type { EffectConnector } from "./types.js";

/**
 * Production-safe fallback: it performs no external write. A caller with
 * effect:commit permission must later submit an immutable receipt through the
 * ManualReceiptService.
 */
export class ManualReceiptConnector implements EffectConnector {
  public readonly type = "manual-receipt";
  public readonly mode = "manual-receipt" as const;
  public readonly capabilities = MANUAL_RECEIPT_CONNECTOR_CAPABILITIES;

  public async execute(): Promise<{
    readonly kind: "WAITING_FOR_MANUAL_RECEIPT";
    readonly reason: string;
  }> {
    return {
      kind: "WAITING_FOR_MANUAL_RECEIPT",
      reason: "No external write was attempted; an authorized user must record a receipt",
    };
  }

  public async reconcile(): Promise<{ readonly kind: "UNKNOWN"; readonly reason: string }> {
    return {
      kind: "UNKNOWN",
      reason: "Manual connector cannot inspect an external system; waiting for a user receipt",
    };
  }
}

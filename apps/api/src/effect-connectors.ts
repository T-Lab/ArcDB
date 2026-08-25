import {
  type ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  canonicalDigest,
  MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
  type Reversibility,
  type RiskLevel,
} from "@arcdb/contracts";

export { MANUAL_RECEIPT_CONNECTOR_CAPABILITIES };

export const REGISTERED_EFFECT_CONNECTOR_TYPES = ["manual-receipt"] as const;
export type RegisteredEffectConnectorType = (typeof REGISTERED_EFFECT_CONNECTOR_TYPES)[number];

export type EffectConnectorDefinition = {
  readonly type: RegisteredEffectConnectorType;
  readonly mode: "manual-receipt" | "automatic-write";
  readonly capabilities: ConnectorCapabilities;
};

export type EffectConnectorPolicyReason =
  | "NOT_REGISTERED"
  | "NOT_ALLOWED"
  | "CAPABILITIES_MISMATCH"
  | "REVERSIBILITY_MISMATCH"
  | "CONDITIONAL_WRITE_UNSUPPORTED"
  | "COMPENSATION_UNSUPPORTED"
  | "HUMAN_APPROVAL_UNSUPPORTED"
  | "MANUAL_RECEIPT_REQUIRED";

export class EffectConnectorPolicyError extends Error {
  public readonly connectorType: string;
  public readonly reason: EffectConnectorPolicyReason;

  public constructor(connectorType: string, reason: EffectConnectorPolicyReason, message: string) {
    super(message);
    this.name = "EffectConnectorPolicyError";
    this.connectorType = connectorType;
    this.reason = reason;
  }
}

const REGISTERED_CONNECTORS: ReadonlyMap<string, EffectConnectorDefinition> = new Map([
  [
    "manual-receipt",
    Object.freeze({
      type: "manual-receipt",
      mode: "manual-receipt",
      capabilities: MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
    }),
  ],
]);

function sameCapabilities(left: ConnectorCapabilities, right: ConnectorCapabilities): boolean {
  return (
    canonicalDigest(left, "connector-capabilities") ===
    canonicalDigest(right, "connector-capabilities")
  );
}

export type ConnectorPreparation = {
  readonly connectorType: string;
  readonly claimedCapabilities: unknown;
  readonly reversibility: Reversibility;
  readonly baseResourceVersion?: string;
  readonly compensationHandler?: string;
  readonly riskLevel: RiskLevel;
};

export type StoredConnectorIntent = {
  readonly connectorType: string;
  readonly connectorCapabilities: unknown;
  readonly reversibility: Reversibility;
  readonly baseResourceVersion?: string;
  readonly compensationHandler?: string;
  readonly riskLevel: RiskLevel;
};

export function assertManualReceiptConnector(
  connector: Pick<EffectConnectorDefinition, "type" | "mode">,
): void {
  if (connector.mode !== "manual-receipt") {
    throw new EffectConnectorPolicyError(
      connector.type,
      "MANUAL_RECEIPT_REQUIRED",
      `Connector ${connector.type} must record receipts through its worker execution path`,
    );
  }
}

/**
 * API-side connector registry. It contains only server-installed connector definitions; the
 * environment allowlist can remove definitions but cannot add or redefine one.
 */
export class EffectConnectorRegistry {
  readonly #allowed: ReadonlySet<string>;

  public constructor(allowedConnectors: readonly string[] = ["manual-receipt"]) {
    const allowed = new Set<string>();
    for (const connectorType of allowedConnectors) {
      if (!REGISTERED_CONNECTORS.has(connectorType)) {
        throw new EffectConnectorPolicyError(
          connectorType,
          "NOT_REGISTERED",
          `Configured connector ${connectorType} is not registered by this ArcDB build`,
        );
      }
      if (allowed.has(connectorType)) {
        throw new TypeError(`Configured connector ${connectorType} appears more than once`);
      }
      allowed.add(connectorType);
    }
    this.#allowed = allowed;
  }

  public resolve(connectorType: string): EffectConnectorDefinition {
    const connector = REGISTERED_CONNECTORS.get(connectorType);
    if (connector === undefined) {
      throw new EffectConnectorPolicyError(
        connectorType,
        "NOT_REGISTERED",
        `Connector ${connectorType} is not registered by this ArcDB build`,
      );
    }
    if (!this.#allowed.has(connectorType)) {
      throw new EffectConnectorPolicyError(
        connectorType,
        "NOT_ALLOWED",
        `Connector ${connectorType} is disabled by the server allowlist`,
      );
    }
    return connector;
  }

  public resolveForPreparation(input: ConnectorPreparation): EffectConnectorDefinition {
    const connector = this.resolve(input.connectorType);
    const claimed = ConnectorCapabilitiesSchema.safeParse(input.claimedCapabilities);
    if (!claimed.success || !sameCapabilities(claimed.data, connector.capabilities)) {
      throw new EffectConnectorPolicyError(
        input.connectorType,
        "CAPABILITIES_MISMATCH",
        "Caller-provided connector capabilities do not match the server registry",
      );
    }
    this.assertIntentCompatibility(connector, input);
    return connector;
  }

  public resolveForStoredIntent(input: StoredConnectorIntent): EffectConnectorDefinition {
    return this.resolveForPreparation({
      connectorType: input.connectorType,
      claimedCapabilities: input.connectorCapabilities,
      reversibility: input.reversibility,
      ...(input.baseResourceVersion === undefined
        ? {}
        : { baseResourceVersion: input.baseResourceVersion }),
      ...(input.compensationHandler === undefined
        ? {}
        : { compensationHandler: input.compensationHandler }),
      riskLevel: input.riskLevel,
    });
  }

  public resolveForManualReceipt(input: StoredConnectorIntent): EffectConnectorDefinition {
    const connector = this.resolveForStoredIntent(input);
    assertManualReceiptConnector(connector);
    return connector;
  }

  public types(): readonly RegisteredEffectConnectorType[] {
    return REGISTERED_EFFECT_CONNECTOR_TYPES.filter((type) => this.#allowed.has(type));
  }

  private assertIntentCompatibility(
    connector: EffectConnectorDefinition,
    input: Pick<
      ConnectorPreparation,
      "reversibility" | "baseResourceVersion" | "compensationHandler" | "riskLevel"
    >,
  ): void {
    if (connector.capabilities.reversibility !== input.reversibility) {
      throw new EffectConnectorPolicyError(
        connector.type,
        "REVERSIBILITY_MISMATCH",
        `Connector ${connector.type} supports ${connector.capabilities.reversibility}, not ${input.reversibility}`,
      );
    }
    if (
      input.baseResourceVersion !== undefined &&
      !connector.capabilities.supportsConditionalWrite
    ) {
      throw new EffectConnectorPolicyError(
        connector.type,
        "CONDITIONAL_WRITE_UNSUPPORTED",
        `Connector ${connector.type} does not support conditional writes`,
      );
    }
    if (
      (input.reversibility === "R0" || input.compensationHandler !== undefined) &&
      !connector.capabilities.supportsCompensation
    ) {
      throw new EffectConnectorPolicyError(
        connector.type,
        "COMPENSATION_UNSUPPORTED",
        `Connector ${connector.type} does not support compensation`,
      );
    }
    if (
      (input.reversibility === "R3" || input.riskLevel === "CRITICAL") &&
      !connector.capabilities.supportsHumanApproval
    ) {
      throw new EffectConnectorPolicyError(
        connector.type,
        "HUMAN_APPROVAL_UNSUPPORTED",
        `Connector ${connector.type} does not support required human approval`,
      );
    }
  }
}

import {
  type ConnectorCapabilities,
  ConnectorCapabilitiesSchema,
  canonicalDigest,
} from "@arcdb/contracts";
import type { EffectIntentRecord } from "@arcdb/db";
import { UnsafeConnectorError } from "../errors.js";
import type { EffectConnector } from "./types.js";

function sameCapabilities(left: ConnectorCapabilities, right: ConnectorCapabilities): boolean {
  return (
    canonicalDigest(left, "connector-capabilities") ===
    canonicalDigest(right, "connector-capabilities")
  );
}

export class ConnectorRegistry {
  readonly #connectors = new Map<string, EffectConnector>();
  readonly #allowlist: ReadonlySet<string> | undefined;

  public constructor(options: { readonly allowlist?: readonly string[] } = {}) {
    this.#allowlist = options.allowlist === undefined ? undefined : new Set(options.allowlist);
  }

  public register(connector: EffectConnector): this {
    if (this.#connectors.has(connector.type)) {
      throw new TypeError(`A connector is already registered for ${connector.type}`);
    }
    if (this.#allowlist !== undefined && !this.#allowlist.has(connector.type)) {
      throw new UnsafeConnectorError(connector.type, "connector type is not on the allowlist");
    }
    const capabilities = ConnectorCapabilitiesSchema.parse(connector.capabilities);
    if (connector.mode === "automatic-write") {
      if (!capabilities.supportsIdempotencyKey) {
        throw new UnsafeConnectorError(connector.type, "idempotency keys are required");
      }
      if (!capabilities.supportsQueryByIdempotencyKey) {
        throw new UnsafeConnectorError(
          connector.type,
          "query by idempotency key is required for the pre-receipt crash window",
        );
      }
      if (!capabilities.supportsFencingToken) {
        throw new UnsafeConnectorError(connector.type, "resource fencing is required");
      }
      if (capabilities.supportsCompensation && connector.compensate === undefined) {
        throw new UnsafeConnectorError(
          connector.type,
          "compensation capability is declared but no handler is implemented",
        );
      }
    } else if (!capabilities.supportsHumanApproval) {
      throw new UnsafeConnectorError(connector.type, "manual connectors require human approval");
    }
    // Bind prototype methods while freezing the validated capability snapshot.
    const registered: EffectConnector = Object.freeze({
      type: connector.type,
      mode: connector.mode,
      capabilities: Object.freeze(capabilities),
      execute: connector.execute.bind(connector),
      reconcile: connector.reconcile.bind(connector),
      ...(connector.compensate === undefined
        ? {}
        : { compensate: connector.compensate.bind(connector) }),
      ...(connector.reconcileCompensation === undefined
        ? {}
        : { reconcileCompensation: connector.reconcileCompensation.bind(connector) }),
    });
    this.#connectors.set(connector.type, registered);
    return this;
  }

  public resolve(type: string): EffectConnector {
    const connector = this.#connectors.get(type);
    if (connector === undefined) {
      throw new UnsafeConnectorError(type, "connector is not registered");
    }
    return connector;
  }

  public resolveForIntent(intent: EffectIntentRecord): EffectConnector {
    const connector = this.resolve(intent.connectorType);
    const preparedCapabilities = ConnectorCapabilitiesSchema.parse(intent.connectorCapabilities);
    if (!sameCapabilities(connector.capabilities, preparedCapabilities)) {
      throw new UnsafeConnectorError(
        connector.type,
        "registered capabilities differ from the immutable prepared snapshot",
      );
    }
    if (connector.capabilities.reversibility !== intent.reversibility) {
      throw new UnsafeConnectorError(
        connector.type,
        `declared reversibility ${connector.capabilities.reversibility} does not match ${intent.reversibility}`,
      );
    }
    if (intent.reversibility === "R0" && !connector.capabilities.supportsCompensation) {
      throw new UnsafeConnectorError(connector.type, "R0 effects require compensation support");
    }
    if (
      intent.baseResourceVersion !== undefined &&
      !connector.capabilities.supportsConditionalWrite
    ) {
      throw new UnsafeConnectorError(
        connector.type,
        "baseResourceVersion requires conditional writes",
      );
    }
    if (intent.riskLevel === "CRITICAL" && !connector.capabilities.supportsHumanApproval) {
      throw new UnsafeConnectorError(
        connector.type,
        "critical effects require human approval support",
      );
    }
    if (intent.reversibility === "R3" && !connector.capabilities.supportsHumanApproval) {
      throw new UnsafeConnectorError(connector.type, "R3 effects require human approval support");
    }
    if (connector.mode === "automatic-write" && intent.fencingToken === undefined) {
      throw new UnsafeConnectorError(
        connector.type,
        "the prepared intent has no resource fencing token",
      );
    }
    return connector;
  }

  public types(): readonly string[] {
    return [...this.#connectors.keys()].sort();
  }
}

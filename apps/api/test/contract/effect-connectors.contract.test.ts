import { describe, expect, it } from "vitest";
import { AllowedConnectorsSchema, readApiConfig } from "../../src/config.js";
import {
  assertManualReceiptConnector,
  EffectConnectorPolicyError,
  EffectConnectorRegistry,
  MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
} from "../../src/effect-connectors.js";

const manualPreparation = {
  connectorType: "manual-receipt",
  claimedCapabilities: { ...MANUAL_RECEIPT_CONNECTOR_CAPABILITIES },
  reversibility: "R3" as const,
  riskLevel: "HIGH" as const,
};

describe("effect connector configuration", () => {
  it("defaults to the sole v0.1 server-registered connector", () => {
    expect(AllowedConnectorsSchema.parse(undefined)).toEqual(["manual-receipt"]);
    expect(new EffectConnectorRegistry().types()).toEqual(["manual-receipt"]);
  });

  it("allows an empty allowlist to disable effects", () => {
    expect(AllowedConnectorsSchema.parse("")).toEqual([]);
    const registry = new EffectConnectorRegistry([]);
    expect(registry.types()).toEqual([]);
    expect(() => registry.resolve("manual-receipt")).toThrowError(
      expect.objectContaining({ reason: "NOT_ALLOWED" }),
    );
  });

  it("cannot enable unregistered or duplicate connectors through configuration", () => {
    expect(AllowedConnectorsSchema.safeParse("postgres").success).toBe(false);
    expect(AllowedConnectorsSchema.safeParse("manual-receipt,manual-receipt").success).toBe(false);
    expect(() => new EffectConnectorRegistry(["postgres"])).toThrowError(
      expect.objectContaining({ reason: "NOT_REGISTERED" }),
    );
  });

  it("reads the allowlist from an ambient process environment without treating PATH as config", () => {
    const environment = {
      PATH: "/usr/bin",
      ARCDB_DATABASE_URL: "postgresql://arcdb:arcdb@localhost:5432/arcdb",
      ARCDB_SYSTEM_DATABASE_URL: "postgresql://arcdb-system:arcdb@localhost:5432/arcdb",
      ARCDB_S3_ENDPOINT: "http://localhost:9000",
      ARCDB_S3_BUCKET: "arcdb-test",
      ARCDB_S3_ACCESS_KEY: "test",
      ARCDB_S3_SECRET_KEY: "test",
      ARCDB_ALLOWED_CONNECTORS: "manual-receipt",
    };
    expect(readApiConfig(environment).ARCDB_ALLOWED_CONNECTORS).toEqual(["manual-receipt"]);
    expect(() => readApiConfig({ ...environment, ARCDB_SYSTEM_DATABASE_URL: undefined })).toThrow();
    expect(() =>
      readApiConfig({
        ...environment,
        ARCDB_SYSTEM_DATABASE_URL: environment.ARCDB_DATABASE_URL,
      }),
    ).toThrow(/must be distinct/u);
    expect(() => readApiConfig({ ...environment, ARCDB_ALLOWED_CONNECTORS: "postgres" })).toThrow();
  });
});

describe("effect connector capability authority", () => {
  it("returns the frozen server snapshot after an exact client claim", () => {
    const clientClaim = { ...MANUAL_RECEIPT_CONNECTOR_CAPABILITIES };
    const connector = new EffectConnectorRegistry().resolveForPreparation({
      ...manualPreparation,
      claimedCapabilities: clientClaim,
    });
    expect(connector.capabilities).toBe(MANUAL_RECEIPT_CONNECTOR_CAPABILITIES);
    expect(connector.capabilities).not.toBe(clientClaim);
    expect(Object.isFrozen(connector.capabilities)).toBe(true);
  });

  it("rejects caller capability escalation", () => {
    const registry = new EffectConnectorRegistry();
    expect(() =>
      registry.resolveForPreparation({
        ...manualPreparation,
        claimedCapabilities: {
          ...MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
          supportsFencingToken: true,
          supportsConditionalWrite: true,
        },
      }),
    ).toThrowError(expect.objectContaining({ reason: "CAPABILITIES_MISMATCH" }));
  });

  it("rejects unknown connectors and unsupported intent semantics", () => {
    const registry = new EffectConnectorRegistry();
    expect(() =>
      registry.resolveForPreparation({ ...manualPreparation, connectorType: "shell" }),
    ).toThrow(EffectConnectorPolicyError);
    expect(() =>
      registry.resolveForPreparation({
        ...manualPreparation,
        baseResourceVersion: "resource-v1",
      }),
    ).toThrowError(expect.objectContaining({ reason: "CONDITIONAL_WRITE_UNSUPPORTED" }));
    expect(() =>
      registry.resolveForPreparation({
        ...manualPreparation,
        reversibility: "R0",
        compensationHandler: "undo",
      }),
    ).toThrowError(expect.objectContaining({ reason: "REVERSIBILITY_MISMATCH" }));
  });

  it("rejects disabled or capability-drifted stored intents before worker enqueue", () => {
    const storedIntent = {
      connectorType: "manual-receipt",
      connectorCapabilities: MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
      reversibility: "R3" as const,
      riskLevel: "HIGH" as const,
    };
    expect(() => new EffectConnectorRegistry([]).resolveForStoredIntent(storedIntent)).toThrowError(
      expect.objectContaining({ reason: "NOT_ALLOWED" }),
    );
    expect(() =>
      new EffectConnectorRegistry().resolveForStoredIntent({
        ...storedIntent,
        connectorCapabilities: {
          ...MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
          supportsDryRun: false,
        },
      }),
    ).toThrowError(expect.objectContaining({ reason: "CAPABILITIES_MISMATCH" }));
  });

  it("allows direct receipt submission only for manual-receipt execution mode", () => {
    expect(
      new EffectConnectorRegistry().resolveForManualReceipt({
        connectorType: "manual-receipt",
        connectorCapabilities: MANUAL_RECEIPT_CONNECTOR_CAPABILITIES,
        reversibility: "R3",
        riskLevel: "HIGH",
      }).mode,
    ).toBe("manual-receipt");
    expect(() =>
      assertManualReceiptConnector({ type: "manual-receipt", mode: "automatic-write" }),
    ).toThrowError(expect.objectContaining({ reason: "MANUAL_RECEIPT_REQUIRED" }));
  });
});

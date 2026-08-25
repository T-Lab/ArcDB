import { describe, expect, it } from "vitest";
import {
  OperatorInputError,
  parseAddEvidence,
  parseCreateLineage,
  parseCreateOutput,
  parseEffectOperation,
  parsePrepareEffect,
  parseRecordReceipt,
  parseTransitionRemediation,
} from "../operator-validation";

const PROJECT_ID = "8f3af96c-5e32-4d0e-b3ac-18ca675a8718";
const EFFECT_ID = "71986db8-b44a-47de-9307-2bef600df0e7";
const REMEDIATION_ID = "c90b3580-f801-4d72-a270-e79de1e2181a";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("operator FormData validation", () => {
  it("parses a structured Output without forwarding unknown defaults", () => {
    const result = parseCreateOutput(
      form({
        projectId: PROJECT_ID,
        logicalId: "report/monthly",
        versionId: "",
        branch: "main",
        outputType: "json",
        content: '{"status":"ready"}',
        schemaId: "",
        producerRunId: "",
        producerAgentId: "agent-1",
        parentVersionIds: "parent-v1, parent-v2",
        policyVersion: "policy-4",
        metadata: '{"source":"operator"}',
      }),
    );

    expect(result).toEqual({
      projectId: PROJECT_ID,
      body: {
        logicalId: "report/monthly",
        branch: "main",
        outputType: "json",
        content: { status: "ready" },
        producerAgentId: "agent-1",
        parentVersionIds: ["parent-v1", "parent-v2"],
        policyVersion: "policy-4",
        metadata: { source: "operator" },
      },
    });
  });

  it("rejects invalid JSON for a structured Output", () => {
    expect(() =>
      parseCreateOutput(
        form({
          projectId: PROJECT_ID,
          logicalId: "report",
          branch: "main",
          outputType: "json",
          content: "not-json",
          metadata: "{}",
        }),
      ),
    ).toThrowError(OperatorInputError);
  });

  it("preserves exact text-like artifact content after validating its bound", () => {
    const result = parseCreateOutput(
      form({
        projectId: PROJECT_ID,
        logicalId: "query",
        branch: "main",
        outputType: "sql",
        content: "  SELECT 1;\n",
        metadata: "{}",
      }),
    );
    expect(result.body.content).toBe("  SELECT 1;\n");
  });

  it("rejects unexpected and duplicate fields", () => {
    const unexpected = form({ projectId: PROJECT_ID, effectId: EFFECT_ID, apiKey: "leak" });
    expect(() => parseEffectOperation(unexpected)).toThrowError(/Unexpected field/u);

    const duplicate = form({ projectId: PROJECT_ID, effectId: EFFECT_ID });
    duplicate.append("effectId", EFFECT_ID);
    expect(() => parseEffectOperation(duplicate)).toThrowError(/exactly once/u);
  });

  it("requires UUID project and Effect identifiers", () => {
    expect(() =>
      parseEffectOperation(form({ projectId: "project-one", effectId: EFFECT_ID })),
    ).toThrowError(/projectId/u);
    expect(() =>
      parseEffectOperation(form({ projectId: PROJECT_ID, effectId: "effect-one" })),
    ).toThrowError(/effectId/u);
  });

  it("enforces inferred-lineage confidence and conservative unknown selectors", () => {
    const base = {
      projectId: PROJECT_ID,
      sourceVersionId: "source-v1",
      targetVersionId: "target-v2",
      edgeType: "DERIVED_FROM",
      selectorKind: "unknown",
      selectorValue: "*",
      transferFunction: "",
      confidence: "0.7",
    };
    expect(() => parseCreateLineage(form(base))).toThrowError(/confidence/u);
    expect(() =>
      parseCreateLineage(form({ ...base, confidence: "", selectorValue: "$.unsafe" })),
    ).toThrowError(/unknown selectors/u);

    const inferred = parseCreateLineage(form({ ...base, inferred: "on" }));
    expect(inferred.body).toMatchObject({ inferred: true, confidence: 0.7 });
  });

  it("validates evidence digest lists and metric value types", () => {
    const base = {
      projectId: PROJECT_ID,
      versionId: "output-v1",
      verifierType: "shadow-sql",
      verifierVersion: "1",
      environmentDigest: "",
      policyVersion: "",
      verdict: "PASS",
      confidence: "1",
      payload: "",
      expiresAt: "",
    };
    expect(() =>
      parseAddEvidence(form({ ...base, dependencyDigests: "not-a-digest", metrics: '{"rows":1}' })),
    ).toThrowError(/dependencyDigests/u);
    expect(() =>
      parseAddEvidence(
        form({
          ...base,
          dependencyDigests: `sha256:${"a".repeat(64)}`,
          metrics: '{"nested":{"unsupported":true}}',
        }),
      ),
    ).toThrowError(/metrics/u);
  });

  it("pins prepared effects to the production-safe manual connector contract", () => {
    const result = parsePrepareEffect(
      form({
        projectId: PROJECT_ID,
        sourceOutputVersionId: "output-v1",
        target: "operator://manual",
        resourceKey: "ticket:42",
        arguments: '{"ticket":42}',
        preconditions: "{}",
        expectedEffects: '{"state":"closed"}',
        readSet: "ticket:42",
        writeSet: "ticket:42",
        baseResourceVersion: "",
        idempotencyKey: "manual-request-42",
        riskLevel: "HIGH",
      }),
    );

    expect(result.idempotencyKey).toBe("manual-request-42");
    expect(result.body).toMatchObject({
      connectorType: "manual-receipt",
      reversibility: "R3",
      riskLevel: "HIGH",
      connectorCapabilities: {
        supportsHumanApproval: true,
        supportsDryRun: true,
        supportsFencingToken: false,
        reversibility: "R3",
      },
    });
  });

  it("accepts only typed manual receipt outcomes and bounded JSON objects", () => {
    const valid = parseRecordReceipt(
      form({
        projectId: PROJECT_ID,
        effectId: EFFECT_ID,
        externalTransactionId: "ticket-42",
        externalStatus: "UNKNOWN",
        beforeDigest: "",
        afterDigest: "",
        actualEffects: '{"observed":"pending"}',
        rawResponse: "null",
        compensationStatus: "",
        committedAt: "2026-08-26T10:00:00+10:00",
      }),
    );
    expect(valid.body).toMatchObject({
      externalTransactionId: "ticket-42",
      externalStatus: "UNKNOWN",
      actualEffects: { observed: "pending" },
      rawResponse: null,
    });

    const invalid = form({
      projectId: PROJECT_ID,
      effectId: EFFECT_ID,
      externalTransactionId: "",
      externalStatus: "MAYBE",
      beforeDigest: "",
      afterDigest: "",
      actualEffects: "[]",
      rawResponse: "",
      compensationStatus: "",
      committedAt: "",
    });
    expect(() => parseRecordReceipt(invalid)).toThrowError(OperatorInputError);
  });

  it("enforces remediation CAS transitions and terminal resolution structure", () => {
    const terminal = parseTransitionRemediation(
      form({
        projectId: PROJECT_ID,
        effectId: EFFECT_ID,
        remediationId: REMEDIATION_ID,
        expectedStatus: "IN_PROGRESS",
        nextStatus: "RESOLVED",
        resolution:
          '{"summary":"Verified corrective write","references":[{"kind":"TICKET","reference":"OPS-42"}],"metadata":{"reviewed":true}}',
      }),
    );
    expect(terminal.body).toEqual({
      expectedStatus: "IN_PROGRESS",
      nextStatus: "RESOLVED",
      resolution: {
        summary: "Verified corrective write",
        references: [{ kind: "TICKET", reference: "OPS-42" }],
        metadata: { reviewed: true },
      },
    });

    expect(() =>
      parseTransitionRemediation(
        form({
          projectId: PROJECT_ID,
          effectId: EFFECT_ID,
          remediationId: REMEDIATION_ID,
          expectedStatus: "OPEN",
          nextStatus: "RESOLVED",
          resolution: '{"summary":"Skipped required work"}',
        }),
      ),
    ).toThrowError(/cannot transition/u);

    expect(() =>
      parseTransitionRemediation(
        form({
          projectId: PROJECT_ID,
          effectId: EFFECT_ID,
          remediationId: REMEDIATION_ID,
          expectedStatus: "IN_PROGRESS",
          nextStatus: "WAIVED",
          resolution: "",
        }),
      ),
    ).toThrowError(/structured resolution/u);
  });
});

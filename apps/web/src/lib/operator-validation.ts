const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^(?:[a-z0-9][a-z0-9_-]*:)?[a-f0-9]{32,}$/iu;
const OFFSET_DATE_TIME_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/u;

const OUTPUT_TYPES = [
  "text",
  "json",
  "markdown",
  "code_patch",
  "file_tree",
  "sql",
  "tool_plan",
  "decision",
  "dataset_record",
] as const;
const STRUCTURED_OUTPUT_TYPES = new Set<string>([
  "json",
  "file_tree",
  "tool_plan",
  "decision",
  "dataset_record",
]);
const EVIDENCE_VERDICTS = ["PASS", "FAIL", "STALE", "UNKNOWN"] as const;
const LINEAGE_EDGE_TYPES = [
  "PRODUCED_BY",
  "DERIVED_FROM",
  "READ_FROM",
  "VERIFIED_BY",
  "CONSUMED_BY",
  "CAUSED",
  "SUPERSEDES",
  "COMPENSATED_BY",
  "REMEDIATED_BY",
] as const;
const SELECTOR_KINDS = [
  "json_path",
  "file",
  "symbol",
  "table_column",
  "record",
  "unknown",
] as const;
const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
const RECEIPT_STATUSES = ["COMMITTED", "FAILED", "UNKNOWN"] as const;
const REMEDIATION_STATUSES = [
  "OPEN",
  "PENDING_APPROVAL",
  "IN_PROGRESS",
  "RESOLVED",
  "WAIVED",
] as const;
const REMEDIATION_REFERENCE_KINDS = ["EVIDENCE", "RECEIPT", "TICKET", "URL", "OTHER"] as const;
type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];
const REMEDIATION_TRANSITIONS: Readonly<Record<RemediationStatus, readonly RemediationStatus[]>> = {
  OPEN: ["PENDING_APPROVAL", "IN_PROGRESS", "WAIVED"],
  PENDING_APPROVAL: ["IN_PROGRESS", "WAIVED"],
  IN_PROGRESS: ["PENDING_APPROVAL", "RESOLVED", "WAIVED"],
  RESOLVED: [],
  WAIVED: [],
};

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type LineageSelector = {
  kind: (typeof SELECTOR_KINDS)[number];
  value: string;
};

export class OperatorInputError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "OperatorInputError";
    this.field = field;
  }
}

function assertAllowedFields(formData: FormData, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of formData.keys()) {
    if (!key.startsWith("$ACTION_") && !allowedSet.has(key)) {
      throw new OperatorInputError(key, `Unexpected field: ${key}`);
    }
  }
}

function fieldValues(formData: FormData, field: string): FormDataEntryValue[] {
  const values = formData.getAll(field);
  if (values.length > 1) {
    throw new OperatorInputError(field, `${field} must appear exactly once`);
  }
  return values;
}

function text(
  formData: FormData,
  field: string,
  options: { min?: number; max: number; optional?: boolean },
): string | undefined {
  const [entry] = fieldValues(formData, field);
  if (entry === undefined) {
    if (options.optional) return undefined;
    throw new OperatorInputError(field, `${field} is required`);
  }
  if (typeof entry !== "string") {
    throw new OperatorInputError(field, `${field} must be text`);
  }
  const value = entry.trim();
  if (value.length === 0 && options.optional) return undefined;
  const minimum = options.min ?? 1;
  if (value.length < minimum || value.length > options.max) {
    throw new OperatorInputError(
      field,
      `${field} must contain between ${minimum} and ${options.max} characters`,
    );
  }
  return value;
}

function requiredText(formData: FormData, field: string, max: number, min = 1): string {
  const value = text(formData, field, { min, max });
  if (value === undefined) throw new OperatorInputError(field, `${field} is required`);
  return value;
}

function requiredRawText(formData: FormData, field: string, max: number): string {
  const [entry] = fieldValues(formData, field);
  if (typeof entry !== "string") {
    throw new OperatorInputError(field, `${field} must be text`);
  }
  if (entry.trim().length === 0 || entry.length > max) {
    throw new OperatorInputError(field, `${field} must contain between 1 and ${max} characters`);
  }
  return entry;
}

function optionalText(formData: FormData, field: string, max: number): string | undefined {
  return text(formData, field, { max, optional: true });
}

function oneOf<const T extends readonly string[]>(
  formData: FormData,
  field: string,
  choices: T,
): T[number] {
  const value = requiredText(formData, field, Math.max(...choices.map((choice) => choice.length)));
  if (!choices.includes(value)) {
    throw new OperatorInputError(field, `${field} has an unsupported value`);
  }
  return value as T[number];
}

function uuid(formData: FormData, field: string): string {
  const value = requiredText(formData, field, 36);
  if (!UUID_PATTERN.test(value)) {
    throw new OperatorInputError(field, `${field} must be an RFC 9562 UUID`);
  }
  return value;
}

function identifier(formData: FormData, field: string, optional = false): string | undefined {
  return optional ? optionalText(formData, field, 512) : requiredText(formData, field, 512);
}

function digest(formData: FormData, field: string): string | undefined {
  const value = optionalText(formData, field, 256);
  if (value !== undefined && !DIGEST_PATTERN.test(value)) {
    throw new OperatorInputError(field, `${field} must be a hexadecimal content digest`);
  }
  return value;
}

function checkbox(formData: FormData, field: string): boolean {
  const [entry] = fieldValues(formData, field);
  if (entry === undefined) return false;
  if (typeof entry !== "string" || !["on", "true"].includes(entry)) {
    throw new OperatorInputError(field, `${field} must be a checkbox`);
  }
  return true;
}

function optionalNumber(
  formData: FormData,
  field: string,
  options: { min: number; max: number; integer?: boolean },
): number | undefined {
  const value = optionalText(formData, field, 64);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    parsed > options.max ||
    (options.integer === true && !Number.isInteger(parsed))
  ) {
    throw new OperatorInputError(field, `${field} is outside its supported numeric range`);
  }
  return parsed;
}

function json(formData: FormData, field: string, optional = false): JsonValue | undefined {
  const raw = optional
    ? optionalText(formData, field, 262_144)
    : requiredText(formData, field, 262_144);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    throw new OperatorInputError(field, `${field} must be valid JSON`);
  }
}

function jsonObject(formData: FormData, field: string, optional = false): JsonObject | undefined {
  const value = json(formData, field, optional);
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new OperatorInputError(field, `${field} must be a JSON object`);
  }
  return value;
}

function list(
  formData: FormData,
  field: string,
  options: { maxItems: number; maxItemLength: number; minItems?: number },
): string[] {
  const raw = optionalText(formData, field, 131_072);
  const values =
    raw === undefined
      ? []
      : raw
          .split(/[\n,]/u)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  if (values.length < (options.minItems ?? 0) || values.length > options.maxItems) {
    throw new OperatorInputError(field, `${field} contains an unsupported number of values`);
  }
  if (values.some((value) => value.length > options.maxItemLength)) {
    throw new OperatorInputError(field, `${field} contains an overlong value`);
  }
  if (new Set(values).size !== values.length) {
    throw new OperatorInputError(field, `${field} must not contain duplicates`);
  }
  return values;
}

function digestList(formData: FormData, field: string, maxItems: number): string[] {
  const values = list(formData, field, { maxItems, maxItemLength: 256 });
  if (values.some((value) => !DIGEST_PATTERN.test(value))) {
    throw new OperatorInputError(field, `${field} must contain only hexadecimal content digests`);
  }
  return values;
}

function offsetDateTime(formData: FormData, field: string): string | undefined {
  const value = optionalText(formData, field, 64);
  if (
    value !== undefined &&
    (!OFFSET_DATE_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value)))
  ) {
    throw new OperatorInputError(field, `${field} must be an ISO 8601 timestamp with an offset`);
  }
  return value;
}

function selector(formData: FormData): LineageSelector {
  const kind = oneOf(formData, "selectorKind", SELECTOR_KINDS);
  const value = requiredText(formData, "selectorValue", 4096);
  if (kind === "unknown" && value !== "*") {
    throw new OperatorInputError("selectorValue", 'unknown selectors must use "*"');
  }
  return { kind, value };
}

function project(formData: FormData): string {
  return uuid(formData, "projectId");
}

function remediationResolution(value: JsonObject): JsonObject {
  const allowed = new Set(["summary", "references", "metadata"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new OperatorInputError("resolution", "resolution contains an unexpected field");
  }
  const summary = value.summary;
  if (typeof summary !== "string" || summary.trim().length === 0 || summary.trim().length > 4096) {
    throw new OperatorInputError(
      "resolution",
      "resolution.summary must contain 1 to 4096 characters",
    );
  }
  const references = value.references ?? [];
  if (!Array.isArray(references) || references.length > 100) {
    throw new OperatorInputError(
      "resolution",
      "resolution.references must contain at most 100 items",
    );
  }
  for (const reference of references) {
    if (reference === null || Array.isArray(reference) || typeof reference !== "object") {
      throw new OperatorInputError("resolution", "each resolution reference must be an object");
    }
    if (
      Object.keys(reference).some((key) => !["kind", "reference"].includes(key)) ||
      typeof reference.kind !== "string" ||
      !REMEDIATION_REFERENCE_KINDS.includes(
        reference.kind as (typeof REMEDIATION_REFERENCE_KINDS)[number],
      ) ||
      typeof reference.reference !== "string" ||
      reference.reference.trim().length === 0 ||
      reference.reference.trim().length > 2048
    ) {
      throw new OperatorInputError("resolution", "resolution contains an invalid reference");
    }
  }
  const metadata = value.metadata ?? {};
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new OperatorInputError("resolution", "resolution.metadata must be a JSON object");
  }
  return { summary: summary.trim(), references, metadata };
}

export function parseCreateOutput(formData: FormData): {
  projectId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "logicalId",
    "versionId",
    "branch",
    "outputType",
    "content",
    "schemaId",
    "producerRunId",
    "producerAgentId",
    "parentVersionIds",
    "policyVersion",
    "metadata",
  ]);
  const projectId = project(formData);
  const outputType = oneOf(formData, "outputType", OUTPUT_TYPES);
  const rawContent = requiredRawText(formData, "content", 262_144);
  let content: JsonValue = rawContent;
  if (STRUCTURED_OUTPUT_TYPES.has(outputType)) {
    try {
      content = JSON.parse(rawContent) as JsonValue;
    } catch {
      throw new OperatorInputError("content", "content must be valid JSON for this output type");
    }
  }
  const versionId = identifier(formData, "versionId", true);
  const schemaId = optionalText(formData, "schemaId", 256);
  const producerRunId = optionalText(formData, "producerRunId", 36);
  if (producerRunId !== undefined && !UUID_PATTERN.test(producerRunId)) {
    throw new OperatorInputError("producerRunId", "producerRunId must be an RFC 9562 UUID");
  }
  const producerAgentId = optionalText(formData, "producerAgentId", 256);
  const policyVersion = optionalText(formData, "policyVersion", 256);
  return {
    projectId,
    body: {
      logicalId: requiredText(formData, "logicalId", 512),
      ...(versionId === undefined ? {} : { versionId }),
      branch: requiredText(formData, "branch", 128),
      outputType,
      content,
      ...(schemaId === undefined ? {} : { schemaId }),
      ...(producerRunId === undefined ? {} : { producerRunId }),
      ...(producerAgentId === undefined ? {} : { producerAgentId }),
      parentVersionIds: list(formData, "parentVersionIds", {
        maxItems: 100,
        maxItemLength: 512,
      }),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      metadata: jsonObject(formData, "metadata") ?? {},
    },
  };
}

export function parseAddEvidence(formData: FormData): {
  projectId: string;
  versionId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "versionId",
    "verifierType",
    "verifierVersion",
    "environmentDigest",
    "dependencyDigests",
    "policyVersion",
    "verdict",
    "confidence",
    "metrics",
    "payload",
    "expiresAt",
  ]);
  const environmentDigest = digest(formData, "environmentDigest");
  const policyVersion = optionalText(formData, "policyVersion", 256);
  const confidence = optionalNumber(formData, "confidence", { min: 0, max: 1 });
  const payload = json(formData, "payload", true);
  const expiresAt = offsetDateTime(formData, "expiresAt");
  const metrics = jsonObject(formData, "metrics") ?? {};
  if (
    Object.values(metrics).some((value) => !["boolean", "number", "string"].includes(typeof value))
  ) {
    throw new OperatorInputError("metrics", "metrics values must be strings, numbers, or booleans");
  }
  return {
    projectId: project(formData),
    versionId: requiredText(formData, "versionId", 512),
    body: {
      verifierType: requiredText(formData, "verifierType", 256),
      verifierVersion: requiredText(formData, "verifierVersion", 256),
      ...(environmentDigest === undefined ? {} : { environmentDigest }),
      dependencyDigests: digestList(formData, "dependencyDigests", 1_000),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      verdict: oneOf(formData, "verdict", EVIDENCE_VERDICTS),
      ...(confidence === undefined ? {} : { confidence }),
      metrics,
      ...(payload === undefined ? {} : { payload }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  };
}

export function parsePromoteOutput(formData: FormData): {
  projectId: string;
  versionId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "versionId",
    "expectedHeadVersionId",
    "branch",
    "requiredVerifierTypes",
    "policyVersion",
    "fencingToken",
  ]);
  const expectedHeadVersionId = optionalText(formData, "expectedHeadVersionId", 512) ?? null;
  const policyVersion = optionalText(formData, "policyVersion", 256);
  const fencingToken = optionalNumber(formData, "fencingToken", {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });
  return {
    projectId: project(formData),
    versionId: requiredText(formData, "versionId", 512),
    body: {
      expectedHeadVersionId,
      branch: requiredText(formData, "branch", 128),
      requiredVerifierTypes: list(formData, "requiredVerifierTypes", {
        minItems: 1,
        maxItems: 100,
        maxItemLength: 256,
      }),
      ...(policyVersion === undefined ? {} : { policyVersion }),
      ...(fencingToken === undefined ? {} : { fencingToken }),
    },
  };
}

export function parseCreateLineage(formData: FormData): {
  projectId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "sourceVersionId",
    "targetVersionId",
    "edgeType",
    "selectorKind",
    "selectorValue",
    "transferFunction",
    "inferred",
    "confidence",
  ]);
  const inferred = checkbox(formData, "inferred");
  const confidence = optionalNumber(formData, "confidence", { min: 0, max: 1 });
  if (!inferred && confidence !== undefined) {
    throw new OperatorInputError("confidence", "confidence is only valid for inferred lineage");
  }
  const transferFunction = optionalText(formData, "transferFunction", 512);
  return {
    projectId: project(formData),
    body: {
      sourceVersionId: requiredText(formData, "sourceVersionId", 512),
      targetVersionId: requiredText(formData, "targetVersionId", 512),
      edgeType: oneOf(formData, "edgeType", LINEAGE_EDGE_TYPES),
      selector: selector(formData),
      ...(transferFunction === undefined ? {} : { transferFunction }),
      inferred,
      ...(confidence === undefined ? {} : { confidence }),
    },
  };
}

export function parseImpact(formData: FormData): {
  projectId: string;
  body: {
    sourceVersionId: string;
    deltaSelectors: LineageSelector[];
    beforeDigest?: string;
    afterDigest?: string;
  };
} {
  assertAllowedFields(formData, [
    "projectId",
    "sourceVersionId",
    "selectorKind",
    "selectorValue",
    "beforeDigest",
    "afterDigest",
  ]);
  const beforeDigest = digest(formData, "beforeDigest");
  const afterDigest = digest(formData, "afterDigest");
  return {
    projectId: project(formData),
    body: {
      sourceVersionId: requiredText(formData, "sourceVersionId", 512),
      deltaSelectors: [selector(formData)],
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(afterDigest === undefined ? {} : { afterDigest }),
    },
  };
}

export function parseInvalidate(formData: FormData): {
  projectId: string;
  versionId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "versionId",
    "reason",
    "selectorKind",
    "selectorValue",
    "beforeDigest",
    "afterDigest",
  ]);
  const beforeDigest = digest(formData, "beforeDigest");
  const afterDigest = digest(formData, "afterDigest");
  return {
    projectId: project(formData),
    versionId: requiredText(formData, "versionId", 512),
    body: {
      reason: requiredText(formData, "reason", 4096),
      deltaSelectors: [selector(formData)],
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(afterDigest === undefined ? {} : { afterDigest }),
    },
  };
}

export function parsePrepareEffect(formData: FormData): {
  projectId: string;
  body: Record<string, unknown>;
  idempotencyKey: string;
} {
  assertAllowedFields(formData, [
    "projectId",
    "sourceOutputVersionId",
    "target",
    "resourceKey",
    "arguments",
    "preconditions",
    "expectedEffects",
    "readSet",
    "writeSet",
    "baseResourceVersion",
    "idempotencyKey",
    "riskLevel",
  ]);
  const idempotencyKey = requiredText(formData, "idempotencyKey", 256, 8);
  const baseResourceVersion = identifier(formData, "baseResourceVersion", true);
  return {
    projectId: project(formData),
    idempotencyKey,
    body: {
      sourceOutputVersionId: requiredText(formData, "sourceOutputVersionId", 512),
      connectorType: "manual-receipt",
      target: requiredText(formData, "target", 2048),
      resourceKey: requiredText(formData, "resourceKey", 512),
      arguments: jsonObject(formData, "arguments") ?? {},
      preconditions: jsonObject(formData, "preconditions") ?? {},
      expectedEffects: jsonObject(formData, "expectedEffects") ?? {},
      readSet: list(formData, "readSet", { maxItems: 1_000, maxItemLength: 512 }),
      writeSet: list(formData, "writeSet", { maxItems: 1_000, maxItemLength: 512 }),
      ...(baseResourceVersion === undefined ? {} : { baseResourceVersion }),
      idempotencyKey,
      reversibility: "R3",
      riskLevel: oneOf(formData, "riskLevel", RISK_LEVELS),
      connectorCapabilities: {
        supportsIdempotencyKey: false,
        supportsQueryByIdempotencyKey: false,
        supportsQueryByExternalId: false,
        supportsConditionalWrite: false,
        supportsFencingToken: false,
        supportsCompensation: false,
        supportsStateDigests: false,
        supportsDryRun: true,
        supportsHumanApproval: true,
        reversibility: "R3",
      },
    },
  };
}

export function parseEffectOperation(formData: FormData): {
  projectId: string;
  effectId: string;
} {
  assertAllowedFields(formData, ["projectId", "effectId"]);
  return { projectId: project(formData), effectId: uuid(formData, "effectId") };
}

export function parseRecordReceipt(formData: FormData): {
  projectId: string;
  effectId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "effectId",
    "externalTransactionId",
    "externalStatus",
    "beforeDigest",
    "afterDigest",
    "actualEffects",
    "rawResponse",
    "compensationStatus",
    "committedAt",
  ]);
  const externalTransactionId = identifier(formData, "externalTransactionId", true);
  const beforeDigest = digest(formData, "beforeDigest");
  const afterDigest = digest(formData, "afterDigest");
  const rawResponse = json(formData, "rawResponse", true);
  const compensationStatus = optionalText(formData, "compensationStatus", 512);
  const committedAt = offsetDateTime(formData, "committedAt");
  return {
    projectId: project(formData),
    effectId: uuid(formData, "effectId"),
    body: {
      ...(externalTransactionId === undefined ? {} : { externalTransactionId }),
      externalStatus: oneOf(formData, "externalStatus", RECEIPT_STATUSES),
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(afterDigest === undefined ? {} : { afterDigest }),
      actualEffects: jsonObject(formData, "actualEffects") ?? {},
      ...(rawResponse === undefined ? {} : { rawResponse }),
      ...(compensationStatus === undefined ? {} : { compensationStatus }),
      ...(committedAt === undefined ? {} : { committedAt }),
    },
  };
}

export function parseTransitionRemediation(formData: FormData): {
  projectId: string;
  effectId: string;
  remediationId: string;
  body: Record<string, unknown>;
} {
  assertAllowedFields(formData, [
    "projectId",
    "effectId",
    "remediationId",
    "expectedStatus",
    "nextStatus",
    "resolution",
  ]);
  const expectedStatus = oneOf(formData, "expectedStatus", REMEDIATION_STATUSES);
  const nextStatus = oneOf(formData, "nextStatus", REMEDIATION_STATUSES);
  if (!REMEDIATION_TRANSITIONS[expectedStatus].includes(nextStatus)) {
    throw new OperatorInputError(
      "nextStatus",
      `remediation cannot transition from ${expectedStatus} to ${nextStatus}`,
    );
  }
  const rawResolution = jsonObject(formData, "resolution", true);
  const terminal = nextStatus === "RESOLVED" || nextStatus === "WAIVED";
  if (terminal && rawResolution === undefined) {
    throw new OperatorInputError("resolution", `${nextStatus} requires a structured resolution`);
  }
  if (!terminal && rawResolution !== undefined) {
    throw new OperatorInputError(
      "resolution",
      "resolution is only valid for RESOLVED or WAIVED transitions",
    );
  }
  const resolution = rawResolution === undefined ? undefined : remediationResolution(rawResolution);
  return {
    projectId: project(formData),
    effectId: uuid(formData, "effectId"),
    remediationId: uuid(formData, "remediationId"),
    body: {
      expectedStatus,
      nextStatus,
      ...(resolution === undefined ? {} : { resolution }),
    },
  };
}

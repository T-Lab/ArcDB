import type {
  AuditEvent,
  Dashboard,
  EffectDetail,
  EffectSummary,
  Evidence,
  ImpactResult,
  JsonRecord,
  LineageEdge,
  LineageNode,
  ListResult,
  OutputDetail,
  OutputSummary,
  Pagination,
  Project,
  Receipt,
  Remediation,
  Span,
  TraceDetail,
  TraceScore,
  TraceSummary,
} from "./types";

export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function valueAt(record: JsonRecord, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

function first(record: JsonRecord, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = valueAt(record, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function stringValue(record: JsonRecord, paths: readonly string[], fallback = ""): string {
  const value = first(record, paths);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function optionalString(record: JsonRecord, paths: readonly string[]): string | undefined {
  return stringValue(record, paths) || undefined;
}

function numberValue(record: JsonRecord, paths: readonly string[]): number | undefined {
  const value = first(record, paths);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(record: JsonRecord, paths: readonly string[]): boolean | undefined {
  const value = first(record, paths);
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1) return true;
  if (value === "false" || value === 0) return false;
  return undefined;
}

function arrayValue(record: JsonRecord, paths: readonly string[]): unknown[] {
  const value = first(record, paths);
  return Array.isArray(value) ? value : [];
}

function stringArray(record: JsonRecord, paths: readonly string[]): string[] {
  return arrayValue(record, paths).flatMap((value) =>
    typeof value === "string" || typeof value === "number" ? [String(value)] : [],
  );
}

export function unwrapData(payload: unknown): unknown {
  const record = asRecord(payload);
  return Object.hasOwn(record, "data") ? record.data : payload;
}

function paginationFrom(payload: unknown, unwrapped: unknown): Pagination {
  const root = asRecord(payload);
  const data = asRecord(unwrapped);
  const nested = asRecord(first(data, ["pagination", "pageInfo", "page"]));
  const rootNested = asRecord(first(root, ["pagination", "pageInfo", "page"]));
  const combined: JsonRecord = { ...root, ...rootNested, ...data, ...nested };
  return {
    nextCursor: optionalString(combined, ["nextCursor", "next", "endCursor"]),
    previousCursor: optionalString(combined, ["previousCursor", "prevCursor", "previous"]),
    total: numberValue(combined, ["total", "totalCount", "count"]),
    pageSize: numberValue(combined, ["pageSize", "limit", "perPage"]),
  };
}

export function normalizeList<T>(payload: unknown, mapper: (item: unknown) => T): ListResult<T> {
  const unwrapped = unwrapData(payload);
  const record = asRecord(unwrapped);
  const candidates = Array.isArray(unwrapped)
    ? unwrapped
    : arrayValue(record, ["items", "results", "records", "nodes"]);
  return {
    items: candidates.map(mapper),
    pagination: paginationFrom(payload, unwrapped),
  };
}

export function normalizeProject(value: unknown): Project {
  const record = asRecord(value);
  const organization = asRecord(first(record, ["organization", "org"]));
  return {
    id: stringValue(record, ["id", "projectId"]),
    name: stringValue(record, ["name", "projectName"], "Unnamed project"),
    slug: optionalString(record, ["slug"]),
    organizationId:
      optionalString(record, ["organizationId", "orgId", "tenantId"]) ??
      optionalString(organization, ["id"]),
    organizationName:
      optionalString(record, ["organizationName", "orgName"]) ??
      optionalString(organization, ["name"]),
    role: optionalString(record, ["role", "membership.role"]),
    createdAt: optionalString(record, ["createdAt", "created_at"]),
  };
}

export function normalizeTrace(value: unknown): TraceSummary {
  const record = asRecord(value);
  const spans = arrayValue(record, ["spans", "observations"]);
  return {
    id: stringValue(record, ["id", "traceId", "runId"]),
    name: stringValue(record, ["name", "displayName", "operationName"], "Unnamed trace"),
    status: stringValue(record, ["status", "state"], "UNKNOWN").toUpperCase(),
    startedAt: optionalString(record, ["startedAt", "startTime", "timestamp", "createdAt"]),
    endedAt: optionalString(record, ["endedAt", "endTime", "completedAt"]),
    durationMs: numberValue(record, ["durationMs", "duration", "latencyMs"]),
    spanCount:
      numberValue(record, ["spanCount", "observationCount"]) ??
      (spans.length > 0 ? spans.length : undefined),
    outputCount: numberValue(record, ["outputCount", "outputsCount"]),
    agentId: optionalString(record, ["agentId", "producerAgentId"]),
    sessionId: optionalString(record, ["sessionId"]),
    metadata: asRecord(first(record, ["metadata", "attributes"])),
  };
}

export function normalizeSpan(value: unknown): Span {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "spanId", "observationId"]),
    parentSpanId: optionalString(record, ["parentSpanId", "parentId", "parentObservationId"]),
    name: stringValue(record, ["name", "displayName", "operationName"], "Unnamed span"),
    kind: stringValue(record, ["kind", "type", "observationType"], "SPAN").toUpperCase(),
    status: stringValue(record, ["status", "state", "level"], "UNKNOWN").toUpperCase(),
    startedAt: optionalString(record, ["startedAt", "startTime", "timestamp", "createdAt"]),
    endedAt: optionalString(record, ["endedAt", "endTime", "completedAt"]),
    durationMs: numberValue(record, ["durationMs", "duration", "latencyMs"]),
    input: first(record, ["input", "request"]),
    output: first(record, ["output", "response"]),
    metadata: asRecord(first(record, ["metadata", "attributes"])),
  };
}

export function normalizeTraceScore(value: unknown): TraceScore {
  const record = asRecord(value);
  const rawValue = first(record, ["value", "score"]);
  return {
    id: stringValue(record, ["id", "scoreId"]),
    name: stringValue(record, ["name", "metric", "scoreName"], "Unnamed score"),
    value:
      typeof rawValue === "string" || typeof rawValue === "number" || typeof rawValue === "boolean"
        ? rawValue
        : undefined,
    dataType: stringValue(record, ["dataType", "type"], typeof rawValue).toUpperCase(),
    source: optionalString(record, ["source", "sourceType"]),
    comment: optionalString(record, ["comment", "reason"]),
    createdAt: optionalString(record, ["createdAt", "timestamp"]),
  };
}

export function normalizeTraceDetail(payload: unknown): TraceDetail {
  const container = asRecord(unwrapData(payload));
  const traceRecord = asRecord(first(container, ["trace", "run"]));
  const base = Object.keys(traceRecord).length > 0 ? traceRecord : container;
  const summary = normalizeTrace(base);
  const spansRaw =
    first(container, ["spans", "observations"]) ?? first(base, ["spans", "observations"]);
  return {
    ...summary,
    spans: (Array.isArray(spansRaw) ? spansRaw : [])
      .map(normalizeSpan)
      .filter((span) => span.id !== ""),
    scores: arrayValue(container, ["scores", "trace.scores", "run.scores"]).map(
      normalizeTraceScore,
    ),
    input: first(base, ["input", "request"]),
    output: first(base, ["output", "response"]),
    raw: container,
  };
}

export function normalizeOutput(value: unknown): OutputSummary {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "outputId", "versionId"]),
    logicalId: stringValue(record, ["logicalId", "logical_id", "name"]),
    versionId: stringValue(record, ["versionId", "version_id", "id"]),
    outputType: stringValue(record, ["outputType", "type"], "unknown"),
    lifecycleState: stringValue(
      record,
      ["lifecycleState", "state", "status"],
      "UNKNOWN",
    ).toUpperCase(),
    contentRef: optionalString(record, ["contentRef", "artifact.contentRef"]),
    contentDigest: optionalString(record, ["contentDigest", "digest", "artifact.digest"]),
    producerRunId: optionalString(record, ["producerRunId", "runId", "traceId"]),
    producerAgentId: optionalString(record, ["producerAgentId", "agentId"]),
    policyVersion: optionalString(record, ["policyVersion"]),
    parentVersionIds: stringArray(record, ["parentVersionIds", "parents"]),
    metadata: asRecord(first(record, ["metadata"])),
    createdAt: optionalString(record, ["createdAt", "created_at"]),
    updatedAt: optionalString(record, ["updatedAt", "updated_at"]),
  };
}

export function normalizeEvidence(value: unknown): Evidence {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "evidenceId"]),
    verdict: stringValue(record, ["verdict", "status"], "UNKNOWN").toUpperCase(),
    freshnessStatus: optionalString(record, ["freshness.status"]),
    freshnessReasons: stringArray(record, ["freshness.reasons"]),
    verifierType: stringValue(record, ["verifierType", "type"], "Unknown verifier"),
    verifierVersion: stringValue(record, ["verifierVersion", "version"], "—"),
    environmentDigest: optionalString(record, ["environmentDigest"]),
    dependencyDigests: stringArray(record, ["dependencyDigests"]),
    policyVersion: optionalString(record, ["policyVersion"]),
    confidence: numberValue(record, ["confidence"]),
    metrics: asRecord(first(record, ["metrics"])),
    fingerprint: optionalString(record, ["fingerprint"]),
    payloadRef: optionalString(record, ["payloadRef"]),
    expiresAt: optionalString(record, ["expiresAt"]),
    createdAt: optionalString(record, ["createdAt"]),
  };
}

export function normalizeOutputDetail(payload: unknown): OutputDetail {
  const container = asRecord(unwrapData(payload));
  const outputRecord = asRecord(first(container, ["output", "version", "item"]));
  const base = Object.keys(outputRecord).length > 0 ? outputRecord : container;
  const summary = normalizeOutput(base);
  const evidence = first(container, ["evidence", "evidenceObjects"]) ?? first(base, ["evidence"]);
  const versions = first(container, ["versions", "versionHistory"]) ?? first(base, ["versions"]);
  const artifact =
    first(container, ["rawContent", "artifact.rawContent", "artifact", "content", "rawArtifact"]) ??
    first(base, ["rawContent", "artifact.rawContent", "artifact", "content", "rawArtifact"]);
  const head = first(container, ["head"]) ?? first(base, ["head"]);
  const headVersionId = optionalString(asRecord(head), ["versionId", "id"]);
  return {
    ...summary,
    artifact,
    evidence: (Array.isArray(evidence) ? evidence : []).map(normalizeEvidence),
    versions: (Array.isArray(versions) ? versions : []).map(normalizeOutput),
    effects: arrayValue(container, ["effects", "effectIntents"]).map(normalizeEffect),
    isHead:
      typeof head === "boolean"
        ? head
        : headVersionId
          ? headVersionId === summary.versionId
          : booleanValue(base, ["isHead"]),
    raw: container,
  };
}

export function normalizeEffect(value: unknown): EffectSummary {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "intentId"]),
    sourceOutputVersionId: optionalString(record, ["sourceOutputVersionId", "outputVersionId"]),
    connectorType: stringValue(
      record,
      ["connectorType", "connector_type", "connector"],
      "Unknown connector",
    ),
    target: stringValue(record, ["target", "resource"], "Unknown target"),
    resourceKey: optionalString(record, ["resourceKey"]),
    status: stringValue(record, ["status", "state"], "UNKNOWN").toUpperCase(),
    riskLevel: stringValue(record, ["riskLevel", "risk_level", "risk"], "UNKNOWN").toUpperCase(),
    reversibility: stringValue(record, ["reversibility"], "UNKNOWN").toUpperCase(),
    idempotencyKey: optionalString(record, ["idempotencyKey"]),
    createdAt: optionalString(record, ["createdAt", "created_at"]),
  };
}

export function normalizeReceipt(value: unknown): Receipt {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "receiptId"]),
    intentId: optionalString(record, ["intentId"]),
    externalTransactionId: optionalString(record, ["externalTransactionId", "transactionId"]),
    externalStatus: stringValue(record, ["externalStatus", "status"], "UNKNOWN"),
    beforeDigest: optionalString(record, ["beforeDigest"]),
    afterDigest: optionalString(record, ["afterDigest"]),
    actualEffects: asRecord(first(record, ["actualEffects", "effects"])),
    rawResponseRef: optionalString(record, ["rawResponseRef"]),
    compensationStatus: optionalString(record, ["compensationStatus"]),
    committedAt: optionalString(record, ["committedAt"]),
    createdAt: optionalString(record, ["createdAt"]),
    raw: record,
  };
}

export function normalizeRemediation(value: unknown): Remediation {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "obligationId"]),
    reason: stringValue(record, ["reason", "description"], "No reason supplied"),
    status: stringValue(record, ["status"], "OPEN").toUpperCase(),
    riskLevel: stringValue(record, ["riskLevel", "risk_level", "risk"], "UNKNOWN").toUpperCase(),
    requiresHumanApproval: booleanValue(record, [
      "requiresHumanApproval",
      "requires_human_approval",
    ]),
    createdAt: optionalString(record, ["createdAt", "created_at"]),
    raw: record,
  };
}

export function normalizeEffectDetail(payload: unknown): EffectDetail {
  const container = asRecord(unwrapData(payload));
  const effectRecord = asRecord(first(container, ["effect", "intent", "effectIntent"]));
  const base = Object.keys(effectRecord).length > 0 ? effectRecord : container;
  const summary = normalizeEffect(base);
  const receipts = first(container, ["receipts", "effectReceipts"]) ?? first(base, ["receipts"]);
  const remediation =
    first(container, ["remediation", "remediations", "remediationObligations", "obligations"]) ??
    first(base, ["remediation", "remediations", "remediationObligations"]);
  const remediationItems = Array.isArray(remediation)
    ? remediation
    : remediation
      ? [remediation]
      : [];
  const reconciliation = asRecord(
    first(container, ["reconciliation", "reconciliationState"]) ??
      first(base, ["reconciliation", "reconciliationState"]),
  );
  return {
    ...summary,
    arguments: first(container, ["arguments"]) ?? first(base, ["arguments"]),
    rawArguments: first(container, ["rawArguments"]) ?? first(base, ["rawArguments"]),
    preconditions: asRecord(first(base, ["preconditions"])),
    expectedEffects: asRecord(first(base, ["expectedEffects"])),
    readSet: stringArray(base, ["readSet"]),
    writeSet: stringArray(base, ["writeSet"]),
    baseResourceVersion: optionalString(base, ["baseResourceVersion"]),
    argumentsRef: optionalString(base, ["argumentsRef"]),
    compensationHandler: optionalString(base, ["compensationHandler"]),
    receipts: (Array.isArray(receipts) ? receipts : []).map(normalizeReceipt),
    remediation: remediationItems.map(normalizeRemediation),
    reconciliation: Object.keys(reconciliation).length > 0 ? reconciliation : undefined,
    raw: container,
  };
}

export function normalizeLineageNode(value: unknown): LineageNode {
  const record = asRecord(value);
  return {
    id: stringValue(record, ["id", "versionId", "nodeId"]),
    label: stringValue(record, ["label", "logicalId", "name", "versionId", "id"], "Unknown node"),
    kind: stringValue(record, ["kind", "type", "outputType"], "OUTPUT").toUpperCase(),
    state: optionalString(record, ["state", "lifecycleState", "status"]),
    depth: numberValue(record, ["depth", "distance"]),
    metadata: asRecord(first(record, ["metadata"])),
  };
}

export function normalizeLineageEdge(value: unknown): LineageEdge {
  const record = asRecord(value);
  const source = stringValue(record, ["sourceVersionId", "source", "from"]);
  const target = stringValue(record, ["targetVersionId", "target", "to"]);
  return {
    id: stringValue(record, ["id"], `${source}:${target}`),
    sourceVersionId: source,
    targetVersionId: target,
    edgeType: stringValue(record, ["edgeType", "type"], "RELATED_TO").toUpperCase(),
    selector: first(record, ["selector"]),
    inferred: booleanValue(record, ["inferred"]) ?? false,
    confidence: numberValue(record, ["confidence"]),
  };
}

const LINEAGE_SELECTOR_KINDS = new Set([
  "json_path",
  "file",
  "symbol",
  "table_column",
  "record",
  "unknown",
]);

const IMPACT_REASON_CODES = new Set([
  "SOURCE_DELTA",
  "SELECTOR_INTERSECTION",
  "UNKNOWN_SELECTOR",
  "TRANSFER_FUNCTION",
  "MISSING_TRANSFER_FUNCTION",
  "SELECTOR_DISJOINT",
  "TRANSFER_REJECTED",
  "FINGERPRINT_UNCHANGED",
]);

type ImpactAnalysisNode = {
  versionId: string;
  generation: number;
  selectors: JsonRecord[];
  viaEdgeIds: string[];
};

function strictIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const identifier = value.trim();
  return identifier.length > 0 && identifier.length <= 512 ? identifier : undefined;
}

function strictIdentifierArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const identifiers = value.map(strictIdentifier);
  return identifiers.every((identifier) => identifier !== undefined)
    ? (identifiers as string[])
    : undefined;
}

function strictLineageSelector(value: unknown): JsonRecord | undefined {
  const record = asRecord(value);
  const kind = record.kind;
  const selectorValue = record.value;
  if (
    typeof kind !== "string" ||
    !LINEAGE_SELECTOR_KINDS.has(kind) ||
    typeof selectorValue !== "string" ||
    selectorValue.trim().length === 0 ||
    selectorValue.length > 4096 ||
    (kind === "unknown" && selectorValue !== "*")
  )
    return undefined;
  return { kind, value: selectorValue };
}

function strictImpactAnalysisNode(value: unknown): ImpactAnalysisNode | undefined {
  const record = asRecord(value);
  const versionId = strictIdentifier(record.versionId);
  const generation = record.generation;
  const selectors = Array.isArray(record.selectors)
    ? record.selectors.map(strictLineageSelector)
    : [];
  const viaEdgeIds = strictIdentifierArray(record.viaEdgeIds);
  if (
    versionId === undefined ||
    typeof generation !== "number" ||
    !Number.isInteger(generation) ||
    generation < 0 ||
    selectors.length === 0 ||
    selectors.some((selector) => selector === undefined) ||
    viaEdgeIds === undefined
  )
    return undefined;
  return {
    versionId,
    generation,
    selectors: selectors as JsonRecord[],
    viaEdgeIds,
  };
}

function nodeFromImpactAnalysis(node: ImpactAnalysisNode, sourceVersionId: string): LineageNode {
  return {
    id: node.versionId,
    label: node.versionId,
    kind: node.versionId === sourceVersionId ? "SOURCE OUTPUT" : "OUTPUT",
    state: undefined,
    depth: node.generation,
    metadata: { selectors: node.selectors, viaEdgeIds: node.viaEdgeIds },
  };
}

function outputFromImpactAnalysis(node: ImpactAnalysisNode): OutputSummary {
  return {
    id: node.versionId,
    logicalId: node.versionId,
    versionId: node.versionId,
    outputType: "unknown",
    lifecycleState: "UNKNOWN",
    contentRef: undefined,
    contentDigest: undefined,
    producerRunId: undefined,
    producerAgentId: undefined,
    policyVersion: undefined,
    parentVersionIds: [],
    metadata: { selectors: node.selectors, viaEdgeIds: node.viaEdgeIds },
    createdAt: undefined,
    updatedAt: undefined,
  };
}

function edgeFromImpactReason(value: unknown): LineageEdge | undefined {
  const record = asRecord(value);
  const id = strictIdentifier(record.edgeId);
  const sourceVersionId = strictIdentifier(record.sourceVersionId);
  const targetVersionId = strictIdentifier(record.targetVersionId);
  const disposition = record.disposition;
  const reason = record.reason;
  const detail = record.detail;
  if (
    id === undefined ||
    sourceVersionId === undefined ||
    targetVersionId === undefined ||
    disposition !== "AFFECTED" ||
    typeof reason !== "string" ||
    !IMPACT_REASON_CODES.has(reason) ||
    typeof detail !== "string" ||
    detail.trim().length === 0
  )
    return undefined;
  return {
    id,
    sourceVersionId,
    targetVersionId,
    edgeType: reason,
    selector: { disposition, detail },
    inferred: true,
    confidence: undefined,
  };
}

export function normalizeImpact(payload: unknown, requestedSourceVersionId: string): ImpactResult {
  const container = asRecord(unwrapData(payload));
  const responseSourceVersionId = strictIdentifier(container.sourceVersionId);
  const sourceVersionId = responseSourceVersionId ?? requestedSourceVersionId;
  const hasImpactAnalysisNodes = Array.isArray(container.affectedNodes);
  const impactAnalysisNodes = hasImpactAnalysisNodes
    ? (container.affectedNodes as unknown[]).flatMap((value) => {
        const node = strictImpactAnalysisNode(value);
        return node === undefined ? [] : [node];
      })
    : [];
  const nodeIds = new Set([sourceVersionId, ...impactAnalysisNodes.map((node) => node.versionId)]);
  const nodes = hasImpactAnalysisNodes
    ? impactAnalysisNodes.map((node) => nodeFromImpactAnalysis(node, sourceVersionId))
    : arrayValue(container, ["nodes", "graph.nodes"])
        .map(normalizeLineageNode)
        .filter((node) => node.id !== "");
  const hasReasonGraph = Array.isArray(container.reasonGraph);
  const edges = hasReasonGraph
    ? (container.reasonGraph as unknown[])
        .flatMap((value) => {
          const edge = edgeFromImpactReason(value);
          return edge === undefined ? [] : [edge];
        })
        .filter((edge) => nodeIds.has(edge.sourceVersionId) && nodeIds.has(edge.targetVersionId))
    : arrayValue(container, ["edges", "graph.edges"])
        .map(normalizeLineageEdge)
        .filter(
          (edge) => edge.id !== "" && edge.sourceVersionId !== "" && edge.targetVersionId !== "",
        );
  const affectedOutputs = hasImpactAnalysisNodes
    ? impactAnalysisNodes
        .filter((node) => node.versionId !== sourceVersionId)
        .map(outputFromImpactAnalysis)
    : arrayValue(container, ["affectedOutputs", "affected", "outputs"])
        .map(normalizeOutput)
        .filter((output) => output.versionId !== "");
  return {
    sourceVersionId,
    nodes,
    edges,
    affectedOutputs,
    recomputationPlan: first(container, ["recomputationPlan", "plan"]),
    raw: container,
  };
}

export function normalizeAuditEvent(value: unknown): AuditEvent {
  const record = asRecord(value);
  const actorRecord = asRecord(first(record, ["actor"]));
  return {
    id: stringValue(record, ["id", "eventId"]),
    action: stringValue(record, ["action", "eventType", "type"], "UNKNOWN").toUpperCase(),
    actor:
      stringValue(record, ["actorName", "actorId", "principalId"]) ||
      stringValue(actorRecord, ["name", "id"], "System"),
    resourceType: stringValue(record, ["resourceType", "subjectType"], "Unknown"),
    resourceId: optionalString(record, ["resourceId", "subjectId"]),
    outcome: stringValue(record, ["outcome", "status"], "UNKNOWN").toUpperCase(),
    occurredAt: optionalString(record, ["occurredAt", "createdAt", "timestamp"]),
    requestId: optionalString(record, ["requestId"]),
    ipAddress: optionalString(record, ["ipAddress", "ip"]),
    metadata: asRecord(first(record, ["metadata", "details"])),
  };
}

function normalizeActivity(value: unknown): Array<{ label: string; value: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const label = stringValue(record, ["label", "date", "timestamp", "bucket"]);
    const count = numberValue(record, ["value", "count", "total"]);
    return label && count !== undefined ? [{ label, value: count }] : [];
  });
}

export function normalizeDashboard(payload: unknown): Dashboard {
  const container = asRecord(unwrapData(payload));
  const metrics = asRecord(first(container, ["metrics", "counts", "summary"]));
  const combined: JsonRecord = { ...container, ...metrics };
  return {
    runCount: numberValue(combined, ["runCount", "runs24h", "runs", "totalRuns"]),
    traceCount: numberValue(combined, ["traceCount", "traces24h", "traces", "totalTraces"]),
    outputCount: numberValue(combined, ["outputCount", "outputsTotal", "outputs", "totalOutputs"]),
    verifiedOutputCount: numberValue(combined, ["verifiedOutputCount", "verifiedOutputs"]),
    unresolvedEffectCount: numberValue(combined, [
      "unresolvedEffectCount",
      "reconciliationRequired",
      "unresolvedEffects",
    ]),
    remediationCount: numberValue(combined, ["remediationCount", "openRemediations"]),
    effectCount: numberValue(combined, ["effectCount", "openEffects", "effects", "totalEffects"]),
    invalidatedOutputCount: numberValue(combined, [
      "invalidatedOutputCount",
      "staleOutputs",
      "invalidatedOutputs",
    ]),
    recentTraces: arrayValue(container, ["recentTraces", "recent.traces"]).map(normalizeTrace),
    recentOutputs: arrayValue(container, ["recentOutputs", "recent.outputs"]).map(normalizeOutput),
    activity: normalizeActivity(first(container, ["activity", "timeSeries", "traceVolume"])),
    raw: container,
  };
}

export type JsonRecord = Record<string, unknown>;

export type Pagination = {
  nextCursor: string | undefined;
  previousCursor: string | undefined;
  total: number | undefined;
  pageSize: number | undefined;
};

export type ListResult<T> = {
  items: T[];
  pagination: Pagination;
};

export type Project = {
  id: string;
  name: string;
  slug: string | undefined;
  organizationId: string | undefined;
  organizationName: string | undefined;
  role: string | undefined;
  createdAt: string | undefined;
};

export type Dashboard = {
  runCount: number | undefined;
  traceCount: number | undefined;
  outputCount: number | undefined;
  verifiedOutputCount: number | undefined;
  unresolvedEffectCount: number | undefined;
  remediationCount: number | undefined;
  effectCount: number | undefined;
  invalidatedOutputCount: number | undefined;
  recentTraces: TraceSummary[];
  recentOutputs: OutputSummary[];
  activity: Array<{ label: string; value: number }>;
  raw: JsonRecord;
};

export type TraceSummary = {
  id: string;
  name: string;
  status: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  durationMs: number | undefined;
  spanCount: number | undefined;
  outputCount: number | undefined;
  agentId: string | undefined;
  sessionId: string | undefined;
  metadata: JsonRecord;
};

export type Span = {
  id: string;
  parentSpanId: string | undefined;
  name: string;
  kind: string;
  status: string;
  startedAt: string | undefined;
  endedAt: string | undefined;
  durationMs: number | undefined;
  input: unknown;
  output: unknown;
  metadata: JsonRecord;
};

export type TraceScore = {
  id: string;
  name: string;
  value: string | number | boolean | undefined;
  dataType: string;
  source: string | undefined;
  comment: string | undefined;
  createdAt: string | undefined;
};

export type TraceDetail = TraceSummary & {
  spans: Span[];
  scores: TraceScore[];
  input: unknown;
  output: unknown;
  raw: JsonRecord;
};

export type OutputSummary = {
  id: string;
  logicalId: string;
  versionId: string;
  outputType: string;
  lifecycleState: string;
  contentRef: string | undefined;
  contentDigest: string | undefined;
  producerRunId: string | undefined;
  producerAgentId: string | undefined;
  policyVersion: string | undefined;
  parentVersionIds: string[];
  metadata: JsonRecord;
  createdAt: string | undefined;
  updatedAt: string | undefined;
};

export type Evidence = {
  id: string;
  verdict: string;
  freshnessStatus: string | undefined;
  freshnessReasons: string[];
  verifierType: string;
  verifierVersion: string;
  environmentDigest: string | undefined;
  dependencyDigests: string[];
  policyVersion: string | undefined;
  confidence: number | undefined;
  metrics: JsonRecord;
  fingerprint: string | undefined;
  payloadRef: string | undefined;
  expiresAt: string | undefined;
  createdAt: string | undefined;
};

export type OutputDetail = OutputSummary & {
  artifact: unknown;
  evidence: Evidence[];
  versions: OutputSummary[];
  effects: EffectSummary[];
  isHead: boolean | undefined;
  raw: JsonRecord;
};

export type EffectSummary = {
  id: string;
  sourceOutputVersionId: string | undefined;
  connectorType: string;
  target: string;
  resourceKey: string | undefined;
  status: string;
  riskLevel: string;
  reversibility: string;
  idempotencyKey: string | undefined;
  createdAt: string | undefined;
};

export type Receipt = {
  id: string;
  intentId: string | undefined;
  externalTransactionId: string | undefined;
  externalStatus: string;
  beforeDigest: string | undefined;
  afterDigest: string | undefined;
  actualEffects: JsonRecord;
  rawResponseRef: string | undefined;
  compensationStatus: string | undefined;
  committedAt: string | undefined;
  createdAt: string | undefined;
  raw: JsonRecord;
};

export type Remediation = {
  id: string;
  reason: string;
  status: string;
  riskLevel: string;
  requiresHumanApproval: boolean | undefined;
  createdAt: string | undefined;
  raw: JsonRecord;
};

export type EffectDetail = EffectSummary & {
  arguments: unknown;
  rawArguments: unknown;
  preconditions: JsonRecord;
  expectedEffects: JsonRecord;
  readSet: string[];
  writeSet: string[];
  baseResourceVersion: string | undefined;
  argumentsRef: string | undefined;
  compensationHandler: string | undefined;
  receipts: Receipt[];
  remediation: Remediation[];
  reconciliation: JsonRecord | undefined;
  raw: JsonRecord;
};

export type LineageNode = {
  id: string;
  label: string;
  kind: string;
  state: string | undefined;
  depth: number | undefined;
  metadata: JsonRecord;
};

export type LineageEdge = {
  id: string;
  sourceVersionId: string;
  targetVersionId: string;
  edgeType: string;
  selector: unknown;
  inferred: boolean;
  confidence: number | undefined;
};

export type ImpactResult = {
  sourceVersionId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  affectedOutputs: OutputSummary[];
  recomputationPlan: unknown;
  raw: JsonRecord;
};

export type AuditEvent = {
  id: string;
  action: string;
  actor: string;
  resourceType: string;
  resourceId: string | undefined;
  outcome: string;
  occurredAt: string | undefined;
  requestId: string | undefined;
  ipAddress: string | undefined;
  metadata: JsonRecord;
};

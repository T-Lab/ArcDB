import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  EffectIntent,
  EffectReceipt,
  EvidenceObject,
  LineageEdge,
  OutputObject,
  RemediationObligationRecord,
  TransitionRemediationRequest,
} from "@arcdb/contracts";
import {
  isRemediationTransitionAllowed,
  RemediationObligationRecordSchema,
  TransitionRemediationSchema,
} from "@arcdb/contracts";
import {
  ArcDBApiError,
  ArcDBBufferedError,
  type ArcDBErrorBody,
  ArcDBNetworkError,
} from "./errors.js";
import { type BufferedOperation, MemoryOfflineBuffer, type OfflineBuffer } from "./offline.js";

type Fetch = typeof globalThis.fetch;

export type RequestContext = {
  readonly runId?: string;
  readonly traceId?: string;
};

export type RetryOptions = {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
};

export type ArcDBOptions = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly projectId: string;
  readonly fetch?: Fetch;
  readonly retry?: RetryOptions;
  readonly offlineBuffer?: OfflineBuffer;
  readonly userAgent?: string;
};

export type Run = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type Trace = {
  readonly id: string;
  readonly runId?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type Span = {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: "SPAN" | "GENERATION" | "TOOL_CALL" | "EVENT" | "EVALUATOR" | "AGENT";
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type Score = {
  readonly id: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly runId?: string;
  readonly name: string;
  readonly dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL";
  readonly numericValue?: number;
  readonly stringValue?: string;
  readonly source: "API" | "EVALUATOR" | "HUMAN";
  readonly createdAt: string;
};

export type CreateRunInput = {
  readonly id?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly input?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
};

export type CreateTraceInput = {
  readonly id?: string;
  readonly runId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly endedAt?: string;
};

export type CreateSpanInput = {
  readonly id?: string;
  readonly parentSpanId?: string;
  readonly externalId?: string;
  readonly name: string;
  readonly kind: Span["kind"];
  readonly model?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly status?: "UNSET" | "OK" | "ERROR";
};

export type CreateScoreInput = {
  readonly id?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly runId?: string;
  readonly name: string;
  readonly value: number | boolean | string;
  readonly comment?: string;
  readonly source?: "API" | "EVALUATOR" | "HUMAN";
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type CreateOutputInput = {
  readonly logicalId: string;
  readonly versionId?: string;
  readonly branch?: string;
  readonly outputType: OutputObject["outputType"];
  readonly content: string | Readonly<Record<string, unknown>> | readonly unknown[];
  readonly schemaId?: string;
  readonly producerRunId?: string;
  readonly producerAgentId?: string;
  readonly parentVersionIds?: readonly string[];
  readonly policyVersion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type AddEvidenceInput = {
  readonly verifierType: string;
  readonly verifierVersion: string;
  readonly environmentDigest?: string;
  readonly dependencyDigests?: readonly string[];
  readonly policyVersion?: string;
  readonly verdict: EvidenceObject["verdict"];
  readonly confidence?: number;
  readonly metrics?: EvidenceObject["metrics"];
  readonly payload?: unknown;
  readonly expiresAt?: string;
};

export type PromoteOutputInput = {
  readonly expectedHeadVersionId: string | null;
  readonly branch?: string;
  readonly requiredVerifierTypes?: readonly string[];
  readonly policyVersion?: string;
};

export type PrepareEffectInput = {
  readonly sourceOutputVersionId: string;
  readonly connectorType: string;
  readonly target: string;
  readonly resourceKey: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly preconditions?: Readonly<Record<string, unknown>>;
  readonly expectedEffects?: Readonly<Record<string, unknown>>;
  readonly readSet?: readonly string[];
  readonly writeSet?: readonly string[];
  readonly baseResourceVersion?: string;
  readonly idempotencyKey?: string;
  readonly reversibility: EffectIntent["reversibility"];
  readonly compensationHandler?: string;
  readonly riskLevel: EffectIntent["riskLevel"];
  readonly connectorCapabilities: {
    readonly supportsIdempotencyKey: boolean;
    readonly supportsQueryByIdempotencyKey: boolean;
    readonly supportsQueryByExternalId: boolean;
    readonly supportsConditionalWrite: boolean;
    readonly supportsFencingToken: boolean;
    readonly supportsCompensation: boolean;
    readonly supportsStateDigests: boolean;
    readonly supportsDryRun: boolean;
    readonly supportsHumanApproval: boolean;
    readonly reversibility: EffectIntent["reversibility"];
  };
};

export type RecordReceiptInput = Omit<EffectReceipt, "id" | "intentId" | "createdAt"> & {
  readonly rawResponse?: unknown;
};

export type TransitionRemediationInput = TransitionRemediationRequest;

export type EffectOperation = {
  readonly intent: EffectIntent;
  readonly job: Readonly<Record<string, unknown>> | null;
};

export type IngestionBatch = {
  readonly batchId: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
};

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly bufferOnNetworkFailure?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 502, 503, 504]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class ArcDB {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #projectId: string;
  readonly #fetch: Fetch;
  readonly #maxAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #offline: OfflineBuffer;
  readonly #contexts = new AsyncLocalStorage<RequestContext>();
  readonly #userAgent: string;

  public constructor(options: ArcDBOptions) {
    this.#baseUrl = new URL(
      options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
    );
    if (!this.#baseUrl.protocol.startsWith("http"))
      throw new Error("ArcDB baseUrl must use HTTP(S)");
    if (options.apiKey.trim().length < 16) throw new Error("ArcDB apiKey is missing or too short");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        options.projectId,
      )
    ) {
      throw new Error("ArcDB projectId must be a UUID");
    }
    this.#apiKey = options.apiKey;
    this.#projectId = options.projectId;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxAttempts = options.retry?.maxAttempts ?? 4;
    this.#baseDelayMs = options.retry?.baseDelayMs ?? 100;
    this.#maxDelayMs = options.retry?.maxDelayMs ?? 2_000;
    this.#offline = options.offlineBuffer ?? new MemoryOfflineBuffer();
    this.#userAgent = options.userAgent ?? "@arcdb/sdk/0.1.0";
  }

  public async createRun(input: CreateRunInput): Promise<Run> {
    return this.#request<Run>("v1/runs", { method: "POST", body: input });
  }

  public async createTrace(input: CreateTraceInput): Promise<Trace> {
    const context = this.#contexts.getStore();
    return this.#request<Trace>("v1/traces", {
      method: "POST",
      body: { ...input, runId: input.runId ?? context?.runId },
    });
  }

  public async createSpan(traceId: string, input: CreateSpanInput): Promise<Span> {
    return this.#request<Span>(`v1/traces/${encodeURIComponent(traceId)}/spans`, {
      method: "POST",
      body: input,
    });
  }

  public async createScore(input: CreateScoreInput): Promise<Score> {
    return this.#request<Score>("v1/scores", { method: "POST", body: input });
  }

  public async ingestBatch(
    batch: IngestionBatch,
  ): Promise<{ accepted: number; duplicate: boolean }> {
    return this.#request("v1/ingestion/batch", {
      method: "POST",
      body: batch,
      idempotencyKey: batch.batchId,
      bufferOnNetworkFailure: true,
    });
  }

  public async createOutput(input: CreateOutputInput): Promise<OutputObject> {
    const context = this.#contexts.getStore();
    return this.#request<OutputObject>("v1/outputs", {
      method: "POST",
      body: { ...input, producerRunId: input.producerRunId ?? context?.runId },
    });
  }

  public async finalizeOutput(versionId: string): Promise<OutputObject> {
    return this.#request<OutputObject>(`v1/outputs/${encodeURIComponent(versionId)}/finalize`, {
      method: "POST",
      body: {},
    });
  }

  public async addEvidence(versionId: string, input: AddEvidenceInput): Promise<EvidenceObject> {
    return this.#request<EvidenceObject>(`v1/outputs/${encodeURIComponent(versionId)}/evidence`, {
      method: "POST",
      body: input,
    });
  }

  public async promoteOutput(versionId: string, input: PromoteOutputInput): Promise<OutputObject> {
    return this.#request<OutputObject>(`v1/outputs/${encodeURIComponent(versionId)}/promote`, {
      method: "POST",
      body: input,
    });
  }

  public async addLineage(input: Omit<LineageEdge, "id" | "createdAt">): Promise<LineageEdge> {
    return this.#request<LineageEdge>("v1/lineage", { method: "POST", body: input });
  }

  public async invalidateOutput(
    versionId: string,
    input: {
      readonly reason: string;
      readonly deltaSelectors?: readonly { readonly kind: string; readonly value: string }[];
    },
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#request(`v1/outputs/${encodeURIComponent(versionId)}/invalidate`, {
      method: "POST",
      body: input,
    });
  }

  public async prepareEffect(input: PrepareEffectInput): Promise<EffectIntent> {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    return this.#request<EffectIntent>("v1/effects", {
      method: "POST",
      body: { ...input, idempotencyKey },
      idempotencyKey,
    });
  }

  public async recordReceipt(intentId: string, input: RecordReceiptInput): Promise<EffectReceipt> {
    return this.#request<EffectReceipt>(`v1/effects/${encodeURIComponent(intentId)}/receipts`, {
      method: "POST",
      body: input,
    });
  }

  public async commitEffect(intentId: string): Promise<EffectOperation> {
    return this.#request<EffectOperation>(`v1/effects/${encodeURIComponent(intentId)}/commit`, {
      method: "POST",
      body: {},
    });
  }

  public async reconcileEffect(intentId: string): Promise<EffectOperation> {
    return this.#request<EffectOperation>(`v1/effects/${encodeURIComponent(intentId)}/reconcile`, {
      method: "POST",
      body: {},
    });
  }

  public async transitionRemediation(
    effectIntentId: string,
    remediationId: string,
    input: TransitionRemediationInput,
  ): Promise<RemediationObligationRecord> {
    const body = TransitionRemediationSchema.parse(input);
    if (!isRemediationTransitionAllowed(body.expectedStatus, body.nextStatus)) {
      throw new TypeError(
        `Remediation obligation cannot transition from ${body.expectedStatus} to ${body.nextStatus}`,
      );
    }
    const response = await this.#request<unknown>(
      `v1/effects/${encodeURIComponent(effectIntentId)}/remediations/${encodeURIComponent(
        remediationId,
      )}/transition`,
      { method: "POST", body },
    );
    return RemediationObligationRecordSchema.parse(response);
  }

  public async withRun<T>(
    input: CreateRunInput,
    callback: (run: RunHandle) => Promise<T>,
  ): Promise<T> {
    const run = await this.createRun(input);
    return this.#contexts.run({ ...this.#contexts.getStore(), runId: run.id }, () =>
      callback(new RunHandle(this, run)),
    );
  }

  public async withTrace<T>(
    input: CreateTraceInput,
    callback: (trace: Trace) => Promise<T>,
  ): Promise<T> {
    const trace = await this.createTrace(input);
    return this.#contexts.run({ ...this.#contexts.getStore(), traceId: trace.id }, () =>
      callback(trace),
    );
  }

  public currentContext(): RequestContext | undefined {
    return this.#contexts.getStore();
  }

  public async flushOffline(limit = 100): Promise<{ flushed: number; remaining: number }> {
    const operations = await this.#offline.peek(limit);
    const completed: string[] = [];
    for (const operation of operations) {
      try {
        await this.#sendBuffered(operation);
        completed.push(operation.id);
      } catch (error) {
        await this.#offline.update({ ...operation, attempts: operation.attempts + 1 });
        if (!(error instanceof ArcDBApiError) || !error.retryable) throw error;
        break;
      }
    }
    await this.#offline.remove(completed);
    return { flushed: completed.length, remaining: await this.#offline.size() };
  }

  async #request<T>(path: string, options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const idempotencyKey = options.idempotencyKey ?? (method === "GET" ? undefined : randomUUID());
    const context = this.#contexts.getStore();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#apiKey}`,
      "X-ArcDB-Project-Id": this.#projectId,
      "User-Agent": this.#userAgent,
      ...options.headers,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    if (context?.runId !== undefined) headers["X-ArcDB-Run-Id"] = context.runId;
    if (context?.traceId !== undefined) headers["X-ArcDB-Trace-Id"] = context.traceId;

    try {
      return await this.#send<T>({ method, path, body: options.body, headers });
    } catch (error) {
      if (options.bufferOnNetworkFailure === true && error instanceof ArcDBNetworkError) {
        const operationId = await this.#offline.enqueue({
          method: method as BufferedOperation["method"],
          path,
          body: options.body,
          headers: Object.fromEntries(
            Object.entries(headers).filter(([name]) => name.toLowerCase() !== "authorization"),
          ),
        });
        throw new ArcDBBufferedError(operationId, error);
      }
      throw error;
    }
  }

  async #sendBuffered(operation: BufferedOperation): Promise<unknown> {
    return this.#send({
      method: operation.method,
      path: operation.path,
      body: operation.body,
      headers: {
        ...operation.headers,
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
  }

  async #send<T>(options: {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>>;
  }): Promise<T> {
    const url = new URL(options.path.replace(/^\//, ""), this.#baseUrl);
    let lastNetworkError: ArcDBNetworkError | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: options.method,
          headers: options.headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (error) {
        lastNetworkError = new ArcDBNetworkError(`Cannot reach ArcDB at ${url.origin}`, error);
        if (attempt === this.#maxAttempts) throw lastNetworkError;
        await this.#delay(attempt);
        continue;
      }

      const parsed = await responseBody(response);
      if (response.ok) {
        if (isRecord(parsed) && "data" in parsed) return parsed.data as T;
        return parsed as T;
      }

      const body = isRecord(parsed) ? (parsed as ArcDBErrorBody) : undefined;
      const error = new ArcDBApiError({
        message: body?.error?.message ?? `ArcDB request failed with HTTP ${response.status}`,
        code: body?.error?.code ?? `HTTP_${response.status}`,
        status: response.status,
        ...(body?.requestId === undefined ? {} : { requestId: body.requestId }),
        ...(body?.error?.details === undefined ? {} : { details: body.error.details }),
        retryable: body?.error?.retryable ?? RETRYABLE_STATUS.has(response.status),
      });
      if (!error.retryable || attempt === this.#maxAttempts) throw error;
      await this.#delay(attempt, parseRetryAfter(response.headers.get("retry-after")));
    }

    throw lastNetworkError ?? new ArcDBNetworkError("ArcDB request exhausted retries", undefined);
  }

  async #delay(attempt: number, serverDelayMs?: number): Promise<void> {
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
    const jittered = Math.round(exponential * (0.5 + Math.random() * 0.5));
    const delay = Math.max(serverDelayMs ?? 0, jittered);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

export class RunHandle {
  public readonly run: Run;
  readonly #client: ArcDB;

  public constructor(client: ArcDB, run: Run) {
    this.#client = client;
    this.run = run;
  }

  public createOutput(input: Omit<CreateOutputInput, "producerRunId">): Promise<OutputObject> {
    return this.#client.createOutput({ ...input, producerRunId: this.run.id });
  }

  public withTrace<T>(
    input: Omit<CreateTraceInput, "runId">,
    callback: (trace: Trace) => Promise<T>,
  ): Promise<T> {
    return this.#client.withTrace({ ...input, runId: this.run.id }, callback);
  }
}

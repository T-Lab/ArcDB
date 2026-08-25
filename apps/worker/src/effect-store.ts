import { canonicalDigest, ReceiptImmutableError } from "@arcdb/contracts";
import {
  type AppendReceiptInput,
  createRepositories,
  type Database,
  type EffectIntentRecord,
  type EffectReceiptRecord,
  type EffectStatus,
  type SqlExecutor,
} from "@arcdb/db";
import { JobFenceLostError } from "./errors.js";

export interface EffectMutationFence {
  readonly tenantId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly jobFencingToken: string;
  readonly resourceKey?: string;
  readonly resourceFencingToken?: string;
}

export interface EffectStore {
  getIntent(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<EffectIntentRecord | null>;
  listReceipts(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<readonly EffectReceiptRecord[]>;
  beginExternalOperation(
    intentId: string,
    expectedStatus: EffectStatus,
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
    leaseSeconds: number,
  ): Promise<EffectIntentRecord | null>;
  transition(
    intentId: string,
    expectedStatus: EffectStatus | readonly EffectStatus[],
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
  ): Promise<EffectIntentRecord | null>;
  appendReceipt(
    input: AppendReceiptInput,
    fence: EffectMutationFence,
  ): Promise<EffectReceiptRecord>;
  isResourceFenceCurrent(
    tenantId: string,
    projectId: string,
    resourceKey: string,
    fencingToken: string,
  ): Promise<boolean>;
  recordManualReceipt(
    input: AppendReceiptInput,
    expectedStatus: EffectStatus,
    terminalStatus: EffectStatus,
  ): Promise<EffectReceiptRecord>;
}

async function lockMutationFences(
  executor: SqlExecutor,
  fence: EffectMutationFence,
): Promise<void> {
  const job = await executor.query<{ id: string }>(
    `SELECT id FROM jobs
      WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = 'RUNNING'
        AND locked_by = $4 AND fencing_token = $5 AND lock_expires_at > now()
      FOR UPDATE`,
    [fence.tenantId, fence.projectId, fence.jobId, fence.workerId, fence.jobFencingToken],
  );
  if (job.rows[0] === undefined) throw new JobFenceLostError(fence.jobId);

  if (fence.resourceKey === undefined || fence.resourceFencingToken === undefined) return;
  const resource = await executor.query<{ resource_key: string }>(
    `SELECT resource_key FROM resource_fences
      WHERE tenant_id = $1 AND project_id = $2 AND resource_key = $3 AND fencing_token = $4
        AND lease_expires_at > now()
      FOR SHARE`,
    [fence.tenantId, fence.projectId, fence.resourceKey, fence.resourceFencingToken],
  );
  if (resource.rows[0] === undefined) throw new JobFenceLostError(fence.jobId);
}

export class PostgresEffectStore implements EffectStore {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public async getIntent(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<EffectIntentRecord | null> {
    return this.#database.withSystem((executor) =>
      createRepositories(executor).effects.get({ tenantId, projectId, id: intentId }),
    );
  }

  public async listReceipts(
    tenantId: string,
    projectId: string,
    intentId: string,
  ): Promise<readonly EffectReceiptRecord[]> {
    return this.#database.withSystem(
      (executor) =>
        createRepositories(executor).receipts.listByIntent({ tenantId, projectId, intentId }),
      { readOnly: true },
    );
  }

  public async beginExternalOperation(
    intentId: string,
    expectedStatus: EffectStatus,
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
    leaseSeconds: number,
  ): Promise<EffectIntentRecord | null> {
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
      throw new TypeError("leaseSeconds must be an integer between 1 and 3600");
    }
    return this.#database.withSystem(async (executor) => {
      await lockMutationFences(executor, fence);
      const locked = await executor.query<{
        id: string;
        status: EffectStatus;
        resource_key: string;
      }>(
        `SELECT id, status, resource_key FROM effect_intents
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3
          FOR UPDATE`,
        [fence.tenantId, fence.projectId, intentId],
      );
      const intent = locked.rows[0];
      if (intent === undefined || intent.status !== expectedStatus) return null;
      const repositories = createRepositories(executor);
      const resourceFence = await repositories.resourceFences.acquire({
        tenantId: fence.tenantId,
        projectId: fence.projectId,
        resourceKey: intent.resource_key,
        leaseOwner: `${fence.workerId}:${fence.jobId}:${fence.jobFencingToken}`,
        leaseSeconds,
      });
      const updated = await executor.query<{ id: string }>(
        `UPDATE effect_intents
            SET fencing_token = $5, status = $6
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND status = $4
          RETURNING id`,
        [
          fence.tenantId,
          fence.projectId,
          intentId,
          expectedStatus,
          resourceFence.fencingToken,
          nextStatus,
        ],
      );
      if (updated.rows[0] === undefined) return null;
      return repositories.effects.get({
        tenantId: fence.tenantId,
        projectId: fence.projectId,
        id: intentId,
      });
    });
  }

  public async transition(
    intentId: string,
    expectedStatus: EffectStatus | readonly EffectStatus[],
    nextStatus: EffectStatus,
    fence: EffectMutationFence,
  ): Promise<EffectIntentRecord | null> {
    return this.#database.withSystem(async (executor) => {
      await lockMutationFences(executor, fence);
      return createRepositories(executor).effects.updateStatus({
        tenantId: fence.tenantId,
        projectId: fence.projectId,
        id: intentId,
        expectedStatus,
        nextStatus,
      });
    });
  }

  public async appendReceipt(
    input: AppendReceiptInput,
    fence: EffectMutationFence,
  ): Promise<EffectReceiptRecord> {
    if (input.tenantId !== fence.tenantId || input.projectId !== fence.projectId) {
      throw new TypeError("Receipt tenant/project does not match job fence");
    }
    return this.#database.withSystem(async (executor) => {
      await lockMutationFences(executor, fence);
      await executor.query(
        `SELECT id FROM effect_intents
          WHERE tenant_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE`,
        [input.tenantId, input.projectId, input.intentId],
      );
      const repositories = createRepositories(executor);
      if (input.id !== undefined) {
        const existing = (
          await repositories.receipts.listByIntent({
            tenantId: input.tenantId,
            projectId: input.projectId,
            intentId: input.intentId,
          })
        ).find((receipt) => receipt.id === input.id);
        if (existing !== undefined) {
          const same =
            existing.externalTransactionId === input.externalTransactionId &&
            existing.externalStatus === input.externalStatus &&
            existing.beforeDigest === input.beforeDigest &&
            existing.afterDigest === input.afterDigest &&
            canonicalDigest(existing.actualEffects, "receipt-effects") ===
              canonicalDigest(input.actualEffects ?? {}, "receipt-effects") &&
            existing.rawResponseRef === input.rawResponseRef &&
            existing.compensationStatus === input.compensationStatus &&
            existing.committedAt === input.committedAt;
          if (!same) throw new ReceiptImmutableError(input.id);
          return existing;
        }
      }
      return repositories.receipts.append(input);
    });
  }

  public async isResourceFenceCurrent(
    tenantId: string,
    projectId: string,
    resourceKey: string,
    fencingToken: string,
  ): Promise<boolean> {
    return this.#database.withSystem(
      (executor) =>
        createRepositories(executor).resourceFences.isCurrent({
          tenantId,
          projectId,
          resourceKey,
          fencingToken,
        }),
      { readOnly: true },
    );
  }

  public async recordManualReceipt(
    input: AppendReceiptInput,
    expectedStatus: EffectStatus,
    terminalStatus: EffectStatus,
  ): Promise<EffectReceiptRecord> {
    return this.#database.withTenant(input.tenantId, input.projectId, async (executor) => {
      const repositories = createRepositories(executor);
      const existing = await repositories.receipts.listByIntent({
        tenantId: input.tenantId,
        projectId: input.projectId,
        intentId: input.intentId,
      });
      const sameId =
        input.id === undefined ? undefined : existing.find((receipt) => receipt.id === input.id);
      if (sameId !== undefined) return sameId;

      const receipt = await repositories.receipts.append(input);
      let current = expectedStatus;
      if (current === "PREPARED" || current === "FAILED") {
        const reconciliation = await repositories.effects.updateStatus({
          tenantId: input.tenantId,
          projectId: input.projectId,
          id: input.intentId,
          expectedStatus: current,
          nextStatus: "RECONCILIATION_REQUIRED",
        });
        if (reconciliation === null)
          throw new Error("Effect status changed while recording receipt");
        current = "RECONCILIATION_REQUIRED";
      }
      const committed = await repositories.effects.updateStatus({
        tenantId: input.tenantId,
        projectId: input.projectId,
        id: input.intentId,
        expectedStatus: current,
        nextStatus: terminalStatus,
      });
      if (committed === null) throw new Error("Effect status changed while recording receipt");
      return receipt;
    });
  }
}

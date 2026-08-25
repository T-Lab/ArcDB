"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ArcDbApiError, ArcDbConfigurationError, apiMutation } from "./api";
import {
  ConsoleActionAuthorizationError,
  requireConsoleActionAuthorization,
} from "./operator-auth";
import {
  OperatorInputError,
  parseAddEvidence,
  parseCreateLineage,
  parseCreateOutput,
  parseEffectOperation,
  parseImpact,
  parseInvalidate,
  parsePrepareEffect,
  parsePromoteOutput,
  parseRecordReceipt,
  parseTransitionRemediation,
} from "./operator-validation";

type Operation =
  | "add-evidence"
  | "commit-effect"
  | "compute-impact"
  | "create-lineage"
  | "create-output"
  | "invalidate-output"
  | "prepare-effect"
  | "promote-output"
  | "reconcile-effect"
  | "record-receipt"
  | "transition-remediation";

type ActionResult = { projectId: string; resourceId?: string; destination?: string };

function responseData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.data;
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : record;
}

function responseId(value: unknown, keys: readonly string[]): string | undefined {
  const data = responseData(value);
  if (data === undefined) return undefined;
  for (const key of keys) {
    const candidate = data[key];
    if (typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512) {
      return candidate;
    }
  }
  return undefined;
}

function safeRequestId(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 128 || !/^[a-zA-Z0-9._:-]+$/u.test(value)) {
    return undefined;
  }
  return value;
}

function errorNotice(error: unknown): { code: string; message: string; requestId?: string } {
  if (error instanceof ConsoleActionAuthorizationError) {
    return {
      code: error.code,
      message:
        error.code === "CONSOLE_AUTH_MISCONFIGURED"
          ? "Console authentication is not configured on the server."
          : "Console authentication is required for this operation.",
    };
  }
  if (error instanceof OperatorInputError) {
    const field = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/u.test(error.field) ? error.field : "form data";
    return {
      code: "INVALID_FORM_DATA",
      message: `The submitted form is invalid. Review ${field}.`,
    };
  }
  if (error instanceof ArcDbConfigurationError) {
    return {
      code: "WEB_CONFIGURATION_ERROR",
      message: "The console server API configuration is incomplete.",
    };
  }
  if (error instanceof ArcDbApiError) {
    const message =
      error.status === 401 || error.status === 403
        ? "The console server identity is not authorized for this operation."
        : error.status === 404
          ? "The requested ArcDB resource was not found in this project."
          : error.status === 409
            ? "ArcDB rejected the operation because lifecycle state or head state changed."
            : error.status === 422 || error.status === 400
              ? "ArcDB rejected the operation because its contract or policy was not satisfied."
              : error.status === 503
                ? "The ArcDB API is currently unavailable."
                : "ArcDB could not complete the operation.";
    const requestId = safeRequestId(error.requestId);
    const code = /^[A-Z0-9_-]{1,80}$/u.test(error.code) ? error.code : "ARCDB_API_ERROR";
    return {
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
  return { code: "OPERATION_FAILED", message: "ArcDB could not complete the operation." };
}

function operateHref(
  projectId: string | undefined,
  notice:
    | { type: "success"; operation: Operation; resourceId?: string }
    | {
        type: "error";
        operation: Operation;
        code: string;
        message: string;
        requestId?: string;
      },
): string {
  const query = new URLSearchParams();
  if (projectId !== undefined) query.set("projectId", projectId);
  query.set("notice", notice.type);
  query.set("operation", notice.operation);
  if (notice.type === "success") {
    if (notice.resourceId !== undefined) query.set("resourceId", notice.resourceId);
  } else {
    query.set("code", notice.code);
    query.set("message", notice.message);
    if (notice.requestId !== undefined) query.set("requestId", notice.requestId);
  }
  return `/operate?${query.toString()}`;
}

async function runOperation(
  operation: Operation,
  formData: FormData,
  mutate: () => Promise<ActionResult>,
): Promise<never> {
  try {
    const requestHeaders = await headers();
    requireConsoleActionAuthorization(requestHeaders.get("authorization"));
  } catch (error) {
    redirect(operateHref(undefined, { type: "error", operation, ...errorNotice(error) }));
  }

  let projectId: string | undefined;
  const rawProjectId = formData.get("projectId");
  if (
    typeof rawProjectId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(rawProjectId)
  ) {
    projectId = rawProjectId;
  }

  let result: ActionResult;
  try {
    result = await mutate();
  } catch (error) {
    redirect(operateHref(projectId, { type: "error", operation, ...errorNotice(error) }));
  }

  if (result.destination !== undefined) redirect(result.destination);
  redirect(
    operateHref(result.projectId, {
      type: "success",
      operation,
      ...(result.resourceId === undefined ? {} : { resourceId: result.resourceId }),
    }),
  );
}

export async function createOutputAction(formData: FormData): Promise<never> {
  return runOperation("create-output", formData, async () => {
    const input = parseCreateOutput(formData);
    const response = await apiMutation<unknown>("/v1/outputs", {
      projectId: input.projectId,
      body: input.body,
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/outputs");
    const resourceId = responseId(response, ["versionId", "id"]);
    return {
      projectId: input.projectId,
      ...(resourceId === undefined ? {} : { resourceId }),
    };
  });
}

export async function addEvidenceAction(formData: FormData): Promise<never> {
  return runOperation("add-evidence", formData, async () => {
    const input = parseAddEvidence(formData);
    const response = await apiMutation<unknown>(
      `/v1/outputs/${encodeURIComponent(input.versionId)}/evidence`,
      {
        projectId: input.projectId,
        body: input.body,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    revalidatePath("/outputs");
    const resourceId = responseId(response, ["id"]);
    return {
      projectId: input.projectId,
      ...(resourceId === undefined ? {} : { resourceId }),
    };
  });
}

export async function promoteOutputAction(formData: FormData): Promise<never> {
  return runOperation("promote-output", formData, async () => {
    const input = parsePromoteOutput(formData);
    const response = await apiMutation<unknown>(
      `/v1/outputs/${encodeURIComponent(input.versionId)}/promote`,
      {
        projectId: input.projectId,
        body: input.body,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    revalidatePath("/outputs");
    return {
      projectId: input.projectId,
      resourceId: responseId(response, ["versionId", "id"]) ?? input.versionId,
    };
  });
}

export async function createLineageAction(formData: FormData): Promise<never> {
  return runOperation("create-lineage", formData, async () => {
    const input = parseCreateLineage(formData);
    const response = await apiMutation<unknown>("/v1/lineage", {
      projectId: input.projectId,
      body: input.body,
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/lineage");
    const resourceId = responseId(response, ["id"]);
    return {
      projectId: input.projectId,
      ...(resourceId === undefined ? {} : { resourceId }),
    };
  });
}

export async function computeImpactAction(formData: FormData): Promise<never> {
  return runOperation("compute-impact", formData, async () => {
    const input = parseImpact(formData);
    await apiMutation<unknown>("/v1/lineage/impact", {
      projectId: input.projectId,
      body: input.body,
      idempotencyKey: crypto.randomUUID(),
    });
    const selected = input.body.deltaSelectors[0];
    if (selected === undefined) throw new OperatorInputError("selectorValue", "");
    const query = new URLSearchParams({
      projectId: input.projectId,
      sourceVersionId: input.body.sourceVersionId,
      selectorKind: selected.kind,
      selectorValue: selected.value,
    });
    if (input.body.beforeDigest !== undefined) query.set("beforeDigest", input.body.beforeDigest);
    if (input.body.afterDigest !== undefined) query.set("afterDigest", input.body.afterDigest);
    return { projectId: input.projectId, destination: `/lineage?${query.toString()}` };
  });
}

export async function invalidateOutputAction(formData: FormData): Promise<never> {
  return runOperation("invalidate-output", formData, async () => {
    const input = parseInvalidate(formData);
    await apiMutation<unknown>(`/v1/outputs/${encodeURIComponent(input.versionId)}/invalidate`, {
      projectId: input.projectId,
      body: input.body,
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/outputs");
    revalidatePath("/lineage");
    revalidatePath("/effects");
    return { projectId: input.projectId, resourceId: input.versionId };
  });
}

export async function prepareEffectAction(formData: FormData): Promise<never> {
  return runOperation("prepare-effect", formData, async () => {
    const input = parsePrepareEffect(formData);
    const response = await apiMutation<unknown>("/v1/effects", {
      projectId: input.projectId,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    revalidatePath("/effects");
    const resourceId = responseId(response, ["id"]);
    return {
      projectId: input.projectId,
      ...(resourceId === undefined ? {} : { resourceId }),
    };
  });
}

export async function commitEffectAction(formData: FormData): Promise<never> {
  return runOperation("commit-effect", formData, async () => {
    const input = parseEffectOperation(formData);
    await apiMutation<unknown>(`/v1/effects/${encodeURIComponent(input.effectId)}/commit`, {
      projectId: input.projectId,
      body: {},
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/effects");
    return { projectId: input.projectId, resourceId: input.effectId };
  });
}

export async function reconcileEffectAction(formData: FormData): Promise<never> {
  return runOperation("reconcile-effect", formData, async () => {
    const input = parseEffectOperation(formData);
    await apiMutation<unknown>(`/v1/effects/${encodeURIComponent(input.effectId)}/reconcile`, {
      projectId: input.projectId,
      body: {},
      idempotencyKey: crypto.randomUUID(),
    });
    revalidatePath("/effects");
    return { projectId: input.projectId, resourceId: input.effectId };
  });
}

export async function recordReceiptAction(formData: FormData): Promise<never> {
  return runOperation("record-receipt", formData, async () => {
    const input = parseRecordReceipt(formData);
    const response = await apiMutation<unknown>(
      `/v1/effects/${encodeURIComponent(input.effectId)}/receipts`,
      {
        projectId: input.projectId,
        body: input.body,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    revalidatePath("/effects");
    return {
      projectId: input.projectId,
      resourceId: responseId(response, ["id"]) ?? input.effectId,
    };
  });
}

export async function transitionRemediationAction(formData: FormData): Promise<never> {
  return runOperation("transition-remediation", formData, async () => {
    const input = parseTransitionRemediation(formData);
    const response = await apiMutation<unknown>(
      `/v1/effects/${encodeURIComponent(input.effectId)}/remediations/${encodeURIComponent(input.remediationId)}/transition`,
      {
        projectId: input.projectId,
        body: input.body,
        idempotencyKey: crypto.randomUUID(),
      },
    );
    revalidatePath("/effects");
    revalidatePath(`/effects/${encodeURIComponent(input.effectId)}`);
    return {
      projectId: input.projectId,
      resourceId: responseId(response, ["id"]) ?? input.remediationId,
    };
  });
}

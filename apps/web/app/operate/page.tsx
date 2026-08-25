import { AlertTriangle, CheckCircle2, LockKeyhole, Wrench } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "../../src/components/page";
import {
  addEvidenceAction,
  commitEffectAction,
  computeImpactAction,
  createLineageAction,
  createOutputAction,
  invalidateOutputAction,
  prepareEffectAction,
  promoteOutputAction,
  reconcileEffectAction,
  recordReceiptAction,
  transitionRemediationAction,
} from "../../src/lib/operator-actions";
import { ensureProjectId } from "../../src/lib/project-scope";
import { firstParam, type NextSearchParams } from "../../src/lib/query";

export const metadata: Metadata = { title: "Operate" };

const OPERATION_LABELS: Record<string, string> = {
  "add-evidence": "Evidence recorded",
  "commit-effect": "Effect execution requested",
  "compute-impact": "Impact computed",
  "create-lineage": "Lineage edge created",
  "create-output": "Output created",
  "invalidate-output": "Invalidation propagated",
  "prepare-effect": "Effect prepared",
  "promote-output": "Output promoted",
  "reconcile-effect": "Reconciliation requested",
  "record-receipt": "Manual receipt recorded",
  "transition-remediation": "Remediation status transitioned",
};

type FormAction = (formData: FormData) => Promise<never>;

function cleanNotice(value: string | undefined, max: number): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length <= max ? candidate : undefined;
}

function ProjectField({ projectId }: { projectId: string | undefined }): React.JSX.Element | null {
  return projectId ? <input type="hidden" name="projectId" value={projectId} /> : null;
}

function OperationForm({
  action,
  projectId,
  title,
  description,
  submitLabel,
  tone = "primary",
  children,
}: {
  action: FormAction;
  projectId: string | undefined;
  title: string;
  description: string;
  submitLabel: string;
  tone?: "primary" | "warning";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <form action={action} className="operation-card">
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <fieldset disabled={!projectId}>
        <ProjectField projectId={projectId} />
        <div className="operator-form-grid">{children}</div>
        <button
          className={`button ${tone === "warning" ? "button-warning" : "button-primary"}`}
          type="submit"
        >
          {submitLabel}
        </button>
      </fieldset>
    </form>
  );
}

function Field({
  label,
  name,
  hint,
  required = false,
  defaultValue,
  placeholder,
  maxLength,
  type = "text",
  wide = false,
}: {
  label: string;
  name: string;
  hint?: string;
  required?: boolean;
  defaultValue?: string | undefined;
  placeholder?: string;
  maxLength: number;
  type?: "number" | "text";
  wide?: boolean;
}): React.JSX.Element {
  return (
    <label className={`operator-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        maxLength={type === "text" ? maxLength : undefined}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function JsonField({
  label,
  name,
  defaultValue = "{}",
  hint,
  required = true,
  wide = true,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  hint?: string;
  required?: boolean;
  wide?: boolean;
}): React.JSX.Element {
  return (
    <label className={`operator-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <textarea
        className="operator-json-input"
        name={name}
        required={required}
        defaultValue={defaultValue}
        maxLength={262_144}
        spellCheck={false}
      />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
  defaultValue,
  hint,
}: {
  label: string;
  name: string;
  options: readonly string[];
  defaultValue?: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <label className="operator-field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue}>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function SelectorFields(): React.JSX.Element {
  return (
    <>
      <SelectField
        label="Selector kind"
        name="selectorKind"
        options={["unknown", "json_path", "file", "symbol", "table_column", "record"]}
        defaultValue="unknown"
      />
      <Field
        label="Selector value"
        name="selectorValue"
        required
        defaultValue="*"
        maxLength={4096}
        hint='unknown requires the conservative wildcard "*".'
      />
    </>
  );
}

function Notice({ params }: { params: NextSearchParams }): React.JSX.Element | null {
  const notice = firstParam(params.notice);
  const operation = cleanNotice(firstParam(params.operation), 40);
  if (notice !== "success" && notice !== "error") return null;
  const label = (operation && OPERATION_LABELS[operation]) ?? "Operator action";
  if (notice === "success") {
    const resourceId = cleanNotice(firstParam(params.resourceId), 512);
    return (
      <div className="operator-notice success" role="status" aria-live="polite">
        <CheckCircle2 size={19} aria-hidden="true" />
        <div>
          <strong>{label}</strong>
          <p>
            ArcDB accepted the request.
            {resourceId ? (
              <>
                {" "}
                Resource: <code>{resourceId}</code>
              </>
            ) : null}
          </p>
        </div>
      </div>
    );
  }
  const code = cleanNotice(firstParam(params.code), 80) ?? "OPERATION_FAILED";
  const message =
    cleanNotice(firstParam(params.message), 240) ?? "ArcDB could not complete the operation.";
  const requestId = cleanNotice(firstParam(params.requestId), 128);
  return (
    <div className="operator-notice error" role="alert">
      <AlertTriangle size={19} aria-hidden="true" />
      <div>
        <strong>{label} failed</strong>
        <p>
          {message} <code>{code}</code>
          {requestId ? (
            <>
              {" "}
              Request: <code>{requestId}</code>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

export default async function OperatePage({
  searchParams,
}: {
  searchParams: Promise<NextSearchParams>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const projectId = await ensureProjectId(params, "/operate");
  const versionId = cleanNotice(firstParam(params.versionId), 512);
  const requestedEffectId = cleanNotice(firstParam(params.effectId), 36);
  const effectId =
    requestedEffectId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      requestedEffectId,
    )
      ? requestedEffectId
      : undefined;
  const requestedRemediationId = cleanNotice(firstParam(params.remediationId), 36);
  const remediationId =
    requestedRemediationId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      requestedRemediationId,
    )
      ? requestedRemediationId
      : undefined;
  const requestedRemediationStatus = cleanNotice(firstParam(params.remediationStatus), 32);
  const remediationStatus = ["OPEN", "PENDING_APPROVAL", "IN_PROGRESS"].includes(
    requestedRemediationStatus ?? "",
  )
    ? requestedRemediationStatus
    : undefined;
  return (
    <div className="page-container">
      <PageHeader
        eyebrow="Operator workbench"
        title="Run the ArcDB lifecycle"
        description="Create durable artifacts, attach evidence, promote trusted versions, declare lineage, propagate invalidation, and close manual effects through the real ArcDB API."
        actions={
          <span className="status-badge status-warning">
            <LockKeyhole size={12} aria-hidden="true" /> API permissions enforced
          </span>
        }
      />
      <Notice params={params} />
      {!projectId ? (
        <div className="operator-notice error" role="alert">
          <AlertTriangle size={19} aria-hidden="true" />
          <div>
            <strong>No project is available</strong>
            <p>Forms remain disabled until the server identity can read an ArcDB project.</p>
          </div>
        </div>
      ) : null}
      <section className="operator-boundary" aria-label="Safety boundary">
        <Wrench size={19} aria-hidden="true" />
        <div>
          <strong>Supported effect boundary</strong>
          <p>
            This workbench prepares only the built-in <code>manual-receipt</code> connector with R3
            reversibility. Commit and reconcile enqueue durable ArcDB jobs; they do not perform an
            external write or infer its outcome. After an authorized human performs the external
            action, record its immutable receipt below. Automatic connector orchestration and
            compensation are not exposed because this release does not implement them. Remediation
            transitions below remain explicit, authorized human actions.
          </p>
        </div>
      </section>

      <h2 className="operator-group-title">Outputs and evidence</h2>
      <div className="operator-card-grid">
        <OperationForm
          action={createOutputAction}
          projectId={projectId}
          title="1. Create output"
          description="Store immutable content and create a staged output version."
          submitLabel="Create output"
        >
          <Field
            label="Logical ID"
            name="logicalId"
            required
            maxLength={512}
            placeholder="report/monthly"
          />
          <Field
            label="Version ID"
            name="versionId"
            maxLength={512}
            hint="Optional; the API derives one when blank."
          />
          <Field label="Branch" name="branch" required defaultValue="main" maxLength={128} />
          <SelectField
            label="Output type"
            name="outputType"
            options={[
              "text",
              "json",
              "markdown",
              "code_patch",
              "file_tree",
              "sql",
              "tool_plan",
              "decision",
              "dataset_record",
            ]}
            defaultValue="json"
          />
          <JsonField
            label="Content"
            name="content"
            defaultValue={'{"status":"ready"}'}
            hint="Structured output types require JSON; text-like types accept plain text."
          />
          <Field label="Schema ID" name="schemaId" maxLength={256} />
          <Field label="Producer run UUID" name="producerRunId" maxLength={36} />
          <Field label="Producer agent ID" name="producerAgentId" maxLength={256} />
          <Field
            label="Parent version IDs"
            name="parentVersionIds"
            maxLength={131_072}
            hint="Comma or newline separated; up to 100."
            wide
          />
          <Field label="Policy version" name="policyVersion" maxLength={256} />
          <JsonField label="Metadata" name="metadata" />
        </OperationForm>

        <OperationForm
          action={addEvidenceAction}
          projectId={projectId}
          title="2. Add evidence"
          description="Attach a typed verifier result to an immutable output version."
          submitLabel="Record evidence"
        >
          <Field
            label="Output version ID"
            name="versionId"
            required
            defaultValue={versionId}
            maxLength={512}
          />
          <SelectField
            label="Verdict"
            name="verdict"
            options={["PASS", "FAIL", "STALE", "UNKNOWN"]}
            defaultValue="PASS"
          />
          <Field
            label="Verifier type"
            name="verifierType"
            required
            defaultValue="shadow-sql"
            maxLength={256}
          />
          <Field
            label="Verifier version"
            name="verifierVersion"
            required
            defaultValue="1"
            maxLength={256}
          />
          <Field
            label="Confidence"
            name="confidence"
            type="number"
            maxLength={64}
            hint="Optional number from 0 to 1."
          />
          <Field label="Policy version" name="policyVersion" maxLength={256} />
          <Field label="Environment digest" name="environmentDigest" maxLength={256} />
          <Field
            label="Dependency digests"
            name="dependencyDigests"
            maxLength={131_072}
            hint="Comma or newline separated."
            wide
          />
          <JsonField
            label="Metrics"
            name="metrics"
            hint="Object values must be strings, numbers, or booleans."
          />
          <JsonField
            label="Evidence payload"
            name="payload"
            defaultValue=""
            required={false}
            hint="Optional JSON value; stored as an artifact."
          />
          <Field
            label="Expires at"
            name="expiresAt"
            maxLength={64}
            hint="Optional ISO 8601 timestamp with Z or an offset."
            wide
          />
        </OperationForm>

        <OperationForm
          action={promoteOutputAction}
          projectId={projectId}
          title="3. Promote output"
          description="Validate fresh passing evidence, provenance closure, head CAS, and fencing before promotion."
          submitLabel="Promote output"
        >
          <Field
            label="Output version ID"
            name="versionId"
            required
            defaultValue={versionId}
            maxLength={512}
          />
          <Field label="Branch" name="branch" required defaultValue="main" maxLength={128} />
          <Field
            label="Expected head version ID"
            name="expectedHeadVersionId"
            maxLength={512}
            hint="Leave blank only when the branch has no current head."
            wide
          />
          <Field
            label="Required verifier types"
            name="requiredVerifierTypes"
            required
            defaultValue="shadow-sql"
            maxLength={131_072}
            hint="Comma or newline separated. Every required verifier must have fresh PASS evidence."
            wide
          />
          <Field label="Policy version" name="policyVersion" maxLength={256} />
          <Field
            label="Fencing token"
            name="fencingToken"
            type="number"
            maxLength={64}
            hint="Optional non-negative integer; normally acquired by the API."
          />
        </OperationForm>
      </div>

      <h2 className="operator-group-title">Lineage and invalidation</h2>
      <div className="operator-card-grid">
        <OperationForm
          action={createLineageAction}
          projectId={projectId}
          title="4. Add typed lineage"
          description="Declare a directed dependency between two existing output versions."
          submitLabel="Create lineage edge"
        >
          <Field
            label="Source version ID"
            name="sourceVersionId"
            required
            defaultValue={versionId}
            maxLength={512}
          />
          <Field label="Target version ID" name="targetVersionId" required maxLength={512} />
          <SelectField
            label="Edge type"
            name="edgeType"
            options={[
              "DERIVED_FROM",
              "READ_FROM",
              "PRODUCED_BY",
              "VERIFIED_BY",
              "CONSUMED_BY",
              "CAUSED",
              "SUPERSEDES",
              "COMPENSATED_BY",
              "REMEDIATED_BY",
            ]}
            defaultValue="DERIVED_FROM"
          />
          <SelectorFields />
          <Field label="Transfer function" name="transferFunction" maxLength={512} />
          <label className="operator-check">
            <input type="checkbox" name="inferred" />
            <span>Mark as inferred</span>
          </label>
          <Field
            label="Inference confidence"
            name="confidence"
            type="number"
            maxLength={64}
            hint="Allowed only for inferred edges; 0 to 1."
          />
        </OperationForm>

        <OperationForm
          action={computeImpactAction}
          projectId={projectId}
          title="5. Compute impact"
          description="Evaluate selector-aware downstream impact, then open the lineage explanation view."
          submitLabel="Compute impact"
        >
          <Field
            label="Source version ID"
            name="sourceVersionId"
            required
            defaultValue={versionId}
            maxLength={512}
            wide
          />
          <SelectorFields />
          <Field label="Before digest" name="beforeDigest" maxLength={256} />
          <Field label="After digest" name="afterDigest" maxLength={256} />
        </OperationForm>

        <OperationForm
          action={invalidateOutputAction}
          projectId={projectId}
          title="6. Propagate invalidation"
          description="Persist lifecycle changes, stale evidence, a recomputation plan, and remediation obligations."
          submitLabel="Invalidate and propagate"
          tone="warning"
        >
          <Field
            label="Source version ID"
            name="versionId"
            required
            defaultValue={versionId}
            maxLength={512}
            wide
          />
          <Field label="Reason" name="reason" required maxLength={4096} wide />
          <SelectorFields />
          <Field label="Before digest" name="beforeDigest" maxLength={256} />
          <Field label="After digest" name="afterDigest" maxLength={256} />
        </OperationForm>
      </div>

      <h2 className="operator-group-title">Manual effects</h2>
      <div className="operator-card-grid">
        <OperationForm
          action={prepareEffectAction}
          projectId={projectId}
          title="7. Prepare manual effect"
          description="Create a fenced intent for a promoted or committed source output; no external write occurs."
          submitLabel="Prepare effect"
        >
          <Field
            label="Source output version ID"
            name="sourceOutputVersionId"
            required
            defaultValue={versionId}
            maxLength={512}
            wide
          />
          <Field
            label="Target"
            name="target"
            required
            defaultValue="operator://manual"
            maxLength={2048}
          />
          <Field label="Resource key" name="resourceKey" required maxLength={512} />
          <Field
            label="Idempotency key"
            name="idempotencyKey"
            required
            defaultValue={`manual-${crypto.randomUUID()}`}
            maxLength={256}
            hint="Keep this key stable when retrying the same intent."
            wide
          />
          <SelectField
            label="Risk"
            name="riskLevel"
            options={["LOW", "MEDIUM", "HIGH", "CRITICAL"]}
            defaultValue="MEDIUM"
          />
          <Field label="Base resource version" name="baseResourceVersion" maxLength={512} />
          <JsonField label="Arguments" name="arguments" />
          <JsonField label="Preconditions" name="preconditions" />
          <JsonField label="Expected effects" name="expectedEffects" />
          <Field
            label="Read set"
            name="readSet"
            maxLength={131_072}
            hint="Comma or newline separated."
            wide
          />
          <Field
            label="Write set"
            name="writeSet"
            maxLength={131_072}
            hint="Comma or newline separated."
            wide
          />
        </OperationForm>

        <OperationForm
          action={commitEffectAction}
          projectId={projectId}
          title="8a. Request commit"
          description="Enqueue the durable worker job for a PREPARED or FAILED intent. Manual-receipt never executes an external write."
          submitLabel="Request commit"
        >
          <Field
            label="Effect intent UUID"
            name="effectId"
            required
            defaultValue={effectId}
            maxLength={36}
            wide
          />
        </OperationForm>

        <OperationForm
          action={reconcileEffectAction}
          projectId={projectId}
          title="8b. Request reconciliation"
          description="Enqueue recovery for an uncertain intent. The manual connector cannot query external state, so a receipt is still required."
          submitLabel="Request reconciliation"
        >
          <Field
            label="Effect intent UUID"
            name="effectId"
            required
            defaultValue={effectId}
            maxLength={36}
            wide
          />
        </OperationForm>

        <OperationForm
          action={recordReceiptAction}
          projectId={projectId}
          title="9. Record manual receipt"
          description="After the authorized external action, append its observed result and close or escalate the effect."
          submitLabel="Record immutable receipt"
          tone="warning"
        >
          <Field
            label="Effect intent UUID"
            name="effectId"
            required
            defaultValue={effectId}
            maxLength={36}
          />
          <SelectField
            label="External status"
            name="externalStatus"
            options={["COMMITTED", "FAILED", "UNKNOWN"]}
            defaultValue="COMMITTED"
            hint="UNKNOWN creates RECONCILIATION_REQUIRED."
          />
          <Field
            label="External transaction ID"
            name="externalTransactionId"
            maxLength={512}
            wide
          />
          <Field label="Before digest" name="beforeDigest" maxLength={256} />
          <Field label="After digest" name="afterDigest" maxLength={256} />
          <JsonField label="Actual effects" name="actualEffects" />
          <JsonField label="Raw response" name="rawResponse" defaultValue="" required={false} />
          <Field label="Compensation status" name="compensationStatus" maxLength={512} />
          <Field
            label="Committed at"
            name="committedAt"
            maxLength={64}
            hint="Optional ISO 8601 timestamp with Z or an offset."
          />
        </OperationForm>

        <OperationForm
          action={transitionRemediationAction}
          projectId={projectId}
          title="10. Transition remediation"
          description="Advance an obligation with compare-and-set status. Resolving or waiving it requires a structured reason and references."
          submitLabel="Transition obligation"
          tone="warning"
        >
          <Field
            label="Effect intent UUID"
            name="effectId"
            required
            defaultValue={effectId}
            maxLength={36}
          />
          <Field
            label="Remediation UUID"
            name="remediationId"
            required
            defaultValue={remediationId}
            maxLength={36}
          />
          <SelectField
            label="Expected current status"
            name="expectedStatus"
            options={["OPEN", "PENDING_APPROVAL", "IN_PROGRESS", "RESOLVED", "WAIVED"]}
            defaultValue={remediationStatus ?? "OPEN"}
            hint="Compare-and-set rejects stale operator state."
          />
          <SelectField
            label="Next status"
            name="nextStatus"
            options={["PENDING_APPROVAL", "IN_PROGRESS", "RESOLVED", "WAIVED"]}
            defaultValue={remediationStatus === "IN_PROGRESS" ? "RESOLVED" : "IN_PROGRESS"}
            hint="Allowed transitions are enforced before the request and by the API."
          />
          <JsonField
            label="Terminal resolution"
            name="resolution"
            defaultValue=""
            required={false}
            hint={
              'Required only for RESOLVED or WAIVED. Example: {"summary":"Verified fix","references":[],"metadata":{}}'
            }
          />
        </OperationForm>
      </div>
    </div>
  );
}

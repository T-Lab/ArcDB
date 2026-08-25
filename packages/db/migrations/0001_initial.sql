-- ArcDB-PG correctness schema. PostgreSQL 15+ is the supported reference engine.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  password_hash text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(trim(email)))
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX organization_memberships_user_idx ON organization_memberships (user_id, tenant_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  retention_days integer CHECK (retention_days IS NULL OR retention_days > 0),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id)
);
CREATE INDEX projects_tenant_created_idx ON projects (tenant_id, created_at DESC);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  prefix text NOT NULL CHECK (length(prefix) BETWEEN 8 AND 64),
  key_hash text NOT NULL,
  last_four text NOT NULL CHECK (length(last_four) = 4),
  permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_project_tenant_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (prefix)
);
CREATE INDEX api_keys_tenant_project_idx ON api_keys (tenant_id, project_id, created_at DESC);
CREATE INDEX api_keys_active_prefix_idx ON api_keys (prefix) WHERE revoked_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  external_id text,
  name text,
  user_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, project_id, external_id),
  UNIQUE (tenant_id, project_id, id)
);
CREATE INDEX sessions_project_updated_idx ON sessions (tenant_id, project_id, updated_at DESC);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  session_id uuid,
  external_id text,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  environment text,
  agent_id text,
  input jsonb,
  output jsonb,
  error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT runs_session_fk FOREIGN KEY (tenant_id, project_id, session_id)
    REFERENCES sessions(tenant_id, project_id, id) ON DELETE SET NULL (session_id),
  CONSTRAINT runs_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (tenant_id, project_id, external_id),
  UNIQUE (tenant_id, project_id, id)
);
CREATE INDEX runs_project_started_idx ON runs (tenant_id, project_id, started_at DESC, id DESC);
CREATE INDEX runs_status_idx ON runs (tenant_id, project_id, status, started_at DESC);
CREATE INDEX runs_session_idx ON runs (tenant_id, session_id, started_at DESC) WHERE session_id IS NOT NULL;

CREATE TABLE traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  run_id uuid,
  session_id uuid,
  external_id text,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  input jsonb,
  output jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT traces_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT traces_run_fk FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES runs(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT traces_session_fk FOREIGN KEY (tenant_id, project_id, session_id)
    REFERENCES sessions(tenant_id, project_id, id) ON DELETE SET NULL (session_id),
  CONSTRAINT traces_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (tenant_id, project_id, external_id),
  UNIQUE (tenant_id, project_id, id)
);
CREATE INDEX traces_project_started_idx ON traces (tenant_id, project_id, started_at DESC, id DESC);
CREATE INDEX traces_run_idx ON traces (tenant_id, run_id, started_at DESC) WHERE run_id IS NOT NULL;
CREATE INDEX traces_session_idx ON traces (tenant_id, session_id, started_at DESC) WHERE session_id IS NOT NULL;

CREATE TABLE spans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  trace_id uuid NOT NULL,
  parent_span_id uuid,
  external_id text,
  kind text NOT NULL DEFAULT 'SPAN' CHECK (kind IN (
    'SPAN', 'GENERATION', 'TOOL_CALL', 'EVENT', 'EVALUATOR', 'AGENT'
  )),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'UNSET' CHECK (status IN ('UNSET', 'RUNNING', 'OK', 'ERROR', 'CANCELLED')),
  model text,
  input jsonb,
  output jsonb,
  error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spans_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT spans_trace_fk FOREIGN KEY (tenant_id, project_id, trace_id)
    REFERENCES traces(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT spans_parent_fk FOREIGN KEY (tenant_id, project_id, parent_span_id)
    REFERENCES spans(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT spans_time_order CHECK (ended_at IS NULL OR ended_at >= started_at),
  UNIQUE (tenant_id, trace_id, external_id),
  UNIQUE (tenant_id, project_id, id)
);
CREATE INDEX spans_trace_started_idx ON spans (tenant_id, trace_id, started_at, id);
CREATE INDEX spans_parent_idx ON spans (tenant_id, parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX spans_kind_model_idx ON spans (tenant_id, project_id, kind, model, started_at DESC);

CREATE TABLE scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  trace_id uuid,
  span_id uuid,
  run_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  data_type text NOT NULL CHECK (data_type IN ('NUMERIC', 'BOOLEAN', 'CATEGORICAL')),
  numeric_value double precision,
  string_value text,
  comment text,
  source text NOT NULL DEFAULT 'API' CHECK (source IN ('API', 'EVALUATOR', 'HUMAN')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scores_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_trace_fk FOREIGN KEY (tenant_id, project_id, trace_id)
    REFERENCES traces(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_span_fk FOREIGN KEY (tenant_id, project_id, span_id)
    REFERENCES spans(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_run_fk FOREIGN KEY (tenant_id, project_id, run_id)
    REFERENCES runs(tenant_id, project_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_subject_present CHECK (num_nonnulls(trace_id, span_id, run_id) = 1),
  CONSTRAINT scores_value_matches_type CHECK (
    (data_type = 'NUMERIC' AND numeric_value IS NOT NULL AND string_value IS NULL) OR
    (data_type IN ('BOOLEAN', 'CATEGORICAL') AND string_value IS NOT NULL AND numeric_value IS NULL)
  )
);
CREATE INDEX scores_trace_name_idx ON scores (tenant_id, trace_id, name, created_at DESC);
CREATE INDEX scores_run_name_idx ON scores (tenant_id, run_id, name, created_at DESC);

CREATE TABLE artifact_manifests (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  content_ref text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  chunk_count integer NOT NULL CHECK (chunk_count >= 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_manifests_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, project_id, digest),
  UNIQUE (tenant_id, project_id, content_ref)
);

CREATE TABLE outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  logical_id text NOT NULL CHECK (length(logical_id) BETWEEN 1 AND 500),
  version_id text NOT NULL CHECK (length(version_id) BETWEEN 1 AND 200),
  output_type text NOT NULL CHECK (output_type IN (
    'text', 'json', 'markdown', 'code_patch', 'file_tree', 'sql', 'tool_plan', 'decision', 'dataset_record'
  )),
  schema_id text,
  content_ref text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^(sha256:)?[a-f0-9]{64}$'),
  producer_run_id uuid,
  producer_agent_id text,
  parent_version_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  policy_version text,
  lifecycle_state text NOT NULL DEFAULT 'CREATED' CHECK (lifecycle_state IN (
    'CREATED', 'STAGED', 'VERIFIED', 'APPROVED', 'COMMITTED', 'CONSUMED', 'PROMOTED',
    'REJECTED', 'STALE', 'INVALIDATED', 'SUPERSEDED'
  )),
  security_label text NOT NULL DEFAULT 'INTERNAL' CHECK (security_label IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outputs_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT outputs_run_fk FOREIGN KEY (tenant_id, project_id, producer_run_id)
    REFERENCES runs(tenant_id, project_id, id) ON DELETE SET NULL (producer_run_id),
  UNIQUE (tenant_id, project_id, logical_id, version_id),
  UNIQUE (tenant_id, project_id, version_id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX outputs_logical_created_idx ON outputs (tenant_id, project_id, logical_id, created_at DESC);
CREATE INDEX outputs_state_created_idx ON outputs (tenant_id, project_id, lifecycle_state, created_at DESC);
CREATE INDEX outputs_content_digest_idx ON outputs (content_digest);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  subject_version_id text NOT NULL,
  verifier_type text NOT NULL,
  verifier_version text NOT NULL,
  environment_digest text,
  dependency_digests text[] NOT NULL DEFAULT ARRAY[]::text[],
  policy_version text,
  verdict text NOT NULL CHECK (verdict IN ('PASS', 'FAIL', 'STALE', 'UNKNOWN')),
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  payload_ref text,
  fingerprint text NOT NULL CHECK (length(fingerprint) >= 16),
  security_label text NOT NULL DEFAULT 'INTERNAL' CHECK (security_label IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT evidence_subject_fk FOREIGN KEY (tenant_id, project_id, subject_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, project_id, subject_version_id, fingerprint),
  UNIQUE (tenant_id, id)
);
CREATE INDEX evidence_subject_fresh_idx ON evidence (tenant_id, subject_version_id, created_at DESC)
  WHERE verdict <> 'STALE';
CREATE INDEX evidence_expiry_idx ON evidence (tenant_id, expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE logical_heads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  logical_id text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  output_version_id text NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT logical_heads_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT logical_heads_output_fk FOREIGN KEY (tenant_id, project_id, output_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, logical_id, branch)
);
CREATE INDEX logical_heads_output_idx ON logical_heads (tenant_id, output_version_id);

CREATE TABLE lineage_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  source_version_id text NOT NULL,
  target_version_id text NOT NULL,
  edge_type text NOT NULL CHECK (edge_type IN (
    'PRODUCED_BY', 'DERIVED_FROM', 'READ_FROM', 'VERIFIED_BY', 'CONSUMED_BY',
    'CAUSED', 'SUPERSEDES', 'COMPENSATED_BY', 'REMEDIATED_BY'
  )),
  selector jsonb,
  transfer_function text,
  inferred boolean NOT NULL DEFAULT false,
  confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  dependency_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lineage_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT lineage_source_fk FOREIGN KEY (tenant_id, project_id, source_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE CASCADE,
  CONSTRAINT lineage_target_fk FOREIGN KEY (tenant_id, project_id, target_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE CASCADE,
  CONSTRAINT lineage_not_self CHECK (source_version_id <> target_version_id),
  CONSTRAINT lineage_selector_shape CHECK (
    selector IS NULL OR (
      jsonb_typeof(selector) = 'object' AND selector ? 'kind' AND selector ? 'value'
    )
  ),
  UNIQUE NULLS NOT DISTINCT (tenant_id, project_id, source_version_id, target_version_id, edge_type, selector)
);
CREATE INDEX lineage_forward_idx ON lineage_edges (tenant_id, source_version_id, edge_type, target_version_id);
CREATE INDEX lineage_reverse_idx ON lineage_edges (tenant_id, target_version_id, edge_type, source_version_id);

CREATE TABLE resource_fences (
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  resource_key text NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_fences_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, project_id, resource_key)
);

CREATE TABLE effect_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  source_output_version_id text NOT NULL,
  connector_type text NOT NULL,
  connector_capabilities jsonb NOT NULL CHECK (jsonb_typeof(connector_capabilities) = 'object'),
  target text NOT NULL,
  resource_key text NOT NULL,
  arguments_ref text NOT NULL,
  preconditions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(preconditions) = 'object'),
  expected_effects jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_effects) = 'object'),
  read_set text[] NOT NULL DEFAULT ARRAY[]::text[],
  write_set text[] NOT NULL DEFAULT ARRAY[]::text[],
  base_resource_version text,
  idempotency_key text NOT NULL,
  fencing_token bigint CHECK (fencing_token IS NULL OR fencing_token > 0),
  reversibility text NOT NULL CHECK (reversibility IN ('R0', 'R1', 'R2', 'R3')),
  compensation_handler text,
  risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN (
    'PREPARED', 'EXECUTING', 'COMMITTED', 'FAILED', 'COMPENSATION_PENDING', 'COMPENSATED',
    'REMEDIATION_REQUIRED', 'IRREVERSIBLE_COMMITTED', 'RECONCILIATION_REQUIRED'
  )),
  security_label text NOT NULL DEFAULT 'INTERNAL' CHECK (security_label IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT effect_intents_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT effect_intents_source_fk FOREIGN KEY (tenant_id, project_id, source_output_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, connector_type, idempotency_key),
  UNIQUE (tenant_id, project_id, id)
);
CREATE INDEX effect_intents_resource_idx ON effect_intents (tenant_id, resource_key, created_at DESC);
CREATE INDEX effect_intents_reconcile_idx ON effect_intents (tenant_id, status, updated_at)
  WHERE status IN ('EXECUTING', 'RECONCILIATION_REQUIRED', 'COMPENSATION_PENDING');

CREATE TABLE effect_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  sequence integer NOT NULL DEFAULT 1 CHECK (sequence > 0),
  external_transaction_id text,
  external_status text NOT NULL,
  before_digest text,
  after_digest text,
  actual_effects jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(actual_effects) = 'object'),
  raw_response_ref text,
  compensation_status text,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT effect_receipts_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT effect_receipts_intent_fk FOREIGN KEY (tenant_id, project_id, intent_id)
    REFERENCES effect_intents(tenant_id, project_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, intent_id, sequence)
);
CREATE INDEX effect_receipts_intent_idx ON effect_receipts (tenant_id, intent_id, sequence);
CREATE INDEX effect_receipts_external_idx ON effect_receipts (tenant_id, external_transaction_id)
  WHERE external_transaction_id IS NOT NULL;

CREATE TABLE lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'API_KEY', 'WORKER', 'SYSTEM')),
  actor_id text,
  request_id text,
  trace_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_context) = 'object'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lifecycle_events_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, project_id, aggregate_type, aggregate_id, sequence)
);
CREATE INDEX lifecycle_events_aggregate_idx ON lifecycle_events
  (tenant_id, aggregate_type, aggregate_id, sequence);
CREATE INDEX lifecycle_events_created_idx ON lifecycle_events (tenant_id, project_id, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid,
  actor_type text NOT NULL CHECK (actor_type IN ('USER', 'API_KEY', 'WORKER', 'SYSTEM')),
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  request_id text,
  ip_hash text,
  user_agent_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  previous_hash text,
  event_hash text NOT NULL CHECK (length(event_hash) >= 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX audit_events_tenant_created_idx ON audit_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (tenant_id, resource_type, resource_id, created_at DESC);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  method text NOT NULL CHECK (method ~ '^[A-Z]+$'),
  path text NOT NULL CHECK (left(path, 1) = '/'),
  request_hash text NOT NULL CHECK (length(request_hash) >= 32),
  state text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  response_body jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT idempotency_completed_response CHECK (
    state <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL)
  ),
  UNIQUE (tenant_id, project_id, idempotency_key)
);
CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (tenant_id, expires_at);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid,
  job_type text NOT NULL CHECK (job_type IN (
    'process_ingestion_batch', 'run_verifier', 'evaluate_policy', 'compute_impact',
    'propagate_invalidation', 'materialize_dataset_view', 'compact_artifacts',
    'garbage_collect_chunks', 'reconcile_effect', 'run_compensation',
    'create_remediation_obligation', 'publish_analytics_projection'
  )),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  result jsonb,
  error jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lock_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  trace_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(trace_context) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT jobs_effect_project_required CHECK (
    job_type NOT IN ('reconcile_effect', 'run_compensation') OR project_id IS NOT NULL
  ),
  UNIQUE NULLS NOT DISTINCT (tenant_id, project_id, job_type, idempotency_key),
  UNIQUE (tenant_id, id)
);
CREATE INDEX jobs_claim_idx ON jobs (tenant_id, status, available_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX jobs_stale_lock_idx ON jobs (tenant_id, lock_expires_at)
  WHERE status = 'RUNNING';

CREATE TABLE recomputation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  root_output_version_id text NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  reason text NOT NULL,
  affected_nodes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(affected_nodes) = 'array'),
  skipped_nodes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skipped_nodes) = 'array'),
  explanation_graph jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(explanation_graph) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recomputation_plans_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT recomputation_plans_root_fk FOREIGN KEY (tenant_id, project_id, root_output_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE RESTRICT
);
CREATE INDEX recomputation_plans_root_idx ON recomputation_plans (tenant_id, root_output_version_id, created_at DESC);

CREATE TABLE remediation_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  invalidated_output_version_id text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PENDING_APPROVAL', 'IN_PROGRESS', 'RESOLVED', 'WAIVED')),
  risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reason text NOT NULL,
  resolution jsonb,
  approved_by text,
  approved_by_actor_type text CHECK (approved_by_actor_type IN ('API_KEY', 'USER', 'WORKER', 'SYSTEM')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remediation_approver_complete CHECK (
    (approved_by IS NULL) = (approved_by_actor_type IS NULL)
  ),
  CONSTRAINT remediation_terminal_resolution CHECK (
    (status IN ('RESOLVED', 'WAIVED') AND resolution IS NOT NULL
      AND jsonb_typeof(resolution) = 'object' AND resolved_at IS NOT NULL)
    OR
    (status NOT IN ('RESOLVED', 'WAIVED') AND resolution IS NULL AND resolved_at IS NULL)
  ),
  CONSTRAINT remediation_project_fk FOREIGN KEY (tenant_id, project_id)
    REFERENCES projects(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT remediation_intent_fk FOREIGN KEY (tenant_id, project_id, intent_id)
    REFERENCES effect_intents(tenant_id, project_id, id) ON DELETE RESTRICT,
  CONSTRAINT remediation_output_fk FOREIGN KEY (tenant_id, project_id, invalidated_output_version_id)
    REFERENCES outputs(tenant_id, project_id, version_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, project_id, intent_id, invalidated_output_version_id)
);
CREATE INDEX remediation_open_idx ON remediation_obligations (tenant_id, project_id, risk_level, created_at)
  WHERE status IN ('OPEN', 'PENDING_APPROVAL', 'IN_PROGRESS');

CREATE OR REPLACE FUNCTION arcdb_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION arcdb_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION arcdb_protect_output_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.lifecycle_state IN ('COMMITTED', 'CONSUMED', 'PROMOTED', 'SUPERSEDED', 'INVALIDATED') THEN
      RAISE EXCEPTION 'committed output versions cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.version_id IS DISTINCT FROM OLD.version_id OR
       NEW.logical_id IS DISTINCT FROM OLD.logical_id OR
       NEW.output_type IS DISTINCT FROM OLD.output_type OR
       NEW.schema_id IS DISTINCT FROM OLD.schema_id OR
       NEW.content_ref IS DISTINCT FROM OLD.content_ref OR
       NEW.content_digest IS DISTINCT FROM OLD.content_digest OR
       NEW.producer_run_id IS DISTINCT FROM OLD.producer_run_id OR
       NEW.producer_agent_id IS DISTINCT FROM OLD.producer_agent_id OR
       NEW.parent_version_ids IS DISTINCT FROM OLD.parent_version_ids OR
       NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'output version identity and content are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER traces_updated_at BEFORE UPDATE ON traces
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER spans_updated_at BEFORE UPDATE ON spans
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER outputs_updated_at BEFORE UPDATE ON outputs
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER outputs_immutable BEFORE UPDATE OR DELETE ON outputs
  FOR EACH ROW EXECUTE FUNCTION arcdb_protect_output_version();
CREATE TRIGGER effect_intents_updated_at BEFORE UPDATE ON effect_intents
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER recomputation_plans_updated_at BEFORE UPDATE ON recomputation_plans
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER remediation_obligations_updated_at BEFORE UPDATE ON remediation_obligations
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();
CREATE TRIGGER idempotency_records_updated_at BEFORE UPDATE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION arcdb_set_updated_at();

CREATE TRIGGER effect_receipts_append_only BEFORE UPDATE OR DELETE ON effect_receipts
  FOR EACH ROW EXECUTE FUNCTION arcdb_deny_mutation();
CREATE TRIGGER lifecycle_events_append_only BEFORE UPDATE OR DELETE ON lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION arcdb_deny_mutation();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION arcdb_deny_mutation();

-- Tenant isolation is a database invariant. The application role is constrained
-- by FORCE ROW LEVEL SECURITY. Trusted control-plane operations use a separate
-- PostgreSQL role with BYPASSRLS; no caller-controlled setting can disable a policy.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'organization_memberships', 'projects', 'api_keys', 'sessions',
    'runs', 'traces', 'spans', 'scores', 'artifact_manifests', 'outputs', 'evidence', 'logical_heads',
    'lineage_edges', 'resource_fences', 'effect_intents', 'effect_receipts',
    'lifecycle_events', 'audit_events', 'idempotency_records', 'jobs', 'recomputation_plans',
    'remediation_obligations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    IF table_name = 'organizations' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR SELECT USING (id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name
      );
    ELSIF table_name = 'organization_memberships' THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
        table_name
      );
    ELSIF table_name = 'projects' THEN
      EXECUTE format(
        'CREATE POLICY tenant_project_isolation ON %I FOR SELECT USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND id = nullif(current_setting(''app.project_id'', true), '''')::uuid)',
        table_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY tenant_project_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid AND project_id = nullif(current_setting(''app.project_id'', true), '''')::uuid)',
        table_name
      );
    END IF;
  END LOOP;
END;
$$;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.user_id = users.id
        AND membership.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    )
  );

COMMENT ON TABLE effect_receipts IS 'Immutable observations of external reality; UPDATE and DELETE are rejected.';
COMMENT ON TABLE logical_heads IS 'Mutable branch pointers advanced through generation-checked compare-and-swap.';
COMMENT ON COLUMN effect_intents.fencing_token IS 'Monotonic token checked before external commit where the connector supports fencing.';

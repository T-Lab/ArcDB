import type { SqlExecutor } from "../database.js";
import {
  AuditRepository,
  JobsRepository,
  LifecycleEventsRepository,
  RecomputePlansRepository,
  RemediationObligationsRepository,
} from "./control.js";
import {
  ApiKeysRepository,
  MembershipsRepository,
  OrganizationsRepository,
  ProjectsRepository,
  UsersRepository,
} from "./identity.js";
import {
  EffectsRepository,
  EvidenceRepository,
  HeadsRepository,
  LineageRepository,
  OutputsRepository,
  ReceiptsRepository,
  ResourceFencesRepository,
} from "./lifecycle.js";
import {
  RunsRepository,
  ScoresRepository,
  SessionsRepository,
  SpansRepository,
  TracesRepository,
} from "./telemetry.js";

export * from "./control.js";
export * from "./helpers.js";
export * from "./identity.js";
export * from "./lifecycle.js";
export * from "./telemetry.js";

export function createRepositories(executor: SqlExecutor) {
  return {
    organizations: new OrganizationsRepository(executor),
    users: new UsersRepository(executor),
    memberships: new MembershipsRepository(executor),
    projects: new ProjectsRepository(executor),
    apiKeys: new ApiKeysRepository(executor),
    sessions: new SessionsRepository(executor),
    runs: new RunsRepository(executor),
    traces: new TracesRepository(executor),
    spans: new SpansRepository(executor),
    scores: new ScoresRepository(executor),
    outputs: new OutputsRepository(executor),
    evidence: new EvidenceRepository(executor),
    heads: new HeadsRepository(executor),
    lineage: new LineageRepository(executor),
    effects: new EffectsRepository(executor),
    receipts: new ReceiptsRepository(executor),
    resourceFences: new ResourceFencesRepository(executor),
    lifecycleEvents: new LifecycleEventsRepository(executor),
    audit: new AuditRepository(executor),
    jobs: new JobsRepository(executor),
    recomputationPlans: new RecomputePlansRepository(executor),
    remediationObligations: new RemediationObligationsRepository(executor),
  } as const;
}

export type Repositories = ReturnType<typeof createRepositories>;

# ArcDB web console

The console is a Next.js App Router application for inspecting ArcDB traces, output versions,
evidence, lineage impact, external effects, and audit events. Its `/operate` workbench also drives
the supported lifecycle through the real API: create Output, add Evidence, promote, add typed
lineage, compute and propagate invalidation, prepare/commit/reconcile a manual Effect, and record
an immutable manual Receipt. Operators can also advance remediation obligations through the
approval, execution, resolution, and waiver state machine with compare-and-set protection.

## Security boundary

All ArcDB API reads and mutations run on the server through `src/lib/api.ts`. Server Actions parse
and validate `FormData`, invoke the server-only mutation transport, then use a post/redirect/get
result notice. Configure these values only in the web server environment:

```bash
ARCDB_API_URL=http://localhost:4000
ARCDB_API_KEY=arcdb_dev_change_me_32_characters
ARCDB_CONSOLE_USERNAME=operator
ARCDB_CONSOLE_PASSWORD=a-long-random-console-password
```

`ARCDB_API_KEY` is attached as `Authorization: Bearer …` by the server-only client. It is never put
in `NEXT_PUBLIC_*`, passed to a client component, or serialized into HTML.
The selected project is sent upstream with `X-ArcDB-Project-Id`; it remains in the browser URL only
as stable console navigation state and is not forwarded into strict API query schemas.

The console uses one server-side API identity, so every browser user would otherwise inherit that
identity's read authority. Next.js Proxy therefore requires HTTP Basic authentication whenever the
two console credential variables are set, and production fails closed with `503` when they are
missing or invalid. `/health/live` is the only unauthenticated application route. Basic Auth is an
operator perimeter, not multi-user RBAC; deploy behind TLS and an identity-aware proxy for shared
environments.

The workbench does not accept an API key from the browser. Authorization remains the intersection
of the console perimeter and the configured API key's ArcDB permissions. Every submitted project
and Effect ID is UUID-validated; identifiers, enums, lists, JSON payloads, digests, timestamps, and
numeric bounds are validated again on the server before an API request is sent. Upstream failures
are reduced to safe status messages plus a bounded request ID rather than reflecting raw errors.
Every Server Action also repeats the Basic Auth decision from the incoming request before parsing or
mutating, so a Proxy matcher or routing regression cannot turn a Server Function into an
unauthenticated mutation endpoint.

## Effect boundary

The UI deliberately exposes only ArcDB's built-in `manual-receipt` connector. Preparing an Effect
creates a durable R3 intent. Commit and reconcile enqueue durable worker jobs, but neither the
browser nor the manual connector performs an external write or claims to query external state. An
authorized operator performs the external action separately and records the observed Receipt.
Automatic external connectors and compensation execution are not presented as implemented
features. Remediation approval/status transitions are explicit authorized API actions; they do not
silently execute an external fix.

## Commands

From the repository root:

```bash
corepack pnpm --filter @arcdb/web dev
corepack pnpm --filter @arcdb/web typecheck
corepack pnpm --filter @arcdb/web test
corepack pnpm --filter @arcdb/web build
```

The UI reads the versioned API paths documented in the repository guideline. List normalization
accepts the canonical `{ data: [], page: { hasMore, nextCursor }, requestId }` envelope as well as
the earlier `{ items, nextCursor }` shape so rolling upgrades do not break navigation.

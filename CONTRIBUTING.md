# Contributing to ArcDB

ArcDB welcomes focused issues and pull requests. For a significant domain or storage change, open an
issue first and add or update an ADR under `docs/decisions/`.

## Development

Requirements are Node.js 22+, Corepack, Docker with Compose, and Git.

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d --wait postgres redis minio
pnpm db:migrate
pnpm db:seed
docker compose run --rm --no-deps postgres-role-init
docker compose run --rm --no-deps minio-init
pnpm dev
```

Before opening a pull request, run:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

Public API changes need contracts, implementation, tests, SDK updates, and documentation. Database
changes require a new forward migration; never edit a migration that has shipped. Do not weaken a
lifecycle invariant to make a test pass.

## Commit and review expectations

Keep changes cohesive, describe failure behavior, and call out compatibility or migration risks.
Never commit credentials, real customer data, generated build output, or implicit chain-of-thought.

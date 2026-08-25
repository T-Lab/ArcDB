FROM node:22.22.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @arcdb/db... build

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=development
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable
COPY --from=build --chown=node:node /workspace /workspace
USER node

CMD ["sh", "-c", "node packages/db/dist/cli/migrate.js && node packages/db/dist/cli/seed.js"]

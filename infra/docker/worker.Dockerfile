FROM node:22.22.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @arcdb/worker... build

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable
COPY --from=build --chown=node:node /workspace /workspace
USER node

EXPOSE 4002
CMD ["node", "apps/worker/dist/server.js"]

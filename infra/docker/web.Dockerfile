FROM node:22.22.0-bookworm-slim AS build

ARG NEXT_PUBLIC_ARCDB_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_ARCDB_API_URL=$NEXT_PUBLIC_ARCDB_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable
COPY . .
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm --filter @arcdb/web... build

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /workspace

COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
USER node

EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.11 AS builder

WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.base.json typedoc.config.json typedoc.tsconfig.json ./
COPY apps/internal-gateway/package.json apps/internal-gateway/package.json
COPY apps/web-ui/package.json apps/web-ui/package.json
COPY packages/a2a/package.json packages/a2a/package.json
COPY packages/a2a-client/package.json packages/a2a-client/package.json
COPY packages/acp/package.json packages/acp/package.json
COPY packages/acp-host/package.json packages/acp-host/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/reporting/package.json packages/reporting/package.json
COPY packages/schema-utils/package.json packages/schema-utils/package.json
COPY packages/ui-components/package.json packages/ui-components/package.json
COPY packages/validation/package.json packages/validation/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

COPY . .
RUN bun run docs:build

FROM caddy:2-alpine

COPY --from=builder /app/docs/.vitepress/dist /srv
COPY deploy/docs.Caddyfile /etc/caddy/Caddyfile

EXPOSE 80

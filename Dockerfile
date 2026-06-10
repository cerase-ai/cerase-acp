# cerase-acp — in-house Discord-to-ACP bridge for Cerase.
#
# Multi-stage:
#   1. build  → node:20 (full toolchain) installs deps + compiles TS
#   2. runtime → node:20-slim with tini PID 1 + docker.io (needed to
#                spawn `opencode acp` in sibling agent containers via
#                `docker exec`).
#
# Operator contract:
#   - Mount agents.yaml at /etc/cerase-acp/agents.yaml (read-only).
#   - Pass DISCORD_BOT_TOKEN_<AGENT_ID> for each agent in agents.yaml.
#   - Optional: BRIDGE_E2E_TEST=1 to enable the test-injection
#     endpoint on :7474. Never set in production.
#   - Optional: CERASE_ACP_LOG_LEVEL=info|debug|warn|error|silent
#     (default info).
#   - Mount /var/run/docker.sock so the bridge can spawn sibling
#     containers' `opencode acp`. Tier-0 replaces with kubectl-via-
#     in-cluster-API; only the spawn command in agents.yaml changes.

# ---------- build stage ----------
# OPT-22: bumped from node:20 — Node 22 LTS active, no reason to stay
# on 20 on Ubuntu 26.04. Pure TypeScript build, no native deps.
FROM node:26 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Drop dev deps so the runtime stage copies a lean node_modules tree.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
# OPT-22: bumped from node:20-slim (see build-stage comment).
FROM node:26-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini docker.io \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules ./node_modules
COPY package.json ./

# Default config path. Override via CERASE_ACP_CONFIG.
ENV CERASE_ACP_CONFIG=/etc/cerase-acp/agents.yaml
ENV NODE_ENV=production
ENV CERASE_ACP_LOG_LEVEL=info

# OPT-26 (tech-audit 2026-06-01 D4): drop privileges to the bundled
# non-root `node` user (uid 1000) so the bridge process doesn't run
# as root in production. Reads agents.yaml read-only via the
# host-side bind mount; doesn't need root for anything else.
# Re-take ownership of /app so any future writable subdir works.
RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/index.js"]

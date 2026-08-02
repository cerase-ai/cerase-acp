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
#
# M-ACP-NPM-STRIP-1: pinned to an immutable digest. `node:22` is a MUTABLE tag —
# it is re-pushed on every patch release, so the same Dockerfile silently builds
# a different image tomorrow. cerase-agent pinned by digest under M-SUPPLY-PIN-1;
# this image was left on the moving tag. Refresh both digests together when the
# node line moves.
FROM node:22.22.3@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3 AS build
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
# M-ACP-NPM-STRIP-1: digest-pinned, same digest cerase-agent runs — one node
# across the fleet, and a base that cannot change under either image.
FROM node:22.22.3-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini docker.io \
 && rm -rf /var/lib/apt/lists/*

# M-ACP-NPM-STRIP-1: drop the npm bundled in the node base, exactly as
# cerase-agent does. The runtime CMD is `node dist/index.js` — npm is used only
# in the build stage above, which is discarded. Left here it is dead weight
# carrying the whole npm-bundled CVE class (npm 10.9.8 / sigstore 3.1.0 /
# picomatch), the same set that blocked cerase-agent's Trivy gate. node,
# corepack and yarn remain; nothing in src/ shells out to npm or npx.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

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

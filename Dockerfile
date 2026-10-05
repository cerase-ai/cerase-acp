# cerase-acp: the chat bridge of the Cerase platform. It connects each Cerase
# assistant to direct messages on Discord, Telegram, Slack or Google Workspace
# Chat, and runs each conversation as an ACP session with `opencode acp` inside
# the assistant's slot container, reached with `docker exec`.
#
# Two stages:
#   1. build: node:22 installs the dependencies, compiles the TypeScript and
#      drops the dev dependencies.
#   2. runtime: node:22-slim with tini as PID 1 and the Docker CLI, running
#      `node dist/index.js` as the non-root `node` user.
#
# What the container needs:
#   - agents.yaml at /etc/cerase-acp/agents.yaml (CERASE_ACP_CONFIG), mounted
#     read-only. The channel credentials are in it, directly or as ${env:VAR}.
#   - A Docker API for `docker exec` and `docker inspect` against the slots:
#     the socket, or DOCKER_HOST pointing at a proxy, as on the appliance.
#   - A volume on /var/lib/cerase-acp/state (CERASE_ACP_STATE_DIR) for what the
#     bridge keeps across a restart of its own.
#   - More than 200 s to stop, so the turns in flight can end and their notices
#     go out; the appliance gives it 220 s.
#   - Optional: CERASE_ACP_LOG_LEVEL (default info). BRIDGE_E2E_TEST=1 starts
#     the test-injection endpoint on 127.0.0.1:7474 and is never set in
#     production.
# README.md lists every variable.

# ---------- build stage ----------
# Node 22 LTS. A pure TypeScript build, no native dependencies.
#
# Pinned to an immutable digest: `node:22` is a mutable tag, re-pushed on every
# patch release, so the same Dockerfile would build a different image the next
# day. The slot image (cerase-core, agent-runtime/slot/Dockerfile) is pinned to
# the same node release; refresh the digests of both when the node line moves.
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
# Digest-pinned, the same digest the slot image runs: one node across the
# fleet, and a base that cannot change under either image.
FROM node:22.22.3-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime
# The digest-pinned base lags the debian security feed, so this stage applies
# the published security upgrades before installing anything. The blocking
# Trivy scan in the publish workflow holds the image to that, and it can only
# do so because the scan build excludes this stage from the layer cache: a
# cached apt layer keeps the packages of whichever day it was first built.
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends tini docker.io \
 && rm -rf /var/lib/apt/lists/*

# Drop the npm bundled in the node base, as the slot image does. The runtime
# CMD is `node dist/index.js` and npm is used only in the build stage above,
# which is discarded. Left here it carries the CVEs of npm's own dependencies
# into the image for nothing. node, corepack and yarn remain; nothing in src/
# shells out to npm or npx.
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

# The bridge runs as the base image's non-root `node` user (uid 1000): it reads
# agents.yaml from a read-only mount and needs root for nothing. The state
# directory holds what must outlive a restart of the bridge (resumable
# sessions, messages kept during a stop, the Chat space each person last wrote
# from), and is created here so a named volume mounted on it starts owned by
# that user.
RUN mkdir -p /var/lib/cerase-acp/state && chown -R node:node /app /var/lib/cerase-acp
ENV CERASE_ACP_STATE_DIR=/var/lib/cerase-acp/state
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/index.js"]

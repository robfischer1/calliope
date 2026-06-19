# Multi-stage Dockerfile for calliope-mcp — the prose-facet constellation star.
# A Node/pnpm app (no private schema, no DB; it reaches urania east-west over
# HTTP). Mirrors hades's builder→runtime split, adapted to the pnpm toolchain.

# -- Stage 1: builder ---------------------------------------------------------
# pnpm 11 requires Node >=22.13; node:22-bookworm-slim satisfies it.
FROM node:22-bookworm-slim AS builder

# Enable the pinned pnpm via corepack (version comes from package.json
# "packageManager"), so the image build matches the dev/CI toolchain exactly.
RUN corepack enable

WORKDIR /app

# Install with a frozen lockfile against just the manifest first, for layer
# caching: deps only re-resolve when package.json / the lockfile change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# Build dist/ (the `prepare` script also builds, but it's skipped above via
# --ignore-scripts; run the explicit build over the full source).
COPY . .
RUN pnpm build

# Prune to production deps only for a lean runtime node_modules.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm prune --prod --ignore-scripts

# -- Stage 2: runtime ---------------------------------------------------------
FROM node:22-bookworm-slim

# The runtime runs on `node` alone — strip the bundled global npm (+ its
# build-time deps) so image scans don't block on npm CVEs (e.g. picomatch ReDoS)
# that never execute in production.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Drop privileges: run as the stock unprivileged `node` user.
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=8204 \
    HOST=0.0.0.0 \
    URANIA_URL=http://urania:8202

USER node

EXPOSE 8204

# Parity with the other stars: a TCP-connect liveness probe on $PORT.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('net').createConnection(parseInt(process.env.PORT||'8204'),'127.0.0.1').on('connect',function(s){this.end();process.exit(0)}).on('error',function(){process.exit(1)})" || exit 1

CMD ["node", "dist/mcp/http.js"]

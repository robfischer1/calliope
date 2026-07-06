# Multi-stage Dockerfile for calliope-mcp — the prose-facet constellation star.
# Both stages run on oven/bun: bun runs the TypeScript natively (no tsc build,
# no dist/), so the runtime is bun, not node. The star exposes the SAME
# four-tool MCP server over StreamableHTTP; the container serves the HTTP
# transport (src/mcp/http.ts) that the Hades gateway fronts east-west at
# http://calliope-mcp:8204/mcp. Deps (@modelcontextprotocol/sdk, pg, zod) are
# pure JS and work under bun.

# -- Stage 1: builder (bun) ---------------------------------------------------
FROM oven/bun:1.3-slim AS builder
ENV CI=1
WORKDIR /app
COPY . /app
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
# Bundle the HTTP entrypoint + pg + mcp-sdk + zod into ONE bun-target file.
# --target=bun keeps node builtins (net/tls/crypto/http) external, resolved by
# the runtime bun; the artifact is self-contained without shipping node_modules
# — smaller image, smaller CVE surface (the node runtime's `pnpm prune --prod`
# equivalent). pg's optional pg-native is never required (native:false default),
# so it drops out cleanly.
RUN bun build src/mcp/http.ts --target=bun --outfile /deploy/server.js --minify

# -- Stage 2: runtime (bun) ---------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

# Patch the debian base: the pinned oven/bun tag lags debian's security fixes,
# so the deploy gate's Trivy blocks on fixable HIGH/CRITICAL base CVEs. Upgrade
# as root before dropping to the unprivileged bun user.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# The self-contained server bundle (no node_modules, no dist).
COPY --from=builder --chown=bun:bun /deploy/server.js ./server.js

ENV NODE_ENV=production \
    PORT=8204 \
    HOST=0.0.0.0 \
    # Substrate default for a no-DATABASE_URL run; compose overrides with the
    # sovereign store (DATABASE_URL → the pg backend) + CHAOS_URL for migration.
    URANIA_URL=http://urania:8202

USER bun

EXPOSE 8204

# Liveness probe — the oven/bun image has bun (no node, no curl); use bun's
# fetch against the MCP route. A GET /mcp answers 405 (POST-only), which still
# proves the HTTP server is up; only a connection failure fails the probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8204)+'/mcp').then(function(r){process.exit(r.status?0:1)}).catch(function(){process.exit(1)})"

CMD ["bun", "server.js"]

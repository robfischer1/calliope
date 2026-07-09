# Multi-stage Dockerfile for calliope -- on the stellar_core:bun-mcp base.
# The base is FROM oven/bun + the Pistis stellar-boot chain; its ENTRYPOINT is
# stellar-boot, which execs this CMD (dormant until CALYPSO_IDENTITY_ID is set).

# -- Stage 1: builder ---------------------------------------------------------
FROM forgejo.notusmi.com/rob/stellar_core:bun-mcp@sha256:b8d636c2b64b82f07940bdfddc9347443bc40775bfde367eca2ef5a4b449280b AS builder
ENV CI=1
WORKDIR /app
COPY . /app
RUN --mount=type=cache,id=bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
# Bundle the streamable-HTTP entry + deps into ONE bun-target file (no
# node_modules shipped -- smaller image, smaller CVE surface).
RUN bun build src/mcp/http.ts --target=bun --outfile /deploy/server.js --minify

# -- Stage 2: runtime ---------------------------------------------------------
FROM forgejo.notusmi.com/rob/stellar_core:bun-mcp@sha256:b8d636c2b64b82f07940bdfddc9347443bc40775bfde367eca2ef5a4b449280b
WORKDIR /app
COPY --from=builder --chown=bun:bun /deploy/server.js ./server.js
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8204
USER bun
EXPOSE 8204
# Liveness -- the base has bun (no curl); a GET /mcp answers 405 (POST-only),
# which still proves the HTTP server is up; only a connect failure fails.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8204)+'/mcp').then(function(r){process.exit(r.status?0:1)}).catch(function(){process.exit(1)})"
CMD ["bun", "server.js"]

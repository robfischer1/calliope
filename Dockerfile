# Dockerfile — the calliope star image: the fleet's bun base plus the bundle
# the Gate built. No build stage, and nothing installs or bundles here (CA
# master-plan F17).
#
# THE BUNDLE IS NOT BUILT HERE. The push's Gate builds it once (foundry-tools
# ts:release) ON THIS SAME BASE: `bun install --frozen-lockfile`, then the
# steps the record names (tools.build.release — `bun
# apps/calliope/scripts/bundle.ts release`), which bundle the streamable-HTTP
# entry and its dependencies into one bun-target file, release/server.js. No
# node_modules ship. Through the script rather than `bun build` inline: the
# core's Kafka client needs a resolve-time swap (its WebAssembly is read off
# disk relative to the module, which a one-file bundle cannot carry) and the
# CLI takes no plugins. The build lane stages the result at release/ in the
# build context before this file runs: `COPY release/…` is what asks for it
# (foundry-tools buildlane.CopiesRelease). release/ is never in the tree —
# .gitignore refuses it.
#
# THE BASE is oven/bun slim plus stellar-boot (foundry/base-images/bun); its
# ENTRYPOINT is stellar-boot, which execs this CMD — dormant until
# CALYPSO_IDENTITY_ID is set. Renovate moves the digest.
FROM registry.notusmi.com/foundry/base-images/bun:stable@sha256:4f9b16c1d9eb6659828ac4fd1a6db0e08c5d3c220530237d33c39c12c3cfc1b8
WORKDIR /app
# Numeric, so the host and the kubelet can resolve it without the image's
# /etc/passwd: the base's bun user, measured uid=1000 gid=1000 on the running pod.
COPY --chown=1000:1000 release/server.js ./server.js
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8204
# THE BOOT SMOKE (foundry-tools build:smoke): the build lane starts this image
# alone, on the in-memory fixture backend (no Postgres, no broker, no SPIRE),
# and it must still answer GET /mcp (405 counts) after 8s. The identity core
# loads at boot (http.ts), so a bundle that cannot carry its wasm is a red
# pull here rather than a crashloop in the cluster (stellar-core-ts 0.17.0,
# 2026-10-04).
LABEL org.notusmi.smoke="port=8204 path=/mcp wait=8 env=CALLIOPE_MCP_BACKEND=fixture"
USER 1000:1000
EXPOSE 8204 8205
# Liveness — the base has bun and curl; a GET /mcp answers 405 (POST-only),
# which still proves the HTTP server is up; only a connect failure fails.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8204)+'/mcp').then(function(r){process.exit(r.status?0:1)}).catch(function(){process.exit(1)})"]
CMD ["bun", "server.js"]

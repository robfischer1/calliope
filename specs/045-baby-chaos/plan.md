# Implementation Plan: Baby Chaos (F13)

**Spec**: `spec.md` | **Planning context**: master-plan F13 tail (authoritative — reconciled, not regenerated)

## Decisions (from the master-plan tail + Rob's D3/D4 approvals)

- **D3 — bundle the PG binaries**: zonky embedded-postgres artifacts
  (`io.zonky.test.postgres:embedded-postgres-binaries-{linux,windows}-amd64`,
  17.5.0) — relocatable, self-contained (rpath'd libs / bundled DLLs), the
  same binaries the embedded-postgres ecosystem boots. No docker at
  runtime, no lib-closure hand-packing.
- **D4 — build + verify from WSL**: linux integration suite gated on
  `CALLIOPE_BABYCHAOS_DIR`; windows smoke via interop against the real
  compiled exe + payload on `C:\`. Final acceptance: one manual Grace
  launch by Rob.
- **Soft-vector (chaos side, landed separately)**: bigintschema applies
  WLDDL only when pgvector is available; `HasWL` guards the WL verbs with
  `wl_unavailable`. The desktop payload ships NO pgvector.
- **Crash-only**: no second supervisor; child death after boot → sidecar
  exit 1 → Grace's existing generation-safe respawn ladder.
- **Boot failure ≠ crash**: a failed boot serves fs-only (`engine:
  failed`) — exiting would make Grace respawn into the same failure.
- **No themis on the desktop**: LocalChaosDial ports go-court ToWire
  in-process, held to the Go court by its own pinned constants
  (cross-language parity by constant, never by re-deriving).

## Module map

| Piece | File | Role |
| :--- | :--- | :--- |
| Engine lifecycle | `src/mcp/babychaos.ts` | resolvePayload / startEngine (initdb-once, freePort, readiness gates, reverse-order stop, crash-only onExit) |
| Local admit | `src/local-admit.ts` | contentHash + toCaptureOps (ToWire port) + LocalChaosDial (reads delegate to LiveChaosDial at loopback; admit lands on `capture`) |
| Sidecar wiring | `src/mcp/sidecar.ts` | EngineView read per request; `/health` gains `engine` + `engine_ports`; `/mcp` gains the container facet when ready; shutdown stops the engine |
| Payload assembly | `scripts/fetch-babychaos-payload.ts` | zonky pg + `go build` chaosstore per platform → `dist/babychaos-<platform>` |

## Wire contracts pinned

- Spawn contract UNCHANGED: `--root <dir> --port 0 --parent-guard`, one
  stdout line `{"event":"listening","port":N}` (SC-002).
- chaosstore env: `CHAOS_BIGINT_DATABASE_URL`, `CHAOS_GO_MCP_ADDR=127.0.0.1:<port>`,
  `CHAOS_GO_MCP_MTLS_ADDR=127.0.0.1:0`, empty `KAFKA_BOOTSTRAP` /
  `CHAOS_GO_KAFKA_BOOTSTRAP` (witness log to stdout, discarded).
- pg: `trust` auth on 127.0.0.1 ONLY, TCP loopback both platforms
  (`-k ""` on posix, windows has no unix sockets).

## Test strategy

- `__tests__/local-admit.test.ts` — the ToWire port's constant pins.
- `__tests__/sidecar.test.ts` (additions) — the EngineView seam with a
  fixture facet: verbs appear on ready without restart; `/health` states.
- `__tests__/local-engine.test.ts` — real chaosstore + PLAIN postgres
  (docker) + LocalChaosDial: write/read/as-of history/dedupe (SC-004).
- `__tests__/sidecar-engine.test.ts` — the sidecar as a CHILD PROCESS over
  a real payload: boot, container surface, fs beside it, crash-only
  (SIGKILL the postmaster — a TERM'd postmaster does a SMART shutdown and
  waits for the sidecar's own pool connections, measured), initdb-once.

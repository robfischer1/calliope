# Tasks: Baby Chaos (F13)

- [x] T001 `src/local-admit.ts` — contentHash (0x1f canonical form + collision
      guard), toCaptureOps (ToWire port: $mint labels, in-batch intern,
      $blob passthrough, removeEdge graph pin), LocalChaosDial (capture
      admit + delegated reads).
- [x] T002 `__tests__/local-admit.test.ts` — pins to go-court's constants
      (DONE_CONTENT_HASH / MOIRAE_GRAPH_HASH) + wire-shape cases.
- [x] T003 `src/mcp/babychaos.ts` — resolvePayload (env override / beside-exe;
      null = fs-only), startEngine (initdb-once, postgres on a free
      loopback port, idempotent CREATE DATABASE, chaosstore env contract,
      readiness gates, crash-only onExit, reverse-order stop).
- [x] T004 chaos soft-vector (landed on chaos main separately): WLDDL split,
      HasWL, `wl_unavailable` guards, plain-postgres CI lane.
- [x] T005 `src/mcp/sidecar.ts` — EngineView (state/containers/ports read
      per request), background boot after the handshake, `/health` engine
      fields, `/mcp` container facet, engine-aware shutdown.
- [x] T006 `__tests__/sidecar.test.ts` — engine-absent default, resolvePayload
      layout cases, verbs-appear-on-ready without restart (fixture facet).
- [x] T007 `scripts/fetch-babychaos-payload.ts` — zonky pg 17.5.0 + go-built
      chaosstore per platform → `dist/babychaos-<platform>` (gitignored).
- [x] T008 `__tests__/local-engine.test.ts` — real engine on PLAIN postgres:
      write/read, as-of history, cross-container dedupe.
- [x] T009 `__tests__/sidecar-engine.test.ts` — child-process boot, container
      surface over /mcp, fs beside it, crash-only exit 1, initdb-once.
- [x] T010 Windows interop smoke — real `calliope-sidecar.exe` + payload on
      `C:\Temp\coral4-smoke`: engine ready in /health, mint at the engine
      door, write_container/read_container round trip (SMOKE PASS,
      2026-08-16).
- [ ] T011 Manual acceptance (Rob): launch Grace with the payload beside the
      sidecar — the shell needs zero changes; `/health` should say
      `engine: ready`.

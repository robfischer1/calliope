---
title: "Flip the default body backend to PgBodyClient"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: ready
---

# Flip the default body backend to PgBodyClient — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. (Constitution I/II)

> **Planning context consumed** (master-plan F2 Tail — authoritative). The Tail
> decides: prose to rows / metadata to the graph [Rob, TURN 257]; a default
> change not a build [Claude, R054]. The Tail's migration scope was
> **measured already-delivered in production** (see Reconcile evidence below);
> per the override, the divergence is recorded here, not silently absorbed.

## Reconcile evidence — live measurements (2026-08-10, this session)

| Claim | Measurement |
| :--- | :--- |
| Production backend is pg | `bun server.js` (pid 1) env carries an injected `DATABASE_URL` (Calypso `/fleet/calliope`); `backendKind()` resolves `pg` on it |
| Migration ran | sovereign store holds **11,709 sections / 4,665 nodes** (aether:5432/calliope) |
| Retraction ran | oldest migrated body owner (`Anvil — The Workstation Job Runner`, created 2026-07-04) carries **only metadata edges** in `moirae` — no `hasPart`, no `text`; two heaviest owners read zero moirae edges |
| Migration tool exists, gated | `src/mcp/migrate.ts`: migrate + sha256 parity gate + export artifact + `--probe` + `--retract` (refuses without export; re-verifies parity) |
| The remaining gap | `backendKind({})` → `"urania"`: a boot with a FAILED secret injection silently reverts prose writes to chaos triples |

Consequence: F2's migration half is **done and verified**; what ships here is
the default flip + fail-fast. The F2 Brief's "defaults to UraniaBodyClient"
was true only of the bare-env fallback — C2 already landed the
`DATABASE_URL` auto-select. Surfaced, measured, resolved.

## Summary

Make `pg` the unconditional default backend and make a missing `DATABASE_URL`
a loud boot failure. `urania` (graph substrate) becomes explicit-only
(`CALLIOPE_MCP_BACKEND=urania`); `hades` auto-select and every explicit
selection behave exactly as today.

## Architecture

One file of behavior, one of tests:

- `apps/calliope/src/mcp/backend.ts` — `backendKind()` final fallback
  `urania` → `pg`; the two pg construction sites (`makeBodyClient`,
  `makeBackend`) throw on absent/empty `DATABASE_URL`; header docs updated.
- `apps/calliope/src/mcp/main.ts` — stale doc comment (line 8) updated.
- `apps/calliope/__tests__/backend.test.ts` — default expectation flips to
  `pg`; new fail-fast test; explicit/auto-select matrix unchanged.

## Contracts & Seams

### Exposes — the interface this provides

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `function:backend:backendKind` | `backendKind(env) -> "pg"` when no explicit backend and no hades auto-select flag | decided |
| `function:backend:makeBodyClient("pg")` | throws `Error(/DATABASE_URL/)` when `env.DATABASE_URL` absent/empty | decided |
| `function:backend:makeBackend("pg")` | same fail-fast | decided |

### Consumes / Requires — the seams (what this CALLS)

| Dependency | Contract relied on | Pin |
| :--- | :--- | :--- |
| Calypso secret injection | `DATABASE_URL` present in the live process env | measured live (pid 1) |
| `hadesEnabled(env)` / `CHARON_URL` | hades auto-select unchanged | backend.ts (live) |

### Resource-Reach — touched, field-level (VERIFIED against the real repo)

| RR pointer | Access | Role | Used by |
| :--- | :--- | :--- | :--- |
| `function:src/mcp/backend.ts:backendKind` | write | the flip | US1 |
| `function:src/mcp/backend.ts:makeBodyClient` | write | fail-fast | US2 |
| `function:src/mcp/backend.ts:makeBackend` | write | fail-fast | US2 |
| `file:src/mcp/main.ts:8` | write | stale doc comment | US1 |
| `file:__tests__/backend.test.ts` | write | matrix + fail-fast tests | all |

## Data model

None — no schema change. (The Tail's `urania-client.ts` migration-read-path
pointer belongs to the already-delivered migration; untouched here.)

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Default backend | `pg`, unconditional | prose lives in rows [Rob, TURN 257]; the bare-env fallback is the last path that writes prose to the graph | Rob (direction) · Claude (this diff) | keep urania fallback (rejected: silent post-cutover drift) |
| Missing DATABASE_URL | throw at construction | `new Pool({connectionString: undefined})` silently falls back to libpq defaults — a THIRD wrong store | Default (Claude) | let Pool fail on first query (rejected: late + cryptic) |
| `urania` fate | explicit-only, kept | migration rollback hatch until F3/F6 finish the strangle | Default (Claude) | delete (rejected: not this feature's call) |
| hades auto-select precedence | unchanged (`explicit > DATABASE_URL > hades-auto > pg-default`) | F2 gateway path must keep working | Default (Claude) | — |
| Run/re-run the live migration | NO — measured already-run | reconcile evidence above; re-running is idempotent but pointless | Claude, measured | re-run for ceremony (rejected) |

## Dependencies

- Test flip depends on the selection flip; fail-fast tests on the throw. No cycles.

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| selection flip | 3 |
| fail-fast | 2 |
| test matrix | 2 |

## Open & risk

- Risk: an undiscovered dev/CI caller relying on the bare-env urania default.
  Sweep: `backendKind` callers are `main.ts`/`http.ts` (live service — has
  DATABASE_URL injected) and tests (explicit). The sidecar does not use
  `backendKind`. Residual risk accepted; the failure mode is a loud boot
  error naming the fix.
- `[OPEN — F7's scope]` deleting the urania body path entirely once the
  strangler completes.

## Constitution Check

- **I**: all points decided-with-provenance; the plan-vs-code divergence is
  surfaced with measurements, not silently absorbed.
- **II**: defaults logged as binding.
- **III**: the changed selection contract and fail-fast shapes are named.
- **IV**: SC-001..003 are directly testable; the fail-fast test is the
  non-vacuity guard (it fails on today's code, which returns urania).
- **V**: done = suite green + the flipped default proven by the previously
  red test + live measurements recorded above.

---
Definition of Ready:
[x] every decision resolved + provenance-tagged
[x] Contracts & Seams complete
[x] Resource-Reach field-level, verified
[x] dependencies stated, no cycles
[x] constitution check authored

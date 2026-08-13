# Research — Widen AuthoredBy to a Session Principal

Phase 0 output. The planning context (master-plan F1 Tail) decides most points; research resolved only what it was silent on. Points the planning context already decides were **not** re-researched (Forge override rule).

## R1 — Where the widened type must live

- **Decision:** define in `types.ts`, re-export from `urania-client.ts`.
- **Rationale:** measured import graph: `urania-client.ts` imports `types.js` (L1–10); `types.ts` imports nothing. Defining the widened union in `urania-client.ts` and importing it into `types.ts` (for `BlockOp.authored_by`) would create a cycle. `pg-client.ts:29` and `hades-capture.ts:46` import `AuthoredBy` from `urania-client.js` — a re-export keeps both compiling unchanged.
- **Alternatives considered:** moving all importers to `types.js` (larger diff, zero benefit); a new `provenance.ts` module (a third home for a one-line type family — fails the dependency-vs-20-lines judgment).

## R2 — Principal grammar

- **Decision:** `^spiffe://[^/]+/session/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (lowercase UUID tail).
- **Rationale:** the fleet form is `spiffe://{td}/session/{uuid}` (master-plan Consumes: Kairos SVIDs; the proven resolve `spiffe://notusmi.com/session/aa579121-…` has a UUID tail). Terpsichore resolves by session UUID — admitting a non-UUID tail stores a citation the ladder can never answer.
- **Alternatives considered:** free-form tail (garbage in, unresolvable citation out); full SPIFFE-spec path validation (over-general — the *session* principal is the only family this field attributes).

## R3 — Existing per-call provenance precedent

- **Measured:** `UraniaCapture.capture(ops, authoredBy?)` and every `UraniaBodyClient` write method already take a per-call `authoredBy` (defaults `"human"`); `PgBodyClient` is the outlier — instance-fixed `#authoredBy` (constructor, `pg-client.ts:98`). Threading a per-call override through `PgBodyClient` write methods is an extension of an established repo pattern, not a new idiom. Existing tests (`urania-client.test.ts:201–240`) already assert per-call threading; the same pattern extends to the widened values.

## R4 — Read path already satisfies FR-004

- **Measured:** `pg-client.ts:717` returns `authoredBy: r.authored_by` (raw string); `types.ts:272` types the revision event's `authoredBy` as `string`. No read-side change needed; tests assert the round-trip.

## R5 — Authenticity verification (NOT resolved — surfaced)

- The master-plan lists Kairos-vs-gateway trust as a **gap**, and the fleet precedent (Cerberus F9/F10: Kairos token + PoP signature in `_meta`, store-side verification — adopted by chaos, athena, urania) is the likely eventual answer. Measured: calliope has no `_meta` handling and no stellar_core dependency. **F1 does not decide this** — form-only validation, posture unchanged; carried as [OPEN] in plan.md.

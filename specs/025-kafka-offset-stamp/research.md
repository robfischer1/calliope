# Research — Stamp Block Writes with the Session Log Offset

Phase 0 output. The planning context decides the shape (one column, offset-over-timestamp per TURN 288); research resolved only the store mechanics.

## R1 — Schema-evolution mechanism

- **Measured:** `SCHEMA_SQL` already evolves idempotently — `ALTER TABLE sections ADD COLUMN IF NOT EXISTS tombstone …` (the A11 precedent) runs on every `ensureSchema()`. The offset column takes the same form; existing deployments pick it up on next boot with no migration step.

## R2 — bigint round-trip

- **Measured:** node-postgres returns `bigint` columns as strings (int8 exceeds JS number range in general). The store writes JS numbers bounded to `Number.MAX_SAFE_INTEGER`; tests compare against the string form on read-back. F9's reader must parse — noted in plan Open & risk.

## R3 — Where the offset-requires-principal contract lives

- **Decision:** enforced at the MCP boundary (clear caller error) AND as a cheap guard in the store client (`validateWriteProvenance`) so a future internal caller cannot bypass it.
- **Rationale:** the boundary owns UX; the guard owns the invariant. Both are one predicate on two values — no measurable cost.

## R4 — Gateway-side stamping (NOT resolved — surfaced)

- The alternative supplier (Charon/Hades stamping the offset server-side) needs changes outside this repo's Resource-Reach and would move the trust boundary. Carried as [OPEN] exactly as the master plan surfaces it.

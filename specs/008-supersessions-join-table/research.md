# Research — The supersessions join table

No open unknowns survived planning. The planning context (master-plan F1 Tail)
decided the table shape, the column's fate, and the size; the two gaps it
surfaced resolve as follows.

## Decision: tombstone rows backfill

- **Decision**: tombstone rows' `supersedes` edges backfill into the join
  table like any other superseding row.
- **Rationale**: `readRevisionAt` excludes a superseded section at time T via
  the existence of an edge from a row created ≤ T. A delete's edge lives on
  its tombstone row. Once the read path consults the join table, a missing
  tombstone edge would resurrect deleted sections in every as-of read — a
  direct SC-003 violation.
- **Alternatives considered**: skip tombstones (rejected — breaks
  reconstruction); backfill them with a marker column (rejected — the edge is
  an edge; tombstone-ness stays on `sections.tombstone`).

## Decision: the single column is NOT dropped here

- **Decision**: `sections.supersedes` is kept and still written; whether it is
  dropped or kept as a denormalised fast path is F3's cutover decision.
- **Rationale**: carried verbatim from the master-plan Brief ("leave the
  column until F3 cuts over") and its Gaps line, which explicitly defers the
  question. Surfaced in plan.md Open & risk rather than resolved.

## Decision: backfill lives in `ensureSchema`

- **Decision**: the idempotent `INSERT … SELECT … ON CONFLICT DO NOTHING`
  ships inside `ensureSchema`, immediately after the DDL.
- **Rationale**: `ensureSchema` is the store's existing migration seam (the
  A11 `ALTER TABLE … ADD COLUMN IF NOT EXISTS` precedent); deploy = migrated;
  a boot-time pass over `sections` is cheap at this store's size and
  converges every boot.
- **Alternatives considered**: a separate migration verb/script (rejected —
  one more thing to run and forget; no precedent in this client).

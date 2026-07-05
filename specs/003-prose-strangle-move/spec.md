# Feature Specification: The Prose Strangle — writes + writing-arc (C3)

**Status**: Draft | **Input**: Master-plan C3 head — "Move the monolith's prose surface onto the star — `write_document` and `write_plan` (the typed-write dissolve sinks), the HTTP document/plan read/write routes, and the writing-arc analytics — through the full strangle loop: build the star-side verbs, run the parity gate, repoint the callers (vault-mcp's write path among them), then deregister the phdb surface — so the monolith stops accruing prose."

> **Reconcile (2026-07-04, session Birch):** the live backend changes the strangle's shape. On live PG: `write_document`/`write_plan` insert with SQLite syntax against columns that no longer exist (`INSERT OR IGNORE`, `subject`/`file_path`/`bucket`…) — **dead since the PG cutover** (`history.documents` MAX(created_at) = 2026-06-10; the Harmonia precedent: "the phdb path had NEVER landed a row"). There is NO `plans` table on PG. `writing_sessions`/`writing_deltas` exist with **0 rows** and all three analytics verbs short-circuit with a `not available on the PostgreSQL backend` error (#746). So the strangle is: build the LIVE successor for documents, migrate the 2,770-row archive with parity, repoint the dissolve path, and retire the already-dead surfaces explicitly.

## User Scenarios & Testing _(mandatory)_

### US1 - Dissolving a note lands on the star (P1)

Rob dissolves a vault note. Its body lands in Calliope's document store — verbatim, deduped, idempotent — and the monolith is not touched.

**Acceptance**: 1. Given a note's body + source path, When `write_document` is called (verb or HTTP), Then a document row lands in calliope-db with content-hash + dedup semantics (an identical re-submit is a no-op). 2. Given a landed document, When read back (by id or source path), Then the body round-trips verbatim.

### US2 - The archive comes along with parity (P1)

The 2,770 historical dissolve artifacts in `history.documents` migrate to the star with a green content-hash parity artifact.

**Acceptance**: 1. Given the migration has run, When each source row's `body_text` hash is compared with the star row's, Then 2770/2770 match and a re-run migrates zero. 2. Given the parity artifact, Then it is exported beside the migration (the C2 house pattern).

### US3 - The callers move; the monolith surface dies (P1)

vault-mcp's dissolve path posts documents to the star; the phdb prose surface deregisters — verbs and routes uncallable, code retained.

**Acceptance**: 1. Given a real dissolve through vault-mcp, Then the document lands in calliope-db and phdb is untouched. 2. Given the deregistration PR is merged + the service restarted, Then the five MCP verbs are gone from the surface and the four HTTP routes 404, verified live.

### US4 - The superseded surfaces retire honestly (P2)

`write_plan` and the writing-arc trio do not get star ports — they retire with named successors, recorded where the next reader will look.

**Acceptance**: 1. `write_plan`: RETIRED-superseded — plans are graph bodies (Athena structure + Calliope prose) since the naming close; there is no PG table and no live caller. 2. `writing_arc`/`writing_session_detail`/`writing_stats`: RETIRED-superseded by the Aglaia block-op stream (the C4 gap's succession, decided with live data: 0 rows, short-circuited code); the SQLite-era archive stays where it is for C5's residual sweep.

## Requirements _(mandatory)_

- **FR-001**: Calliope MUST expose `write_document` (verb + HTTP) writing to its own store with the project dedup contract (source path + raw content hash → idempotent re-submit).
- **FR-002**: Calliope MUST expose document reads (by id / source path; list with filters) sufficient for the dissolve-audit consumers.
- **FR-003**: The migration MUST be idempotent, parity-checked (content-hash 100%), and export its artifact.
- **FR-004**: vault-mcp's dissolve MUST repoint to the star path with no note-shape knowledge moving (the sink stays note-ignorant).
- **FR-005**: The phdb surface (5 verbs, 4 routes) MUST deregister via the detach pattern — uncallable, code retained — with live post-verification.
- **FR-006**: Retirements MUST be recorded on the Deregistration Checklist row with successors named.

## Success Criteria

- **SC-001**: A live dissolve lands a calliope-db row; re-dissolving the same content is a no-op; phdb row count unchanged.
- **SC-002**: Parity artifact green (2770/2770); re-run migrates zero.
- **SC-003**: phdb MCP surface count drops by 5; `/write/document`, `/write/plan`, `/read/documents`, `/read/plans` return 404 live.
- **SC-004**: Full calliope gate green; deploy green; the star's verbs serve through hades.

## Assumptions

- The `history.documents` vs `external.documents` split IS the Clio/Calliope row split (resolved with data: web content already lives in `external.*`; all 2,770 `history.documents` rows are vault-dissolve artifacts).
- Plan-note dissolves post document payloads only after the repoint (plan METADATA's home is the graph, not a typed table).

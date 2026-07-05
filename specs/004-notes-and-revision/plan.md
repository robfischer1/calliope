---
title: "Notes + Revision Intelligence Re-home (C4)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C4 — Design Plan

> Binding. Reconciled against the master-plan C4 tail (authoritative) + live PG (which resolves both of the tail's gaps): the writing-delta succession was decided at C3 (block-op stream); `vault_notes` resolves to RETIRE-not-port (0 rows, no consumer — the "on-star FTS index" lean dies on the data). The C3 build is the template: same store pattern, same migration/parity shape, same detach pattern.

## Summary

Calliope grows a **revision store**: `revision-store.ts` (`PgRevisionStore` on the shared pool) with `file_revisions` + `revision_triple_deltas` tables mirroring the phdb shapes (ids preserved — the deltas key on revision id), verbs `file_revisions` (path/repo/id queries, newest-first) and `revision_deltas` (by revision id) registered beside the C3 document verbs, and `migrate-revisions.ts` porting 17,483 + 57,631 rows with a per-row content-hash parity artifact. Blob content NEVER moves — `git_blob_sha` pointers stay pointers (FR-003; the vault git repo is the blob store). Then phdb detaches the `note`(6) and `revision`(12) CLI groups (the #972/#973/#977 house pattern), the Checklist row extends, and the two retirements (vault_notes; the frozen capture + batch pipeline) land as veto-able board decisions.

## Live-reality basis (verified 2026-07-04)

| Surface                              | Live state                                                                        | Disposition                                                                                                       |
| :----------------------------------- | :-------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| `history.file_revisions`             | 17,483 rows; capture DEAD since 2026-05-27                                        | **migrate** with parity; read verbs on-star; capture freezes as history                                           |
| `history.revision_triple_deltas`     | 57,631 rows                                                                       | **migrate** with parity; read verb on-star                                                                        |
| `_infra.vault_notes` + CLI `note`(6) | 0 rows — never backfilled on PG; no live consumer                                 | **retire** — successors: vault-mcp live search · Calliope `read_documents`                                        |
| CLI `revision`(12)                   | read core (list/show/diff/stats/materialize) + batch AI-summary tooling + capture | **detach** — read core → star verbs; materialize/diff stay vault-git-side; batch tooling freezes with the archive |
| writing-delta capture                | decided at C3                                                                     | already RETIRED-superseded (block-op stream)                                                                      |

## Architecture

| Piece             | Home                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :---------------- | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PgRevisionStore` | `src/revision-store.ts` (new)  | schema: `file_revisions` (id bigint PK — SOURCE ids preserved, repo, commit_sha, file_path, prior_file_path, change_type, authorship, summary, summary_model, summary_generated_at, git_blob_sha, parent_blob_sha, captured_at, schema_type) + `revision_triple_deltas` (id bigint PK preserved, revision_id FK-by-value, delta fields mirrored from source); `importRevision`/`importDelta` (idempotent ON CONFLICT DO NOTHING), `byPath`, `byRepo`, `byId`, `deltasFor`, `counts` |
| verbs             | `src/mcp/server.ts`            | `file_revisions {file_path? repo? id? limit?}` → newest-first rows; `revision_deltas {revision_id}` → ordered deltas — registered when the pg backend carries the store (the C3 `ServerOptions` pattern extended)                                                                                                                                                                                                                                                                   |
| migration         | `src/mcp/migrate-revisions.ts` | source = `PHDB_DATABASE_URL`, dest = calliope-db; batched copy preserving ids; parity = counts + per-row sha256 over a canonical field list, sampled full-read-back; `--probe`; artifact JSON (the C2/C3 pattern)                                                                                                                                                                                                                                                                   |
| deregister        | `personal-history-db` PR       | detach the `note` + `revision` click groups (decorators off, code stays); restart; verify `No such command`                                                                                                                                                                                                                                                                                                                                                                         |

## Decision Log

| Decision                 | Resolution                              | Rationale                                                                                                                                                                         | Provenance                        |
| :----------------------- | :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- |
| `vault_notes`            | RETIRE — no port, no star FTS index     | the tail's lean ("on-star") dies on live data: 0 rows, never backfilled, no consumer; live-note search belongs to the live vault (vault-mcp), dissolved prose to `read_documents` | Claude (reconcile) — veto-flagged |
| capture + batch pipeline | freeze with the archive — no star port  | capture dead 5+ weeks unnoticed; go-forward instrumentation is the block-op stream (C3 decision); the batch AI-summary tooling operated on the frozen corpus                      | Claude (reconcile) — veto-flagged |
| materialize/diff         | stay vault-git-side                     | they read git BLOBS; the blob store is the vault repo on the workstation — a star cannot materialize what it does not hold (FR-003)                                               | live reality                      |
| id preservation          | source ids kept verbatim in both tables | deltas reference revisions by id; preserving ids keeps the archive's internal references intact and the migration idempotent                                                      | Claude (Default)                  |
| delta schema             | mirror the source columns verbatim      | this is an archive re-home, not a remodel; C5 sweeps residuals                                                                                                                    | Claude (Default)                  |

## Open & risk

- 57K-row migration over two pools — batch the copies (500-row pages) to keep memory flat; the runtime is the deployed container (the C3 run's exact harness).
- The `revision_triple_deltas` source columns are mirrored at build time (introspected from live PG, not guessed).
- Retirements are Claude-reconciled — the completion report flags both for veto (same as C3).

---

DoR: [x] decisions tagged · [x] shapes named · [x] RR verified · [x] constitution I–V hold.

# Tasks (inline)

- **T001 (calliope)**: `PgRevisionStore` + verbs + tests (fixture + real-postgres contract) → gate → PR → deploy.
- **T002 (migration)**: `migrate-revisions.ts` → run in the deployed container → parity 17,483 + 57,631 green → artifact exported → re-run zero.
- **T003 (deregister)**: phdb PR detaching `note`(6) + `revision`(12) → Windows service pull + restart → `No such command` verified.
- **T004 (record)**: Checklist row extended; two `log_decision` mints; C4 board node closed.

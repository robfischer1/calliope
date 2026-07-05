# Feature Specification: Notes + Revision Intelligence Re-home (C4)

**Status**: Draft | **Input**: Master-plan C4 head — "Re-home the note index and git-for-ideas — `vault_notes` (the current-state FTS index and the `note` CLI), the file-revision intelligence (`file_revisions`, `revision_triple_deltas`, the 12-command `revision` CLI), and the writing-delta self-instrumentation — onto the star, so the prose domain's memory lives with its owner and the phdb CLI groups deregister."

> **Reconcile (2026-07-04, session Birch):** live PG facts reshape the feature. `_infra.vault_notes` holds **0 rows** (the FTS index was never backfilled post-cutover; the `note` CLI reads an empty table). `history.file_revisions` holds **17,483 rows** and `history.revision_triple_deltas` **57,631** — real history, but capture is DEAD (MAX(captured_at) = 2026-05-27). The writing-delta succession was already decided at C3 (RETIRED-superseded by the Aglaia block-op stream). And `materialize`/`diff` resolve prose from the VAULT's git blobs — which live host-side with the vault repo, not on nas01: the star can own the revision METADATA + deltas; git itself stays the blob store.

## User Scenarios & Testing _(mandatory)_

### US1 - The revision archive lives with its owner (P1)

The git-for-ideas corpus — which notes changed, when, how, with AI summaries — serves from Calliope.

**Acceptance**: 1. Given the migration has run, When counts and per-row content hashes are compared, Then 17,483 revisions and 57,631 triple-deltas match with a green parity artifact and a re-run migrates zero. 2. Given a note path, When `file_revisions` is called on the star, Then its revision history returns (newest first, with summaries and blob shas).

### US2 - The deltas are queryable at the star (P2)

Revision-grain triple deltas (the frontmatter/link evolution record) read from the star by revision id.

**Acceptance**: 1. Given a migrated revision id, When `revision_deltas` is called, Then its triple deltas return in stored order.

### US3 - The dead surfaces retire honestly (P1)

The empty note index and the monolith CLI groups go, with successors named where the next reader will look.

**Acceptance**: 1. `vault_notes` + CLI `note`(6): RETIRED — 0 rows, no live consumer; successors: live-vault lookup/search = vault-mcp's own search surface; dissolved prose = Calliope `read_documents`. 2. CLI `revision`(12) detaches — the read core's successor is the star verbs; the AI-summary batch pipeline and `capture` freeze with the archive (capture dead since 2026-05-27; go-forward self-instrumentation is the block-op stream, per the C3 decision). 3. Both detachments verified live post-restart (`No such command`).

## Requirements _(mandatory)_

- **FR-001**: Calliope MUST store and serve the full revision archive (revisions + triple deltas) with the migration idempotent and parity-checked.
- **FR-002**: The star MUST expose `file_revisions` (by path / repo / id, newest-first, limit) and `revision_deltas` (by revision id) verbs.
- **FR-003**: Blob materialization stays with the vault git repo — the star stores `git_blob_sha` pointers verbatim, never blob content.
- **FR-004**: The phdb `note` and `revision` CLI groups MUST deregister via the detach pattern with live verification.
- **FR-005**: Retirements MUST be recorded on the Checklist row and as veto-able board decisions.

## Success Criteria

- **SC-001**: Parity artifact green (17,483 + 57,631; re-run migrates zero).
- **SC-002**: A known note path's revision history round-trips from the star with summary + sha fields intact.
- **SC-003**: phdb CLI: `phdb note` and `phdb revision` → "No such command", verified on the live service.
- **SC-004**: Full calliope gate green; deploy green.

## Assumptions

- The frozen capture path is history, not a regression to fix here — a revival (or block-op-native successor) is its own future feature.
- The empty `vault_notes` needs no data migration (0 rows) — retirement only.

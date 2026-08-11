# Feature Specification: Local version history — the .grace/ revlog

**Status**: Draft | **Input**: Master-plan F13 Head + Rob's decision
(2026-08-10): the Calliope-side revlog under `.grace/`, not git snapshots.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - History works offline, in any directory (Priority: P1)

The fs backend grows the optional revision verbs over a copy-on-write
revlog under `<root>/.grace/revlog/`, so the already-shipped HistoryDrawer
lights up locally WITH NO CLIENT CHANGE (it speaks `read_body_revisions` /
`read_body_at`, which the sidecar already routes — the verbs go live the
moment the client implements the optional methods). Works for non-vault
directories — the reason the git option lost.

**Acceptance Scenarios**:

1. **Given** a local file edited N times through the backend, **When**
   history is requested, **Then** N revisions resolve newest-first and any
   one reconstructs the body as it stood.
2. **Given** an EXTERNAL edit (another app wrote the file), **When**
   history is next read, **Then** the observed state is captured as a
   revision — external states become recoverable once seen.
3. **Given** a directory that is not a vault, **Then** everything above
   still works (no git dependency anywhere).

### User Story 2 - Bounded and prunable (Priority: P1)

The revlog cannot grow without bound and cannot endanger bodies: entries
cap per node (oldest dropped); deleting `.grace/` loses only history, never
content, and history simply restarts.

**Acceptance Scenarios**:

1. **Given** more writes than the cap, **Then** the entry count holds at
   the cap with the newest retained.
2. **Given** a deleted revlog file, **Then** reads degrade to
   empty-history and the next write restarts it — bodies untouched.

## Requirements

- **FR-001**: `FsBodyClient` implements `readRevisions` / `readRevisionAt`
  over a per-node JSONL revlog at `.grace/revlog/<sha256(nodeId)>.jsonl`.
- **FR-002**: every backend write (save / edit) appends an entry (deduped
  against the head; strictly-increasing timestamps); reads lazily capture
  externally-changed state.
- **FR-003**: per-node cap (200) at append time; the dot-directory is
  invisible to the body layer and the F12 tag walker by construction.
- **FR-004**: the fs GRAIN is untouched — one file, one block, no
  inference; reconstruction returns the same one-section shape `derive`
  produces.

## Success Criteria

- **SC-001**: N-edit history + per-revision byte-exact reconstruction over
  a real temp directory.
- **SC-002**: external-edit capture; cap enforcement; deleted-revlog
  degrade.
- **SC-003**: the sidecar serves the two verbs with zero dispatch changes
  (pinned by the existing guard tests turning live).

## Assumptions

- Revision identity is the entry's ISO timestamp (the store model's
  convention); `authoredBy` is `"human"` (the local surface's provenance).
  [Default]
- Pruning = the cap plus the documented safety of deleting `.grace/`; a
  scheduled pruner is not built until measured necessary. [Default]

# Feature Specification: The Cut

**Status**: Implemented | **Input**: Master-plan feature F12 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One model on the surface (Priority: P1)

Remove the old surface and the old tables. The body, section, document,
plan and revision verb families leave the fleet surface (`_note`
survives, per Rob); the block verb family goes with them (zero callers
fleet-wide, and the end-state Exposes row is explicit: the client
computes ops, `write_container` is the write path, history is a graph
read — "no revision verbs"). This is a FEATURE with its own acceptance,
not a clause — the last plan's "removed *or* aliased" OR collapsed to
the no-work branch and two of twelve cuts landed.

**Acceptance Scenarios**:

1. **Given** the fleet surface, **When** listed, **Then** none of the
   retired verbs appear — pinned by the tools/list fence, which now IS
   the post-cut surface: blob_census, container_history, copy_reference,
   create_note, dissolve_note, export_note, file_revisions, list_by_tag,
   list_tags, look, materialize_note, read_container, revision_deltas,
   search, unpin, write_container.
2. **Given** a fleet-wide sweep, **Then** no caller references the
   retired verbs (theia's four body clients were repointed FIRST — the
   sweep is a gate, not a hope).
3. **Given** a passing parity report, **When** the drop runs with an
   explicit `--execute` flag, **Then** `sections`, `supersessions` and
   `comments_on` are removed; **Given** a failing or absent report — or
   a live store that moved AFTER the report — **Then** the drop refuses.
4. **Given** the ferry allowlist, **Then** it no longer names retired
   verbs.
5. **Given** a fresh install, **Then** the old model's DDL never runs —
   no code path can write the old model.

### User Story 2 - The desktop keeps its loopback dialect (Priority: P2)

The DESKTOP's path-addressed body verbs (read_body/write_body/…) are the
sidecar's own engine-backed surface since F14 — not the old model. They
stay, behind an explicit `pathBodies` server option only the sidecar
passes. The retirement is of the OLD MODEL's fleet surface, not of the
wire spelling Grace's loopback speaks.

## Success Criteria *(mandatory)*

- **SC-001**: the retired families are unreachable on the fleet (the http
  fence pins the exact surviving surface + annotations).
- **SC-002**: the caller sweep is clean (theia repointed + the ferry
  naming bug fixed — the F9 remote container path never matched charon's
  allowlist until now).
- **SC-003**: the drop is GATED on the specs/043 parity report
  (7,416/7,416, zero refusals, zero mismatches) AND on the live store
  still matching it (frozen-store check).
- **SC-004**: fresh installs bootstrap the blob store only; the legacy
  DDL exists solely behind the migration suite's `legacy: true` flag.
- **SC-005**: the audit finding is closed: the container facet is now
  actually PASSED to the server by both fleet entries (it was wired in
  the backend but never served — found by the post-cut fence).

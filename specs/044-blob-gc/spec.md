# Feature Specification: Blob Garbage Collection

**Status**: Draft | **Input**: Master-plan feature F7 — "Git for Ideas — The Blob Store and the Tree"

## User Scenarios & Testing

### US1 - Only garbage is reaped (P1)
Write-ordering (F4) deliberately produces orphan blobs on failure. The
census reaps them — and ONLY them: a blob any graph's log ever named is
held forever (as-of reads resolve historical blobs).

1. **Given** a blob no fact names, **When** a complete census runs twice
   (mark, then sweep), **Then** it is reaped.
2. **Given** a blob one fact names — current OR retracted — **Then** it is
   held and survives every census.
3. **Given** a blob marked unheld and referenced before the next census,
   **Then** it is spared (the grace window for saves in flight).

### US2 - The census refuses to guess (P1)
1. **Given** a reporter that did not answer, **Then** the census is
   incomplete: nothing marked, nothing reaped, no mark state written.
2. **Given** a reporter answering zero held, **Then** that is a REPORT
   (ok, count 0) — recorded distinctly from silence.
3. **Given** a fact naming an absent blob, **Then** it is reported
   dangling and never "fixed".

## Requirements
- **FR-001**: roster = the tenant graphs (notes/documents/comments/
  governance), each reporting separately; ANY missing answer aborts.
- **FR-002**: mark-and-sweep with the snapshot taken FIRST: only ids ≤ the
  snapshot are candidates; reap requires marked-by-a-previous-complete-
  census AND still-unheld.
- **FR-003**: held is the graph LOG, not current state.
- **FR-004**: reaping is the census's one sanctioned deletion; the general
  prose surface (ProseStore, the F1 pin) stays mint-and-read only.
- **FR-005**: reachable as an MCP verb; execute is explicit.

## Success Criteria
Covered 1:1 by the six-test suite (mark→sweep, grace window, incomplete
refusal, dangling report, empty-vs-no report, snapshot frame).

## Assumptions
- **Full-enumeration reports** (Default): held lists cross the wire whole;
  fine at the fleet's tens-of-thousands scale, ceiling noted in plan.

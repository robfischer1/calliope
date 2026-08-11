# Feature Specification: The export hatch

**Status**: Draft | **Input**: Master-plan F14 Head

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Blocks project to markdown, one way (Priority: P1)

Once blocks are the source of truth, markdown demotes to an EXPORT — the
one-way projection that keeps git and grep first-class citizens. A container
exports to clean markdown: blocks serialized in order, joined by the
dialect's block separator, no markers, no metadata smuggling. This closes
the A5 fork (open since the original Aglaia plan).

**Acceptance Scenarios**:

1. **Given** a container, **When** exported, **Then** its blocks serialise
   in order with the dialect's constructs preserved (the projection never
   rewrites prose — blocks pass through verbatim).
2. **Given** the export re-imported through the dialect's block seam (the
   separator join the fs backend and editor already share), **Then** block
   count and order match, for blocks free of the separator; multi-paragraph
   blocks are the surfaced fidelity boundary.

### User Story 2 - The shell's print path is B1's mount (Priority: P3)

Grace's desktop today has NO note-action surface (measured: no menu, no
toolbar, no Dissolve mount — F9's menu item is also pending B1). The
print-to-PDF webview hook lands with that menu system, where it belongs;
building the actions architecture cold inside this feature would be
inventing B1's UI. Surfaced, not silently skipped.

## Requirements

- **FR-001**: `export_note` serves `{container_id | source_path}` →
  `{container_id, markdown, block_count}`; misses structured
  (`container_not_found`); read-only annotated.
- **FR-002**: the projection is blocks joined with the shared block
  separator (`\n\n`) — the exact seam `fs-client` writes and the editor
  reads; prose passes through byte-verbatim.
- **FR-003**: the surface fence grows to 26 with the read-only annotation.

## Success Criteria

- **SC-001**: wire round trip: dissolve a container → export → markdown
  equals the blocks joined; separator-split re-import matches count+order.
- **SC-002**: miss shape + fence + annotation pinned.

## Assumptions

- Fidelity gaps (`raw_block` tables, footnotes, multi-paragraph blocks) are
  the Tail's surfaced round-trip boundary — the projection passes prose
  verbatim, so what the dialect round-trips is exactly what the editor
  round-trips; no re-writing is attempted here. [Carried gap]
- Per-container export; per-lens export is a later question. [Tail gap —
  carried]

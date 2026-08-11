# Feature Specification: Tags offline

**Status**: Draft | **Input**: Master-plan F12 Head

> **Gap-protocol (Constitution I).** Mark unresolved points `[OPEN]`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The fs backend answers tags without a graph (Priority: P1)

The phone and the offline desktop browse by tag with no graph call: the
sidecar answers `list_tags` and `list_by_tag` from a COMPUTED index over the
served directory — inline tags extracted from body text with the shared
grammar (F11 hygiene included free). Tags stay a computed index offline;
`hasTag` edges materialise only at Dissolve.

**Acceptance Scenarios**:

1. **Given** a directory, **When** tags are requested, **Then** they are
   computed from body text with no graph call, with carrier counts; a tag
   query returns the carrying files' node ids (root-relative paths).
2. **Given** the offline path, **Then** NO `hasTag` edge is written — by
   construction (the sidecar carries no graph dial).
3. **Given** the fs grain constraint, **Then** body derivation is untouched
   (index only — one file, one block, no inference).

### User Story 2 - The `#` trigger suggests from it (Priority: P1)

Aglaia's suggest surface gains a `#` picker (the `[[` picker's sibling):
source-injected, so the package stays store-blind; typing `#` at a word
boundary offers the known tags, filtered by fuzzy match.

**Acceptance Scenarios**:

1. **Given** an injected tag list, **When** `#` is typed at a word start,
   **Then** matching tags are offered and a pick inserts the exact `#tag `
   text; mid-word `#` never triggers.

## Requirements

- **FR-001**: `computeFsTagIndex(root)` walks served markdown (skipping
  dot-directories), extracts inline tags with the shared F11-guarded
  grammar, and aggregates counts + carriers. Computed per request — no
  cache, so the watcher-invalidation gap dissolves (nothing to invalidate).
- **FR-002**: sidecar dispatch gains `list_tags` / `list_by_tag`.
- **FR-003**: aglaia `tagPickerSource(listTags)` mirrors `notePickerSource`
  (injected source, fuzzy filter, exact dialect insertion).

## Success Criteria

- **SC-001**: sidecar wire test: seeded directory → tags with counts; by-tag
  → correct node ids; junk (hex) never appears.
- **SC-002**: aglaia unit test: trigger boundaries, fuzzy filter, insertion.
- **SC-003**: grain untouched: no fs-client.ts derivation change (diff-level
  fact recorded in the PR).

## Assumptions

- The tag atlas rail (Grace UI) appears in the Brief's seams narrative but
  NOT in the Tail's Touches (RR) or Success — the binding write-set is
  calliope + theia. The rail is B1's mount, like F9/F14's menu items.
  [Measured from the Tail; surfaced]
- Per-request index computation (no cache) is the invalidation answer for
  local-scale directories; a cache is a later optimization if measured
  slow. [Default]

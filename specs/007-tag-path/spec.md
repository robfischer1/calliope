# Feature Specification: The Tag Path — `hasTag` write + read (C9)

**Feature Branch**: `007-tag-path` | **Status**: Draft

**Input**: Master-plan C9 head — "Give notes their tags. Calliope extracts inline `#tags` from a note's body text on write (`create_note` / `write_body`) as the sole authoritative tag-writer, and also accepts an explicit list of tags for the ones that aren't in the text — the folder-derived tags like `#journal` and `#brain-soup` — writing both as `hasTag` edges on the note's graph node. Expose the read half too: one verb that returns the notes carrying a tag (over the graph's indexed point lookup) and one that returns the distinct tag set. Literal tags this pass; tag-nodes (rename, metadata) are a later evolution."

> **Gap-protocol (Constitution I).** Unresolved points are `[OPEN: …]`; defaults are logged.

## User Scenarios & Testing _(mandatory)_

### US1 - Tags are written where the note lives (P1)

Writing a note whose body carries `#tags` puts `hasTag` edges on its graph node; an explicit tags list (the folder-derived set the importer passes) lands the same way. Calliope is the sole authoritative extractor — the render side (Aglaia scan.ts) stays render-only.

**Independent Test**: create a note with explicit tags, write a body carrying inline `#tags`, read the node's edges — every tag present as a `hasTag` edge.

**Acceptance Scenarios**:

1. **Given** a note body carrying `#alpha` and `#beta`, **When** the body writes, **Then** `hasTag → "#alpha"` and `hasTag → "#beta"` edges exist on the note's node.
2. **Given** `create_note(title, tags: ["#journal"])`, **Then** the explicit tag lands as a `hasTag` edge (the C8 inert arg goes live).
3. **Given** a non-Note node (a work-node's plan prose), **When** its body writes, **Then** NO tag extraction runs — the tag path is the notes tenant's.

### US2 - Re-writes reconcile, explicit survives (P1)

Re-writing a note reconciles its inline tags — added ones appear, removed ones go — without disturbing explicit tags (folders aren't in the text; deleting a paragraph must not strip `#journal`).

**Acceptance Scenarios**:

1. **Given** a note with inline `#a #b`, **When** the body re-writes carrying only `#b #c`, **Then** the edges reconcile to `#b #c` (+ any explicit tags).
2. **Given** an explicit `#journal` and zero inline occurrences, **When** the body re-writes, **Then** `#journal` survives every reconcile.

### US3 - The read half (P2)

A tag query returns exactly the notes carrying it (indexed, server-side); a distinct-tag verb returns the tag set with counts — the picker's chip source.

**Acceptance Scenarios**:

1. **Given** notes tagged `#x`, **When** `list_by_tag("#x")` runs, **Then** exactly those node ids return (the graph's indexed point lookup).
2. **Given** the corpus, **When** `list_tags()` runs, **Then** the distinct `{tag, count}` set returns.

## Requirements _(mandatory)_

- **FR-001**: Calliope MUST extract inline `#tags` (the Aglaia scan.ts grammar, mirrored) from a Note-kind node's body on write and reconcile them as `hasTag` edges — sole authoritative extractor.
- **FR-002**: `create_note`'s `tags[]` MUST write as explicit `hasTag` edges; explicit tags are never removed by an inline reconcile.
- **FR-003**: Tag identity is the LITERAL string (`hasTag → "#x"`, lowercase-normalized); tag-nodes are out of scope (the Thalia-T7 evolution).
- **FR-004**: `list_by_tag(tag) -> {node_ids}` MUST serve over the graph's indexed point lookup (`find_by_value(notes, hasTag, tag)`).
- **FR-005**: `list_tags() -> {tags: [{tag, count}]}` MUST return the distinct set.
- **FR-006**: Non-Note nodes never enter the tag path.

## Success Criteria

- **SC-001**: inline + explicit tags round-trip as `hasTag` edges; the reconcile matrix (add/remove/explicit-survives) passes.
- **SC-002**: `list_by_tag` answers the exact carrier set; `list_tags` the distinct set with counts.
- **SC-003**: Full calliope gate green; both verbs serve through the gateway.

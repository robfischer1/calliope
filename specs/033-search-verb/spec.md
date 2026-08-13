# Feature Specification: The search verb in Calliope

**Status**: Draft | **Input**: Findability master-plan F2 — "The search verb in Calliope"

> **Gap-protocol (Constitution I).** Mark every unresolved point `[OPEN: question]` —
> never a silent guess. A reasonable default is allowed but must be logged in
> Assumptions as a Default-provenance decision, not left implicit. The WHAT lives
> here; the HOW (architecture, contracts) lives in plan.md.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Rob finds the note that contains a phrase, offline (Priority: P1)

Rob types a phrase. The search verb answers over the bound directory — no network,
no service, no index server — with ranked hits carrying snippets, and clicking a hit
resolves to the containing note. This is the single biggest functional hole in the
stack: today nothing anywhere searches note bodies.

**Why this priority**: Every downstream surface — the search panel, the mobile
sheet, backlinks, unlinked mentions, remote search — rides this verb. Without it
they have nothing to ride.

**Independent Test**: With the machine offline and a directory of markdown files
bound, a query for a phrase present in exactly one file returns that file's hit,
with a snippet showing the phrase, in ranked position 1.

**Acceptance Scenarios**:

1. **Given** a bound root containing notes, **When** a query runs, **Then** ranked
   hits with snippets return, each resolving to its containing note.
2. **Given** the machine fully offline, **When** the same query runs, **Then** the
   full-text arm and the semantic arm both answer (semantic over locally-generated
   vectors), fused into one ranked list.

### User Story 2 - Degraded arms are stated, never hidden (Priority: P1)

When the semantic arm cannot answer — its vectors not yet generated, its encoder
assets missing, or its embedding provider unreachable — Rob still gets full-text
results, and the response says the semantic arm did not answer. Honesty is a
property of the response, not of a status page.

**Why this priority**: The architecture ruling (F1) makes degraded-mode honesty a
design property; the verb is where it becomes observable behavior.

**Independent Test**: Disable the semantic arm's provider; run a query; results
return from full-text only and the response envelope names the semantic arm as
dark.

**Acceptance Scenarios**:

1. **Given** the embedding provider down, **When** a query runs, **Then** FTS-only
   results return and the response says so (the dark arm is named).
2. **Given** no index yet built and no arms available, **When** a query runs,
   **Then** the response distinguishes "no arms could answer" from "no matches".

### User Story 3 - An edit costs one block, not a rebuild (Priority: P2)

Rob edits one block of one note and saves. The index absorbs exactly that change —
one full-text row replaced, one vector regenerated — without rescanning or
re-embedding anything else.

**Why this priority**: Incremental cost is what makes the index sustainable on
every save; a rebuild-the-world index gets turned off.

**Independent Test**: Index a corpus; edit one block of one file; observe exactly
that block's index entries change (measured by re-embed count = 1) and the rest
untouched.

**Acceptance Scenarios**:

1. **Given** an indexed corpus, **When** one block of one file changes on disk,
   **Then** only that block is re-embedded and re-indexed.
2. **Given** many files changing at once (a bulk operation), **When** the changes
   settle, **Then** the index converges to the new state without redundant
   per-event rebuilds (changes coalesce).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose one search interface taking a query and a
  scope, answering with ranked hits (id, snippet, score, arm provenance) and an
  availability envelope (arms queried, arms dark) — the shape ruled in F1.
- **FR-002**: The full-text arm MUST answer over the bound root entirely
  in-process, offline included.
- **FR-003**: The semantic arm MUST rank by vector similarity over locally stored
  block vectors, offline included once vectors exist; vector generation MUST work
  without any remote service (a local encoder), and MAY be accelerated by a remote
  embedding provider when one is configured and reachable.
- **FR-004**: Results from available arms MUST fuse into one ranked list by
  reciprocal-rank fusion; with one arm available the fused order MUST equal that
  arm's order; a hit ranked by both arms MUST appear once carrying both arms'
  provenance.
- **FR-005**: The response MUST name every arm that did not answer and MUST
  distinguish "no arms available" from "no matches found".
- **FR-006**: The index MUST stay fresh incrementally: a changed file re-indexes
  only its changed blocks (one re-embed per changed block); bulk changes coalesce;
  changes made while the index was not running are caught up on start.
- **FR-007**: The index MUST live under the bound root's local state area, be
  excluded from its own indexing, and impose no approximate-nearest-neighbor
  structure (exhaustive similarity at this corpus scale — ruled in F1).
- **FR-008**: A query MUST NOT mutate note content anywhere (read-only verb), and
  the index MUST never alter served bodies (index only — the body grain is
  unchanged).

### Key Entities

- **The hit**: id (the containing note as the backend addresses it), snippet,
  fused score, arm provenance — the F1-ruled shape.
- **The envelope**: hits + armsQueried + armsDark.
- **The block vector**: one compact vector per paragraph-shaped block, regenerated
  only when its block changes.
- **The index**: full-text rows + block vectors for the bound root, incrementally
  maintained, locally stored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A phrase present in exactly one note is found at rank 1, offline,
  with a snippet, on a corpus of thousands of files.
- **SC-002**: With the semantic arm's provider unavailable, queries still answer
  from full-text and 100% of such responses name the dark arm.
- **SC-003**: Editing one block of one file causes exactly one re-embed (measured
  by the embed counter) and no other file is touched.
- **SC-004**: The verb's answer latency stays within the interactive budget the
  programme set (p95 under 100 ms on the reference corpus — asserted later by the
  F14 gate; the verb must not preclude it by design).

## Assumptions

- The scope parameter selects the extent searched (the whole bound root or a
  subtree prefix) — Default provenance; the master-plan names the signature
  `search(query, scope)` without pinning scope's vocabulary, and subtree filtering
  is the minimal useful reading. The remote-backend scope routing arrives in F4.
- Snippet highlighting markers are part of the snippet text contract (the UI needs
  to know what to bold) — Default provenance.
- The initial bulk generation of vectors for an existing corpus happens in the
  background after indexing starts, with the semantic arm honestly partial until
  caught up — Default provenance; nothing in the plan demands a blocking first
  index.

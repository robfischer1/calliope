# Feature Specification: The Note-Native Mint — `create_note` (C8)

**Feature Branch**: `006-create-note` | **Status**: Draft

**Input**: Master-plan C8 head — "Give Calliope its own note-creation verb so a note is born correctly instead of borrowed from the work-planner. Build `create_note` — it mints a Note-kind identity node on the `notes` graph through the gated path (two admits: create the node, then add its name and type edges — since a bare create mints only an invisible dictionary row), imports a ChaosClient for that graph write, creates the note's prose body in Calliope's store, ensures an invisible 'Notes' root the whole graph hangs off and parents the new note to it unless the caller names another parent, and canonizes the parent-optional Note shape so a note admits with no violation. Location is set later (the gated path drops it today — themis#65); it is forward-declared, so nothing reads it yet."

> **Gap-protocol (Constitution I).** Unresolved points are marked `[OPEN: …]`; defaults are logged, never implicit. The WHAT lives here; the HOW (ChaosClient import-vs-wrap, admit mechanics) lives in plan.md.

## User Scenarios & Testing _(mandatory)_

### US1 - A note is born correct (P1)

Any caller — the editor's "+ New", the bulk notes importer — creates a note and gets back a browsable, prose-tenant-owned identity: a Note-kind node on the `notes` graph carrying its name and type edges, never a mistyped work-node borrowed from athena's `create_work_node` (which stamped `hasType:Task` and a parent-required violation).

**Why this priority**: the whole feature — every note-creating caller stops borrowing the work-planner.

**Independent Test**: call `create_note(title)` against the live star; read the `notes` graph back and see the node with name + type edges.

**Acceptance Scenarios**:

1. **Given** the registered `notes` graph, **When** `create_note(title)` runs, **Then** a Note-kind node exists that a graph read on `notes` returns **with its name and type edges** (browsable — not an invisible dictionary row), minted via the gated two-admit path.
2. **Given** the canonical parent-optional Note shape, **When** the minted node is admitted, **Then** it admits with **zero shape violations**.
3. **Given** the mint, **When** the note's body is read back through `read_body`, **Then** the created prose body returns.

### US2 - Orphan-safety by default (P1)

A parentless note must not vanish to the orphan sweep (one did on 2026-07-21). Calliope owns an invisible "Notes" root; a note with no caller-named parent auto-parents to it.

**Why this priority**: a created note that silently vanishes is worse than no verb at all.

**Independent Test**: create a note with no parent; verify its parent edge points at the ensured "Notes" root; verify the root is a singleton across repeated creates.

**Acceptance Scenarios**:

1. **Given** no parent argument, **When** `create_note(title)` runs, **Then** the note parents to the ensured "Notes" root (anchorsRole pattern).
2. **Given** the root does not yet exist, **When** the first create runs, **Then** the root is minted exactly once; concurrent/repeated creates never mint a second root.
3. **Given** a caller-named parent, **When** `create_note(title, parent)` runs, **Then** the note parents there and the root is untouched.

### US3 - Idempotent, gated, tags-forward (P2)

Re-running a create for the same note must not duplicate it; the mint rides the ChaosClient (the gated `themis_admit` path), never the raw body-capture; an explicit tags argument is accepted and forward-carried (the tag write itself is C9's).

**Why this priority**: the bulk importer re-runs; a twin-minting create poisons the graph it exists to serve.

**Independent Test**: run the identical `create_note` twice; verify one node, one body, same `node_id` both times.

**Acceptance Scenarios**:

1. **Given** a completed `create_note(title, parent?, tags?)`, **When** the identical call re-runs, **Then** no duplicate node or body is created and the standing `node_id` returns.
2. **Given** the mint path, **When** inspected, **Then** the graph write went through the gated admit (ChaosClient), not the raw urania body-capture.

## Requirements _(mandatory)_

- **FR-001**: `create_note(title, parent?, tags?) -> {node_id}` MUST mint a Note-kind identity node on the `notes` graph via the gated path — **two admits**: createNode, then the name and type edges (a bare createNode alone is an invisible dictionary row).
- **FR-002**: The star MUST acquire a ChaosClient (import or thin wrap — `[OPEN: import a TS client vs wrap the Hades gateway — plan.md reconciles first]`) for `themis_admit`; the raw `HadesCapture` body-capture path is not the identity-mint path.
- **FR-003**: The mint MUST create the note's prose body in Calliope's sovereign store, keyed by the minted `node_id`, readable via the existing body verbs.
- **FR-004**: Calliope MUST own and ensure an invisible anchorsRole "Notes" root on the `notes` graph; a parentless create auto-parents to it; the ensure is singleton-safe.
- **FR-005**: The parent-optional Note shape MUST be canonical at completion (registered-proposed `c8a6c340…` today), so a minted note admits with zero violations.
- **FR-006**: `create_note` MUST be idempotent on the note's identity — a re-run returns the standing node, never a twin.
- **FR-007**: `location` is deliberately NOT set (themis#65 drops it on createNode) — forward-declared, backfilled later; nothing may depend on it.

## Success Criteria

- **SC-001**: A live `create_note` round-trips: graph read on `notes` shows the node with name/type edges; `read_body` returns its body; admit reports zero violations.
- **SC-002**: A parentless create parents to the "Notes" root; the root is a verified singleton after N repeated creates.
- **SC-003**: An identical re-run returns the same `node_id` with no new node/body rows.
- **SC-004**: Full calliope gate green; deploy green; the verb serves through the Hades gateway.

# Feature Specification: Baby Chaos — the Desktop Runs the Real Engine

**Status**: Implemented | **Input**: Master-plan feature F13 — "Git for Ideas — The Blob Store and the Tree"

> **Gap-protocol (Constitution I).** `[OPEN: …]` or logged Default.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One store, two deployments (Priority: P1)

Grace's desktop stops being a lesser fork of the fleet's model. The
sidecar boots the REAL engine — a bundled PostgreSQL plus the actual
chaosstore binary — beside the fs surface it already serves, and the
container verbs (`write_container` / `read_container` /
`container_history`) answer locally with the same semantics the fleet
serves. Markdown files stay the working tree; the engine is `.git`.

**Acceptance Scenarios**:

1. **Given** a payload beside the sidecar exe (or `CALLIOPE_BABYCHAOS_DIR`),
   **When** the sidecar boots, **Then** the handshake line is emitted
   IMMEDIATELY (Grace's bounded wait never blocks on initdb), `/health`
   reports `engine: booting → ready`, and `/mcp` grows the container verbs
   the moment the engine is ready — no listener restart.
2. **Given** no payload, **Then** the sidecar serves exactly its fs-only
   surface (`engine: absent`) — the transition posture.
3. **Given** the engine is ready, **When** a container is written through
   `/mcp`, **Then** it reads back byte-identically, history serves from the
   local graph, and byte-identical prose dedupes to one blob across
   containers.

### User Story 2 - Crash-only supervision (Priority: P1)

Grace's Rust shell already carries a generation-safe respawn ladder for the
ONE process it spawns. The sidecar therefore never grows a second
supervisor: any engine child dying after boot takes the sidecar down
(exit 1) and Grace brings the stack back.

**Acceptance Scenarios**:

1. **Given** a running engine, **When** its postgres is killed, **Then**
   the sidecar exits 1 (and Grace's ladder respawns it).
2. **Given** a payload whose boot FAILS, **Then** the sidecar keeps serving
   fs-only (`engine: failed`) — a respawn would loop into the same failure.
3. **Given** a prior data directory, **When** the sidecar reboots, **Then**
   `initdb` does not run again (a data directory that exists is never
   re-initialized) and the prior containers are still readable.

### User Story 3 - No court on the desktop (Priority: P2)

One machine, one writer: themis's arbitration has nothing to arbitrate.
The gate's ops dialect translates in-process (a port of go-court ToWire,
pinned to its constants) and lands on chaosstore's own `capture` door.

**Acceptance Scenarios**:

1. **Given** the translation, **Then** `ContentHash("done")` and
   `NameHash("moirae")` equal go-court's own pinned test constants.
2. **Given** a batch with creates and edges, **Then** batch-local labels
   resolve as `{$mint: i}`, literals intern in-batch, and blob targets
   cross as `{"$blob": id}` — themis's exact wire.

## Success Criteria *(mandatory)*

- **SC-001**: The full stack boots from a cold directory on BOTH platforms
  (linux CI-shaped run; windows via the real exe + payload) and a
  write/read/history round trip passes through the sidecar's `/mcp`.
- **SC-002**: The handshake contract is unchanged — Grace's shell needs
  ZERO Rust changes.
- **SC-003**: A killed engine child exits the sidecar (crash-only pin).
- **SC-004**: The engine runs on a PLAIN postgres — no pgvector — via
  chaos's soft-vector mode (WL verbs answer `wl_unavailable`).

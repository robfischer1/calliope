# Feature Specification: The Sidecar's Local MCP Endpoint

**Status**: Draft | **Input**: Master-plan feature node F12 — "Look At This — The Attention Pointer" (Fable Wave 6.3, pulled forward from December)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Any agent edits the open workspace (Priority: P1)

The Grace sidecar serves the local workspace over a `{verb, args}` ferry wire
— a private dialect only the desktop app speaks. Fleet-side, every agent
already speaks MCP to calliope. This lands Fable's Wave 6.3: **the sidecar
exposes its verbs as a local MCP endpoint**, so any agent on the machine
edits the open workspace through the same contract Claude already uses
fleet-side. It is nearly free — the sidecar already speaks HTTP and calliope
already owns the MCP server machinery; Logseq DB ships built-in MCP as a
headline, and this is the category's fastest-rising expectation.

**Acceptance Scenarios**:
1. **Given** a running sidecar, **When** an MCP client initializes against `POST /mcp` and lists tools, **Then** the body verbs and the pointer read (`look`) are served.
2. **Given** `read_body`/`write_body` called over MCP, **Then** they behave identically to the ferry wire (same client, same files).
3. **Given** an operation the fs backend deliberately lacks, **Then** the same structured refusal the ferry gives (de-inference law) — never a phantom capability.
4. **Given** the sidecar's bind, **Then** it remains 127.0.0.1-only — an off-host dial cannot reach the endpoint at all (connection-level refusal).
5. **Given** `look` with nothing pointing at the local workspace, **Then** the honest `{focus: null, pins: []}`.

## Requirements *(mandatory)*
- **FR-001**: The sidecar's existing HTTP server MUST additionally serve MCP at `POST /mcp` (stateless streamable transport — the calliope-mcp-http pattern) over the SAME FsBodyClient.
- **FR-002**: The endpoint MUST NOT widen the bind (loopback stays the law).
- **FR-003**: The served tool set is the fs-supported surface: what the BodyClient implements, plus `look` (a process-lifetime register; empty until something feeds it).
- **FR-004**: No grace changes — the endpoint rides the existing listener and lifecycle.

## Success Criteria *(mandatory)*
- **SC-001**: A stock MCP client on the machine lists tools and round-trips a body read/write against the open workspace.
- **SC-002**: The ferry wire is byte-for-byte unaffected.

## Assumptions
- Auth: the machine IS the trust boundary for v1 (loopback bind, same as the ferry today); token auth is a surfaced hardening open, not smuggled scope (Default, binding — the master-plan's "binding and auth" gap decided minimally).
- Verb subset: the fs-supported set with structured refusals, not a curated allowlist (the de-inference law already answers this) (Default, binding — the "full set or subset" gap decided).

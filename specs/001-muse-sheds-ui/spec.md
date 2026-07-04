# Feature Specification: Identity — the Muse Sheds Its UI

**Status**: Draft | **Input**: Master-plan C1 head — "Make the calliope repo purely the Muse — the editor components leave for Aglaia (its A1 is the same change from the other side), the package identity stops claiming to be an editor, and what remains is the body service (src/mcp/) plus the carve target for the prose domain — so the name finally means what B3 decided it means."

> Mirror of `aglaia/specs/001-the-split` (the receiving side). One window: A1 ↔ C1 ↔ Tantalus B5.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - The body service survives the subtraction untouched (Priority: P1)

Every verb consumer (Aglaia, the board via Athena's plane, Hades callers) keeps dialing `read_body` / `write_body` / `append_section` / `edit_section` / `revise_section_node` on `calliope-mcp:8204`; the wire surface is byte-identical after the editor leaves.

**Independent Test**: calliope full gate green post-subtraction; redeployed container round-trips the verbs on a scratch node.

**Acceptance Scenarios**:

1. **Given** the editor files removed, **When** the repo builds and redeploys, **Then** the MCP tool list and each verb's request/response shapes are unchanged and live round-trips succeed.

### User Story 2 - The package identity is the Muse's wire (Priority: P2)

The manifest no longer describes an editor; its deps carry no React/ProseMirror; the public exports are service-facing (body-model types + clients), not UI.

**Acceptance Scenarios**:

1. **Given** C1 landed, **When** reading `package.json` and `src/index.ts`, **Then** nothing claims to be an editor and no UI dependency remains.

### Edge Cases

- Retained modules that the service imports (`types`, `order-key`, `fixture-client`, `urania-client`) stay in place so `src/mcp` imports are untouched (zero-churn subtraction).
- Remaining tests must not require a DOM (vitest env flips jsdom → node).

## Requirements _(mandatory)_

- **FR-001**: `src/` MUST NOT contain `NodeBodyEditor.tsx` or `prosemirror.ts` (nor their tests) after C1.
- **FR-002**: `src/mcp/**` MUST be byte-identical through C1 (no import churn).
- **FR-003**: `package.json` MUST drop React/ProseMirror/UI-test dependencies and describe the body service.
- **FR-004**: The wire surface (verbs, port 8204, Hades registration) MUST be unchanged; the redeployed container MUST serve.
- **FR-005**: Full gate green (format/lint/typecheck/test/build).

## Success Criteria _(mandatory)_

- **SC-001**: verb round-trip live on the redeployed container (read/append/edit/write on a scratch node).
- **SC-002**: `grep -c prosemirror package.json` → 0; no react dep; description names the Muse's wire.
- **SC-003**: repo gate green; the C1 PR merges in the A1/B5 window.

## Assumptions

- Retained shared modules (`types.ts`, `order-key.ts`, `fixture-client.ts`) are calliope's own copies per the A1 shared-module Default; `urania-client.ts` is calliope-only.
- `src/index.ts` stays as a trimmed service-facing export surface (types + clients); no external npm consumer remains after B5.

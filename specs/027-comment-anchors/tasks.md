---
description: "Forge work-chunks"
---

# Tasks: Anchor a Comment to a Revision

### T001 — Types + store anchor resolution  ·  M
- **Acceptance:** pg (live): comment on "v1", edit target to "v2" → anchored read gives anchorText "v1", currentText "v2", drift true; a comment on head gives drift false with equal texts; after `coalesceArc` collapses the anchored moment, the anchored read still answers (nearest surviving state) and never throws; flag absent ⇒ records carry none of the three fields (existing tests untouched). Fixture twin mirrors via its snapshots. **Tests first.**
- **Touches:** `types.ts` · `pg-client.ts` · `fixture-client.ts` · `__tests__/pg-client.test.ts` · `__tests__/fixture-comments.test.ts`.

### T002 — The verb flag  ·  S
- **Acceptance:** MCP (fixture): `list_comments{resolve_anchors:true}` returns the three fields; false/absent byte-identical to 026. **Tests first.**
- **Touches:** `mcp/server.ts` · `mcp/tools.ts` · `__tests__/mcp-comments.test.ts`.

### T003 — Gate  ·  S
- **Acceptance:** full repo gate green; no DDL in the diff.

Done-when: [x] acceptance+touches · [x] no cycles

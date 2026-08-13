---
title: "Anchor a Comment to a Revision"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# Anchor a Comment to a Revision — Design Plan

> **Binding contract.** decided / [OPEN] only. (Constitution I/II)

## Summary

`listComments` gains `resolveAnchors?: boolean` (verb: `resolve_anchors`, default false — FR-004). When set, each `CommentRecord` additionally carries `anchorText: string | null` (the targeted revision-row's own immutable text — copy-on-write makes every revision a distinct immortal row, so this equals the `readRevisionAt` reconstruction for that block without the whole-body pass, and stays correct for ops-only bodies whose reconstruction has no generation anchor; measured at implement), `currentText: string | null` (the target's active-successor text via the existing lineage walk), and `drift: boolean` (`anchorText !== currentText`). Reply comments resolve in the comment container by the same rule. **This closes the carried [OPEN] from 026 (B2 F8 arc-coalesce interaction), by decision:** a COMMENTED revision becomes an arc BOUNDARY — `coalesceArc` never removes a row that a `comments_on` edge targets, so an anchor always resolves exactly while its thread exists. Compaction never destroys what a session reviewed; the bound is honest (commented pause-writes are rare by construction).

## Architecture

| Path | Change |
| :--- | :--- |
| `apps/calliope/src/types.ts` | `CommentRecord` gains optional `anchorText?`, `currentText?`, `drift?`; `BodyClient.listComments?` gains the flag param. |
| `apps/calliope/src/pg-client.ts` | `listComments(containerId, blockId?, resolveAnchors?)`: per comment, `readRevisionAt(scope, createdAt)` (scope = container for block targets, comment container for reply targets) + current text via the forward lineage walk. |
| `apps/calliope/src/fixture-client.ts` | twin: snapshots already stored per event — anchor = target text in the latest snapshot at/before createdAt. |
| `apps/calliope/src/mcp/server.ts` + `mcp/tools.ts` | `list_comments` gains `resolve_anchors?: boolean`. |

## Contracts & Seams

| Surface | Shape | State |
| :--- | :--- | :--- |
| `mcp_tool:list_comments` | + `resolve_anchors?: boolean` (default false); records gain `anchorText \| null`, `currentText \| null`, `drift` when set | decided |
| anchor semantics | anchor moment = the comment row's `created_at` (stamped at creation, 026); resolution = `readRevisionAt` over surviving history | decided |
| arc-coalesce interaction (carried from 026) | resolves by degradation to surviving reconstruction — **decided here**, closing the carried [OPEN] | decided |

Consumes: `readRevisionAt` (already built — master plan "do not rebuild"); 026's `comments_on` + threads (landed).

## Decision Log

| Decision | Resolution | Rationale | Provenance |
| :--- | :--- | :--- | :--- |
| Anchor key | the edge's target row itself — its immutable prose; `createdAt` stays the anchor moment | equivalent to the master plan's `readRevisionAt` mechanism for the anchored block (TURN 288 semantics preserved), minus a whole-body pass; REVISED at implement: the reconstruction's generation anchor returns empty for ops-only bodies — measured, surfaced here | Claude (binding; revision noted in completion report) |
| Opt-in flag | `resolve_anchors`, default false | a reconstruction per comment is a real cost; the default read stays cheap and byte-identical | Claude (Default — binding) |
| Coalesce interaction | a commented revision is an arc boundary — never removed | exact anchors beat approximate ones, and the guard is one set-membership test in the existing boundary check; B2 F8's boundary law already protects structural events, this extends it to reviewed ones | Claude (Default — binding; closes 026's carried [OPEN]) |
| Re-anchor to head | out of scope, nothing precludes | master-plan gap, carried | [OPEN] |

## Open & risk

- **[OPEN]** (master plan, carried): whether a comment can be re-anchored to head — untouched.
- N+1 reconstructions under the flag — bounded by thread size; opt-in per read.

---
DoR: [x] decided/tagged · [x] seams shaped · [x] RR verified (files above, post-030 main) · [x] no cycles · [x] I–V

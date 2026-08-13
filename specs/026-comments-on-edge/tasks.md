---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: A Comment Is a Block with a commentsOn Edge

**Input:** plan.md · spec.md.
**Binding contract:** tasks are binding; deviations surface. (Constitution I/II)

## Parallelization

- **Critical path:** T001 → T002 → T003 → T004 (sequential this run; T002 lanes could split pg/fixture after T001).

| Lane | Tasks | Depends on | Files |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | types.ts |
| 2 | T002 | T001 | pg-client.ts · fixture-client.ts · __tests__/pg-client.test.ts · __tests__/fixture-comments.test.ts |
| 3 | T003 | T002 | mcp/tools.ts · mcp/server.ts · __tests__/mcp-comments.test.ts · __tests__/mcp-http.test.ts (fence) |
| 4 | T004 | T003 | — (gate) |

## Work-chunks

### T001 — Shapes and the container derivation  ·  S
- **Serves:** every other chunk.
- **Acceptance:** `commentContainerOf("abc")` → `"abc#comments"`; idempotent on `"abc#comments"`; `CommentRecord`/`CommentThread`/`TargetState` types compile; `BodyClient.createComment?/listComments?` optional methods declared per plan Contracts. Unit-tested in the fixture-comments file (lane-2 hosts the test to keep the lane conflict-free).
- **Touches (RR):** write `file:apps/calliope/src/types.ts`.
- **Decisions-slice:** derived container, idempotent suffix [Claude Default — binding].
- **Size basis:** types + one helper → S.

### T002 — The store: atomic create, both-ways lineage-aware read  ·  M
- **Serves:** spec US1/US2/US3; SC-001/003/004.
- **Acceptance (pg, live docker):** `createComment` lands section+edge in ONE tx (author principal + optional offset stamped; rejected author → neither row, verified by count); `listComments(container, block)` returns the thread with author/offset/created_at; after `editSection` on the target, the CURRENT block's thread includes the pre-edit comment (lineage walk); after `mergeSections`/`splitSection` same; after `delete` the thread reports `target_state: "deleted"`; body reads of the target container byte-identical (existing suites). Reply: comment-on-comment resolves to the parent comment. Fixture twin mirrors all of it (offline). **Tests first.**
- **Exposes:** `db_table:comments_on` + client methods per plan — decided.
- **Touches (RR):** write `file:apps/calliope/src/pg-client.ts` (DDL, `createComment`, `listComments`, recursive lineage CTE); write `file:apps/calliope/src/fixture-client.ts`; write `file:apps/calliope/__tests__/pg-client.test.ts` (new describe) · `file:apps/calliope/__tests__/fixture-comments.test.ts` (new).
- **Decisions-slice:** join-table edge; atomic tx; author required [binding, per plan].
- **Size basis:** DDL + tx + CTE + twin + tests → M.

### T003 — The verbs and the fence  ·  M
- **Serves:** the `commentsOn` Exposes row's caller surface.
- **Acceptance (fixture-backed MCP):** `create_comment` with principal author lands and `list_comments` returns it both ways (by container and by block); missing/legacy author rejects naming the session-required rule (nothing lands); stale target rejects; `kafka_offset` composes per 025's contract; the tool-list FENCE includes exactly the old surface + `create_comment` + `list_comments`. **Tests first.**
- **Touches (RR):** write `file:apps/calliope/src/mcp/tools.ts` · `file:apps/calliope/src/mcp/server.ts` · `file:apps/calliope/__tests__/mcp-comments.test.ts` (new) · `file:apps/calliope/__tests__/mcp-http.test.ts` (fence line).
- **Decisions-slice:** two verbs, not an overloaded create_block; human rejected [binding, per plan].
- **Conflicts-with:** Clover4 029–031 (process: pull merged main before landing).
- **Size basis:** two registrations + validation + fence → M.

### T004 — Gate run  ·  S
- **Serves:** Constitution V.
- **Acceptance:** full repo gate green (format/lint/typecheck/test/build); pg comment suite ran under docker; SC-002 pinned by untouched existing body-read tests.
- **Size basis:** verification → S.

---
Done-when:
[x] tasks carry Serves/Acceptance/field-level Touches/Decisions/size
[x] lanes conflict-checked; critical path stated; no cycles
[x] every Exposes shape traces to plan Contracts & Seams

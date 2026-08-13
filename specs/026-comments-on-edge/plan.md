---
title: "A Comment Is a Block with a commentsOn Edge"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# A Comment Is a Block with a commentsOn Edge — Design Plan

> **Binding contract.** Every item is `decided` or `[OPEN]`. No advisory tier. (Constitution I/II)

## Summary

A comment is an ordinary `sections` row living in a **comment container** (the target container's id + `#comments` suffix), plus one row in a new **`comments_on` join table** — the same edge-as-table move `supersessions` already made. Creation is one transaction (block + edge, `createComment` on the store client), requires a session-principal author (comments are attributed by definition), and reuses the whole 024/025 write path (author + offset stamping, copy-on-write, lineage). Thread resolution walks the target's `supersessions` lineage so supersession never orphans a thread. Surface: `create_comment` + `list_comments` MCP verbs — licensed by the master-plan Exposes row `commentsOn` (open — F4); the tool-list fence is updated in the same landing.

## Architecture

| Path | Change |
| :--- | :--- |
| `apps/calliope/src/pg-client.ts` (Tail RR) | `comments_on` DDL (join table + indexes, idempotent); `createComment()` (one tx: section INSERT into the comment container + edge INSERT); `listComments()` (both-ways read joining sections for author/offset/created_at, lineage-expanded via a recursive walk over `supersessions`). |
| `apps/calliope/src/fixture-client.ts` (adjacent — surfaced) | in-memory twin of both methods (MCP tests run fixture-backed). |
| `apps/calliope/src/types.ts` (adjacent — surfaced) | `BodyClient.createComment?/listComments?` optional methods + `CommentRecord`/`CommentThread` shapes; comment-container derivation helper `commentContainerOf()`. |
| `apps/calliope/src/mcp/tools.ts` (Tail RR) | `createComment`/`listComments` handlers (validation: author required, principal-form). |
| `apps/calliope/src/mcp/server.ts` (Tail RR) | verb registrations `create_comment` + `list_comments`. |
| `apps/calliope/__tests__/mcp-http.test.ts` (adjacent — surfaced) | the tool-list FENCE gains the two verbs (each traces to the `commentsOn` Exposes row). |

## Contracts & Seams

### Exposes

| Surface | Signature / shape | State |
| :--- | :--- | :--- |
| `db_table:comments_on` | `(comment_id text, target_id text, node_id text /* the TARGET's container */, created_at timestamptz, PK (comment_id, target_id))` + index `(node_id, target_id)` | decided |
| comment container | derived id: `targetContainer.endsWith("#comments") ? targetContainer : targetContainer + "#comments"` — replies land beside their parents | decided |
| `mcp_tool:calliope:create_comment` | `(container_id, target_block_id, text, authored_by /* REQUIRED, session principal */, kafka_offset?) -> { comment: {id, text, orderKey}, target_id, comment_container_id }` — atomic | decided |
| `mcp_tool:calliope:list_comments` | `(container_id, block_id?) -> { threads: [{target_id, target_state: "active"\|"superseded"\|"deleted", comments: [{id, text, author, kafka_offset, created_at, comments_on}]}] }` — `block_id` given: that block's thread INCLUDING lineage-predecessor comments; absent: every thread in the container | decided |
| master-plan Exposes row `commentsOn` | closed by the two verbs + the table | decided |

### Consumes / Requires

| Dependency | Contract | Pin |
| :--- | :--- | :--- |
| B2 F3 `create_block` machinery (`applySectionOps` add-path) | the comment block INSERT reuses the section-write shape | landed (calliope main) |
| F1/F2 provenance (`authored_by`, `kafka_offset`, `validateWriteProvenance`) | comments stamp both | landed (`a2fdcb2`, `e5e6989`) |
| `supersessions` join table | lineage walk for FR-005 | live (pg-client DDL L66) |
| `SESSION_PRINCIPAL_RE` | the author-required check | landed (types.ts) |

### Resource-Reach — verified

| RR pointer | Access | Role |
| :--- | :--- | :--- |
| `file:apps/calliope/src/pg-client.ts` (Tail RR) | write | DDL + two methods |
| `file:apps/calliope/src/mcp/tools.ts` (Tail RR) | write | handlers |
| `file:apps/calliope/src/mcp/server.ts` (Tail RR) | write | registrations |
| `file:apps/calliope/src/types.ts` · `fixture-client.ts` · `__tests__/mcp-http.test.ts` (adjacent — surfaced) | write | shapes · fixture twin · fence |

## Data model

- **`comments_on`** (new, the one predicate): `comment_id` → the comment block's section id; `target_id` → the commented block's section id; `node_id` → the TARGET's container (thread reads are per-document); `created_at` → edge birth (F8's anchor input). No FK constraints — section ids are copy-on-write immortal (rows never delete except arc-coalesce; a coalesced intermediate is B2 F8's interaction, surfaced [OPEN] below).
- **Comment blocks**: ordinary `sections` rows under the derived comment container. Body reads of the target container are untouched (SC-002) because the container ids differ.
- **Thread resolution** (FR-005): comments of block B = edges whose `target_id ∈ lineage(B)` where `lineage(B)` = B plus its transitive `supersessions` predecessors (recursive CTE, bounded by the container). `target_state`: "active" (B active), "superseded" (inactive, non-tombstone successor exists), "deleted" (tombstone in its successor chain).

## Decision Log

| Decision | Resolution | Rationale | Provenance | Alternatives |
| :--- | :--- | :--- | :--- | :--- |
| Comment placement | separate derived container (`+ "#comments"`), NOT a flag column on body rows | zero regression surface on body reads (SC-002); every block verb works on comments free; `#` cannot collide with node tokens (64-hex/ULID) | Claude (Default — binding) | `comment` boolean on sections (touches every body query — high regression) |
| The edge | a join table mirroring `supersessions` | the store's established edge idiom; "one predicate" made literal | Claude (Default — binding); master-plan TURN 265 (a comment is just a block) | edge-in-sections-column (single-valued, wrong cardinality) |
| Reply nesting (Tail gap) | a reply's edge targets the COMMENT; replies live in the same comment container (derivation is idempotent on the `#comments` suffix) | threading (F6) reconstructs the tree from edges; no depth limit imposed at the store | Claude (Default — binding; resolves the Tail's surfaced gap) | replies target the root block (flattens threads — loses the Reddit shape F6 needs) |
| Author required | `create_comment` REJECTS without a session-principal `authored_by` | "Who comments: sessions, as users — with identity, not anonymous writes" [Rob, TURN 258]; an unattributed comment is the checkpoint-nobody-reads again | Claude (binding; direct consequence of Rob's TURN 258 decision) | optional author (recreates the anonymity this plan exists to end) |
| Human comments | NOT designed for; `authored_by: "human"` is rejected by create_comment | master-plan Boundaries: same mechanism, entirely unexplored, do not design for it here | carried verbatim (master-plan non-goal) | — |
| Atomicity | `createComment` = one store transaction | SC-004; two calls would race (block lands, edge fails → invisible orphan block) | Claude (Default — binding) | compose create_block + add_edge verbs (the race) |
| Verb surface | `create_comment` + `list_comments`, fence updated same landing | the `commentsOn` Exposes row licenses the surface; overloading `create_block` with comment semantics would fork its contract (comment container derivation + required author) invisibly | Claude (Default — binding) | `create_block(comments_on=…)` (hides a different contract inside an existing verb) |
| B2 F8 arc-coalesce interaction (Tail gap) | **[OPEN — surfaced, not resolved]**: a coalesced intermediate that is a comment target loses its lineage row; F8 (revision anchoring) owns the resolution per the master plan ("resolve the interaction at /plan" of F8) | the master plan assigns this to F8 explicitly | [OPEN] | — |

## Dependencies

- types → pg/fixture clients → tools → server → fence. Consumes F1 (landed) + B2 F3 (landed); **gates F5, F8** (Tail, verbatim).

## Impact

| Slice | Impact (0–10) |
| :--- | :--- |
| Store (DDL + tx + lineage walk) | 6 |
| Fixture twin | 3 |
| Verbs + fence | 4 |

## Open & risk

- **[OPEN] (carried to F8, per master plan):** arc coalescing (B2 F8) physically removes intermediate rows; a comment targeting a removed intermediate must re-anchor — F8's revision anchoring owns it.
- **Risk:** the recursive lineage CTE on a long edit chain — bounded by container and by the chain length the arc-coalesce keeps short; no budget stated (not perf-load-bearing at plan grain).
- **Risk:** Clover4's 029–031 land in `server.ts`/`tools.ts` — pull merged main before landing (process).

---
Definition of Ready:
[x] decisions provenance-tagged; 1 [OPEN] carried where the master plan assigns it
[x] contracts shaped both directions; deps pinned to landed shas
[x] RR verified against post-028 main
[x] no cycles
[x] constitution I–V (falsifiable acceptance; fence updated with the surface it pins)

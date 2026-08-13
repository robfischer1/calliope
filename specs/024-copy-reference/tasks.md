# Tasks: Compound Copy-Reference

**Input:** plan.md · spec.md · the Contracts & Seams (the dependency edges).
**Binding contract:** every task is binding spec. The executor follows it and does NOT
use judgment outside items marked `[OPEN]`. A needed deviation is surfaced back, not
decided locally. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)

- **Critical path:** T001 → T002 → T004 (calliope formatter → verb → gate). The
  theia lane (T005) is independent — different repo.

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | apps/calliope/src/mcp/tools.ts (+ test file) |
| 1 | T002 | T001 | apps/calliope/src/mcp/server.ts |
| 1 | T003 | T001 | apps/calliope/src/mcp/sidecar.ts (+ test file) |
| 1 | T004 | T001–T003 | (gate run, no new files) |
| 2 | T005 [P] | — | repo:theia apps/aglaia/src/view/write-app.tsx · apps/aglaia/src/plugin.tsx (+ test) |

## Work-chunks

### T001 — formatter + copyReference in tools.ts  ·  S  ·  sequential
- **Serves:** plan Slice "calliope verb + sidecar".
- **Acceptance:** Given title `T` and id `I`, `formatCompoundReference("T","I")`
  returns `{ compound: "[[T]] (I)", wikilink: "[[T]]", id: "I" }`; newlines in
  `T` are stripped; Given a dial knowing `{hex: "My note"}`,
  `copyReference(dial, hex)` returns `{..., title: "My note", address_form:
  "node" }`; Given an unknown hex, returns `{ error: "unknown_node", detail }`.
- **Exposes:** `formatCompoundReference(title, id)` + `copyReference(dial, nodeId)` (module exports) · decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/mcp/tools.ts` ·
  call `function:chaos-client.ts:dial.resolveNodes` · write `file:apps/calliope/src/mcp/tools.test.ts` (or the repo's test convention).
- **Decisions-slice:** compound form [Claude] · full id [Default] · strip-newlines [Default].
- **Conflicts-with:** T002/T003 import it — sequential after.
- **Size basis:** one pure fn + one resolve fn + tests → S.

### T002 — register copy_reference on the MCP server  ·  S  ·  sequential
- **Serves:** plan Slice "calliope verb + sidecar".
- **Acceptance:** Given the server built with a chaos facet, the tool list
  contains `copy_reference` (readOnly annotations); calling it with a known
  node returns the T001 shape with `address_form: "node"`; without the chaos
  facet the tool is absent.
- **Exposes:** `mcp_tool:calliope:copy_reference` per plan.md Contracts · decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/mcp/server.ts`
  (inside the `options.chaos !== undefined` block) · call `function:tools.ts:copyReference`.
- **Decisions-slice:** chaos-gated registration [Default].
- **Conflicts-with:** T001 (imports); Briar4's branch also edits server.ts —
  cross-session, handled at merge (append-shaped).
- **Size basis:** one registerTool block + a tools test → S.

### T003 — copy_reference on the fs sidecar dispatch  ·  S  ·  sequential
- **Serves:** plan Slice "calliope verb + sidecar" (the fs half of FR-003).
- **Acceptance:** Given the sidecar dispatch, `{verb:"copy_reference",
  args:{node_id:"Brain Soup/idea.md"}}` returns `{ compound: "[[idea]] (Brain
  Soup/idea.md)", title: "idea", address_form: "path" }`; a `.markdown`
  extension also strips; an escaping path errors exactly as read_body does.
- **Exposes:** `sidecar_verb:copy_reference` per plan.md Contracts · decided.
- **Touches (RR, field-level):** write `file:apps/calliope/src/mcp/sidecar.ts`
  (dispatch case) · call `function:tools.ts:formatCompoundReference` · write the sidecar test file.
- **Decisions-slice:** path form on fs [Claude, master-plan] · title = basename sans extension [Default].
- **Conflicts-with:** T001 (imports).
- **Size basis:** one dispatch case + tests → S.

### T004 — calliope gate green  ·  S  ·  sequential
- **Serves:** Constitution V.
- **Acceptance:** `bun run gate` passes in the worktree (format:check, lint,
  typecheck, test, build).
- **Exposes:** —
- **Touches (RR, field-level):** none new.
- **Decisions-slice:** —
- **Conflicts-with:** all lane-1 tasks precede it.
- **Size basis:** a gate run → S.

### T005 — theia copy-reference palette command  ·  S  ·  [P] lane-2
- **Serves:** plan Slice "theia palette command".
- **Acceptance:** Given an open note with a resolved title, invoking the
  `copy-reference` command writes `[[<title>]] (<node hex>)` to the clipboard;
  Given no open note, the command is a no-op (no throw, no clipboard write);
  the command appears in the plugin's `commands` manifest.
- **Exposes:** `ui_command:copy-reference` per plan.md Contracts · decided.
- **Touches (RR, field-level):** write `file:repo:theia
  apps/aglaia/src/view/write-app.tsx` (H6 commands block + a format helper) ·
  write `file:repo:theia apps/aglaia/src/plugin.tsx` (manifest entry) · write
  the app test per repo convention.
- **Decisions-slice:** palette placement [Default] · local format, no ferry call [Default] · full id [Default].
- **Conflicts-with:** none in this feature (different repo).
- **Open:** —
- **Size basis:** one command + helper + test → S.

---
Done-when (the gate):
[x] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[x] every [P] verified conflict-free (no shared file in a lane)
[x] critical path identified; no dependency cycles
[x] every Exposes shape traces to plan.md Contracts & Seams
[x] State + Budget present where stateful / perf-load-bearing (none stateful)

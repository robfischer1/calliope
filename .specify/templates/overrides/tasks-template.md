---
description: "Forge work-chunks — binding, conflict-checked, executor-optimized"
---

# Tasks: {Title}

**Input:** plan.md (required) · spec.md · the Contracts & Seams (the dependency edges).
**Binding contract:** every task is binding spec. The executor follows it and does NOT
use judgment outside items marked `[OPEN]`. A needed deviation is surfaced back, not
decided locally. (Constitution I/II)

## Parallelization — conflict-checked (NOT optimistic)
<!-- Stock spec-kit's [P] over-promised: it marked same-file tasks parallel. Here [P] is EARNED. -->
- `[P]` requires BOTH: different files from every other [P] task in the lane AND no unmet dependency.
- A shared-file touch with any other task ALWAYS removes [P] (see each task's Conflicts-with).
- **Critical path:** {the longest dependency chain — the real wall-clock floor}.

| Lane | Tasks | Depends on | Distinct files (conflict-verified) |
| :--- | :--- | :--- | :--- |
| 1 | T001, T003 | — | {files} |
| 2 | T002 | T001 | {files} |

## Work-chunks
<!-- One ### per chunk, ~one PR. Tactics (free choices like local names) evaporate;
     anything whose wrong choice causes rework is binding spec, NOT a tactic. -->

### T001 — {title}  ·  {S | M | L}  ·  {[P] lane-N | sequential}
- **Serves:** {which plan Slice / the Objective}
- **Acceptance:** {Given X When Y Then Z} — *conformance target; impl diffed against this + Touches + State* (Constitution IV)
- **Exposes:** {verbs/endpoints/ports stood up, with shape · decided/open · "—" if none}
- **Touches (RR, field-level):** read `file:…` · write `db_field:t.col` · call `mcp_tool:server:verb`
- **State:** {modes/transitions introduced or depended on — when stateful}
- **Budget:** {latency / rows / tokens — a number, when load-bearing}
- **Decisions-slice:** {in-scope Decision-Log subset · each Rob | Default | Claude}
- **Conflicts-with:** {tasks sharing a file → forces sequential; "none" if isolated}
- **Open:** {surfaced open gaps — executor surfaces back, never resolves by inventing}
- **Size basis:** {why S/M/L}

---
Done-when (the gate):
[ ] every task: Serves + Acceptance + field-level Touches + Decisions-slice + size
[ ] every [P] verified conflict-free (no shared file in a lane)
[ ] critical path identified; no dependency cycles
[ ] every Exposes shape traces to plan.md Contracts & Seams
[ ] State + Budget present where stateful / perf-load-bearing

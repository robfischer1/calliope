# Tasks: ToolAnnotations on every Calliope verb

- [X] T001 Fence test first in `__tests__/mcp-http.test.ts`: every tool in
      `tools/list` carries annotations; the exact read/destructive/idempotent
      map is asserted per verb. Run: red (no annotations emitted).
- [X] T002 Add `annotations` to all 25 registrations in
      `src/mcp/server.ts` from the plan's map. Run: green.
- [X] T003 Gate + audit — green. Land.

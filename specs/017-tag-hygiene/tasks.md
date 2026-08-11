# Tasks: Server-side tag hygiene and a persisted cleanup pass

- [X] T001 Test-first `__tests__/tags.test.ts`: normalizeTag strips trailing
      slashes; isJunkTag on hex shapes (3/4/6/8) and non-hex; computeTagDelta
      drops junk on both provenance paths. `__tests__/mcp-tools.test.ts`:
      create_note with a hex tag → bad_tags. Run: red.
- [X] T002 Implement in `src/tags.ts` + `src/mcp/tools.ts`. Run: green.
- [X] T003 `src/mcp/cleanup-tags.ts` (probe/apply) + pure-plan unit test
      (`planTagCleanup(distinct)` → {remove, merge}). Run: green.
- [X] T004 Gate + audit — green. Land.
- [ ] T005 Live run: probe → apply → re-run zero; verify the 10 junk
      entries gone; paste output.

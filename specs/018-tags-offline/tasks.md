# Tasks: Tags offline

- [X] T001 Calliope test-first (`__tests__/fs-tags.test.ts` + sidecar wire
      cases in `__tests__/sidecar.test.ts`): seeded temp dir → counts,
      by-tag ids, junk excluded, dot-dirs skipped. Run: red.
- [X] T002 Implement `src/fs-tags.ts` + the two sidecar dispatch arms.
      Run: green. Gate + audit. Land calliope.
- [ ] T003 Theia test-first: `tagPickerSource` trigger boundaries, fuzzy
      filter, insertion. Implement in
      `packages/aglaia/src/suggest/pickers.ts`. Theia gate. Land theia.

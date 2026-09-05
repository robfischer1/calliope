# Tasks: One stream or two
| Lane | Tasks | Depends on | Files |
| :--- | :--- | :--- | :--- |
| 1 | T001 | — | census (recorded in spec.md) |
| 1 | T002 | T001 | `consciousness-emit.ts`, `@noble/hashes`, `heartbeat.ts` metrics, `http.ts`/`main.ts` wiring |
| 1 | T003 | T002 | remove `notes-emit.ts` + test; move `fanOutPushers`; docs |
| 2 | T004 | deploy | eros: retire `from_calliope_note` + `calliope-notes` subscription (follow-up PR) |
Done-when: [x] T001–T003 · [ ] T004 (eros, after deploy)

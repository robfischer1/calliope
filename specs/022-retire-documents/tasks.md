# Tasks: Retire the documents table

- [X] T001 Test-first: `__tests__/notes-document-store.test.ts` (write→
      note-only; byId via migrated document_id; bySourcePath vault + archive;
      list schema_type/omit_body; reconstruction byte-exact). Run: red.
- [X] T002 Implement `src/notes-document-store.ts`. Green.
- [X] T003 Wire both backends; write_document drops the separate bridge
      call; archive verbs re-scoped FROZEN ARCHIVE; plan-ingest test seeds
      move to source_path handles. Full suite green.
- [X] T004 `src/mcp/drop-documents.ts` (probe / --execute, convergence-
      gated) + unit test of the convergence check. Gate + audit. Land.
- [ ] T005 Live: verify deployed image serves notes-backed reads (or record
      the gate + exact command); probe convergence; execute the drop when
      gated-clear. Paste output. Close F7.

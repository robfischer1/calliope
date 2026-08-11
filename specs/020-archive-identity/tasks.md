# Tasks: Archive identity amendment (F7 prelude)

- [X] T001 Test-first: sink identity override + additive attrs; migration
      composite grouping, isArchived, document_id edges, vault rows
      unchanged, unwind of stale names, re-run zero-delta. Run: red.
- [X] T002 Implement sink seam + migration identity model + unwind. Green.
- [X] T003 Gate + audit — green. Land.
- [ ] T004 Live run: probe → migrate (composite) → unwind verified → re-run
      zero → spot-check an archive note. Paste output.

# Tasks: The .grace/ revlog

- [X] T001 Test-first in `__tests__/fs-client.test.ts`: N edits → N
      revisions newest-first; per-revision byte-exact reconstruction (id =
      the derive shape); external-edit lazy capture; head dedup; cap at
      200; deleted-revlog degrade; pre-history revision → []. Run: red.
- [X] T002 Implement `src/fs-revlog.ts` + the FsBodyClient methods. Green.
- [X] T003 Gate + audit — green. Land.

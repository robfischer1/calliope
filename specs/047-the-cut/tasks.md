# Tasks: The Cut (F12)

- [x] T001 Caller sweep across 18 sibling repos → four theia clients still
      spoke the families; repointed to the container surface (theia PR
      #241, merged) + fixed the bare-vs-prefixed ferry naming bug.
- [x] T002 server.ts: retire 21 registrations (body/section/document/plan/
      revision families + the block family + comments); the six
      path-addressed body verbs move behind `pathBodies` (desktop only).
- [x] T003 tools.ts: delete the dead helpers (12); `look`'s drift verdict
      reads the body directly (the block read inlined).
- [x] T004 pg-client.ts: SCHEMA_SQL splits — fresh installs get the blob
      store only; the old model's DDL survives ONLY behind
      `ensureSchema({ legacy: true })` (the migration suite's old-store
      simulator).
- [x] T005 drop-old-tables.ts: the gated drop — parity-report gate +
      frozen-store check, dry-run by default, `--execute` to cut.
- [x] T006 Audit fix: main.ts + http.ts actually pass the containers facet
      to createServer (wired in the backend since F4, served never).
- [x] T007 Tests: the http fence re-pinned to the exact post-cut surface +
      annotations; retired-surface suites deleted (authored-by wire,
      comments, documents, plan-ingest); legacy flag in the old-store
      suites; drop-tool suite (5, docker); full suite 430 green; the F13
      engine suites pass unchanged.
- [x] T008 charon: BODY_VERBS drops the five retired entries (separate
      landing, same feature).
- [x] T009 Production: run the gated drop against the live store with the
      specs/043 report (dry-run, then --execute).
- [ ] T010 F12-bound leftovers named for the record: splitSection /
      mergeSections / coalesceArc / createComment / listComments stay
      OPTIONAL on BodyClient with guards — their verbs are gone from every
      surface; the methods die when the substrate clients retire.

# Tasks: Delete the Parallel Implementation (F14)

- [x] T001 Extract `search-types.ts`; move `eros-provider.ts` out of the
      dying directory; repoint server.ts/http.ts/main.ts imports.
- [x] T002 `src/local-store.ts` — LocalEngineStore: path discipline (fs
      rules verbatim), container-per-path (label = path, minted on first
      write), readBody/saveBody/editSection/applySectionOps/readRevisions/
      readRevisionAt/hasBody over readContainer/writeContainer/
      containerHistory; projection (atomic write, SECTION_SEP join);
      ingestion (lazy on read + debounced recursive watcher + boot scan);
      tags walk; tsvector search + wikilink mentions in the engine's pg.
- [x] T003 DELETE fs-client/fs-tags/fs-revlog/fs-search + 11 suites.
- [x] T004 Rewrite `mcp/sidecar.ts`: engine required, SidecarBackend view,
      boot gate (requests wait; handshake and /health never do), /mcp with
      the store as body client + search provider + container facet.
- [x] T005 Interface collapse: types.ts drops `?` on the five methods every
      surviving client implements; tools.ts guards deleted; IndexingBody-
      Client passthroughs unconditional; UraniaBodyClient gains honest
      refusing stubs; guard-pinning test cases deleted; `bareClient` test
      helper for deliberate partial backends.
- [x] T006 New suites: local-store (fixture engine + real temp tree, 13
      cases), local-search (docker pg: FTS/scope/mentions/reindex/unindex),
      sidecar rewritten (ferry + boot gate + /mcp + tags + darkness).
- [x] T007 The F13 real-engine suites pass UNCHANGED (sidecar-engine 4,
      local-engine 3) against the engine-only sidecar.
- [ ] T008 F12 seam: retire the five still-optional methods with their verb
      families (splitSection/mergeSections/coalesceArc/createComment/
      listComments) — the last capability guards die there.

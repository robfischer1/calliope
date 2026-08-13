# Implementation Plan: Route the pg arm through Eros

**Branch**: `034-eros-arm` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: spec.md + Findability F4 planning context + live reconnaissance
(eros_list_sources: `calliope_documents` 36,432/100%; a live fts-mode hit shape
recorded in this session).

## Summary

Two small diffs, one seam. **Eros** grows `source: str | None` on its search
tool, threading a `source_table` filter through both retrieval arms (its schema
already carries `source_table` on every chunk; sibling verbs already filter by
it). **Calliope** grows `ErosSearchProvider` — an MCP streamable-HTTP client
(the SDK calliope already ships) calling Eros's `search` with
`{query, k, source: "calliope_documents", since: "1900"}` and mapping the
response to the F1 envelope — wired into the store-backed servers (`http.ts`,
`main.ts`) when `CALLIOPE_EROS_URL` is set. The pg backend's architecture has
ONE arm (`eros`): reachable → `armsQueried:["eros"], armsDark:[]`; not →
`armsQueried:[], armsDark:["eros"]`. RRF weighting across eros+local arms
(the master-plan's surfaced gap) stays moot in this feature: no backend serves
both today; recorded for F8's era.

## Technical Context

Calliope: TypeScript/Bun, `@modelcontextprotocol/sdk` client + vitest (fetch-
level fixture tests — the SDK client is exercised against a stub MCP endpoint).
Eros: Python 3.12, psycopg, pytest (SQL-fixture tests exist — `tests/`), ruff.
`since: "1900"` disables the 2018 hybrid skew-default (notes must not be
date-filtered). No new deps on either side.

## Constitution Check

Passed. The one Touches extension (eros's tool signature) is Brief-licensed
("Route the remote arm at eros_search **with a source filter**") and surfaced
in spec FR-002; the scope-inertness and id-resolution defaults are recorded in
the spec's Assumptions/Edge cases.

## Project Structure

```text
calliope: apps/calliope/src/fs-search/eros-provider.ts   (the arm)
          apps/calliope/src/mcp/http.ts, main.ts         (wiring, env-gated)
          apps/calliope/__tests__/eros-provider.test.ts
          specs/034-eros-arm/*
eros:     src/eros/server.py    (+source param), src/eros/search.py
          (+source_table threading into _semantic_search/_fts_search)
          tests/test_search_source_filter.py
```

## Decisions (binding)

1. Provider transport = MCP streamable-HTTP via the SDK, stateless per query,
   5 s timeout; any transport/tool error → dark, never a thrown search.
2. Hit mapping: `id = String(source_id)`; snippet = `title — snippet` when a
   title exists, else the snippet; `score` = Eros's fused score; provenance
   `["eros"]`.
3. Source value `calliope_documents`, since `"1900"`, k passed through
   (default 20, ≤100 → Eros k).
4. Eros filter: one optional param on the tool → `source_table` equality in
   both arms' SQL (parameterized; NULL = unfiltered, today's behavior).

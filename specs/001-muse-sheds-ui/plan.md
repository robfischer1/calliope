---
title: "Identity — the Muse Sheds Its UI (C1)"
spec: "./spec.md"
constitution: "../../.specify/memory/constitution.md"
status: draft
---

# C1 — Design Plan (mirror of aglaia A1)

> Binding contract; the authoritative split design lives in `aglaia/specs/001-the-split/plan.md`. This plan carries only the calliope-side slices.

## Summary

Subtract the editor: delete `NodeBodyEditor.tsx` + `prosemirror.ts` + their tests, trim `src/index.ts` to service-facing exports, drop UI deps (react/prosemirror/jsdom/@testing-library), flip vitest env to node, re-describe the package as the Muse's wire. `src/mcp/**` untouched. Redeploy `calliope-mcp` and round-trip the verbs live.

## Contracts & Seams

### Exposes (unchanged — the invariant)

| Surface                                                                                    | Signature / shape                       | State                               |
| :----------------------------------------------------------------------------------------- | :-------------------------------------- | :---------------------------------- |
| `mcp_tool:calliope:{read_body,write_body,append_section,edit_section,revise_section_node}` | as served today on `:8204` behind Hades | decided — byte-identical through C1 |

### Resource-Reach — verified

| RR pointer                                                                                            | Access        | Role                 |
| :---------------------------------------------------------------------------------------------------- | :------------ | :------------------- |
| `src/{NodeBodyEditor.tsx,prosemirror.ts}` + `__tests__/{NodeBodyEditor.test.tsx,prosemirror.test.ts}` | delete        | the UI that leaves   |
| `src/index.ts`, `package.json`, `vitest.config.ts`, `eslint.config.mjs` (react bits if any)           | write         | identity trim        |
| `src/{types,order-key,fixture-client,urania-client}.ts` + their tests, `src/mcp/**`                   | read-only     | the Muse — untouched |
| `container:calliope-mcp` (nas01)                                                                      | redeploy (CI) | the wire proof       |

## Decision Log

| Decision                     | Resolution                                              | Rationale                                          | Provenance        | Alternatives           |
| :--------------------------- | :------------------------------------------------------ | :------------------------------------------------- | :---------------- | :--------------------- |
| Repo keeps the Calliope name | yes — UI leaves instead (resolves B3's deferred rename) | same outcome, no wire rename, no Hades re-register | Rob (2026-07-04)  | rename repo            |
| Retained copies              | types/order-key/fixture-client stay in place            | zero-churn for `src/mcp` imports                   | Default (A1 plan) | re-home under src/mcp/ |
| vitest env                   | jsdom → node                                            | no DOM tests remain                                | Claude            | leave jsdom            |

## Open & risk

- First `admit.yml` run on this repo (kit re-pour) — if it reds on pre-existing supply-chain facts, surface.
- The kit re-pour's CI rewrite rides this PR as a separate `chore(governance)` commit.

---

DoR: [x] decisions provenance-tagged · [x] invariant surface named · [x] RR verified · [x] constitution: I–V hold (subtraction with an observable wire invariant).

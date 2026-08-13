# Quickstart — Compound Copy-Reference (024)

## Prerequisites
- calliope worktree, `bun install` done.
- theia checkout for the affordance leg.

## Validate the calliope verb (fixture chaos dial)
```sh
cd apps/calliope && bun test copy-reference
```
Expected: formatter emits `[[Title]] (id)`; graph-backend resolve returns
`address_form: "node"`; unknown node → `{ error: "unknown_node" }`.

## Validate the sidecar path form
```sh
cd apps/calliope && bun test sidecar
```
Expected: `{verb:"copy_reference", args:{node_id:"Brain Soup/idea.md"}}` →
`{ compound: "[[idea]] (Brain Soup/idea.md)", address_form: "path" }`.

## Validate the theia command (theia repo)
```sh
pnpm --filter aglaia-app test -- copy-reference
```
Expected: invoking the `copy-reference` command with an open note writes
`[[<title>]] (<node hex>)` to the clipboard mock.

## End-to-end resolution proof
Paste a copied compound into a session; the session extracts the parenthesized
id and calls `calliope_read_body(node_id)` (hades) — the body returns. That is
the resolve path; no new verb.

## Full gates
```sh
bun run gate          # calliope: format:check, lint, typecheck, test, build
```

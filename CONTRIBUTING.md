# Contributing to Calliope

## Setup

```bash
bun install
```

## Checks (all must pass before a PR)

```bash
bun run gate   # format:check + lint + typecheck + test + build
```

`bun run gate` is the single source of truth: the husky pre-commit hook and CI
both run it, so they can't drift. CI adds `bun audit` + opengrep (SAST) on top.

> Local git hooks are wired: `bun install` activates husky, and the pre-commit
> hook runs lint-staged (autofix) then `bun run gate`. Skip on a WIP commit with
> `git commit --no-verify`. CI is the backstop.

Pull template updates with `copier update` (3-way merged against local edits).

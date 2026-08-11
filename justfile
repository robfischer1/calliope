# justfile — frontend repo local gate.
#
# `check` is the fast edit loop. `gate` is the full mirror of
# .forgejo/workflows/frontend-ci.yml — run it before you push and CI holds no
# surprises. `just` with no argument lists everything.
#
# Thin over package.json: turbo already owns the task graph and its cache, so
# these recipes name the entry points rather than re-implementing them. The
# value here is one vocabulary (`just check` / `just gate`) across all four
# language templates, not a second build system.
#
# Poured verbatim by copier (no .jinja suffix): just's {{ }} interpolation and
# Jinja's {{ }} are the same delimiters, so a .jinja suffix here would have Jinja
# eat every recipe parameter at pour time.

set shell := ["bash", "-euo", "pipefail", "-c"]

star := file_name(justfile_directory())

# List available recipes
default:
    @just --list

# Fast loop: lint, typecheck, test. Run this constantly.
#
# Skips the build that `gate` runs — turbo caches it, but it is still the slow
# leg and rarely what a source edit breaks first.
check: lint typecheck test

# Everything frontend-ci.yml runs. Run before pushing.
#
# `bun run gate` is package.json's own gate — format:check, then turbo lint /
# typecheck / test / build. Calling it (rather than re-listing its parts) keeps
# this file from drifting out of step with the script CI actually invokes.
gate: install
    bun run gate
    just vuln
    just sast

# Restore node_modules from the lockfile, exactly as CI does.
# --frozen-lockfile FAILS on a drifted lock instead of silently updating it.
[doc('Restore node_modules from the lockfile, exactly as CI does')]
install:
    bun install --frozen-lockfile

[doc('Lint all packages')]
lint:
    turbo run lint

[doc('Typecheck all packages')]
typecheck:
    turbo run typecheck

[doc('Run the test suite')]
test *ARGS:
    turbo run test {{ARGS}}

[doc('Build all packages')]
build:
    turbo run build

# Rewrite files in place (gate runs the check-only half)
fmt:
    bun run format

# Known-vulnerability scan.
# CI gates at high; some advisories are deferred by policy — see the workflow.
[doc('Scan dependencies for high-severity advisories')]
vuln:
    bun audit --audit-level=high

# Static analysis, scoped taint rules
sast:
    LANG=C.UTF-8 LC_ALL=C.UTF-8 opengrep scan --config rules/sast --error .

# Dev server with HMR — the fast path here is the bundler, not a container
dev *ARGS:
    turbo run dev {{ARGS}}

# Build the container exactly as CI does — catches Dockerfile drift `check` cannot
image:
    DOCKER_BUILDKIT=1 docker build --pull -t {{star}}:dev .

[doc('Remove node_modules, .turbo and dist trees')]
clean:
    rm -rf node_modules .turbo
    find . -name dist -type d -prune -exec rm -rf {} +

# Regenerate CHANGELOG.md from the commit log.
#
# The file is DERIVED — never hand-edit it. git-cliff buckets by git tag, so an
# untagged repo renders one [Unreleased] section; `just release` seeds the tag.
# uvx rather than this ecosystem's own runner, deliberately: one pinned
# generator fleet-wide, so a rust star and a python star cannot drift into
# emitting different formats. git-cliff ships wheels, so nothing compiles.
[doc('Regenerate CHANGELOG.md from the commit log')]
changelog:
    uvx git-cliff@2.13.1 --config cliff.toml -o CHANGELOG.md

# Compute the next semver from the commit types, tag it, and regenerate.
#
# feat -> MINOR, fix -> PATCH, `!` or BREAKING CHANGE -> MAJOR. Prints the tag
# without creating it unless you pass EXECUTE=1, because a pushed tag is not
# something to discover you did by accident.
[doc('Compute + apply the next semver tag, then regenerate the changelog')]
release EXECUTE="0":
    #!/usr/bin/env bash
    set -euo pipefail
    next="$(uvx git-cliff@2.13.1 --config cliff.toml --bumped-version)"
    echo "next version: ${next}"
    if [[ "{{EXECUTE}}" != "1" ]]; then
        echo "dry run — re-run with EXECUTE=1 to tag"
        exit 0
    fi
    uvx git-cliff@2.13.1 --config cliff.toml --bump -o CHANGELOG.md
    git tag -a "${next}" -m "${next}"
    echo "tagged ${next} — push it with: git push origin ${next}"

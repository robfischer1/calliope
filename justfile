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

# Compute the next semver, write it into the version literal, and regenerate.
#
# feat -> MINOR, fix -> PATCH, `!` or BREAKING CHANGE -> MAJOR (MINOR below 1.0).
# Prints what it would do unless you pass 1.
#
# THIS DOES NOT TAG, and that is the fix. The version LITERAL is authority: the
# package published from this repo carries it, and the ourea door mints
# refs/tags/vX.Y.Z FROM it when the landing merges. This recipe used to run
# `git tag -a` without touching package.json, which names a new version while
# shipping the previous one — and hand-made version tags are forbidden
# fleet-wide for that reason.
#
# Written with sed on the FIRST "version" key rather than a JSON rewrite: the
# manifest is hand-maintained and formatted, and piping it through a JSON tool
# reformats every line, burying a one-field release in a whole-file diff.
#
# INVOKE AS `just release 1`, NOT `just release EXECUTE=1`. The second form
# looks like it sets the parameter and does not: just reads `NAME=value` as a
# variable assignment, so the RECIPE PARAMETER keeps its "0" default and the
# run silently dry-runs. That was the old recipe's own advice and it is why
# this was never run — the documented invocation could not work.
[doc('Compute the next semver, write it to package.json, regenerate the changelog')]
release EXECUTE="0":
    #!/usr/bin/env bash
    set -euo pipefail
    next="$(uvx git-cliff@2.13.1 --config cliff.toml --bumped-version)"
    bare="${next#v}"
    echo "next version: ${next}  (literal: package.json version)"
    if [[ "{{EXECUTE}}" != "1" ]]; then
        echo "dry run — re-run as \`just release 1\` to write the literal + changelog"
        exit 0
    fi
    sed -i -E '0,/^([[:space:]]*)"version":[[:space:]]*"[^"]+"/s//\1"version": "'"${bare}"'"/' package.json
    grep -qE "^[[:space:]]*\"version\": \"${bare}\"" package.json \
        || { echo "literal write failed in package.json" >&2; exit 1; }
    uvx git-cliff@2.13.1 --config cliff.toml --bump -o CHANGELOG.md
    echo "wrote ${bare} to package.json, regenerated CHANGELOG.md"
    echo "land it as: chore(release): ${bare} — the door mints ${next} when it merges"

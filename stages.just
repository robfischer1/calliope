# THE TWO STAGES A COMMIT AND A PUSH MUST PASS (CA master-plan F15), as the
# recipes the tracked hooks call: hooks/pre-commit is `just check`, hooks/pre-push
# is `just gate`. The hook never changes; what a commit must pass is a recipe —
# the same recipe a session runs by hand.
#
# RENDERED BY THE SPEC-KIT OVERRIDE TEMPLATE (foundry-stocks, speckit/), tracked,
# re-laid at every session start: one home for the call across the fleet, so a
# change to what a commit must pass is one template landing. The star's own
# justfile takes it with `import 'stages.just'` and defines no `check` or `gate`
# of its own. Edit it in foundry-stocks, never here.
#
# THE ENGINE IS A DEPENDENCY, DELIBERATELY. The stages run on the cluster's Dagger
# engine, so a commit needs the cluster — which is where the git origin already
# lives (Rob, 2026-09-17: "Shit, our git origin is already in the cluster"). An
# engine that cannot be reached refuses the commit rather than waving it
# through: a check that could not run is not a check that passed. NO SKIP LIST
# AND NO --no-verify: this is the gate the door runs, so a commit that cannot
# pass it here cannot pass it there either.
#
# THE COMMIT STAGE is the basic checks every tree gets, beside the language
# checks for what this tree contains — format, lint, unit tests — planned before
# anything runs and settled on the worst of them. THE PUSH STAGE is the slow
# checks in sequence, cheapest first — deep lint, the known-vulnerability scan,
# the release build the image will carry, the race + live-database suite —
# stopping at the first that finds something, with the mutation gate beside
# them. Its base is the merge base with origin/main, and only the atoms that
# grade a CHANGE read it; a repo with no origin/main yet (a fresh birth) is
# gated without one.
#
# THE ORIGIN RIDES WITH THE BASE, so a push from a linked worktree has the
# base's history (CA F16; Rob, 2026-09-19: "let dagger grab the tree"). A
# worktree's .git is a pointer into the primary that means nothing inside the
# engine, and the diff-scoped atoms stood down on it — go:mutation answered 0
# with "no usable PR base sha" on the hook while the door's Job found 244
# missed mutants on the same sha (terpsichore 1c28f38, foundry-tools#10253).
# Named the origin, the ENGINE fetches the base commit's repository from the
# door and commits the snapshot on top, so the hook grades the same change set
# the door does (foundry-tools run.gitReadyOn).

# The module that carries the stages. CA_MODULE overrides it for a session
# gating a foundry-tools change against itself (`CA_MODULE=/path/to/checkout`).
ca_module := env("CA_MODULE", "git.notusmi.com/rob/foundry-tools@main")

# `--source=.` IS THE WHOLE POINT, NOT A NICETY. The module declares its
# Source with `+defaultPath="."`, and for a module loaded from git that
# default is the MODULE'S OWN checkout — GitRef.tree of foundry-tools at the
# ref, shallow — not the tree the hook runs in. MEASURED 2026-09-18 (dagger
# v0.21.9): without it, `just gate` in a TypeScript star ran the Go lanes,
# reported "no package.json at the repository root", and the witness could
# not run because the star's merge base was "not in this history" — foundry-
# tools' history. Every star's stage read green against the wrong tree.
# `--source=.` hands the function this checkout, with the module's ignore
# patterns applied and `.git` as the working tree carries it.

# The commit stage, on the engine — what hooks/pre-commit runs.
check:
    dagger call -m "{{ca_module}}" --source=. check exit

# The push stage, on the engine — what hooks/pre-push runs.
gate:
    #!/bin/sh
    set -eu
    base=$(git merge-base origin/main HEAD 2>/dev/null || true)
    if [ -n "$base" ]; then
        exec dagger call -m "{{ca_module}}" --source=. push --base="$base" --origin="$(git remote get-url origin)" exit
    fi
    exec dagger call -m "{{ca_module}}" --source=. push exit

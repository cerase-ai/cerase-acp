#!/usr/bin/env bash
#
# No document names a command, file or path that does not exist.
#
# This is not hygiene, it is the gate: the PoC is not done while a doc
# tells the next person to run something that no longer exists. A
# document can teach a removed verb for months, or point at a path that
# moved to a sibling repo, and nothing else notices.
# `tests/unit/docs_parity.bats` guarded the CLI's own verbs; this generalises the
# same idea to every tracked markdown file, and — being a plain script with no
# bats and no PHP — runs unchanged in each of the eight repos' CI.
#
# It checks two things and deliberately no more:
#
#   1. Verbs. Every `./cli.sh <verb>`, `./cerase-tenant.sh <verb>` and
#      `./mgmt.sh <verb>` named in prose must be dispatched by that script —
#      but only when that script lives in THIS repo. A doc in cerase-core that
#      mentions `./cerase-tenant.sh provision` is describing a sibling tool, and
#      a guard that fails on it would be a guard that punishes cross-referencing.
#   2. Paths. Every repo-relative path in a markdown link `](…)` or in
#      backticks must resolve. Backticked paths are checked only when they carry
#      a file extension or start with a directory this repo actually has, because
#      backticks also hold shell fragments, env vars and JSON keys.
#
# What it deliberately does NOT do: follow URLs, check anchors, or read prose for
# meaning. A guard that is 90% right and silent about the rest is worth more than
# one nobody can keep green.
#
# Usage:  scripts/docs-parity.sh [--quiet]
# Exit:   0 clean · 1 something named does not exist

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; DIM=$'\033[2m'; NC=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; DIM=""; NC=""; }

failures=0
checked_files=0

# Tracked markdown only. An untracked scratch file is not documentation, and a
# vendored dependency's README is not ours to keep true.
mapfile -t DOCS < <(git ls-files '*.md' 2>/dev/null | grep -v '^vendor/' || true)

if [ ${#DOCS[@]} -eq 0 ]; then
    echo "no tracked markdown in $ROOT — nothing to check"
    exit 0
fi

# ── directories that make a backticked string look like a path ──────────────
mapfile -t TOP_DIRS < <(git ls-files | awk -F/ 'NF>1{print $1}' | sort -u)

_looks_like_path() {
    local candidate="$1" dir
    # A path has a SLASH. Without this the guard flags `agents.yaml`,
    # `AGENTS.md`, `SKILL.md` and `opencode.json` — generic filenames prose
    # legitimately uses as nouns, not as locations. A guard with that many
    # false positives is a guard somebody turns off.
    [[ "$candidate" == */* ]] || return 1
    # Placeholders and globs are not paths: `slot-N/`, `<customer>/values.yaml`,
    # `docs/operator/{telegram,slack}-setup.md`.
    [[ "$candidate" == *'<'* || "$candidate" == *'>'* ]] && return 1
    [[ "$candidate" == *'{'* || "$candidate" == *'}'* ]] && return 1
    # A path inside a CONTAINER, which this repo cannot be asked to resolve.
    [[ "$candidate" == /* ]] && return 1
    # `file.sh::function` is a reference to a function, not to a file.
    [[ "$candidate" == *'::'* ]] && return 1
    # A HOME path (`~/.docker/config.json`) belongs to whoever is reading.
    [[ "$candidate" == '~'* ]] && return 1
    # `docker/metadata-action@v5` is an action reference, not a directory.
    [[ "$candidate" == *'@'* ]] && return 1
    # `KEY=/some/path` is an env assignment quoted whole.
    [[ "$candidate" == *'='* ]] && return 1

    # A LINE reference — `file.py:67`, `file.md:200-272` — names a real file and
    # a position in it. Check the file; the position is not ours to verify.
    candidate="${candidate%%:*}"

    # Placeholder segments. `slot-N`, `NN-foo.sh`, `tech-audit-YYYY-MM-DD.md`
    # and `foo.sh` are conventions being TAUGHT, and a guard that demands they
    # exist is a guard that forbids writing documentation about naming.
    case "$candidate" in
        *-N/*|*-N|*/N/*|*NN-*|*YYYY*|*MM-DD*|*foo*|*bar*|*baz*) return 1 ;;
    esac

    # An extension we would expect a file to carry.
    [[ "$candidate" =~ \.(md|sh|php|py|ts|js|json|yml|yaml|tf|tftpl|bats|neon|lock|toml|conf|env)$ ]] && return 0
    # Or a prefix that is a real directory here.
    for dir in "${TOP_DIRS[@]}"; do
        [[ "$candidate" == "$dir/"* ]] && return 0
    done
    return 1
}

# Every tracked path, once, plus every directory prefix implied by one.
#
# Resolution is against the TRACKED SET, never against the working
# filesystem. `[ -e ]` finds untracked runtime state on a developer's
# machine (`agent-runtime/bridge/agents.yaml` is generated at boot) and
# sibling repos that CI does not have — a guard green on a laptop and red
# on the runner. Reading only what git tracks makes the two identical,
# which is the whole point of a guard.
#
# An associative array, not a string with `grep` per candidate. The string
# version was O(files × candidates) and took 52 seconds locally — enough
# to push the CI unit job past its 10-minute cap, so the whole publish
# came back as "cancelled", which reads like somebody hit a button. A
# guard that costs a publish is a guard people remove.
declare -A TRACKED_SET=()
while IFS= read -r path; do
    # Every directory prefix, so `docs/privacy` resolves as well as the files in it.
    d="$path"
    while :; do
        TRACKED_SET["$d"]=1
        [[ "$d" == */* ]] || break
        d="${d%/*}"
    done
    # And every trailing SUFFIX, which is what makes app-relative names work:
    # `architecture.md` says `routes/console.php` and
    # `docs/conventions/filament-render-tests.md`, both correct inside the Laravel
    # app and wrong from the repo root. Dropping this silently produces 44
    # false "missing" hits — the suffix match is what resolves them.
    d="$path"
    while [[ "$d" == */* ]]; do
        d="${d#*/}"
        # Each suffix AND each of ITS directory prefixes, so `tests/Browser/`
        # resolves as a directory the same way `tests/Browser/X.php` resolves as
        # a file. Suffix-without-prefixes left exactly one hit behind.
        p2="$d"
        while :; do
            TRACKED_SET["$p2"]=1
            [[ "$p2" == */* ]] || break
            p2="${p2%/*}"
        done
    done
done < <(git ls-files)

_resolves() {   # <target> <document's dir>
    local target="${1%%:*}" base="$2"
    target="${target%/}"

    # Joined in bash rather than by shelling out to realpath: this runs once per
    # backticked string in every document, and a process each was most of the 52
    # seconds.
    local joined="$target"
    if [ "$base" != "." ]; then
        joined="$base/$target"
        while [[ "$joined" == *"/./"* ]]; do joined="${joined//\/.\//\/}"; done
        while [[ "$joined" =~ ([^/]+)/\.\./ ]]; do
            joined="${joined/${BASH_REMATCH[1]}\/..\//}"
        done
    fi

    # Three readings, all legitimate in prose: as written, relative to the
    # DOCUMENT, and relative to the REPO ROOT with a leading `./` — which is how
    # every page writes `./run-tests.sh` from inside docs/.
    local candidate
    for candidate in "$target" "$joined" "${target#./}"; do
        [ -n "$candidate" ] || continue
        [ -n "${TRACKED_SET[$candidate]:-}" ] && return 0
    done

    # A SIBLING REPO's path is always accepted, and NOT conditionally on the
    # sibling being checked out next door. Checking for the sibling's presence
    # passes on a developer's machine — where all eight repos sit side by
    # side — then fails in CI, which clones ONE repo.
    #
    # The rule the guard can honestly enforce is "does THIS repo name something
    # that does not exist HERE". A `cerase-<repo>/…` path is by construction not
    # here, and a repo that fails its own CI over a sibling's contents is a repo
    # whose CI depends on a checkout it does not control. The cost is stated
    # plainly: a stale cross-repo path is not caught by this guard, by anyone.
    case "$target" in
        # Written as a repo name, or reached with `../` from inside one.
        cerase-*/*|../cerase-*/*|../*/*) return 0 ;;
    esac

    return 1
}

# ── 1. verbs ────────────────────────────────────────────────────────────────
_verbs_of() {   # <script path>
    # The dispatch allowlist, which is the same source `docs_parity.bats` reads.
    # Leading DIGITS too: run-tests.sh dispatches `1|u|U|unit)`, and a pattern
    # that only accepted letters read its allowlist as empty — which made every
    # documented tier look like an unknown verb. Ten of the first sweep's hits.
    grep -oE '^[[:space:]]+[a-zA-Z0-9][a-zA-Z0-9|:_-]*\)' "$1" 2>/dev/null \
        | tr -d ' )' | tr '|' '\n' | sed 's/^ *//' | sort -u
}

_check_verbs() {   # <tool name> <script path>
    local tool="$1" script="$2"

    # Not in this repo: the docs are referring to a sibling tool, and saying so
    # is exactly what the workspace wants them to do.
    [ -f "$script" ] || return 0

    local known; known="$(_verbs_of "$script")"
    [ -n "$known" ] || return 0

    local doc verb
    for doc in "${DOCS[@]}"; do
        # docs/internal/ holds DATED audit snapshots — history, which
        # legitimately records the commands that existed on the day it was
        # written. Same carve-out docs_parity.bats already makes.
        [[ "$doc" == docs/internal/* ]] && continue
        [[ "$doc" == devplan/* ]] && continue

        while read -r verb; do
            [ -n "$verb" ] || continue
            grep -qx -- "$verb" <<<"$known" && continue
            echo "${RED}✗${NC} $doc: \`./$tool $verb\` — $tool has no such subcommand"
            failures=$((failures + 1))
        done < <(grep -oE "\./${tool//./\\.} [a-z][a-z-]*" "$doc" 2>/dev/null | awk '{print $2}' | sort -u)
    done
}

# ── 2. paths ────────────────────────────────────────────────────────────────
_check_paths() {
    local doc line target base
    for doc in "${DOCS[@]}"; do
        # Same carve-out the verb pass makes, for the same reason: docs/internal/
        # holds DATED audit snapshots, and an audit that names the screenshots it
        # was written from is a correct record of that day even after the
        # screenshots are gone. devplan/ is a work log, not documentation.
        [[ "$doc" == docs/internal/* ]] && continue
        [[ "$doc" == devplan/* ]] && continue

        # An explicit, VISIBLE opt-out for a document that describes ANOTHER
        # project's tree — an evaluation of a third-party gateway, a note about
        # a skill's own layout. Those paths are correct and this repo cannot
        # resolve them. The marker lives in the document rather than in a list
        # inside this script, so the reason travels with the file and a future
        # reader sees why the guard is quiet about it.
        grep -q '<!-- docs-parity: external' "$doc" && continue

        # A SCOPED opt-out, for the handful of strings that look like paths and
        # are not: an illustrative filename a convention is being taught with, a
        # GitHub Action reference. One line per string, with its reason next to
        # it, so nothing is quietly exempt.
        local -a ignores=()
        mapfile -t ignores < <(grep -oE '<!-- docs-parity: ignore [^ ]+' "$doc" | awk '{print $4}')

        base="$(dirname "$doc")"

        {
            # Markdown links, minus URLs, anchors and mailto.
            grep -oE '\]\([^)]+\)' "$doc" 2>/dev/null | sed 's/^](//; s/)$//'
            # Backticked strings that look like paths.
            grep -oE '`[^`]+`' "$doc" 2>/dev/null | tr -d '`'
        } | while read -r target; do
            [ -n "$target" ] || continue
            case "$target" in
                http*|mailto:*|\#*|'<'*|*' '*|*'$'*|*'*'*) continue ;;
            esac
            target="${target%%#*}"
            [ -n "$target" ] || continue

            _looks_like_path "$target" || continue

            _resolves "$target" "$base" && continue

            local ign skip=false
            for ign in "${ignores[@]}"; do
                [ "$target" = "$ign" ] && { skip=true; break; }
            done
            $skip && continue

            echo "MISSING|$doc|$target"
        done
    done
}

# ── run ─────────────────────────────────────────────────────────────────────
$QUIET || echo "${DIM}docs-parity: ${#DOCS[@]} tracked markdown file(s) in $(basename "$ROOT")${NC}"

_check_verbs "cli.sh" "$ROOT/cli.sh"
_check_verbs "cerase-tenant.sh" "$ROOT/cerase-tenant.sh"
_check_verbs "mgmt.sh" "$ROOT/deploy/mgmt.sh"
_check_verbs "run-tests.sh" "$ROOT/run-tests.sh"

# The path pass runs in a subshell per document (the `while` after a pipe), so
# its failures are counted from its output rather than from the variable — the
# classic bash trap, and the reason this is not a plain counter increment.
while IFS='|' read -r _ doc target; do
    [ -n "${target:-}" ] || continue
    echo "${RED}✗${NC} $doc: \`$target\` does not exist"
    failures=$((failures + 1))
done < <(_check_paths | grep '^MISSING|' || true)

checked_files=${#DOCS[@]}

if [ "$failures" -eq 0 ]; then
    $QUIET || echo "${GREEN}✓${NC} docs-parity: $checked_files file(s), nothing named that does not exist"
    exit 0
fi

echo ""
echo "${RED}docs-parity: $failures reference(s) point at something that does not exist${NC}"
echo "${DIM}Fix the document or restore the thing — a doc that names a missing file is how"
echo "the next person loses an afternoon.${NC}"
exit 1

#!/usr/bin/env bash
#
# A0 step 4 · G2 + G3 — what makes the secrets architecture permanent rather
# than a tidy-up somebody did once.
#
# ── G2: no credential file inside any checkout ──
#
# The defect it exists for was real and sat in a working tree for weeks: a
# `.env.guidance-ops.bak` holding twenty-two live credentials, including the
# only ops-side copy of a backup passphrase. `.gitignore` kept it out of git and
# nothing kept it out of the DIRECTORY, which is where a backup of the checkout,
# an editor's remote sync or a `docker build` context finds it.
#
# ── G3: no retired credential name survives ──
#
# This is what makes a HARD cutover safe. `_load_env_file` dies on an old
# spelling at RUNTIME, on one machine, when somebody happens to run something.
# This fails in CI, in every repo, on the commit that introduced it. Without it
# the cutover is a state the tree drifts out of the first time somebody copies a
# line from an old document.
#
# The rename list is DATA (`scripts/_secret_renames.sh`) and this reads it.
# A guard carrying its own copy of the list is a second list, and the two would
# disagree exactly when it mattered.
#
# `devplan/` is excluded from G3, deliberately: it holds the rename table
# itself and the historical record of why each name changed. A guard that
# forced the devplan to stop naming the old spellings would delete the
# reasoning for the very change it enforces.
#
# Usage:  scripts/secrets-guard.sh [--quiet]
# Exit:   0 clean · 1 a finding
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; DIM=$'\033[2m'; NC=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; DIM=""; NC=""; }

findings=0
# No BACKTICKS in any message passed here. Inside a double-quoted string a
# backtick is command substitution, so `.env` in a finding does not print a
# file name — it tries to RUN one. Two of the three G2 rules shipped broken
# that way and printed "command not found" instead of the defect they had
# found.
_fail() { echo "${RED}✗${NC} $1"; findings=$((findings + 1)); }

# ── G2 ────────────────────────────────────────────────────────────
#
# Three rules, not one, because "no credential file in a checkout" is false in
# `cerase-core`: that checkout IS the appliance — `assemble.sh` derives the
# shipped payload from `git ls-files`, so tracked means shipped and UNTRACKED
# means the machine's own state. `/opt/cerase/.env` is state and belongs there.
# A guard that reds on it is a guard an operator turns off, and then rule 1
# stops protecting anything either.
#
#   1. TRACKED credential file            → red everywhere. This is a leak into
#                                           git history, and history is forever.
#   2. an UNMANAGED copy of one       → red everywhere. The original defect:
#                                           `.env.guidance-ops.bak`, twenty-two
#                                           live credentials, the only ops-side
#                                           copy of a backup passphrase, sat in a
#                                           working tree for weeks.
#   3. a NAMED variant (.env.something) → red everywhere. `.env` itself is the
#                                           universal convention for local dev
#                                           state in every repo here; a named
#                                           variant is somebody's private copy.
#
# Rule 3 was first written as "untracked credential file, in a tool repo
# only", with a tool/machine discriminator that GUESSED from the presence of
# `cli.sh`. It reddened `cerase-dash` and `cerase-marketplace` — two Laravel
# apps whose local `.env` is ordinary developer state — and a guard that reds
# on normal work is a guard somebody switches off, after which rules 1 and 2
# stop protecting anything either. The name is the honest signal: a plain
# `.env` is ordinary local state, and no convention here produces a named
# variant like `.env.guidance-ops`.

# 1 — tracked.
while IFS= read -r f; do
    case "${f##*/}" in *.example|*.example.*) continue ;; esac
    _fail "credential file COMMITTED to git: ${f}
     Git history is forever. Remove it from the index, rotate whatever it held, and
     put the value in ~/.cerase-ops/ (0600)."
done < <(git ls-files -- '*.env' '.env' '.env.*' 2>/dev/null)

# 2 — unmanaged copies, tracked or not, in any repo.
while IFS= read -r f; do
    case "$f" in ./.git/*|./vendor/*|./node_modules/*) continue ;; esac
    _fail "UNMANAGED copy of a credential file: ${f#./}
     This is the defect the milestone opened on: a .bak of an env file, holding live
     credentials, ignored by git and therefore invisible — and still read by a tree
     backup, an editor sync or a docker build context.
     A copy taken by the TOOL is fine and is not flagged: the .bak-secret-<stamp>
     pattern is what _secrets.sh prunes. This one nothing prunes.
     Delete it, or move it to ~/.cerase-ops/retired/."
done < <(find . -type f \( -name '.env.*bak' -o -name '*.env.bak' -o -name '.env.save' \
                          -o -name '.env.old' -o -name '*.env.old' -o -name '.env.*.orig' \) 2>/dev/null)

# 3 — a named variant, anywhere.
while IFS= read -r f; do
    case "${f##*/}" in
        .env|.env.example|*.example|*.example.*) continue ;;
        # The tool's own pruned backups of `.env`, rule 2's exception.
        .env.bak-secret-*) continue ;;
    esac
    case "$f" in ./.git/*|./vendor/*|./node_modules/*|./.terraform/*|*/tests/*|*/test/*) continue ;; esac
    _fail "named credential variant in the checkout: ${f#./}
     A plain .env is ordinary local state; a named variant is a private copy nothing
     manages. The one this milestone opened on was .env.guidance-ops — twenty-two live
     credentials in a working tree for weeks, invisible because git ignored it.
     Move it to ~/.cerase-ops/ (0600)."
done < <(find . -type f -name '.env.*' 2>/dev/null)

# ── G3 ────────────────────────────────────────────────────────────
RENAMES=""
for cand in "$ROOT/scripts/_secret_renames.sh" "$ROOT/../cerase-core/scripts/_secret_renames.sh"; do
    [ -r "$cand" ] && { RENAMES="$cand"; break; }
done

if [ -z "$RENAMES" ]; then
    # NOT a silent pass. A guard that cannot find its input and reports
    # success is the shape this whole class of bug takes.
    _fail "no scripts/_secret_renames.sh reachable — G3 could not run, and that is a finding, not a pass."
else
    # shellcheck source=scripts/_secret_renames.sh
    . "$RENAMES"

    while IFS= read -r old; do
        [ -n "$old" ] || continue
        # USES, not mentions: a retired name matters when something ASSIGNS
        # or READS it, and a document explaining what was renamed has to be
        # able to say what was renamed.
        #
        # Two passes rather than one clever pattern: `git grep` finds every
        # candidate (its matcher is the same everywhere CI runs, unlike the
        # `grep` these machines resolve to), then a plain ERE keeps only the
        # shapes that are a use —
        #
        #   NAME=            an assignment, in a script or a .env
        #   $NAME  ${NAME    a read
        #   'NAME' "NAME"    a name handed to something, as in PASSTHROUGH_ENV
        #
        # A backticked name in a sentence is none of those.
        # `tests/` excluded, and NOT because it is inconvenient. Several
        # tests must name a retired spelling precisely BECAUSE it is retired —
        # the one proving the converge renames it writes the old name into a
        # fixture on purpose. And a test that genuinely still READ an old name
        # would fail on its own, at runtime: `_load_env_file` dies on one. The
        # runtime covers what this exclusion gives up.
        # One use this rule cannot forbid: reading a retired name out of a
        # file written before the rename. `cerase-ops` opens historical copies
        # of an appliance's `.env` under ~/.cerase-ops/appliance-env-backups/ to
        # recover the passphrase for a pre-cutover archive. Those files are
        # RECORDS of what a box held then; `_converge_secret_names` migrates the
        # live `.env` and can do nothing about an artefact. Reading both
        # spellings is the only way to open an old backup, and forbidding it
        # would trade a naming rule for unreadable archives.
        #
        # An explicit MARKER, in the eight lines above the use, never an
        # inference from context — the same choice `a0-g4-allow` makes in
        # cerase-ops, and for the same reason: a rule nobody can predict is a
        # rule that gets worked around. The marker asserts nothing about the
        # LIVE path, which `_load_env_file` still kills on sight.
        hits="$(git grep -n "$old" -- . ':!devplan' ':!tests' ':!scripts/_secret_renames.sh' 2>/dev/null \
                | grep -E "(^|[^A-Za-z0-9_])${old}=|[$]\{?${old}([^A-Za-z0-9_]|$)|['\"]${old}['\"]" \
                | while IFS= read -r hit; do
                    hf="${hit%%:*}"; rest="${hit#*:}"; hl="${rest%%:*}"
                    awk -v n="$hl" 'NR>=n-8 && NR<=n' "$ROOT/$hf" 2>/dev/null \
                      | grep -q 'secrets-guard-allow-retired-read' && continue
                    printf '%s\n' "$hit"
                  done | head -5)"
        [ -n "$hits" ] || continue
        _fail "retired credential name still IN USE: ${old} → $(_cerase_rename_for "$old")
$(printf '     %s\n' "$hits")"
    done < <(_cerase_rename_old_names)
fi

if [ "$findings" -eq 0 ]; then
    $QUIET || echo "${GREEN}✓${NC} secrets guard: no credential file in the tree, no retired name in use"
    exit 0
fi

echo ""
echo "${DIM}A0 · M-SECRETS-ARCHITECTURE-1 — the rename list is scripts/_secret_renames.sh.${NC}"
exit 1

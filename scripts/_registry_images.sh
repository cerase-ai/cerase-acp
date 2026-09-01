# shellcheck shell=bash
#
# What a repo publishes, and under which tag — derived from the repo itself.
#
# ── Why this is its own file ──
#
# The pre-push hook asks whether the PREVIOUS commit ever became an image,
# because a red CI does not publish and nothing else says so. It is installed in
# all seven repos. It was reading these functions out of
# `scripts/_registry_check.sh`, which exists in `cerase-core` and nowhere else,
# so in the six repos where the question matters the hook sourced nothing and
# exited quietly -- including `cerase-ops`, whose stopped publish is the reason
# the hook was written. A check that reports nothing is indistinguishable from a
# check that passed, which is the defect this whole line of work is about.
#
# The alternative was to inline the derivation into the hook body. That would be
# a second copy of the rules, in a file `.git/hooks` does not track, free to
# drift from the one CI actually uses. So the shared shape is extracted here and
# vendored, and `_registry_check.sh` sources it like everybody else.
#
# ── Nothing here is specific to one repo ──
#
# Every function takes the repo directory and reads that repo's own
# `.github/workflows/docker-publish.yml`. There is no map of repo to images to
# keep in step, deliberately: a hand-maintained map goes stale silently, and the
# workflow is the file that decides the answer anyway.

# Every image a repo publishes, one per line.
#
# The four repos declare them in three different shapes, so this reads all
# three rather than carrying a hand-maintained map that goes stale silently:
#   - matrix entries      `- image: cerase-control-plane`   (core, gateway)
#   - a workflow env var  `IMAGE_NAME: ${{ … }}/cerase-acp` (acp, agent)
#   - an inline metadata  `images: ${{ … }}/cerase-marketplace` (marketplace)
# Emits nothing when it cannot tell — the caller treats that as a reason to
# report, never as a pass.
_registry_images_for() {
    local repo_dir="$1"
    local wf="$repo_dir/.github/workflows/docker-publish.yml"
    [[ -f "$wf" ]] || return 0
    {
        sed -n 's/^[[:space:]]*-[[:space:]]*image:[[:space:]]*\([A-Za-z0-9._-]\+\).*/\1/p' "$wf"
        sed -n 's/^[[:space:]]*IMAGE_NAME:.*\/\([A-Za-z0-9._-]\+\)[[:space:]]*$/\1/p' "$wf"
        # `images:` lines that name a literal image, not a matrix reference.
        #
        # `|| true` on the filter, and it is load-bearing rather than tidy: a
        # workflow whose images: lines are ALL matrix references leaves this
        # grep with no match, so under `pipefail` the branch fails and takes the
        # whole group with it. The other two branches had already resolved nine
        # names by then, and the function returned them WITH a failing status —
        # so every caller running `set -e` threw them away and reported an
        # unrecognised shape. It was the two matrix repos and only those.
        { grep -E '^[[:space:]]*images:' "$wf" || true; } \
            | { grep -v 'matrix\.' || true; } \
            | sed -n 's/.*\/\([A-Za-z0-9._-]\+\)[[:space:]]*$/\1/p'
    } 2>/dev/null | sed '/^$/d' | sort -u
    # Output is the answer; status says whether the question could be asked, and
    # here it always could.
    return 0
}

# HEAD abbreviated the way the TAG is, not the way git feels like.
#
# docker/metadata-action's `type=sha,format=short` emits a fixed SEVEN
# characters. `git rev-parse --short` honours core.abbrev and lengthens on
# ambiguity — on this repo it already returns eight — so using it asked GHCR
# about a tag that can never exist and reported a successful publish as "CI
# never published". Caught by running the command for real against a push whose
# workflow had just gone green; the offline tests could not see it.
_registry_sha_for() {
    local repo_dir="$1"
    local wf="$repo_dir/.github/workflows/docker-publish.yml"
    if [[ -f "$wf" ]] && grep -q 'type=sha[^[:space:]]*format=long' "$wf"; then
        git -C "$repo_dir" rev-parse HEAD 2>/dev/null
        return
    fi
    git -C "$repo_dir" rev-parse --short=7 HEAD 2>/dev/null
}

# The ignore patterns a publish workflow declares, one per line, verbatim.
#
# Verbatim is the whole point. This parser used to keep only the literal head of
# each pattern, cutting it at the first star, so a subtree filter survived as a
# directory prefix and a filter that begins with a wildcard survived as the
# empty string. An empty entry excuses no path, so a two-pattern filter behaved
# like a one-directory filter and a README outside that directory was judged
# publishable. The matcher below is what reads the glob, and it needs the glob.
_registry_ignored_patterns() {
    local wf="$1" pat
    [[ -f "$wf" ]] || return 0
    while IFS= read -r pat; do
        # A YAML scalar here never contains a space, so cutting at the first one
        # drops trailing whitespace and any inline comment in a single step.
        pat="${pat%%[[:space:]]*}"
        pat="${pat#\'}"; pat="${pat%\'}"
        pat="${pat#\"}"; pat="${pat%\"}"
        [[ -n "$pat" ]] && printf '%s\n' "$pat"
    done < <(
        sed -n '/paths-ignore:/,/^[[:space:]]*[a-z_]*:[[:space:]]*$/p' "$wf" \
            | sed -n 's/^[[:space:]]*-[[:space:]]*//p'
    )
    return 0
}

# 0 when one repository path is covered by one workflow filter pattern.
#
# GitHub Actions and bash agree on almost all of this: a star already crosses a
# slash inside a bash pattern match, so a subtree filter needs no rewriting. The
# one place they differ is a leading doubled-star segment, which GitHub lets
# stand for NO directory at all -- so a filter written for markdown anywhere has
# to cover a README sitting at the repository root, and bash on its own would
# demand a slash. The extglob optional-group form expresses exactly that, and
# the previous extglob setting is restored because this is sourced into a
# pre-push hook and into the CLI, neither of which asked for it.
#
# An empty pattern matches nothing. A parser that loses a pattern therefore
# leaves a path unexcused and the check reds, which is the safe direction: the
# opposite would silence a real missing publish.
_registry_path_matches() {
    local pat="$1" path="$2"
    [[ -n "$pat" && -n "$path" ]] || return 1
    local any_dirs='?(*/)'
    pat="${pat//'**/'/$any_dirs}"
    local had_extglob=1
    shopt -q extglob || had_extglob=0
    shopt -s extglob
    local rc=1
    # shellcheck disable=SC2053  # the right side is a glob on purpose.
    [[ "$path" == $pat ]] && rc=0
    [[ "$had_extglob" -eq 1 ]] || shopt -u extglob
    return "$rc"
}

# 0 when HEAD changed nothing the publish workflow cares about.
#
# The workflows exclude documentation and plan paths from the publish job, so a
# push touching only those does not run it and NO image carries that sha --
# legitimately. Without this, the very next plan commit would be reported as
# "CI never published", and a check that cries wolf gets ignored, which is how
# the original defect survived.
#
# Scoped to HEAD's own diff. A multi-commit push whose head commit is
# documentation may still have published (an earlier commit in the range touched
# code), so this only suppresses the RED -- it never asserts an image must be
# absent.
_registry_head_is_ignored_only() {
    local repo_dir="$1"
    # The ref to judge, HEAD by default. The pre-push note asks about the commit
    # ALREADY pushed rather than the one being pushed, so it needs to name it:
    # answering about HEAD there meant judging the wrong commit and warning on
    # every plan-only push.
    local ref="${2:-HEAD}"
    local wf="$repo_dir/.github/workflows/docker-publish.yml"
    [[ -f "$wf" ]] || return 1
    local -a ignored=()
    mapfile -t ignored < <(_registry_ignored_patterns "$wf")
    [[ ${#ignored[@]} -gt 0 ]] || return 1
    local -a changed=()
    mapfile -t changed < <(git -C "$repo_dir" diff --name-only "${ref}~1..${ref}" 2>/dev/null)
    [[ ${#changed[@]} -gt 0 ]] || return 1
    local f pat hit
    for f in "${changed[@]}"; do
        hit=0
        for pat in "${ignored[@]}"; do
            _registry_path_matches "$pat" "$f" && { hit=1; break; }
        done
        [[ "$hit" -eq 1 ]] || return 1
    done
    return 0
}

# The images a ref should have on the registry and does not.
#
# This is the question the pre-push note actually asks, and keeping it here
# rather than in the hook is what makes it testable: the hook backgrounds its
# own work and disowns it, so nothing about it is observable from a test.
#
# Three things have to be true before a name is printed, and each of them was
# once missing:
#
#   - the ref changed something a workflow rebuilds at all, or a plan-only
#     commit reports every image the repo publishes;
#   - the ref's own diff touched that image's build context, or a push that
#     published exactly what it should reports every image it correctly did
#     not rebuild;
#   - the registry ANSWERED, or an outage and an expired credential both read
#     as an image that was never built.
#
# Silence is therefore the normal outcome, and that is the point: a note printed
# on every push is a note nobody reads.
_registry_unpublished_images() {
    local repo_dir="$1" ref="${2:-HEAD}"
    _registry_head_is_ignored_only "$repo_dir" "$ref" && return 0

    local short
    short="$(git -C "$repo_dir" rev-parse --short=7 "$ref" 2>/dev/null)" || return 0

    local image
    while read -r image; do
        [ -n "$image" ] || continue
        [ "$(_registry_package_tag_state "$image" "sha-${short}")" = no ] \
          && printf '%s\n' "$image"
    done < <(_registry_expected_images "$repo_dir" "$ref" 2>/dev/null)
    return 0
}

# The images a ref was EXPECTED to produce, one per line.
#
# A workflow that rebuilds only the contexts a push touched publishes a subset
# on any given push, and every image outside that subset is legitimately absent
# at that sha. Asking about all of them turned an ordinary push into a note
# naming seven images whose contexts nobody had touched, beside two that had
# been built correctly — so the note fired on almost every push and was right on
# almost none.
#
# Under-reports on purpose. CI diffs each image against the commit it was last
# BUILT from, which can be older than this ref's parent, so an image whose
# context this commit did not touch may still have been due. Naming it here
# would be a guess; leaving it out costs a note that `registry-check` gives
# properly. The direction that matters is the other one: nothing is named unless
# this commit's own diff touches its context, and then it was certainly due.
#
# A repo whose workflow declares no per-image context rebuilds everything on
# every push, and there the answer is every image it publishes.
_registry_expected_images() {
    local repo_dir="$1" ref="${2:-HEAD}"
    local -a spec=() changed=()
    mapfile -t spec < <(_registry_image_contexts "$repo_dir")
    if [[ ${#spec[@]} -eq 0 ]]; then
        _registry_images_for "$repo_dir"
        return 0
    fi
    # `diff-tree -r` rather than a `ref~1..ref` range, so a repository's first
    # commit reads as "every file" instead of failing and taking the narrowing
    # with it.
    mapfile -t changed < <(git -C "$repo_dir" diff-tree --no-commit-id --name-only -r "$ref" 2>/dev/null)
    if [[ ${#changed[@]} -eq 0 ]]; then
        # The diff could not be read. Narrowing on an empty list would silence
        # the note for every image at once, which is the failure this whole
        # check exists to remove, so fall back to asking about all of them.
        _registry_images_for "$repo_dir"
        return 0
    fi
    local line image always ctx excl f
    for line in "${spec[@]}"; do
        IFS='|' read -r image always ctx excl <<<"$line"
        [[ -n "$image" ]] || continue
        if [[ "$always" == "true" ]]; then
            printf '%s\n' "$image"
            continue
        fi
        for f in "${changed[@]}"; do
            _registry_path_under "$f" "$ctx" || continue
            [[ -n "$excl" ]] && _registry_path_under "$f" "$excl" && continue
            printf '%s\n' "$image"
            break
        done
    done
    return 0
}

# 0 when a path sits at or under a prefix. A bare `.` is the whole tree.
_registry_path_under() {
    local p="$1" pre="${2%/}"
    [[ -n "$pre" ]] || return 1
    [[ "$pre" == "." ]] && return 0
    [[ "$p" == "$pre" || "$p" == "$pre"/* ]]
}

# `<image>|<always>|<context>|<exclude>` per matrix entry that declares a build
# context, with the leading `./` stripped so the values compare against git
# paths directly.
#
# Only a LITERAL context counts. Every workflow here also carries the build
# step's own `context: ${{ matrix.context }}`, which sits after the last matrix
# entry and would otherwise be read as that entry's path — a template expression
# matches no file, so the last image in the list would silently stop being
# expected. First literal per entry wins, for the same reason in the other
# direction.
#
# An entry marked `always` opts out of filtering: its context is a directory
# assembled during the build and absent from git, so no diff can ever touch it.
_registry_image_contexts() {
    local repo_dir="$1"
    local wf="$repo_dir/.github/workflows/docker-publish.yml"
    [[ -f "$wf" ]] || return 0
    awk '
        function literal(v) { return (v ~ /^[.A-Za-z0-9_\/-]+$/) }
        function flush() {
            if (img != "" && (ctx != "" || always == "true")) {
                sub(/^\.\//, "", ctx); sub(/^\.\//, "", excl)
                print img "|" always "|" ctx "|" excl
            }
            img = ""; ctx = ""; excl = ""; always = ""
        }
        /^[[:space:]]*-[[:space:]]+image:[[:space:]]+/ { flush(); img = $3; next }
        /^[[:space:]]*context:[[:space:]]+/ { if (img != "" && ctx == "" && literal($2)) ctx = $2; next }
        /^[[:space:]]*exclude:[[:space:]]+/ { if (img != "" && literal($2)) excl = $2; next }
        /^[[:space:]]*always:[[:space:]]+/  { if (img != "") { always = $2; gsub(/['"'"'"]/, "", always) } next }
        END { flush() }
    ' "$wf"
    return 0
}

# yes | no | unknown — whether a package carries a tag.
#
# The read and the answer are separate facts. This asked the packages API with
# stderr discarded and piped into a match, so a request that FAILED produced no
# output and read exactly like a tag that is not there: an expired credential,
# a rate limit or an outage all reported the image as unpublished. Only the
# registry's own not-found is an absence; everything else is a question that
# could not be asked, and the caller stays quiet on it.
#
# The window is the hundred most recent versions of the package, which is what
# the caller needs — it asks about a commit pushed minutes ago — and not a
# general answer about the registry.
_registry_package_tag_state() {
    local image="$1" tag="$2" out err rc=0
    err="$(mktemp)"
    out="$(gh api "orgs/cerase-ai/packages/container/${image}/versions?per_page=100" \
             --jq '.[].metadata.container.tags[]' 2>"$err")" || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        rm -f "$err"
        grep -qx "$tag" <<<"$out" && { echo yes; return 0; }
        echo no
        return 0
    fi
    # A package that has never been published answers 404, and that IS an
    # absence — the first push of a new image is precisely when the note earns
    # its place.
    if grep -qiE 'not found|HTTP 404' "$err"; then
        rm -f "$err"
        echo no
        return 0
    fi
    rm -f "$err"
    echo unknown
}

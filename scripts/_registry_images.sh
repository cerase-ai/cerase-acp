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
        grep -E '^[[:space:]]*images:' "$wf" \
            | grep -v 'matrix\.' \
            | sed -n 's/.*\/\([A-Za-z0-9._-]\+\)[[:space:]]*$/\1/p'
    } 2>/dev/null | sed '/^$/d' | sort -u
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

# 0 when HEAD changed nothing the publish workflow cares about.
#
# Both workflows carry `paths-ignore: [docs/**, devplan/**]`, so a docs-only or  comment-check: ok
# devplan-only push does not run the publish job at all and NO image carries
# that sha — legitimately. Without this, the very next devplan commit would be
# reported as "CI never published", and a check that cries wolf gets ignored,
# which is how the original defect survived.
#
# Scoped to HEAD's own diff. A multi-commit push whose head commit is docs-only
# may still have published (an earlier commit in the range touched code), so
# this only suppresses the RED — it never asserts an image must be absent.
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
    mapfile -t ignored < <(
        sed -n "/paths-ignore:/,/^[[:space:]]*[a-z_]*:[[:space:]]*$/p" "$wf" \
            | sed -n "s/^[[:space:]]*-[[:space:]]*'\{0,1\}\([^'*]*\).*/\1/p"
    )
    [[ ${#ignored[@]} -gt 0 ]] || return 1
    local -a changed=()
    mapfile -t changed < <(git -C "$repo_dir" diff --name-only "${ref}~1..${ref}" 2>/dev/null)
    [[ ${#changed[@]} -gt 0 ]] || return 1
    local f prefix hit
    for f in "${changed[@]}"; do
        hit=0
        for prefix in "${ignored[@]}"; do
            [[ -n "$prefix" && "$f" == "$prefix"* ]] && { hit=1; break; }
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
# A ref no workflow rebuilds has nothing missing BY CONSTRUCTION, so it returns
# empty rather than listing every image. That is the cry-wolf this closes: a
# plan-only commit reported nine missing images, twice in one evening.
_registry_unpublished_images() {
    local repo_dir="$1" ref="${2:-HEAD}"
    _registry_head_is_ignored_only "$repo_dir" "$ref" && return 0

    local short
    short="$(git -C "$repo_dir" rev-parse --short=7 "$ref" 2>/dev/null)" || return 0

    local image
    while read -r image; do
        [ -n "$image" ] || continue
        gh api "orgs/cerase-ai/packages/container/${image}/versions?per_page=100" \
             --jq '.[].metadata.container.tags[]' 2>/dev/null \
          | grep -qx "sha-${short}" || printf '%s\n' "$image"
    done < <(_registry_images_for "$repo_dir" 2>/dev/null)
}

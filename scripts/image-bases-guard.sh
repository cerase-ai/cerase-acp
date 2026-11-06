#!/usr/bin/env bash
#
# Every image this repo builds names what it starts from by digest, and no
# build pipes an installer into a shell.
#
# A tag is a name its publisher can move. `composer:2` sat in three Dockerfiles
# beside a full version on the same image, and it resolves to whatever the
# registry holds the day a build runs: a base moved under an unchanged line
# reaches a tenant with the next release, and no commit says so. A digest is the
# one reference a registry cannot answer differently tomorrow.
#
# The guard matches the USE: a `FROM` instruction, a `COPY --from=` that reads an
# image, a pipe into a shell outside a comment. A stage built earlier in the same
# file is a local name and has no digest to carry. Comments are not read, because
# two Dockerfiles explain the installer pipe they replaced.
#
# Takes the directory to walk, which is this repo when none is given. The same
# script is in every repo, synced from core by `scripts/sync-tooling.sh`.

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT" || exit 1

# Every tracked Dockerfile. A tree extracted onto an appliance is not a git
# checkout, and there the files on disk are what is read.
_dockerfiles() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files | grep -E '(^|/)Dockerfile[^/]*$'
  else
    find . -type f -name 'Dockerfile*' | sed 's|^\./||'
  fi
}

# One awk per file, so a stage name in one Dockerfile means nothing in the next.
_defects() {
  awk '
    function pinned(ref) { return match(ref, /@sha256:[0-9a-f]+$/) && RLENGTH == 72 }
    /^[ \t]*#/ { next }
    tolower($1) == "from" {
      i = 2
      while ($i ~ /^--/) i++
      ref = $i
      known = (tolower(ref) in stages) || tolower(ref) == "scratch"
      if (tolower($(i + 1)) == "as") stages[tolower($(i + 2))] = 1
      if (!known && !pinned(ref)) printf "%s:%d: FROM %s has no digest\n", FILENAME, FNR, ref
      next
    }
    tolower($1) == "copy" {
      for (i = 2; i <= NF && $i ~ /^--/; i++) {
        if ($i !~ /^--from=/) continue
        ref = substr($i, 8)
        if (tolower(ref) in stages || ref ~ /^[0-9]+$/ || pinned(ref)) continue
        printf "%s:%d: COPY --from=%s has no digest\n", FILENAME, FNR, ref
      }
      next
    }
    /\|[ \t]*(ba)?sh([ \t]|$)/ { printf "%s:%d: pipes a download into a shell\n", FILENAME, FNR }
  ' "$1"
}

defects=""
while IFS= read -r file; do
  [ -n "$file" ] || continue
  defects+="$(_defects "$file")"$'\n'
done < <(_dockerfiles)
defects="$(printf '%s' "$defects" | sed '/^$/d')"

if [ -n "$defects" ]; then
  printf '%s\n' "$defects"
  echo "Name each base as image:version@sha256:<digest>, and take a build tool from its own image." >&2
  exit 1
fi

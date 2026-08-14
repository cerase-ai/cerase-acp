#!/usr/bin/env bash
#
# No comment carries what git already holds.
#
# Three kinds of content belong in the commit body rather than in a comment: a
# past date or an incident narrative, a milestone or ticket ID, and markdown or
# emoji inside an inline comment. The rule and its reasoning live in the
# forge-flow executor convention; this script is the enforceable half of it,
# and it exists because the rule holds only until the first long session
# without one.
#
# SCOPE IS THE WHOLE DESIGN. The check runs over the files changed since the
# merge-base with the default branch, never over the repository. A repo-wide
# version reds on every legacy file the day it lands and is switched off the
# same week, taking the rule with it.
#
# This workspace pushes to main rather than opening pull requests, so on the
# branch that matters the merge-base with the default branch is HEAD and the
# diff is empty. CI therefore passes the push range explicitly with --base,
# which scopes the check to the commits of that push. Without it the check
# would skip on every run that counts and report success for having looked at
# nothing.
#
# Two of the convention's carve-outs cannot be expressed as a pattern: a
# forward deadline matches the date branch, and a marker that is the literal
# under test matches the emoji branch. CI needs a deterministic verdict, so a
# cleared hit is recorded in the line itself with "comment-check: ok". A
# reviewer writes that; the pattern never decides it.
#
# The ID branch requires two alphabetic segments, which is what separates our
# ticket IDs from external identifiers that share their shape. EN-301-549 is
# the accessibility standard and CVE-2026-69246 names a real advisory; neither
# is a unit of our work, and a reader has no commit to look them up in.
#
# Usage:  scripts/comment-check.sh [--quiet] [--base <ref>]
# Exit:   0 clean or skipped with a reason - 1 a comment carries what git holds

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

QUIET=false
BASE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=true; shift ;;
    --base)  BASE_REF="${2:-}"; shift 2 ;;
    *)       echo "comment-check: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

say()  { $QUIET || echo "$@"; }
skip() { say "comment-check: SKIP - $1"; exit 0; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || skip "not a git repository"

# The default branch as this checkout knows it, remote first: CI fetches
# origin and a developer machine may not have the ref at all.
if [ -n "$BASE_REF" ]; then
  # An explicit base comes from CI, where a first push carries the all-zero sha
  # and a shallow clone may not hold the previous commit at all. Both are
  # ordinary, and neither is a reason to fail a run.
  git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null \
    || skip "base $BASE_REF is not a commit in this checkout"
else
  for candidate in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$candidate" >/dev/null; then
      BASE_REF="$candidate"; break
    fi
  done
fi
[ -n "$BASE_REF" ] || skip "no default branch ref to compare against"

MERGE_BASE="$(git merge-base HEAD "$BASE_REF" 2>/dev/null)"
[ -n "$MERGE_BASE" ] || skip "no merge-base with $BASE_REF"

SRC_RE='\.(sh|bash|py|ts|tsx|js|jsx|php|go|rb|rs|java)$'

# Reading inside a Python docstring needs a parser. Where there is no
# interpreter the other two surfaces still run: a partial check that says so
# beats a run that fails for a reason unrelated to any comment.
PY="$(command -v python3 || true)"
[ -n "$PY" ] || say "comment-check: note - no python3, Python docstrings not read"

# Deleted files are excluded: a path that no longer exists cannot be read, and
# grep would fail the run on the one change that always satisfies the rule.
mapfile -t CHANGED < <(
  git diff --name-only --diff-filter=d "$MERGE_BASE"...HEAD \
    | grep -E "$SRC_RE" || true
)

[ "${#CHANGED[@]}" -gt 0 ] || skip "no source file changed since $BASE_REF"

DATE_BRANCH='([Mm]easured 20|[Ff]ound 20|[0-9]{4}-[0-9]{2}-[0-9]{2})'
ID_BRANCH='[A-Z][A-Z0-9]*-[A-Z0-9-]*[A-Z][A-Z0-9-]*-[0-9]+'
# The decorative markers that actually turn up, named rather than tested for
# non-ASCII, which would fire on every accented word. Deliberately absent:
# the check and cross marks, which this codebase emits as literal UI strings.
MARKUP_BRANCH='(\*\*|⚠️|✅|❌|🔄|🔴|🟡|🟢|📋)'

# An inline comment is read as plain text in an editor, so all three bans
# apply to it.
LINE_RE="^[[:space:]]*(#|//).*($DATE_BRANCH|$ID_BRANCH|$MARKUP_BRANCH)"

# A doc comment is rendered by a generator, so its markup is the format and
# stays. The other two bans do not depend on how the comment is displayed: a
# reader of a PHPDoc block can no more resolve a ticket ID than a reader of a
# line comment can. Matching the continuation line rather than the opening
# delimiter is what reaches the body, and in these languages a line whose
# first character is an asterisk is inside a block comment.
#
# The pipe covers Laravel's banner style, whose continuation lines are drawn
# with `|` instead: those blocks carry section titles with a ticket ID in them
# and no other pattern here reaches inside one.
DOC_RE="^[[:space:]]*(\*|\|).*($DATE_BRANCH|$ID_BRANCH)"

HITS=0
for f in "${CHANGED[@]}"; do
  [ -f "$f" ] || continue

  # The three surfaces are scanned separately and reported together, in line
  # order: a reader works down a file, not down a list of patterns.
  found=""
  _collect() {
    while IFS= read -r hit; do
      case "$hit" in *"comment-check: ok"*) continue ;; esac
      found="${found}${hit%%:*}"$'\n'
    done
  }

  _collect < <(grep -nE "$LINE_RE" "$f" 2>/dev/null || true)

  case "$f" in
    *.php|*.js|*.jsx|*.ts|*.tsx|*.java|*.go|*.rs)
      _collect < <(grep -nE "$DOC_RE" "$f" 2>/dev/null || true)
      ;;
    *.py)
      # A Python docstring is a string expression, so no line prefix marks it
      # and the grep above cannot see inside one. It carries the same ticket
      # IDs as any other doc comment, and a reader can resolve them no better.
      [ -z "$PY" ] || _collect < <("$PY" - "$f" "$DATE_BRANCH" "$ID_BRANCH" <<'PYEOF' 2>/dev/null || true
import ast, re, sys
path, date_re, id_re = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    src = open(path, encoding="utf-8", errors="replace").read()
    tree = ast.parse(src)
except Exception:
    sys.exit(0)
bad = re.compile(f"({date_re}|{id_re})")
seen = set()
for node in ast.walk(tree):
    if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
        continue
    doc = ast.get_docstring(node, clean=False)
    if not doc:
        continue
    # The string expression's own lineno is where the docstring's first line
    # sits. Counting back from end_lineno instead lands one line early,
    # because the value shares its first line with the opening quotes.
    body = node.body[0]
    start = getattr(body, "lineno", None)
    if start is None:
        continue
    for i, line in enumerate(doc.split("\n")):
        if bad.search(line):
            n = start + i
            if n not in seen:
                seen.add(n)
                print(f"{n}:{line.strip()}")
PYEOF
      )
      ;;
  esac

  [ -n "$found" ] || continue
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    say "  $f:$n"
    HITS=$((HITS + 1))
  done < <(printf '%s' "$found" | sort -nu)
done

if [ "$HITS" -gt 0 ]; then
  say ""
  say "comment-check: FAIL - $HITS comment line(s) carry a date, an ID or markup."
  say "Move it to the commit body, or mark a carve-out with 'comment-check: ok'."
  exit 1
fi

say "comment-check: OK - ${#CHANGED[@]} changed source file(s) clean"
exit 0

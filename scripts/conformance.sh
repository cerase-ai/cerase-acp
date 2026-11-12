#!/usr/bin/env bash
#
# Run the tests that cite spec rows, then judge the ledger they wrote.
#
# The ledger is a fresh temporary file, so a stale line from an earlier run
# cannot make a row look executed.

set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root" || exit 1

ledger="$(mktemp "${TMPDIR:-/tmp}/cerase-spec-ledger.XXXXXX")"
trap 'rm -f "$ledger"' EXIT

status=0
CERASE_SPEC_LEDGER="$ledger" npx vitest run -t "\[spec\]" || status=$?
python3 scripts/conformance.py --ledger "$ledger" --root . --all || status=$?

exit "$status"

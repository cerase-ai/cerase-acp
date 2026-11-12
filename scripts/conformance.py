#!/usr/bin/env python3
"""Judge whether every selected spec row was executed and still holds.

    python3 scripts/conformance.py --ledger FILE [--root DIR] [--decisions FILE]
                                   (--all | PATH [PATH ...])

The index at ``specs/INDEX.tsv`` names each area file, the paths its scope
covers, and how many rows it declares. Every indexed area is checked for its
shape; a selected area's rows are matched against the ledger written by
``spec_rows.py``. A row is green only when a test executed it, passed, and read
the row's current text. Unselected areas are left out of the verdict, and a
ledger ID that no area declares is reported rather than silently ignored.

The verdict is TAP on stdout and one JSON summary line at the end. Structural
faults print to stderr and exit 2 without producing TAP. Green exits 0 and any
``not ok`` line exits 1.
"""

from __future__ import annotations

import argparse
import csv
import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path

_INDEX_HEADER = ["path", "scope", "rows"]
_AREA_HEADER = ["id", "when", "expect", "file"]
_AREA_HEADER_WITH_DEC = _AREA_HEADER + ["dec"]
_OUTCOMES = {"pass", "fail", "skip"}
_DEC = re.compile(r"DEC-[0-9]+")
_ROWS = re.compile(r"[0-9]+")


def _read_tsv(path: Path):
    with path.open(encoding="utf-8", newline="") as stream:
        reader = csv.DictReader(stream, delimiter="\t", quoting=csv.QUOTE_NONE)
        return list(reader.fieldnames or []), list(reader)


def _fingerprint(row: dict[str, str]) -> str:
    payload = (row.get("when", "") + "\t" + row.get("expect", "")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def _fail(messages: list[str]) -> int:
    for message in messages:
        print(f"conformance: {message}", file=sys.stderr)
    return 2


def _read_ledger(path: Path, errors: list[str]):
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path}: {exc}")
        return []

    entries = []
    for number, line in enumerate(text.splitlines(), start=1):
        fields = line.split("\t")
        if len(fields) != 4 or fields[1] not in _OUTCOMES:
            errors.append(
                f"{path}: line {number} is not <id>, <pass|fail|skip>, <test id>, <fingerprint>"
            )
            continue
        entries.append(
            {
                "id": fields[0],
                "outcome": fields[1],
                "test": fields[2],
                "fingerprint": fields[3],
            }
        )
    return entries


def _matches(path: str, scope: str) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in scope.split(";"))


def _select(index, paths, full):
    selected = []
    for entry in index:
        if full or any(_matches(path, entry["scope"]) for path in paths):
            selected.append(entry)
    return selected


def _judge(rows, entries, unknown, full, selected_paths, remaining_paths):
    by_id: dict[str, list[dict[str, str]]] = {}
    for entry in entries:
        by_id.setdefault(entry["id"], []).append(entry)

    lines: list[str] = []
    passed: list[str] = []
    failed: list[str] = []
    number = 0

    for row in rows:
        number += 1
        spec_id = row["id"]
        current = _fingerprint(row)
        found = by_id.get(spec_id, [])
        fails = [entry for entry in found if entry["outcome"] == "fail"]
        skips = [entry for entry in found if entry["outcome"] == "skip"]
        passes = [
            entry
            for entry in found
            if entry["outcome"] == "pass" and entry["fingerprint"] == current
        ]

        if passes and not fails and not skips:
            test_ids = []
            for entry in passes:
                if entry["test"] not in test_ids:
                    test_ids.append(entry["test"])
            lines.append(f"ok {number} - {spec_id} ({', '.join(test_ids)})")
            passed.append(spec_id)
            continue

        if fails:
            reason = f"failed in {fails[0]['test']}"
        elif skips:
            reason = f"skipped in {skips[0]['test']}"
        elif any(entry["outcome"] == "pass" for entry in found):
            first = next(
                entry for entry in found if entry["outcome"] == "pass"
            )
            reason = f"executed by {first['test']} against a different revision of the row"
        else:
            reason = "no test executed it"
        lines.append(f"not ok {number} - {spec_id}: {reason}")
        failed.append(spec_id)

    for spec_id in unknown:
        number += 1
        first = by_id[spec_id][0]
        lines.append(
            f"not ok {number} - {spec_id}: recorded by {first['test']} but declared in no area"
        )
        failed.append(spec_id)

    print(f"1..{number}")
    for line in lines:
        print(line)
    summary = {
        "scope": "full" if full else "partial",
        "selected": selected_paths,
        "remaining": remaining_paths,
        "rows": len(rows),
        "passed": passed,
        "failed": failed,
    }
    print("# conformance " + json.dumps(summary, ensure_ascii=False))
    return 0 if not failed else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--ledger", required=True)
    parser.add_argument("--root", default=None)
    parser.add_argument("--decisions", default=None)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args(argv)

    root = Path(args.root) if args.root else Path(__file__).resolve().parent.parent
    ledger_path = Path(args.ledger)

    if args.all and args.paths:
        return _fail(["--all cannot be combined with paths"])
    if not args.all and not args.paths:
        return _fail(["no scope: pass --all or at least one path"])

    decisions_text = ""
    if args.decisions:
        decisions_path = root / args.decisions
        try:
            decisions_text = decisions_path.read_text(encoding="utf-8")
        except OSError:
            return _fail([f"{args.decisions}: decisions file not found under {root}"])

    errors: list[str] = []
    index_path = root / "specs" / "INDEX.tsv"
    if not index_path.is_file():
        return _fail([f"specs/INDEX.tsv not found under {root}"])

    fields, index = _read_tsv(index_path)
    if fields != _INDEX_HEADER:
        return _fail(
            [
                "specs/INDEX.tsv: header is not exactly path, scope, rows"
            ]
        )
    if not index:
        return _fail(["specs/INDEX.tsv: no entry"])

    seen_paths: set[str] = set()
    for entry in index:
        path = entry.get("path", "")
        scope = entry.get("scope", "")
        rows = entry.get("rows", "")
        if not path:
            errors.append("specs/INDEX.tsv: an entry has an empty path")
            continue
        if path in seen_paths:
            errors.append(f"specs/INDEX.tsv: path {path} is listed twice")
        seen_paths.add(path)
        if not scope.strip():
            errors.append(f"specs/INDEX.tsv: {path} has an empty scope")
        if not _ROWS.fullmatch(rows):
            errors.append(
                f"specs/INDEX.tsv: {path} has a row count that is not a non-negative integer: {rows!r}"
            )

    declared: dict[str, str] = {}
    rows_by_area: dict[str, list[dict[str, str]]] = {}
    for entry in index:
        path = entry.get("path", "")
        if not path:
            continue
        area_path = root / path
        if not area_path.is_file():
            errors.append(f"{path}: area file does not exist")
            continue

        area_fields, area_rows = _read_tsv(area_path)
        if area_fields not in (_AREA_HEADER, _AREA_HEADER_WITH_DEC):
            errors.append(
                f"{path}: header is not id, when, expect, file with an optional final dec"
            )
            continue
        if not area_rows:
            errors.append(f"{path}: no row")
            continue
        if len(area_rows) > 40:
            errors.append(
                f"{path}: {len(area_rows)} rows, split above 40 rows"
            )
        expected = entry.get("rows", "")
        if _ROWS.fullmatch(expected) and int(expected) != len(area_rows):
            errors.append(
                f"{path}: index declares {expected} rows, the area has {len(area_rows)}"
            )

        for number, row in enumerate(area_rows, start=1):
            # csv puts surplus fields under None and fills missing ones with None:
            # either means a tab inside a field or a field left out.
            if None in row or None in row.values():
                errors.append(
                    f"{path}: row {number} does not have the {len(area_fields)} fields its header names"
                )
                continue
            spec_id = row.get("id", "")
            if not spec_id:
                errors.append(f"{path}: row {number} has an empty id")
            for column in ("when", "expect", "file"):
                if not row.get(column, "").strip():
                    errors.append(
                        f"{path}: row {number} ({spec_id or '?'}) has an empty {column}"
                    )
            target = row.get("file", "")
            if target and not (root / target).exists():
                errors.append(
                    f"{path}: row {number} ({spec_id or '?'}) names a file that does not exist under the root: {target}"
                )
            decision = row.get("dec") or ""
            if decision:
                if not _DEC.fullmatch(decision):
                    errors.append(
                        f"{path}: row {number} ({spec_id or '?'}) has a dec that is not DEC-<n>: {decision}"
                    )
                elif args.decisions and not re.search(
                    rf"^## {re.escape(decision)}:", decisions_text, re.MULTILINE
                ):
                    errors.append(
                        f"{path}: row {number} ({spec_id or '?'}) names {decision}, which is not a heading in {args.decisions}"
                    )
            if spec_id:
                if spec_id in declared:
                    errors.append(
                        f"duplicate spec ID {spec_id} in {declared[spec_id]} and {path}"
                    )
                else:
                    declared[spec_id] = path
        rows_by_area[path] = area_rows

    entries = _read_ledger(ledger_path, errors)

    if errors:
        return _fail(errors)

    selected_entries = _select(index, args.paths, args.all)
    selected_paths = [entry["path"] for entry in selected_entries]
    remaining_paths = [
        entry["path"] for entry in index if entry["path"] not in selected_paths
    ]

    for path in args.paths:
        if not any(_matches(path, entry["scope"]) for entry in index):
            return _fail([f"{path} matches no scope in specs/INDEX.tsv"])

    rows = []
    for entry in selected_entries:
        rows.extend(rows_by_area.get(entry["path"], []))

    ledger_ids = []
    for entry in entries:
        if entry["id"] not in ledger_ids:
            ledger_ids.append(entry["id"])
    unknown = [spec_id for spec_id in ledger_ids if spec_id not in declared]

    return _judge(rows, entries, unknown, args.all, selected_paths, remaining_paths)


if __name__ == "__main__":
    sys.exit(main())

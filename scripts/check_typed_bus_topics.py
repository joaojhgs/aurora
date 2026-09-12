#!/usr/bin/env python3
"""Fail when production bus topic usage bypasses typed constants."""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ROOTS = (
    REPO_ROOT / "app/services",
    REPO_ROOT / "app/ui",
    REPO_ROOT / "app/shared/services",
)
TOPIC_LITERAL_RE = re.compile(r"^[A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)+$")
BUS_CALLS = {"publish", "request", "subscribe", "unsubscribe", "stream_request"}
TOPIC_KWARGS = {"method_id", "bus_topic"}


@dataclass(frozen=True)
class TopicLiteralViolation:
    path: str
    line: int
    column: int
    context: str
    value: str


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _call_name(node: ast.Call) -> str | None:
    if isinstance(node.func, ast.Attribute):
        return node.func.attr
    if isinstance(node.func, ast.Name):
        return node.func.id
    return None


def _string_literal(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _is_topic_literal(value: str) -> bool:
    return bool(TOPIC_LITERAL_RE.match(value))


def _python_files(paths: Iterable[Path]) -> list[Path]:
    files: list[Path] = []
    for path in paths:
        if path.is_file() and path.suffix == ".py":
            files.append(path)
        elif path.is_dir():
            files.extend(sorted(path.rglob("*.py")))
    return sorted({item.resolve() for item in files})


def collect_violations(paths: Iterable[Path]) -> list[TopicLiteralViolation]:
    violations: list[TopicLiteralViolation] = []
    for path in _python_files(paths):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node)
            if name in BUS_CALLS and node.args:
                value = _string_literal(node.args[0])
                if value is not None and _is_topic_literal(value):
                    violations.append(
                        TopicLiteralViolation(
                            path=_rel(path),
                            line=node.args[0].lineno,
                            column=node.args[0].col_offset,
                            context=f"{name} positional topic",
                            value=value,
                        )
                    )
            for keyword in node.keywords:
                if keyword.arg not in TOPIC_KWARGS:
                    continue
                value = _string_literal(keyword.value)
                if value is not None and _is_topic_literal(value):
                    violations.append(
                        TopicLiteralViolation(
                            path=_rel(path),
                            line=keyword.value.lineno,
                            column=keyword.value.col_offset,
                            context=f"{keyword.arg} keyword",
                            value=value,
                        )
                    )
    return sorted(violations, key=lambda item: (item.path, item.line, item.column))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        default=list(DEFAULT_ROOTS),
        help="Python files or directories to scan; defaults to production bus callers",
    )
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable report")
    args = parser.parse_args()

    paths = [path if path.is_absolute() else REPO_ROOT / path for path in args.paths]
    violations = collect_violations(paths)
    report = {
        "checked_roots": [_rel(path) for path in paths],
        "violation_count": len(violations),
        "violations": [asdict(item) for item in violations],
        "ok": not violations,
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif violations:
        for item in violations:
            print(
                f"{item.path}:{item.line}:{item.column}: {item.context} "
                f"uses literal topic {item.value!r}; use a typed *Methods/*Events constant"
            )
    else:
        print("typed bus topic audit passed")
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check production UI string literals for forbidden implementation wording."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from dataclasses import dataclass


DEFAULT_PATHS = (
    "packages/aurora-ui/src/product-copy.ts",
    "packages/aurora-ui/src/onboarding-view.tsx",
    "packages/aurora-ui/src/web-thin-connection-panel.tsx",
    "packages/aurora-ui/src/shell.tsx",
    "packages/aurora-ui/src/nav.tsx",
    "packages/aurora-ui/src/mesh-peers-view.tsx",
    "packages/aurora-ui/src/service-routing-view.tsx",
)

FORBIDDEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("proof", re.compile(r"\bproof\b", re.I)),
    ("evidence", re.compile(r"\bevidence\b", re.I)),
    ("fixture", re.compile(r"\bfixtures?\b", re.I)),
    ("assertion", re.compile(r"\bassertions?\b", re.I)),
    ("implementation", re.compile(r"\bimplement(?:ation|ed|ing)?\b", re.I)),
    ("tested", re.compile(r"\btested\b", re.I)),
    ("debug", re.compile(r"\bdebug(?:ging)?\b", re.I)),
    ("fallback", re.compile(r"\bfallback\b", re.I)),
    ("provider-consumer-role", re.compile(r"\b(?:provider|consumer|hybrid)\b", re.I)),
    ("route-counts", re.compile(r"\b\d+\s*/\s*\d+\s+routes?\b|\broute counts?\b", re.I)),
    ("manifest", re.compile(r"\bmanifest\b", re.I)),
    ("contract", re.compile(r"\bcontracts?\b", re.I)),
    ("protocol", re.compile(r"\bprotocol\b", re.I)),
    ("transport", re.compile(r"\btransport\b", re.I)),
    ("runtime", re.compile(r"\bruntime\b", re.I)),
    ("schema", re.compile(r"\bschema\b", re.I)),
    ("migration", re.compile(r"\bmigrations?\b", re.I)),
    ("sqlite", re.compile(r"\bsqlite\b", re.I)),
    ("indexeddb", re.compile(r"\bindexeddb\b", re.I)),
    ("opfs", re.compile(r"\bopfs\b", re.I)),
    ("sidecar", re.compile(r"\bsidecar\b", re.I)),
    ("thin", re.compile(r"\bthin\b", re.I)),
)

ATTRIBUTE_NAMES = {
    "aria-label",
    "title",
    "placeholder",
    "alt",
    "label",
    "description",
    "disabledReason",
}

ADVANCED_CONNECTION_ALLOWLIST = (
    re.compile(r"\bAurora address\b", re.I),
    re.compile(r"\bConnection method\b", re.I),
    re.compile(r"\bHTTP only\b", re.I),
    re.compile(r"\bWebRTC only\b", re.I),
    re.compile(r"\bWebRTC preferred\b", re.I),
)


@dataclass(frozen=True)
class Finding:
    path: pathlib.Path
    line: int
    term_id: str
    text: str


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="Files or directories to scan.")
    parser.add_argument("--repo-root", default=".", help="Repository root. Defaults to cwd.")
    args = parser.parse_args(argv)

    repo_root = pathlib.Path(args.repo_root).resolve()
    paths = [repo_root / path for path in (args.paths or DEFAULT_PATHS)]
    findings: list[Finding] = []
    for path in expand_paths(paths):
        findings.extend(scan_file(path))

    if findings:
        for finding in findings:
            rel = finding.path.relative_to(repo_root) if finding.path.is_relative_to(repo_root) else finding.path
            print(f"{rel}:{finding.line}: {finding.term_id}: {finding.text}", file=sys.stderr)
        print(f"Found {len(findings)} production UI copy issue(s).", file=sys.stderr)
        return 1
    return 0


def expand_paths(paths: list[pathlib.Path]) -> list[pathlib.Path]:
    expanded: list[pathlib.Path] = []
    for path in paths:
        if path.is_dir():
            expanded.extend(sorted(
                child for child in path.rglob("*")
                if child.suffix in {".ts", ".tsx"} and "tests" not in child.parts
            ))
        elif path.exists():
            expanded.append(path)
    return expanded


def scan_file(path: pathlib.Path) -> list[Finding]:
    text = path.read_text(encoding="utf-8")
    clean = strip_comments(text)
    findings: list[Finding] = []
    for line_no, literal in rendered_literals(clean):
        stripped = normalize_literal(literal)
        if not stripped or is_allowed_connection_copy(stripped):
            continue
        for term_id, pattern in FORBIDDEN_PATTERNS:
            if pattern.search(stripped):
                findings.append(Finding(path, line_no, term_id, stripped))
    return findings


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", lambda match: "\n" * match.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"//.*", "", text)


def rendered_literals(text: str) -> list[tuple[int, str]]:
    results: list[tuple[int, str]] = []
    line_starts = [0]
    for match in re.finditer(r"\n", text):
        line_starts.append(match.end())

    def line_for(index: int) -> int:
        low, high = 0, len(line_starts)
        while low + 1 < high:
            mid = (low + high) // 2
            if line_starts[mid] <= index:
                low = mid
            else:
                high = mid
        return low + 1

    attr_pattern = re.compile(
        rf"(?:{'|'.join(re.escape(name) for name in ATTRIBUTE_NAMES)})\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|\{{\s*(['\"])(.*?)\3\s*\}})",
        re.S,
    )
    for match in attr_pattern.finditer(text):
        results.append((line_for(match.start()), next(group for group in match.groups() if group and group not in {"'", '"'})))

    for index, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith((
            "const ",
            "let ",
            "return ",
            "if ",
            "?",
            ":",
            "}",
            "{",
            "case ",
            "function ",
        )):
            continue
        for match in re.finditer(r">([^<>{}]+)<", line):
            value = match.group(1)
            if value.strip():
                results.append((index, value))

    product_copy_pattern = re.compile(r"\b(?:label|title|description|action|saved|temporary|ownedElsewhere|unchanged|lost|panelTitle|addressLabel|methodLabel|deviceName|scan|openFile|paste|continue|saving|advanced|connectedDevice|localFeatures|approvals|approve|deny|remove|needed|limited|administrator)\s*:\s*(['\"])(.*?)\1", re.S)
    for match in product_copy_pattern.finditer(text):
        results.append((line_for(match.start()), match.group(2)))

    return results


def normalize_literal(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def is_allowed_connection_copy(value: str) -> bool:
    return any(pattern.search(value) for pattern in ADVANCED_CONNECTION_ALLOWLIST)


if __name__ == "__main__":
    raise SystemExit(main())

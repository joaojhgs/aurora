"""Validate Aurora documentation hygiene.

Checks current docs and README-style files for:
- broken relative Markdown links;
- stale workflow/gate/task artifact references;
- generated JSON/TXT report artifacts under docs/;
- task-specific PER/QA docs outside archive/provenance locations.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]

SKIP_PARTS = {
    ".git",
    ".mypy_cache",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "build",
    "dist",
    "htmlcov",
    "node_modules",
    "target",
}

ARCHIVE_PARTS = {"archive", ".omx"}

LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
STALE_RE = re.compile(
    r"(?:test-core\.yml|test-all\.yml|test-e2e\.yml|test-performance\.yml|"
    r"test-process-mode\.yml|test-modules\.yml|release-packaging-operator|"
    r"transport-parity|multi_mode_e2e|security_privacy_regression|"
    r"ui_release_preflight|\.omx/reports/(?:multi-mode-e2e|security-privacy-regression|"
    r"release-packaging-operator|transport-parity|ui-release-preflight))",
    re.IGNORECASE,
)
TASK_DOC_RE = re.compile(r"(?:^|[/_-])(?:PER-\d+|QA-\d{2,})(?:[/_.-]|$)", re.IGNORECASE)


def is_skipped(path: Path) -> bool:
    return any(part in SKIP_PARTS for part in path.parts)


def is_archive_or_provenance(path: Path) -> bool:
    return any(part in ARCHIVE_PARTS for part in path.parts)


def markdown_files() -> list[Path]:
    roots = [
        ROOT / "docs",
        ROOT / "readme.md",
        ROOT / "README.process-mode.md",
        ROOT / "SECURITY.md",
    ]
    roots.extend((ROOT / "apps").glob("*/README.md"))
    roots.extend((ROOT / "apps").glob("*/SECURITY.md"))
    roots.extend((ROOT / "packages").glob("*/README.md"))
    roots.append(ROOT / "tests" / "README.md")
    roots.append(ROOT / "voice_models" / "README.md")

    files: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            files.append(root)
        else:
            files.extend(root.rglob("*.md"))
    return sorted({p.resolve() for p in files if not is_skipped(p.relative_to(ROOT))})


def check_links(files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        rel = path.relative_to(ROOT)
        if is_archive_or_provenance(rel):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in LINK_RE.finditer(text):
            target = match.group(1).strip("<>")
            if not target or target.startswith("#"):
                continue
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            target_path = unquote(target.split("#", 1)[0])
            if not target_path:
                continue
            resolved = (path.parent / target_path).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                errors.append(f"{rel}: link escapes repo: {target}")
                continue
            if not resolved.exists():
                line = text[: match.start()].count("\n") + 1
                errors.append(f"{rel}:{line}: broken link -> {target}")
    return errors


def check_stale_refs(files: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in files:
        rel = path.relative_to(ROOT)
        if is_archive_or_provenance(rel):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in STALE_RE.finditer(text):
            line = text[: match.start()].count("\n") + 1
            errors.append(f"{rel}:{line}: stale workflow/gate reference -> {match.group(0)}")
    return errors


def check_generated_docs() -> list[str]:
    errors: list[str] = []
    docs = ROOT / "docs"
    for path in docs.rglob("*"):
        rel = path.relative_to(ROOT)
        if is_archive_or_provenance(rel):
            continue
        if path.is_file() and path.suffix.lower() in {".json", ".txt"}:
            errors.append(f"{rel}: generated/report artifact should not live in current docs")
    return errors


def check_task_docs() -> list[str]:
    errors: list[str] = []
    for path in (ROOT / "docs").rglob("*.md"):
        rel = path.relative_to(ROOT)
        if is_archive_or_provenance(rel):
            continue
        if TASK_DOC_RE.search(rel.as_posix()):
            errors.append(f"{rel}: task-specific PER/QA doc outside archive")
    return errors


def main() -> int:
    files = markdown_files()
    errors = []
    errors.extend(check_links(files))
    errors.extend(check_stale_refs(files))
    errors.extend(check_generated_docs())
    errors.extend(check_task_docs())

    if errors:
        print("Documentation check failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print(f"Documentation check passed ({len(files)} markdown files scanned).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Reject generated artifacts and local run output tracked by Git."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path, PurePosixPath

FORBIDDEN_DIRECTORY_NAMES = {
    ".artifacts",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".turbo",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "htmlcov",
    "node_modules",
    "playwright-report",
    "reports",
    "target",
    "test-results",
}

FORBIDDEN_FILE_SUFFIXES = (
    ".aab",
    ".7z",
    ".apk",
    ".app",
    ".appimage",
    ".br",
    ".class",
    ".ckpt",
    ".bz2",
    ".db",
    ".deb",
    ".dll",
    ".dmg",
    ".dylib",
    ".exe",
    ".gguf",
    ".gz",
    ".ipa",
    ".jar",
    ".log",
    ".msi",
    ".nupkg",
    ".onnx",
    ".pt",
    ".pth",
    ".pdb",
    ".pyz",
    ".rpm",
    ".rar",
    ".safetensors",
    ".so",
    ".sqlite",
    ".sqlite3",
    ".tar",
    ".tar.gz",
    ".tflite",
    ".tgz",
    ".xz",
    ".war",
    ".wasm",
    ".whl",
    ".zip",
)

FORBIDDEN_OMX_PREFIXES = (
    ".omx/archive/",
    ".omx/cache/",
    ".omx/logs/",
    ".omx/plans/dependency-analysis-archive/",
    ".omx/plans/docs-plans/",
    ".omx/reports/",
    ".omx/research/",
    ".omx/state/",
    ".omx/tmp/",
)

FORBIDDEN_OMX_GENERATED_NAMES = {
    "created-issues.json",
    "full-coverage-review.md",
    "generate_and_push.py",
    "push_to_multica.py",
    "resume_push.py",
    "task-index.json",
    "update_multica_descriptions.py",
}

FORBIDDEN_EXACT_PATHS = {
    ".omx/notepad.md",
    ".omx/project-memory.json",
    ".DS_Store",
    "modules/Aurora Cockpit.dc.html",
    "modules/Owl Loader (standalone).html",
}

ALLOWED_EXACT_PATHS = {
    "docker/services/Dockerfile.db",
}


def artifact_reason(path: str) -> str | None:
    """Return why a tracked path is generated/local-only, if applicable."""

    normalized = path.replace("\\", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    pure_path = PurePosixPath(normalized)
    lower_path = normalized.lower()

    if normalized in ALLOWED_EXACT_PATHS:
        return None
    if normalized in FORBIDDEN_EXACT_PATHS:
        return "local runtime state"
    if any(normalized.startswith(prefix) for prefix in FORBIDDEN_OMX_PREFIXES):
        return "generated, archived, or local OMX state"
    if pure_path.parts[0] == ".omx":
        if pure_path.name in FORBIDDEN_OMX_GENERATED_NAMES:
            return "generated OMX receipt or publishing helper"
        if "report" in pure_path.stem.lower():
            return "generated OMX report"
    if pure_path.parts[0] == "docs" and "archive" not in pure_path.parts:
        stem = pure_path.stem.lower()
        if "report" in stem or "handoff" in stem:
            return "task report or handoff outside the documentation archive"
    if any(
        part in FORBIDDEN_DIRECTORY_NAMES or part.startswith(".next.")
        for part in pure_path.parts[:-1]
    ):
        return "generated output directory"
    if lower_path.endswith(FORBIDDEN_FILE_SUFFIXES):
        return "built, downloaded, or runtime-generated file"
    if pure_path.name.endswith(("_new.py", "_old.py")):
        return "temporary source copy"
    if (
        len(pure_path.parts) == 1
        and pure_path.name.startswith("test_")
        and pure_path.suffix == ".py"
    ):
        return "root-level scratch test"
    return None


def find_forbidden_tracked_paths(paths: list[str]) -> list[tuple[str, str]]:
    """Return sorted tracked paths that violate the repository artifact policy."""

    violations = []
    for path in paths:
        reason = artifact_reason(path)
        if reason is not None:
            violations.append((path, reason))
    return sorted(violations)


def git_tracked_paths(repo_root: Path) -> list[str]:
    """Read the repository's tracked paths without inspecting untracked user files."""

    result = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        check=True,
        capture_output=True,
    )
    return [path.decode("utf-8") for path in result.stdout.split(b"\0") if path]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Git worktree to inspect (defaults to this script's repository)",
    )
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    violations = find_forbidden_tracked_paths(git_tracked_paths(repo_root))
    if violations:
        print("Tracked artifact check failed:")
        for path, reason in violations:
            print(f"- {path}: {reason}")
        return 1

    print("Tracked artifact check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Validate sherpa source identity and run a build without inherited Git metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

SHERPA_SOURCE_ID = "sherpa-onnx-source-v1.13.4"


class SourceIdentityError(RuntimeError):
    """Raised when a sherpa source tree cannot be tied to the pinned archive."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_sherpa_pin(manifest_path: Path) -> dict[str, Any]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    for artifact in data.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == SHERPA_SOURCE_ID:
            return artifact
    raise SourceIdentityError(f"manifest is missing {SHERPA_SOURCE_ID}")


def _git_output(source_root: Path, *args: str, env: dict[str, str] | None = None) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(source_root), *args],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def verify_source_identity(
    manifest_path: Path, artifact_root: Path, source_root: Path
) -> tuple[dict[str, Any], dict[str, str]]:
    pin = load_sherpa_pin(manifest_path)
    resolved_artifact_root = artifact_root.resolve()
    resolved_source_root = source_root.resolve()
    if not resolved_source_root.is_dir():
        raise SourceIdentityError(f"sherpa source directory is missing: {source_root}")

    archive_relative = Path(str(pin["archive_path"]))
    if archive_relative.is_absolute():
        raise SourceIdentityError("sherpa archive_path must be relative")
    archive = (resolved_artifact_root / archive_relative).resolve()
    try:
        archive.relative_to(resolved_artifact_root)
    except ValueError as exc:
        raise SourceIdentityError("sherpa archive_path escapes the artifact root") from exc
    if not archive.is_file():
        raise SourceIdentityError(f"sherpa source archive is missing: {archive}")
    if archive.stat().st_size != pin["size_bytes"]:
        raise SourceIdentityError("sherpa source archive size does not match the manifest")
    actual_archive_sha = sha256_file(archive)
    if actual_archive_sha != pin["sha256"]:
        raise SourceIdentityError("sherpa source archive hash does not match the manifest")

    expected_commit = str(pin["commit"])
    inherited_git_root = _git_output(resolved_source_root, "rev-parse", "--show-toplevel")
    source_has_own_git = (
        inherited_git_root is not None
        and Path(inherited_git_root).resolve() == resolved_source_root
    )
    if source_has_own_git:
        actual_commit = _git_output(resolved_source_root, "rev-parse", "HEAD")
        if actual_commit != expected_commit:
            raise SourceIdentityError(
                f"sherpa Git checkout is {actual_commit}, expected {expected_commit}"
            )

    build_env = os.environ.copy()
    ceiling = str(resolved_source_root.parent)
    existing_ceiling = build_env.get("GIT_CEILING_DIRECTORIES")
    build_env["GIT_CEILING_DIRECTORIES"] = (
        f"{ceiling}{os.pathsep}{existing_ceiling}" if existing_ceiling else ceiling
    )
    build_env["AURORA_SHERPA_EXPECTED_COMMIT"] = expected_commit

    if inherited_git_root is not None and not source_has_own_git:
        leaked_identity = _git_output(
            resolved_source_root, "rev-parse", "--show-toplevel", env=build_env
        )
        if leaked_identity is not None:
            raise SourceIdentityError(
                f"Git metadata still leaks from enclosing checkout: {leaked_identity}"
            )

    evidence = {
        "archive": str(archive),
        "archive_sha256": actual_archive_sha,
        "expected_commit": expected_commit,
        "source_root": str(resolved_source_root),
        "source_has_own_git": source_has_own_git,
        "inherited_git_root_suppressed": (
            inherited_git_root if inherited_git_root and not source_has_own_git else None
        ),
        "git_ceiling_directories": build_env["GIT_CEILING_DIRECTORIES"],
        "status": "verified",
    }
    return evidence, build_env


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path(__file__).with_name("phase4_manifest.json"),
    )
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        evidence, build_env = verify_source_identity(
            args.manifest, args.artifact_root, args.source_root
        )
    except (OSError, KeyError, json.JSONDecodeError, SourceIdentityError) as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}), file=sys.stderr)
        return 2

    print(json.dumps(evidence, indent=2, sort_keys=True))
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        return 0
    return subprocess.run(command, env=build_env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

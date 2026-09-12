#!/usr/bin/env python3
"""Validate sherpa source identity and run a build without inherited Git metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

SHERPA_SOURCE_ID = "sherpa-onnx-source-v1.13.5"
AURORA_SHERPA_PATCHED_FILES = {
    "sherpa-onnx/csrc/offline-tts-pocket-model.h": (
        "53f1b87d998ba0e72340819fc0678df020d7280c917a9a8252e5f405a3a49e2f"
    ),
    "sherpa-onnx/csrc/offline-tts-pocket-model.cc": (
        "07e7375f366cfff3c8652fd79ca854979721d3d30f6eeb04edc8399893983ac9"
    ),
    "sherpa-onnx/csrc/offline-tts-pocket-impl.h": (
        "a7896e6e8df22d678fb325f12440eb42137276542012ee4246225a8d65a29567"
    ),
    "wasm/tts/CMakeLists.txt": ("bae61a4165725f1d67d4d0f16274b2c5b4fff445e10dde2527050e630355ce11"),
    "wasm/vad-asr/CMakeLists.txt": (
        "3fd71985745374ae49c39dda296880326588159c42b01d474a18b06454c6a553"
    ),
    "wasm/kws/CMakeLists.txt": ("333eb9872949a142c3941e10f72833a9073670e90530a400b3c3fc51b6b55737"),
    "cmake/onnxruntime-osx-arm64-static.cmake": (
        "b8422656f5379ff338c810351a22981185894f6b4b0b9dc932b38e998320bf6e"
    ),
}
OMITTED_PINNED_UPSTREAM_SYMLINKS = {
    "scripts/go/_internal/vad-spoken-language-identification/main.go": (
        "/Users/fangjun/open-source/sherpa-onnx/go-api-examples/"
        "vad-spoken-language-identification/main.go"
    ),
    "scripts/go/_internal/vad-spoken-language-identification/run.sh": (
        "/Users/fangjun/open-source/sherpa-onnx/go-api-examples/"
        "vad-spoken-language-identification/run.sh"
    ),
}


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


def _safe_relative_path(value: object, field: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise SourceIdentityError(f"sherpa {field} must be a non-empty relative path")
    relative = Path(value)
    if relative.is_absolute() or ".." in relative.parts:
        raise SourceIdentityError(f"sherpa {field} must stay beneath the artifact root")
    return relative


def _hash_stream(source: Any) -> tuple[int, str]:
    size = 0
    digest = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def _canonical_digest(records: dict[str, tuple[str, ...]]) -> str:
    digest = hashlib.sha256()
    for path, record in sorted(records.items()):
        digest.update(
            json.dumps([path, *record], ensure_ascii=False, separators=(",", ":")).encode()
        )
        digest.update(b"\n")
    return digest.hexdigest()


def _archive_records(archive: Path, source_name: str) -> dict[str, tuple[str, ...]]:
    records: dict[str, tuple[str, ...]] = {}
    with tarfile.open(archive, "r:*") as tar:
        for member in tar:
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts:
                raise SourceIdentityError(f"unsafe path in sherpa archive: {member.name}")
            parts = member_path.parts
            if not parts or parts[0] != source_name:
                raise SourceIdentityError(
                    f"sherpa archive member is outside {source_name}: {member.name}"
                )
            if len(parts) == 1 or member.isdir():
                continue
            relative = PurePosixPath(*parts[1:]).as_posix()
            if relative in records:
                raise SourceIdentityError(f"duplicate sherpa archive member: {relative}")
            if member.isfile():
                source = tar.extractfile(member)
                if source is None:
                    raise SourceIdentityError(f"cannot read sherpa archive member: {relative}")
                with source:
                    size, member_sha = _hash_stream(source)
                if size != member.size:
                    raise SourceIdentityError(f"truncated sherpa archive member: {relative}")
                records[relative] = ("file", str(size), member_sha)
            elif member.issym():
                records[relative] = ("symlink", member.linkname)
            else:
                raise SourceIdentityError(f"unsupported sherpa archive member type: {relative}")
    return records


def _source_records(source_root: Path) -> dict[str, tuple[str, ...]]:
    records: dict[str, tuple[str, ...]] = {}

    def visit(directory: Path, prefix: PurePosixPath) -> None:
        with os.scandir(directory) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                relative_path = prefix / entry.name
                relative = relative_path.as_posix()
                if entry.is_symlink():
                    records[relative] = ("symlink", os.readlink(entry.path))
                elif entry.is_dir(follow_symlinks=False):
                    visit(Path(entry.path), relative_path)
                elif entry.is_file(follow_symlinks=False):
                    with open(entry.path, "rb") as source:
                        size, member_sha = _hash_stream(source)
                    records[relative] = ("file", str(size), member_sha)
                else:
                    raise SourceIdentityError(
                        f"unsupported entry in sherpa source tree: {relative}"
                    )

    visit(source_root, PurePosixPath())
    return records


def _verify_extracted_tree(
    archive: Path,
    source_root: Path,
    *,
    allow_aurora_pockettts_patches: bool = False,
) -> tuple[str, int]:
    archive_records = _archive_records(archive, source_root.name)
    source_records = _source_records(source_root)
    archive_digest = _canonical_digest(archive_records)
    source_digest = _canonical_digest(source_records)
    if allow_aurora_pockettts_patches:
        return _verify_patched_tree(archive_records, source_records, source_root)
    if archive_records != source_records:
        missing = sorted(archive_records.keys() - source_records.keys())
        extra = sorted(source_records.keys() - archive_records.keys())
        changed = sorted(
            path
            for path in archive_records.keys() & source_records.keys()
            if archive_records[path] != source_records[path]
        )
        details = []
        if missing:
            details.append(f"missing={missing[0]}")
        if extra:
            details.append(f"extra={extra[0]}")
        if changed:
            details.append(f"changed={changed[0]}")
        raise SourceIdentityError(
            "sherpa extracted source tree does not match the pinned archive"
            + (f" ({', '.join(details)})" if details else "")
        )
    if archive_digest != source_digest:
        raise SourceIdentityError("sherpa source tree digest does not match the archive")
    return archive_digest, len(archive_records)


def _verify_patched_tree(
    archive_records: dict[str, tuple[str, ...]],
    source_records: dict[str, tuple[str, ...]],
    source_root: Path,
) -> tuple[str, int]:
    extra = sorted(source_records.keys() - archive_records.keys())
    missing = set(archive_records.keys() - source_records.keys())
    expected_omissions = set(OMITTED_PINNED_UPSTREAM_SYMLINKS)
    for relative, target in OMITTED_PINNED_UPSTREAM_SYMLINKS.items():
        if archive_records.get(relative) != ("symlink", target):
            raise SourceIdentityError(f"pinned omitted sherpa symlink changed: {relative}")
    unexpected_missing = sorted(missing - expected_omissions)
    retained_escaping_links = sorted(expected_omissions - missing)
    if extra or unexpected_missing or retained_escaping_links:
        raise SourceIdentityError(
            "patched sherpa tree changed the archive file set"
            + (f" extra={extra[0]}" if extra else "")
            + (f" missing={unexpected_missing[0]}" if unexpected_missing else "")
            + (f" unsafe_link={retained_escaping_links[0]}" if retained_escaping_links else "")
        )
    changed = sorted(
        path
        for path in archive_records.keys() & source_records.keys()
        if archive_records[path] != source_records[path]
    )
    if set(changed) != set(AURORA_SHERPA_PATCHED_FILES):
        raise SourceIdentityError(
            "patched sherpa tree does not match the Aurora downstream patch file set"
            + (f" changed={changed}" if changed else "")
        )
    for relative, expected in AURORA_SHERPA_PATCHED_FILES.items():
        actual = sha256_file(source_root / relative)
        if actual != expected:
            raise SourceIdentityError(f"patched file digest mismatch: {relative}")
    return _canonical_digest(source_records), len(source_records)


def validate_cmake_command(command: list[str], source_root: Path) -> None:
    if Path(command[0]).name not in {"cmake", "cmake.exe"}:
        raise SourceIdentityError("the wrapped command must invoke cmake directly")
    if any(token.startswith("-S") and token != "-S" for token in command[1:]):
        raise SourceIdentityError("cmake source must use one separate -S argument")
    source_flags = [index for index, token in enumerate(command) if token == "-S"]
    if len(source_flags) != 1 or source_flags[0] + 1 >= len(command):
        raise SourceIdentityError("cmake command must contain exactly one separate -S argument")
    command_source = Path(command[source_flags[0] + 1]).resolve()
    if command_source != source_root:
        raise SourceIdentityError(
            f"cmake -S resolves to {command_source}, expected verified source {source_root}"
        )


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
    manifest_path: Path,
    artifact_root: Path,
    source_root: Path,
    *,
    allow_aurora_pockettts_patches: bool = False,
) -> tuple[dict[str, Any], dict[str, str]]:
    pin = load_sherpa_pin(manifest_path)
    resolved_artifact_root = artifact_root.resolve()
    resolved_source_root = source_root.resolve()
    extraction_relative = _safe_relative_path(pin.get("extraction_path"), "extraction_path")
    expected_source_root = (resolved_artifact_root / extraction_relative).resolve()
    try:
        expected_source_root.relative_to(resolved_artifact_root)
    except ValueError as exc:
        raise SourceIdentityError("sherpa extraction_path escapes the artifact root") from exc
    if resolved_source_root != expected_source_root:
        raise SourceIdentityError(
            f"sherpa source_root must be the pinned extraction path: {expected_source_root}"
        )
    if not resolved_source_root.is_dir():
        raise SourceIdentityError(f"sherpa source directory is missing: {source_root}")

    archive_relative = _safe_relative_path(pin.get("archive_path"), "archive_path")
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
    source_tree_sha, source_entry_count = _verify_extracted_tree(
        archive,
        resolved_source_root,
        allow_aurora_pockettts_patches=allow_aurora_pockettts_patches,
    )

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
        "source_tree_sha256": source_tree_sha,
        "source_entry_count": source_entry_count,
        "aurora_pockettts_patches": allow_aurora_pockettts_patches,
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
    parser.add_argument(
        "--allow-aurora-pockettts-patches",
        action="store_true",
        help="Allow the Aurora PocketTTS patch queue on the verified v1.13.5 tree",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        evidence, build_env = verify_source_identity(
            args.manifest,
            args.artifact_root,
            args.source_root,
            allow_aurora_pockettts_patches=args.allow_aurora_pockettts_patches,
        )
    except (OSError, KeyError, json.JSONDecodeError, SourceIdentityError) as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}), file=sys.stderr)
        return 2

    print(json.dumps(evidence, indent=2, sort_keys=True))
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        return 0
    try:
        validate_cmake_command(command, Path(evidence["source_root"]))
    except SourceIdentityError as exc:
        print(json.dumps({"status": "invalid", "error": str(exc)}), file=sys.stderr)
        return 2
    return subprocess.run(command, env=build_env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Validate the Phase 4 native voice source/model manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tomllib
from pathlib import Path, PureWindowsPath
from typing import Any

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
PLACEHOLDER_RE = re.compile(r"\b(TBD|TODO|PLACEHOLDER|UNKNOWN)\b", re.IGNORECASE)
SELECTED_STATUSES = {"selected"}
BLOCKED_STATUSES = {"blocked"}
REQUIRED_ARTIFACT_FIELDS = (
    "id",
    "kind",
    "role",
    "status",
    "url",
    "version",
    "sha256",
    "size_bytes",
    "archive_path",
    "license",
)
REQUIRED_ARTIFACT_STATUSES = {
    "silero-vad-upstream-v4.0": "selected",
    "vits-piper-en-us-ljspeech-medium": "blocked",
    "kaldi-native-fbank-source-v1.22.3": "selected",
    "kissfft-source-febd4cae": "selected",
    "kaldi-decoder-source-v0.3.0": "selected",
    "kaldifst-source-v1.8.0": "selected",
    "openfst-source-v1.8.5-2026-04-11": "selected",
    "eigen-source-5.0.1": "selected",
    "simple-sentencepiece-source-v0.7": "selected",
    "nlohmann-json-source-v3.12.0": "selected",
    "onnxruntime-linux-x64-release-1.27.1": "selected",
    "cpal-crate-v0.18.1": "selected",
    "piper-phonemize-source-f3ff95af": "blocked",
    "espeak-ng-source-ed530aa1": "blocked",
}
CPAL_ARTIFACT_ID = "cpal-crate-v0.18.1"
CPAL_DOC_PATH = Path("docs/NATIVE_VOICE_RUNTIME_PHASE4.md")
CPAL_LOCK_PATH = Path("rust/Cargo.lock")


class ManifestError(RuntimeError):
    """Raised when the manifest cannot be accepted."""


def default_manifest_path() -> Path:
    return Path(__file__).with_name("phase4_manifest.json")


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(
    data: dict[str, Any],
    artifact_root: Path | None = None,
    repo_root: Path | None = None,
) -> list[str]:
    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")

    declared_required = data.get("policy", {}).get("required_artifact_fields")
    if declared_required != list(REQUIRED_ARTIFACT_FIELDS):
        errors.append("policy.required_artifact_fields must match the validator contract")

    errors.extend(_placeholder_errors(data))
    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("artifacts must be a non-empty list")
    else:
        seen: set[str] = set()
        for index, artifact in enumerate(artifacts):
            path = f"artifacts[{index}]"
            if not isinstance(artifact, dict):
                errors.append(f"{path} must be an object")
                continue
            artifact_id = str(artifact.get("id", f"#{index}"))
            if artifact_id in seen:
                errors.append(f"{path}.id {artifact_id!r} is duplicated")
            seen.add(artifact_id)
            errors.extend(_validate_artifact(artifact, path))
            if artifact_root is not None:
                errors.extend(_validate_local_artifact(artifact, path, artifact_root))

    denials = data.get("policy_denials")
    if not isinstance(denials, list) or not denials:
        errors.append("policy_denials must be a non-empty list")
    else:
        for index, denial in enumerate(denials):
            path = f"policy_denials[{index}]"
            if not isinstance(denial, dict):
                errors.append(f"{path} must be an object")
                continue
            errors.extend(_validate_denial(denial, path))

    for artifact_id, status in REQUIRED_ARTIFACT_STATUSES.items():
        _require_artifact(data, artifact_id, status, errors)
    _require_denial(data, "pockettts-standard-voice-packs", errors)
    _require_denial(data, "sherpa-exported-silero-vad-v4-16k-derivative", errors)
    _require_denial(data, "piper-espeak-tts-runtime-chain", errors)
    if repo_root is not None:
        errors.extend(_validate_cpal_alignment(data, repo_root))
    return errors


def assert_valid_manifest(data: dict[str, Any]) -> None:
    errors = validate_manifest(data)
    if errors:
        raise ManifestError("; ".join(errors))


def _validate_artifact(artifact: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    for field in REQUIRED_ARTIFACT_FIELDS:
        if field not in artifact:
            errors.append(f"{path}.{field} is required")

    status = artifact.get("status")
    if status not in SELECTED_STATUSES | BLOCKED_STATUSES:
        errors.append(f"{path}.status must be selected or blocked")

    sha256 = artifact.get("sha256")
    if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
        errors.append(f"{path}.sha256 must be a lowercase SHA-256 digest")

    size_bytes = artifact.get("size_bytes")
    if not isinstance(size_bytes, int) or size_bytes <= 0:
        errors.append(f"{path}.size_bytes must be a positive integer")

    archive_path = artifact.get("archive_path")
    errors.extend(_validate_relative_path(archive_path, f"{path}.archive_path"))

    url = artifact.get("url")
    if not isinstance(url, str) or not url.startswith(("https://", "git+https://")):
        errors.append(f"{path}.url must be an https URL")

    commit = artifact.get("commit")
    if commit is not None and (not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit)):
        errors.append(f"{path}.commit must be a 40-character lowercase git commit")

    tag_object = artifact.get("tag_object")
    if tag_object is not None and (
        not isinstance(tag_object, str) or not COMMIT_RE.fullmatch(tag_object)
    ):
        errors.append(f"{path}.tag_object must be a 40-character lowercase git object")

    license_info = artifact.get("license")
    if not isinstance(license_info, dict):
        errors.append(f"{path}.license must be an object")
    else:
        errors.extend(_validate_license(license_info, f"{path}.license", status))

    for file_index, contained in enumerate(artifact.get("contained_files", [])):
        contained_path = f"{path}.contained_files[{file_index}]"
        if not isinstance(contained, dict):
            errors.append(f"{contained_path} must be an object")
            continue
        if not contained.get("path"):
            errors.append(f"{contained_path}.path is required")
        contained_sha = contained.get("sha256")
        if not isinstance(contained_sha, str) or not SHA256_RE.fullmatch(contained_sha):
            errors.append(f"{contained_path}.sha256 must be a lowercase SHA-256 digest")
        contained_size = contained.get("size_bytes")
        if not isinstance(contained_size, int) or contained_size <= 0:
            errors.append(f"{contained_path}.size_bytes must be a positive integer")

    return errors


def _validate_license(
    license_info: dict[str, Any], path: str, artifact_status: object
) -> list[str]:
    errors: list[str] = []
    disposition = license_info.get("disposition")
    if artifact_status == "selected" and disposition != "allowed":
        errors.append(f"{path}.disposition must be allowed for selected artifacts")
    if artifact_status == "blocked" and disposition != "blocked":
        errors.append(f"{path}.disposition must be blocked for blocked artifacts")
    if not license_info.get("evidence"):
        errors.append(f"{path}.evidence is required")
    else:
        errors.extend(_validate_relative_path(license_info["evidence"], f"{path}.evidence"))
    if artifact_status == "selected" and not license_info.get("spdx"):
        errors.append(f"{path}.spdx is required for selected artifacts")
    evidence_sha = license_info.get("evidence_sha256")
    if not isinstance(evidence_sha, str) or not SHA256_RE.fullmatch(evidence_sha):
        errors.append(f"{path}.evidence_sha256 must be a lowercase SHA-256 digest")
    return errors


def _validate_local_artifact(artifact: dict[str, Any], path: str, artifact_root: Path) -> list[str]:
    errors: list[str] = []
    archive = _resolve_local_path(
        artifact_root, artifact.get("archive_path"), f"{path}.archive_path", errors
    )
    if archive is not None:
        errors.extend(
            _verify_local_file(
                archive,
                artifact.get("size_bytes"),
                artifact.get("sha256"),
                f"{path}.archive_path",
            )
        )

    license_info = artifact.get("license")
    if isinstance(license_info, dict):
        evidence = _resolve_local_path(
            artifact_root,
            license_info.get("evidence"),
            f"{path}.license.evidence",
            errors,
        )
        if evidence is not None:
            errors.extend(
                _verify_local_file(
                    evidence,
                    None,
                    license_info.get("evidence_sha256"),
                    f"{path}.license.evidence",
                )
            )
    return errors


def _resolve_local_path(root: Path, value: object, path: str, errors: list[str]) -> Path | None:
    if not isinstance(value, str) or not value:
        return None
    relative = Path(value)
    if relative.is_absolute() or PureWindowsPath(value).is_absolute():
        errors.append(f"{path} must be relative to the artifact root")
        return None
    if ".." in relative.parts or ".." in PureWindowsPath(value).parts:
        errors.append(f"{path} escapes the artifact root")
        return None
    resolved_root = root.resolve()
    unresolved = resolved_root / relative
    resolved = unresolved.parent.resolve() / unresolved.name
    try:
        resolved.parent.relative_to(resolved_root)
    except ValueError:
        errors.append(f"{path} escapes the artifact root")
        return None
    return resolved


def _validate_relative_path(value: object, path: str) -> list[str]:
    if not isinstance(value, str) or not value.strip():
        return [f"{path} must be a non-empty relative path"]

    candidate = Path(value)
    if candidate.is_absolute() or PureWindowsPath(value).is_absolute():
        return [f"{path} must be a relative path"]
    if ".." in candidate.parts or ".." in PureWindowsPath(value).parts:
        return [f"{path} must not contain parent traversal"]
    return []


def _verify_local_file(
    file_path: Path,
    expected_size: object,
    expected_sha256: object,
    path: str,
) -> list[str]:
    errors: list[str] = []
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(file_path, flags)
    except OSError as exc:
        return [f"{path} cannot be opened as a regular file: {file_path}: {exc}"]

    try:
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            return [f"{path} is not a regular file: {file_path}"]
        if isinstance(expected_size, int) and file_stat.st_size != expected_size:
            errors.append(
                f"{path} size mismatch: expected {expected_size}, got {file_stat.st_size}"
            )
        if isinstance(expected_sha256, str):
            actual_sha256 = _sha256_descriptor(descriptor)
            if actual_sha256 != expected_sha256:
                errors.append(
                    f"{path} SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}"
                )
    finally:
        os.close(descriptor)
    return errors


def _sha256_descriptor(descriptor: int) -> str:
    digest = hashlib.sha256()
    while chunk := os.read(descriptor, 1024 * 1024):
        digest.update(chunk)
    return digest.hexdigest()


def _validate_denial(denial: dict[str, Any], path: str) -> list[str]:
    errors: list[str] = []
    for field in ("id", "status", "subject", "reason", "license"):
        if not denial.get(field):
            errors.append(f"{path}.{field} is required")
    if denial.get("status") != "blocked":
        errors.append(f"{path}.status must be blocked")
    if not isinstance(denial.get("license"), dict):
        errors.append(f"{path}.license must be an object")
    elif denial["license"].get("disposition") != "blocked":
        errors.append(f"{path}.license.disposition must be blocked")
    sha256 = denial.get("sha256")
    if sha256 is not None and (not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256)):
        errors.append(f"{path}.sha256 must be a lowercase SHA-256 digest")
    size_bytes = denial.get("size_bytes")
    if size_bytes is not None and (not isinstance(size_bytes, int) or size_bytes <= 0):
        errors.append(f"{path}.size_bytes must be a positive integer")
    return errors


def _placeholder_errors(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            errors.extend(_placeholder_errors(item, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            errors.extend(_placeholder_errors(item, f"{path}[{index}]"))
    elif isinstance(value, str) and PLACEHOLDER_RE.search(value):
        errors.append(f"{path} contains a placeholder token")
    return errors


def _require_artifact(
    data: dict[str, Any], artifact_id: str, status: str, errors: list[str]
) -> None:
    for artifact in data.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == artifact_id:
            if artifact.get("status") != status:
                errors.append(f"artifact {artifact_id} must have status {status}")
            return
    errors.append(f"artifact {artifact_id} is required")


def _require_denial(data: dict[str, Any], denial_id: str, errors: list[str]) -> None:
    for denial in data.get("policy_denials", []):
        if isinstance(denial, dict) and denial.get("id") == denial_id:
            if denial.get("status") != "blocked":
                errors.append(f"policy denial {denial_id} must be blocked")
            return
    errors.append(f"policy denial {denial_id} is required")


def _validate_cpal_alignment(data: dict[str, Any], repo_root: Path) -> list[str]:
    errors: list[str] = []
    lock_version, lock_checksum = _read_locked_cpal(repo_root / CPAL_LOCK_PATH)
    expected_version = f"v{lock_version}"
    expected_url = f"https://crates.io/api/v1/crates/cpal/{lock_version}/download"
    expected_archive = f"sources/cpal-{lock_version}.crate"
    expected_license = f"sources/extracted/cpal-{lock_version}/LICENSE"

    artifact = _find_artifact(data, CPAL_ARTIFACT_ID)
    if artifact is None:
        return [f"artifact {CPAL_ARTIFACT_ID} is required for CPAL lockfile alignment"]

    if artifact.get("version") != expected_version:
        errors.append(f"{CPAL_ARTIFACT_ID}.version must match {CPAL_LOCK_PATH}: {expected_version}")
    if artifact.get("sha256") != lock_checksum:
        errors.append(f"{CPAL_ARTIFACT_ID}.sha256 must match {CPAL_LOCK_PATH}: {lock_checksum}")
    if artifact.get("url") != expected_url:
        errors.append(f"{CPAL_ARTIFACT_ID}.url must match crates.io package URL: {expected_url}")
    if artifact.get("archive_path") != expected_archive:
        errors.append(f"{CPAL_ARTIFACT_ID}.archive_path must be {expected_archive}")

    license_info = artifact.get("license")
    if not isinstance(license_info, dict):
        errors.append(f"{CPAL_ARTIFACT_ID}.license must be an object")
    elif license_info.get("evidence") != expected_license:
        errors.append(f"{CPAL_ARTIFACT_ID}.license.evidence must be {expected_license}")

    doc_path = repo_root / CPAL_DOC_PATH
    try:
        doc_text = doc_path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{CPAL_DOC_PATH} cannot be read for CPAL alignment: {exc}")
    else:
        if f"CPAL `v{lock_version}`" not in doc_text:
            errors.append(f"{CPAL_DOC_PATH} must pin CPAL `v{lock_version}`")
        if lock_checksum not in doc_text:
            errors.append(f"{CPAL_DOC_PATH} must include CPAL checksum {lock_checksum}")

    return errors


def _read_locked_cpal(lock_path: Path) -> tuple[str, str]:
    try:
        lock_data = tomllib.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ManifestError(f"{CPAL_LOCK_PATH} cannot be read for CPAL alignment: {exc}") from exc

    for package in lock_data.get("package", []):
        if package.get("name") == "cpal":
            version = package.get("version")
            checksum = package.get("checksum")
            if isinstance(version, str) and isinstance(checksum, str):
                return version, checksum
            break
    raise ManifestError(f"{CPAL_LOCK_PATH} must contain cpal with version and checksum")


def _find_artifact(data: dict[str, Any], artifact_id: str) -> dict[str, Any] | None:
    for artifact in data.get("artifacts", []):
        if isinstance(artifact, dict) and artifact.get("id") == artifact_id:
            return artifact
    return None


def command_validate(args: argparse.Namespace) -> int:
    manifest_path = args.manifest
    data = load_manifest(manifest_path)
    errors = validate_manifest(data, args.artifact_root, _repo_root_from_manifest(manifest_path))
    payload = {
        "manifest": str(manifest_path),
        "status": "valid" if not errors else "invalid",
        "artifact_count": len(data.get("artifacts", [])) if isinstance(data, dict) else 0,
        "denial_count": len(data.get("policy_denials", [])) if isinstance(data, dict) else 0,
        "artifact_root": str(args.artifact_root) if args.artifact_root else None,
        "verified_local": args.artifact_root is not None and not errors,
        "errors": errors,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    if errors:
        return 2
    return 0


def _repo_root_from_manifest(manifest_path: Path) -> Path:
    resolved = manifest_path.resolve()
    for parent in (resolved.parent, *resolved.parents):
        if (parent / CPAL_LOCK_PATH).is_file() and (parent / CPAL_DOC_PATH).is_file():
            return parent
    return Path.cwd()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "manifest",
        nargs="?",
        type=Path,
        default=default_manifest_path(),
        help="Manifest JSON path. Defaults to tools/voice-runtime/phase4_manifest.json.",
    )
    parser.add_argument(
        "--artifact-root",
        type=Path,
        help="Verify declared archives and license evidence beneath this directory.",
    )
    parser.set_defaults(func=command_validate)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (OSError, json.JSONDecodeError, ManifestError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

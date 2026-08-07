#!/usr/bin/env python3
"""Validate the Phase 4 native voice source/model manifest."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
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
    "license",
)


class ManifestError(RuntimeError):
    """Raised when the manifest cannot be accepted."""


def default_manifest_path() -> Path:
    return Path(__file__).with_name("phase4_manifest.json")


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")

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

    _require_artifact(data, "silero-vad-upstream-v4.0", "selected", errors)
    _require_artifact(data, "vits-piper-en-us-ljspeech-medium", "selected", errors)
    _require_denial(data, "pockettts-standard-voice-packs", errors)
    _require_denial(data, "sherpa-exported-silero-vad-v4-16k-derivative", errors)
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
    if artifact_status == "selected" and not license_info.get("spdx"):
        errors.append(f"{path}.spdx is required for selected artifacts")
    evidence_sha = license_info.get("evidence_sha256")
    if evidence_sha is not None and (
        not isinstance(evidence_sha, str) or not SHA256_RE.fullmatch(evidence_sha)
    ):
        errors.append(f"{path}.evidence_sha256 must be a lowercase SHA-256 digest")
    return errors


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


def command_validate(args: argparse.Namespace) -> int:
    manifest_path = args.manifest
    data = load_manifest(manifest_path)
    errors = validate_manifest(data)
    payload = {
        "manifest": str(manifest_path),
        "status": "valid" if not errors else "invalid",
        "artifact_count": len(data.get("artifacts", [])) if isinstance(data, dict) else 0,
        "denial_count": len(data.get("policy_denials", [])) if isinstance(data, dict) else 0,
        "errors": errors,
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    if errors:
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "manifest",
        nargs="?",
        type=Path,
        default=default_manifest_path(),
        help="Manifest JSON path. Defaults to tools/voice-runtime/phase4_manifest.json.",
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

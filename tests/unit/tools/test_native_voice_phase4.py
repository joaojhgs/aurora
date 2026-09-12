from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "tools/voice-runtime/validate_phase4_manifest.py"
MANIFEST = REPO / "tools/voice-runtime/phase4_manifest.json"


def load_validator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("phase4_manifest_validator", CLI)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )


def read_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def test_phase4_manifest_validates_selected_and_blocked_assets() -> None:
    result = run_cli(str(MANIFEST))

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "valid"
    assert payload["artifact_count"] >= 10
    assert payload["denial_count"] == 3


def test_manifest_selects_upstream_silero_and_blocks_piper_ljspeech() -> None:
    manifest = read_manifest()
    artifacts = {item["id"]: item for item in manifest["artifacts"]}
    denials = {item["id"]: item for item in manifest["policy_denials"]}

    silero = artifacts["silero-vad-upstream-v4.0"]
    assert silero["status"] == "selected"
    assert silero["commit"] == "915dd3d639b8333a52e001af095f87c5b7f1e0ac"
    assert silero["tag_object"] == "7a176cc294a2c40615458e50895ed9703782638d"
    assert silero["sha256"] == "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"
    assert silero["license"]["disposition"] == "allowed"

    assert artifacts["onnxruntime-source-v1.27.1"]["license"]["evidence_sha256"] == (
        "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"
    )

    piper = artifacts["vits-piper-en-us-ljspeech-medium"]
    assert piper["status"] == "blocked"
    assert piper["sha256"] == "3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba"
    assert piper["license"]["spdx"] == "Public-Domain"
    assert piper["license"]["disposition"] == "blocked"
    assert "C API evidence only" in piper["notes"]
    espeak = artifacts["espeak-ng-source-ed530aa1"]
    assert espeak["status"] == "blocked"
    assert espeak["license"]["spdx"] == "GPL-3.0-or-later"
    assert {item["path"] for item in piper["contained_files"]} == {
        "en_US-ljspeech-medium.onnx",
        "en_US-ljspeech-medium.onnx.json",
        "espeak-ng-data",
        "tokens.txt",
    }
    piper_files = {item["path"]: item for item in piper["contained_files"]}
    assert piper_files["espeak-ng-data"]["sha256"] == (
        "eb8b19ec00b564ee1725efe626775ae20deef533a43be16d8f9310077daf5cb3"
    )

    assert denials["pockettts-standard-voice-packs"]["status"] == "blocked"
    assert "non-commercial" in denials["pockettts-standard-voice-packs"]["reason"]
    assert denials["piper-espeak-tts-runtime-chain"]["status"] == "blocked"
    assert "GPL-3.0-or-later" in denials["piper-espeak-tts-runtime-chain"]["reason"]
    assert denials["sherpa-exported-silero-vad-v4-16k-derivative"]["status"] == "blocked"
    assert (
        denials["sherpa-exported-silero-vad-v4-16k-derivative"]["sha256"]
        == "9e2449b0656e4cd9355e6ccfa27e2f1196fbacbe01065916ae426246fe40e55d"
    )


def test_manifest_pins_correct_native_release_urls_and_contained_sizes() -> None:
    manifest = read_manifest()
    artifacts = {item["id"]: item for item in manifest["artifacts"]}

    assert artifacts["onnxruntime-android-1.27.1"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.1/"
        "onnxruntime-android-1.27.1.zip"
    )
    assert artifacts["onnxruntime-ios-static-xcframework-1.27.1"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.1/"
        "onnxruntime-ios-static-xcframework-1.27.1.zip"
    )
    assert artifacts["onnxruntime-wasm-static-lib-simd-1.27.1"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.1/"
        "onnxruntime-wasm-static_lib-simd-1.27.1.zip"
    )
    moonshine = artifacts["moonshine-tiny-en-quantized-2026-02-27"]
    assert moonshine["license"]["evidence_sha256"] == (
        "6148d7574a6554b7379b633cfd4c4fe5840c3f548d13bc83e00b52dc6fa00abd"
    )
    assert artifacts["sherpa-onnx-android-1.13.5"]["url"].endswith(
        "/sherpa-onnx-v1.13.5-android.tar.bz2"
    )
    assert artifacts["sherpa-onnx-ios-source-v1.13.5"]["url"].endswith(
        "/sherpa-onnx/archive/refs/tags/v1.13.5.tar.gz"
    )
    kws = artifacts["sherpa-kws-gigaspeech-2024-01-01"]
    assert kws["url"].endswith("/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2")
    assert "-mobile" not in kws["id"]
    assert kws["sha256"] == "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
    assert kws["contained_files"][0]["sha256"] == (
        "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678"
    )

    cpal = artifacts["cpal-crate-v0.18.2"]
    assert cpal["kind"] == "crate"
    assert cpal["version"] == "v0.18.2"
    assert cpal["url"] == "https://crates.io/api/v1/crates/cpal/0.18.2/download"
    assert cpal["sha256"] == "6f02e8d0327b42d3e2e4ab2119af397344eb9fc54a34bf0ddeaa1277af8681f1"
    assert cpal["size_bytes"] == 233947
    assert cpal["archive_path"] == "sources/cpal-0.18.2.crate"
    assert cpal["license"]["spdx"] == "Apache-2.0"
    assert cpal["license"]["evidence"] == "sources/extracted/cpal-0.18.2/LICENSE"
    assert cpal["license"]["evidence_sha256"] == (
        "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    )

    for artifact in artifacts.values():
        assert artifact["archive_path"]
        assert len(artifact["license"]["evidence_sha256"]) == 64
        for contained in artifact.get("contained_files", []):
            assert contained["path"]
            assert contained["size_bytes"] > 0
            assert len(contained["sha256"]) == 64


@pytest.mark.parametrize(
    ("field", "value", "expected"),
    [
        ("sha256", "TBD", "placeholder token"),
        ("sha256", "0" * 63, "lowercase SHA-256"),
        ("size_bytes", 0, "positive integer"),
    ],
)
def test_validator_rejects_missing_or_placeholder_artifact_metadata(
    tmp_path: Path, field: str, value: object, expected: str
) -> None:
    manifest = read_manifest()
    manifest["artifacts"][0][field] = value
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli(str(broken))

    assert result.returncode == 2
    assert expected in result.stdout


def test_validator_rejects_selected_artifacts_without_explicit_allowed_license(
    tmp_path: Path,
) -> None:
    manifest = read_manifest()
    manifest["artifacts"][0]["license"].pop("spdx")
    broken = tmp_path / "missing-license.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli(str(broken))

    assert result.returncode == 2
    assert "license.spdx is required" in result.stdout


def test_validator_rejects_contained_files_without_positive_size(tmp_path: Path) -> None:
    manifest = read_manifest()
    moonshine = next(
        artifact
        for artifact in manifest["artifacts"]
        if artifact["id"] == "moonshine-tiny-en-quantized-2026-02-27"
    )
    moonshine["contained_files"][0].pop("size_bytes")
    broken = tmp_path / "missing-contained-size.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli(str(broken))

    assert result.returncode == 2
    assert "contained_files[0].size_bytes must be a positive integer" in result.stdout


def test_validator_rejects_missing_required_denials(tmp_path: Path) -> None:
    manifest = read_manifest()
    manifest["policy_denials"] = [
        item
        for item in manifest["policy_denials"]
        if item["id"] != "pockettts-standard-voice-packs"
    ]
    broken = tmp_path / "missing-denial.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    validator = load_validator()
    errors = validator.validate_manifest(manifest)

    assert "policy denial pockettts-standard-voice-packs is required" in errors

    result = run_cli(str(broken))
    assert result.returncode == 2
    assert "policy denial pockettts-standard-voice-packs is required" in result.stdout


def test_validator_requires_complete_transitive_source_inventory() -> None:
    validator = load_validator()
    manifest = read_manifest()
    manifest["artifacts"] = [
        artifact
        for artifact in manifest["artifacts"]
        if artifact["id"] != "kaldi-native-fbank-source-v1.22.3"
    ]

    errors = validator.validate_manifest(manifest)

    assert "artifact kaldi-native-fbank-source-v1.22.3 is required" in errors


def test_validator_rejects_cpal_manifest_drift_from_rust_lockfile(tmp_path: Path) -> None:
    validator = load_validator()
    manifest = read_manifest()
    cpal = next(
        artifact for artifact in manifest["artifacts"] if artifact["id"].startswith("cpal-")
    )
    cpal["version"] = "v0.17.3"
    cpal["sha256"] = "0" * 64
    cpal["archive_path"] = "sources/cpal-0.17.3.tar.gz"
    cpal["license"]["evidence"] = "sources/extracted/cpal-0.17.3/LICENSE"
    broken = tmp_path / "cpal-drift.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    errors = validator.validate_manifest(manifest, repo_root=REPO)

    assert "cpal-crate-v0.18.2.version must match rust/Cargo.lock: v0.18.2" in errors
    assert any("cpal-crate-v0.18.2.sha256 must match rust/Cargo.lock" in error for error in errors)
    assert "cpal-crate-v0.18.2.archive_path must be sources/cpal-0.18.2.crate" in errors
    assert (
        "cpal-crate-v0.18.2.license.evidence must be sources/extracted/cpal-0.18.2/LICENSE"
        in errors
    )

    result = run_cli(str(broken))
    assert result.returncode == 2
    assert "cpal-crate-v0.18.2.version must match rust/Cargo.lock" in result.stdout


def test_validator_rejects_cpal_doc_drift_from_rust_lockfile(tmp_path: Path) -> None:
    validator = load_validator()
    manifest = read_manifest()
    repo = tmp_path / "repo"
    (repo / "rust").mkdir(parents=True)
    (repo / "docs").mkdir()
    (repo / "rust/Cargo.lock").write_text((REPO / "rust/Cargo.lock").read_text(), encoding="utf-8")
    (repo / "docs/NATIVE_VOICE_RUNTIME_PHASE4.md").write_text(
        "| CPAL crates.io package | `v0.17.3` | registry checksum `0` |\n",
        encoding="utf-8",
    )

    errors = validator.validate_manifest(manifest, repo_root=repo)

    assert "docs/NATIVE_VOICE_RUNTIME_PHASE4.md must pin CPAL `v0.18.2`" in errors
    assert any(
        "docs/NATIVE_VOICE_RUNTIME_PHASE4.md must include CPAL checksum" in error
        for error in errors
    )


def test_local_artifact_verifier_checks_hash_size_and_root_containment(
    tmp_path: Path,
) -> None:
    validator = load_validator()
    archive = tmp_path / "asset.bin"
    license_file = tmp_path / "LICENSE"
    archive.write_bytes(b"voice-runtime")
    license_file.write_bytes(b"license")
    artifact = {
        "archive_path": "asset.bin",
        "size_bytes": archive.stat().st_size,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "license": {
            "evidence": "LICENSE",
            "evidence_sha256": hashlib.sha256(license_file.read_bytes()).hexdigest(),
        },
    }

    assert validator._validate_local_artifact(artifact, "artifact", tmp_path) == []

    artifact["sha256"] = "0" * 64
    errors = validator._validate_local_artifact(artifact, "artifact", tmp_path)
    assert any("SHA-256 mismatch" in error for error in errors)

    artifact["archive_path"] = "../outside.bin"
    errors = validator._validate_local_artifact(artifact, "artifact", tmp_path)
    assert any("escapes the artifact root" in error for error in errors)


def test_structural_validator_rejects_absolute_and_parent_paths() -> None:
    validator = load_validator()
    manifest = read_manifest()
    manifest["artifacts"][0]["archive_path"] = "/tmp/source.tar.gz"
    manifest["artifacts"][1]["license"]["evidence"] = "licenses/../LICENSE"

    errors = validator.validate_manifest(manifest)

    assert any("archive_path must be a relative path" in error for error in errors)
    assert any("license.evidence must not contain parent traversal" in error for error in errors)


def test_local_artifact_verifier_rejects_symlink_files(tmp_path: Path) -> None:
    validator = load_validator()
    real_archive = tmp_path / "real.bin"
    archive = tmp_path / "asset.bin"
    license_file = tmp_path / "LICENSE"
    real_archive.write_bytes(b"voice-runtime")
    archive.symlink_to(real_archive.name)
    license_file.write_bytes(b"license")
    artifact = {
        "archive_path": archive.name,
        "size_bytes": real_archive.stat().st_size,
        "sha256": hashlib.sha256(real_archive.read_bytes()).hexdigest(),
        "license": {
            "evidence": license_file.name,
            "evidence_sha256": hashlib.sha256(license_file.read_bytes()).hexdigest(),
        },
    }

    errors = validator._validate_local_artifact(artifact, "artifact", tmp_path)

    assert any("cannot be opened as a regular file" in error for error in errors)

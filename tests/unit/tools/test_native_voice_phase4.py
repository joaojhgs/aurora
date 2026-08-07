from __future__ import annotations

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
    assert payload["denial_count"] == 2


def test_manifest_selects_upstream_silero_and_piper_ljspeech() -> None:
    manifest = read_manifest()
    artifacts = {item["id"]: item for item in manifest["artifacts"]}
    denials = {item["id"]: item for item in manifest["policy_denials"]}

    silero = artifacts["silero-vad-upstream-v4.0"]
    assert silero["status"] == "selected"
    assert silero["commit"] == "915dd3d639b8333a52e001af095f87c5b7f1e0ac"
    assert silero["tag_object"] == "7a176cc294a2c40615458e50895ed9703782638d"
    assert silero["sha256"] == "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"
    assert silero["license"]["disposition"] == "allowed"

    piper = artifacts["vits-piper-en-us-ljspeech-medium"]
    assert piper["status"] == "selected"
    assert piper["sha256"] == "3dfb4b759d8be032a4903a9538d128b0fda2a06ab1de6cbc2d93a97e2dd83dba"
    assert piper["license"]["spdx"] == "Public-Domain"
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
    assert denials["sherpa-exported-silero-vad-v4-16k-derivative"]["status"] == "blocked"
    assert (
        denials["sherpa-exported-silero-vad-v4-16k-derivative"]["sha256"]
        == "9e2449b0656e4cd9355e6ccfa27e2f1196fbacbe01065916ae426246fe40e55d"
    )


def test_manifest_pins_correct_native_release_urls_and_contained_sizes() -> None:
    manifest = read_manifest()
    artifacts = {item["id"]: item for item in manifest["artifacts"]}

    assert artifacts["onnxruntime-android-1.27.0"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.0/"
        "onnxruntime-android-1.27.0.zip"
    )
    assert artifacts["onnxruntime-ios-static-xcframework-1.27.0"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.0/"
        "onnxruntime-ios-static-xcframework-1.27.0.zip"
    )
    assert artifacts["onnxruntime-wasm-static-lib-simd-1.27.0"]["url"] == (
        "https://github.com/csukuangfj/onnxruntime-libs/releases/download/v1.27.0/"
        "onnxruntime-wasm-static_lib-simd-1.27.0.zip"
    )
    assert artifacts["sherpa-onnx-android-1.13.4"]["url"].endswith(
        "/sherpa-onnx-v1.13.4-android.tar.bz2"
    )
    assert artifacts["sherpa-onnx-ios-static-xcframework-1.13.4"]["url"].endswith(
        "/sherpa-onnx-v1.13.4-ios.xcframework.zip"
    )
    kws = artifacts["sherpa-kws-gigaspeech-2024-01-01"]
    assert kws["url"].endswith(
        "/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2"
    )
    assert "-mobile" not in kws["id"]
    assert kws["sha256"] == "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a"
    assert kws["contained_files"][0]["sha256"] == (
        "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678"
    )

    cpal = artifacts["cpal-source-v0.17.3"]
    assert cpal["license"]["spdx"] == "Apache-2.0"
    assert cpal["license"]["evidence_sha256"] == (
        "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    )

    for artifact in artifacts.values():
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
    manifest["artifacts"][9]["contained_files"][0].pop("size_bytes")
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

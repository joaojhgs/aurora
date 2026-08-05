from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "tools/pockettts-raven/raven_gate.py"
MANIFEST = REPO / "tests/fixtures/local_speech/raven/pinned_raven_manifest.json"
BENCH = REPO / "tests/fixtures/local_speech/raven/sample_runtime_benchmark.json"
TOKENIZER_VECTORS = REPO / "tests/fixtures/local_speech/raven/tokenizer_parity_vectors.json"


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_manifest_validates_pinned_sources_and_required_packs() -> None:
    result = run_cli("manifest", str(MANIFEST))

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "hash-pinned-candidate-blocked"
    assert payload["manifest"] == "tests/fixtures/local_speech/raven/pinned_raven_manifest.json"
    assert payload["required_packs"] == ["english_2026-04", "french_24l", "portuguese"]
    assert payload["readiness"]["hash_pinned"] is True
    assert payload["readiness"]["unpinned_asset_count"] == 0
    assert payload["readiness"]["release_ready"] is False
    assert payload["readiness"]["candidate_input_packs"] == [
        "english_2026-04",
        "french_24l",
        "portuguese",
    ]
    assert {
        item["gate"] for item in payload["readiness"]["release_blockers"] if "gate" in item
    } == {
        "official_source_provenance",
        "license_review",
        "conversion_equivalence",
        "browser_runtime",
        "mobile_runtime",
        "thermal_measurement",
        "cancellation_stale_audio",
    }


def test_manifest_rejects_mutable_or_non_commit_huggingface_urls(tmp_path: Path) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest["packs"]["english_2026-04"]["conversion"]["command"] = (
        "BUNDLE_URL=https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/main/onnx/english_2026-04 "
        "./tools/prepare_models.sh --web"
    )
    mutable = tmp_path / "mutable.json"
    mutable.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli("manifest", str(mutable))

    assert result.returncode == 2
    assert "resolve/main" in result.stderr

    manifest["packs"]["english_2026-04"]["conversion"]["command"] = (
        "BUNDLE_URL=https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/not-a-commit/onnx/english_2026-04 "
        "./tools/prepare_models.sh --web"
    )
    non_commit = tmp_path / "non-commit.json"
    non_commit.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli("manifest", str(non_commit))

    assert result.returncode == 2
    assert "40-character commit" in result.stderr


def test_french_24l_requires_graph_derived_tail_patch_and_counts(tmp_path: Path) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    french = manifest["packs"]["french_24l"]["conversion"]

    assert french["observed_attention_tail_replacements"] == 24
    assert french["observed_state_slots"] == 72
    patch = REPO / french["layer_inference_patch"]["path"]
    assert patch.is_file()
    assert french["layer_inference_patch"]["sha256"] == sha256_file(patch)

    french["observed_attention_tail_replacements"] = 6
    broken = tmp_path / "broken-french.json"
    broken.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_cli("manifest", str(broken))

    assert result.returncode == 2
    assert "observed_attention_tail_replacements must be 24" in result.stderr


def test_conversion_dry_run_reports_missing_assets_without_claiming_reproduction() -> None:
    result = run_cli(
        "conversion",
        "--manifest",
        str(MANIFEST),
        "--pack",
        "english_2026-04",
        "--source-root",
        str(REPO / ".artifacts/pockettts/w0-raven/source-assets"),
        "--dry-run",
    )

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["first_failure"]["reason"] == "missing"
    assert payload["first_failure"]["expected_path"].startswith(
        ".artifacts/pockettts/w0-raven/source-assets"
    )
    assert str(REPO) not in result.stdout
    assert str(Path.home()) not in result.stdout
    assert "conversion not reproduced" in payload["claim"]


def test_fixture_benchmark_report_is_schema_only_not_release_evidence() -> None:
    result = run_cli(
        "benchmark", "--manifest", str(MANIFEST), "--pack", "english_2026-04", "--input", str(BENCH)
    )

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "schema-only"
    assert payload["release_evidence"] is False
    assert payload["first_failure"]["reason"] == "non_release_evidence_kind"
    assert payload["rtf"] == 0.9
    assert payload["metrics"]["cancelled_stale_audio"] is False


def test_measured_benchmark_requires_real_provenance(tmp_path: Path) -> None:
    report = tmp_path / "measured.json"
    report.write_text(
        json.dumps(
            {
                "evidence_kind": "measured",
                "first_audio_ms": 800,
                "audio_duration_ms": 10000,
                "generation_ms": 9000,
                "peak_memory_mb": 512,
                "download_bytes": 70254592,
                "cancelled_stale_audio": False,
                "device": "fixture",
                "browser_or_runtime": "fixture",
                "thermal": "not-measured",
                "source_commit": "1de0f10",
                "artifact_sha256": "0" * 64,
            }
        ),
        encoding="utf-8",
    )

    result = run_cli(
        "benchmark",
        "--manifest",
        str(MANIFEST),
        "--pack",
        "english_2026-04",
        "--input",
        str(report),
    )

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "blocked"
    assert payload["first_failure"]["reason"] == "invalid_measurement_provenance"


def test_provenance_review_exits_nonzero_and_redacts_paths(tmp_path: Path) -> None:
    missing_sibling = tmp_path / "missing-sibling"
    missing_upstream = tmp_path / "missing-upstream"

    result = run_cli(
        "provenance",
        "--manifest",
        str(MANIFEST),
        "--sibling",
        str(missing_sibling),
        "--upstream",
        str(missing_upstream),
    )

    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert payload["status"] == "review"
    assert str(REPO) not in result.stdout
    assert str(Path.home()) not in result.stdout


def test_french_24l_is_not_labeled_compact() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))

    assert manifest["packs"]["french_24l"]["layers"] == 24
    assert manifest["packs"]["french_24l"]["state_slots"] == 72
    assert manifest["packs"]["french_24l"]["claims_compact"] is False


def test_tokenizer_parity_vectors_are_pack_specific_and_hash_bound() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    fixture = json.loads(TOKENIZER_VECTORS.read_text(encoding="utf-8"))

    assert fixture["schema_version"] == 1
    assert sorted(fixture["packs"]) == ["french_24l", "portuguese"]

    for pack_id, pack_fixture in fixture["packs"].items():
        manifest_assets = manifest["packs"][pack_id]["assets"]
        assert (
            pack_fixture["tokenizer_model_sha256"] == manifest_assets["tokenizer.model"]["sha256"]
        )
        assert (
            pack_fixture["derived_spm_vocab_sha256"] == manifest_assets["spm_vocab.json"]["sha256"]
        )
        assert pack_fixture["vector_count"] == len(pack_fixture["vectors"]) == 7
        assert any("12,50" in vector["text"] for vector in pack_fixture["vectors"])
        assert any(
            "l'h" in vector["text"] or "l\u2019" in vector["text"]
            for vector in pack_fixture["vectors"]
        )
        assert any(
            "\t" in vector["text"] and "\n" in vector["text"] for vector in pack_fixture["vectors"]
        )
        byte_vector = next(
            vector
            for vector in pack_fixture["vectors"]
            if vector["text"].startswith("Byte fallback:")
        )
        assert 4 in byte_vector["ids"]
        assert {243, 244}.issubset(set(byte_vector["ids"]))

    portuguese_ids = fixture["packs"]["portuguese"]["vectors"][0]["ids"]
    french_ids = fixture["packs"]["french_24l"]["vectors"][0]["ids"]
    assert portuguese_ids != french_ids


def test_tokenizer_parity_vectors_match_native_sentencepiece_when_assets_are_present() -> None:
    spm = pytest.importorskip("sentencepiece")
    source_root = REPO / ".artifacts/pockettts/w0-raven/community-mirror"
    if not source_root.exists():
        pytest.skip("ignored Raven tokenizer assets are not present")
    fixture = json.loads(TOKENIZER_VECTORS.read_text(encoding="utf-8"))

    for pack_id, pack_fixture in fixture["packs"].items():
        tokenizer_model = source_root / pack_id / "assets/tokenizer.model"
        derived_vocab = source_root / pack_id / "derived_spm_vocab.json"
        if not tokenizer_model.exists() or not derived_vocab.exists():
            pytest.skip(f"ignored Raven tokenizer assets are not present for {pack_id}")
        assert sha256_file(tokenizer_model) == pack_fixture["tokenizer_model_sha256"]
        assert sha256_file(derived_vocab) == pack_fixture["derived_spm_vocab_sha256"]
        processor = spm.SentencePieceProcessor(model_file=str(tokenizer_model))
        for vector in pack_fixture["vectors"]:
            assert processor.encode(vector["text"], out_type=int) == vector["ids"]

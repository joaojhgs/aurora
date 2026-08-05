from __future__ import annotations

import json
import tomllib
from pathlib import Path

from scripts.speech_runtime_abi import cli


def _write_project(root: Path, optional: dict[str, list[str]], lock_optional: dict[str, list[dict[str, str]]] | None = None) -> None:
    optional_lines = []
    for extra, requirements in optional.items():
        optional_lines.append(f"{extra!r} = [")
        optional_lines.extend(f"  {requirement!r}," for requirement in requirements)
        optional_lines.append("]")
    (root / "pyproject.toml").write_text(
        "\n".join(
            [
                "[project]",
                "name = 'fixture'",
                "version = '0.0.0'",
                "[project.optional-dependencies]",
                *optional_lines,
                "",
            ]
        ),
        encoding="utf-8",
    )
    if lock_optional is not None:
        (root / "uv.lock").write_text(
            "version = 1\nrevision = 1\n[[package]]\n"
            + "\n".join(
                [
                    'name = "aurora"',
                    'version = "0.0.0"',
                    "[package.optional-dependencies]",
                    *(
                        f"{extra!r} = ["
                        + ", ".join(f"{{ name = {dep['name']!r} }}" for dep in deps)
                        + "]"
                        for extra, deps in lock_optional.items()
                    ),
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))


def test_scan_accepts_test_only_benchmark_dependency(tmp_path: Path) -> None:
    _write_project(
        tmp_path,
        {
            "runtime": ["numpy==2.2.6"],
            "test-performance": ["pytest-benchmark"],
        },
        {"runtime": [{"name": "numpy"}], "test-performance": [{"name": "pytest-benchmark"}]},
    )

    results = {result.id: result for result in cli.scan_manifests(tmp_path)}

    assert results["pyproject.benchmark_training_release_leak"].status == "pass"
    assert results["uv_lock.benchmark_training_release_leak"].status == "pass"


def test_scan_rejects_non_exact_numpy_pin(tmp_path: Path) -> None:
    _write_project(
        tmp_path,
        {
            "runtime": ["numpy>=2"],
            "service-stt-wakeword": ["numpy==2.2.6"],
        },
        {"runtime": [{"name": "numpy"}]},
    )

    results = {result.id: result for result in cli.scan_manifests(tmp_path)}

    numpy_result = results["pyproject.numpy_2_2_6_pin"]
    assert numpy_result.status == "failure"
    assert numpy_result.detail["issues"] == {"runtime": ["numpy>=2"]}


def test_scan_rejects_realtimestt_and_release_benchmark_leak(tmp_path: Path) -> None:
    _write_project(
        tmp_path,
        {
            "runtime": ["RealtimeSTT==0.3.94", "pytest-benchmark"],
            "service-tts": ["opencv-python"],
        },
        {"runtime": [{"name": "realtimestt"}, {"name": "pytest-benchmark"}]},
    )

    results = {result.id: result for result in cli.scan_manifests(tmp_path)}

    assert results["pyproject.realtimestt_openrecall_ocr_absent"].status == "failure"
    assert results["pyproject.benchmark_training_release_leak"].status == "failure"
    assert (
        results["uv_lock.optional_realtimestt_openrecall_ocr_absent"].status
        == "failure"
    )


def test_scan_rejects_training_dependency_release_leak(tmp_path: Path) -> None:
    _write_project(
        tmp_path,
        {
            "runtime": ["livekit-wakeword"],
            "test-performance": ["pytest-benchmark"],
        },
        {"runtime": [{"name": "livekit-wakeword"}]},
    )

    results = {result.id: result for result in cli.scan_manifests(tmp_path)}

    assert results["pyproject.benchmark_training_release_leak"].status == "failure"
    assert results["uv_lock.benchmark_training_release_leak"].status == "failure"


def test_probe_reports_missing_optional_for_absent_module() -> None:
    result = cli.run_probe(
        {
            "id": "definitely_missing",
            "module": "definitely_missing_aurora_module",
            "required": False,
            "code": "detail = {}",
        },
        timeout=1.0,
        expected_numpy="2.2.6",
    )

    assert result.status == "missing_optional"


def test_hf_reference_parser_extracts_repo_file_and_revision() -> None:
    ref = (
        "hf://kyutai/pocket-tts/languages/english/model.safetensors"
        "@39592ff23c9ef80098bb74895d104c26275fe2c9"
    )

    assert cli._hf_reference(ref) == {
        "repo_id": "kyutai/pocket-tts",
        "filename": "languages/english/model.safetensors",
        "revision": "39592ff23c9ef80098bb74895d104c26275fe2c9",
    }


def test_expected_pockettts_config_set_is_exact() -> None:
    assert sorted(cli.EXPECTED_POCKET_TTS_CONFIG_FILES) == [
        "english.yaml",
        "english_2026-01.yaml",
        "english_2026-04.yaml",
        "french_24l.yaml",
        "german.yaml",
        "german_24l.yaml",
        "italian.yaml",
        "italian_24l.yaml",
        "portuguese.yaml",
        "portuguese_24l.yaml",
        "spanish.yaml",
        "spanish_24l.yaml",
    ]


def test_pockettts_validation_rejects_empty_finite_audio() -> None:
    failure = cli._pockettts_validation_failure(
        {
            "finite_audio": {"finite": True, "numel": 0},
            "stream_audio": {"chunk_count": 1, "total_numel": 12, "all_finite": True},
        }
    )

    assert failure is not None
    assert failure["stage"] == "finite_audio_validation"


def test_pockettts_validation_rejects_missing_or_nonfinite_stream() -> None:
    missing_failure = cli._pockettts_validation_failure(
        {
            "finite_audio": {"finite": True, "numel": 12},
            "stream_audio": {"chunk_count": 0, "total_numel": 0, "all_finite": True},
        }
    )
    nonfinite_failure = cli._pockettts_validation_failure(
        {
            "finite_audio": {"finite": True, "numel": 12},
            "stream_audio": {"chunk_count": 1, "total_numel": 12, "all_finite": False},
        }
    )

    assert missing_failure is not None
    assert missing_failure["stage"] == "stream_audio_validation"
    assert nonfinite_failure is not None
    assert nonfinite_failure["stage"] == "stream_audio_validation"


def test_pockettts_validation_rejects_failed_config_smoke() -> None:
    failure = cli._pockettts_validation_failure(
        {
            "finite_audio": {"finite": True, "numel": 12},
            "stream_audio": {"chunk_count": 1, "total_numel": 12, "all_finite": True},
            "config_smoke": [
                {"language": "english", "status": "pass"},
                {"language": "german", "status": "failure"},
            ],
        }
    )

    assert failure is not None
    assert failure["stage"] == "config_smoke_validation"
    assert failure["failed_configs"] == ["german"]


def test_pockettts_config_smoke_continues_after_failure(monkeypatch) -> None:
    class FakeModel:
        sample_rate = 24000
        has_voice_cloning = False
        config = None

    class FakeTTSModel:
        calls: list[str] = []

        @classmethod
        def load_model(cls, language: str, quantize: bool):
            assert quantize is False
            cls.calls.append(language)
            if language == "broken":
                raise RuntimeError("boom")
            return FakeModel()

    monkeypatch.setattr(
        cli,
        "EXPECTED_POCKET_TTS_CONFIG_FILES",
        {"alpha.yaml", "broken.yaml", "charlie.yaml"},
    )

    results = cli._smoke_pockettts_configs(FakeTTSModel)

    assert FakeTTSModel.calls == ["alpha", "broken", "charlie"]
    assert [result["status"] for result in results] == ["pass", "failure", "pass"]


def test_report_writer_redacts_home_and_cwd(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    report = cli.build_report(
        "manifest_scan",
        [cli.CheckResult(id="path", status="pass", detail={"value": str(tmp_path / "secret")})],
        tmp_path,
    )
    output = tmp_path / "report.json"

    cli.write_report(report, output)

    payload = json.loads(output.read_text(encoding="utf-8"))
    assert "$REPO" in payload["results"][0]["detail"]["value"]

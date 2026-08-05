from __future__ import annotations

import io
import json
import tarfile
import tomllib
import zipfile
from pathlib import Path

from scripts.speech_runtime_abi import cli


def _write_project(
    root: Path,
    optional: dict[str, list[str]],
    lock_optional: dict[str, list[dict[str, str]]] | None = None,
) -> None:
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
    assert results["uv_lock.optional_realtimestt_openrecall_ocr_absent"].status == "failure"


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


def test_artifact_scan_detects_nested_archive_model_weight_path(tmp_path: Path) -> None:
    inner = tmp_path / "inner.zip"
    with zipfile.ZipFile(inner, "w") as archive:
        archive.writestr("models/voice_embedding.safetensors", b"safe placeholder")
    outer = tmp_path / "outer.zip"
    with zipfile.ZipFile(outer, "w") as archive:
        archive.write(inner, "nested/inner.zip")

    result = cli.scan_artifacts(
        [outer],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    finding_paths = {finding["path"] for finding in result.detail["findings"]}
    assert "outer.zip!nested/inner.zip!models/voice_embedding.safetensors" in finding_paths


def test_artifact_scan_rejects_unsafe_archive_paths(tmp_path: Path) -> None:
    archive_path = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("../escape.txt", b"nope")

    result = cli.scan_artifacts(
        [archive_path],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["limit_failures"] == [
        {"path": "bad.zip!../escape.txt", "reason": "unsafe_archive_member_path"}
    ]


def test_artifact_scan_detects_binary_needles(tmp_path: Path) -> None:
    binary = tmp_path / "bundle.bin"
    binary.write_bytes(b"\x00\x01livekit-wakeword\x00")

    result = cli.scan_artifacts(
        [binary],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert {finding["rule_id"] for finding in result.detail["findings"]} == {
        "dependency.livekit",
        "dependency.livekit_wakeword",
    }


def test_artifact_scan_fails_closed_on_member_scan_limit(tmp_path: Path) -> None:
    archive_path = tmp_path / "large.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("assets/blob.bin", b"0123456789")

    result = cli.scan_artifacts(
        [archive_path],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(max_content_scan_bytes=4),
    )[0]

    assert result.status == "failure"
    reasons = {failure["reason"] for failure in result.detail["limit_failures"]}
    assert "archive_member_content_scan_truncated" in reasons


def test_artifact_scan_detects_blocked_release_dependency_text(tmp_path: Path) -> None:
    requirements = tmp_path / "requirements.txt"
    requirements.write_text("sherpa-onnx==1.10.0\n", encoding="utf-8")

    result = cli.scan_artifacts(
        [requirements],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["category"] == "benchmark_or_training_only_dependency"


def test_artifact_package_block_rules_cover_every_training_only_package() -> None:
    rule_ids = {rule["id"] for rule in cli.ARTIFACT_PACKAGE_BLOCK_RULES}

    assert rule_ids == {
        f"dependency.{package.replace('-', '_')}"
        for package in cli.BENCHMARK_OR_TRAINING_ONLY_PACKAGES
    }


def test_artifact_scan_detects_generic_livekit_release_dependency(tmp_path: Path) -> None:
    closure = tmp_path / "closure.txt"
    closure.write_text("livekit==1.0.0\n", encoding="utf-8")

    result = cli.scan_artifacts(
        [closure],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["rule_id"] == "dependency.livekit"


def test_artifact_scan_detects_model_extension_without_name_token(tmp_path: Path) -> None:
    model = tmp_path / "en_us.onnx"
    model.write_bytes(b"placeholder")

    result = cli.scan_artifacts(
        [model],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["rule_id"] == "asset.model_or_voice_weight_extension"


def test_artifact_scan_detects_audio_dataset_input_extension(tmp_path: Path) -> None:
    sample = tmp_path / "sample.wav"
    sample.write_bytes(b"RIFFplaceholder")

    result = cli.scan_artifacts(
        [sample],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["rule_id"] == "asset.audio_dataset_input"


def test_artifact_scan_detects_secrets_without_leaking_secret_values(tmp_path: Path) -> None:
    secret_file = tmp_path / "env.txt"
    secret_file.write_text(
        "\n".join(
            [
                "OPENAI_API_KEY=sk-test-secret-value-should-not-appear",
                "Authorization: Bearer sk-test-bearer-value-should-not-appear",
                "token=abcdef1234567890abcdef1234567890",
                "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                "-----BEGIN PRIVATE KEY-----",
            ]
        ),
        encoding="utf-8",
    )

    result = cli.scan_artifacts(
        [secret_file],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    finding = result.detail["findings"][0]
    assert finding["rule_id"] == "secret.release_credentials"
    assert set(finding["matches"]) >= {
        "authorization_bearer",
        "generic_secret_assignment",
        "named_credential_assignment",
        "openai_api_key",
        "private_key",
    }
    assert "sk-test-secret-value" not in json.dumps(finding)
    assert "wJalrXUtnFEMI" not in json.dumps(finding)


def test_artifact_scan_detects_named_credentials_inside_archive(tmp_path: Path) -> None:
    archive_path = tmp_path / "secrets.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(
            "env/.env",
            "\n".join(
                [
                    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
                    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
                    "SERVICE_PASSWORD=AuroraSecret1234567890Value",
                ]
            ),
        )

    result = cli.scan_artifacts(
        [archive_path],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    findings = result.detail["findings"]
    assert {finding["path"] for finding in findings} == {
        "secrets.zip",
        "secrets.zip!env/.env",
    }
    finding = next(item for item in findings if item["path"] == "secrets.zip!env/.env")
    assert finding["rule_id"] == "secret.release_credentials"
    assert set(finding["matches"]) >= {
        "github_token",
        "named_credential_assignment",
    }
    serialized = json.dumps(findings)
    assert "ghp_abcdefghijklmnopqrstuvwxyz" not in serialized
    assert "wJalrXUtnFEMI" not in serialized


def test_artifact_scan_allows_ordinary_source_and_config_key_names(tmp_path: Path) -> None:
    source = tmp_path / "app.js"
    source.write_text(
        "\n".join(
            [
                "const apiKey = process.env.AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY?.trim()",
                "const token = extractMeshInviteToken(trimmed)",
                "flags.password = this._list.readUInt8(this._pos)",
                '{"accessKeyLabel": "Access key", "tokenState": "pending"}',
            ]
        ),
        encoding="utf-8",
    )

    result = cli.scan_artifacts(
        [source],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "pass"


def test_artifact_scan_detects_python_sidecar_markers(tmp_path: Path) -> None:
    report = tmp_path / "prep.json"
    report.write_text(
        '{"pythonSidecarStaged": true, "externalBin": ["aurora-sidecar"]}',
        encoding="utf-8",
    )

    result = cli.scan_artifacts(
        [report],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["rule_id"] == "runtime.python_sidecar_marker"


def test_artifact_scan_allows_empty_sidecar_report_markers(tmp_path: Path) -> None:
    report = tmp_path / "prep.json"
    report.write_text(
        '{"pythonSidecarStaged": false, "externalBin": []}',
        encoding="utf-8",
    )

    result = cli.scan_artifacts(
        [report],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "pass"


def test_artifact_scan_detects_python_sidecar_path_marker(tmp_path: Path) -> None:
    sidecar = tmp_path / "bin" / "aurora-sidecar"
    sidecar.parent.mkdir()
    sidecar.write_bytes(b"binary placeholder")

    result = cli.scan_artifacts(
        [sidecar],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(),
    )[0]

    assert result.status == "failure"
    assert result.detail["findings"][0]["matches"] == ["aurora_sidecar_path"]


def test_artifact_scan_streams_tar_and_stops_at_member_limit(tmp_path: Path) -> None:
    archive_path = tmp_path / "many.tar"
    with tarfile.open(archive_path, "w") as archive:
        for index in range(2):
            data = f"file-{index}".encode()
            info = tarfile.TarInfo(f"item-{index}.txt")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))

    result = cli.scan_artifacts(
        [archive_path],
        root=tmp_path,
        limits=cli.ArtifactScanLimits(max_archive_members=1),
    )[0]

    assert result.status == "failure"
    assert result.detail["limit_failures"] == [
        {
            "path": "many.tar",
            "reason": "archive_member_count_exceeds_limit",
            "member_count": 2,
            "limit_members": 1,
        }
    ]

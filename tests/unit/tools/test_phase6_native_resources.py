from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile as stdlib_tempfile
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest


def load_module():
    path = (
        Path(__file__).resolve().parents[3]
        / "tools"
        / "voice-runtime"
        / "resource-metrics"
        / "run_phase6_native_resources.py"
    )
    spec = importlib.util.spec_from_file_location("phase6_native_resources", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


metrics = load_module()


TIME_OUTPUT = """
\tCommand being timed: "private command"
\tUser time (seconds): 1.25
\tSystem time (seconds): 0.50
\tPercent of CPU this job got: 87%
\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:02.00
\tMaximum resident set size (kbytes): 12345
"""


def test_parse_time_verbose_accepts_gnu_time_format():
    parsed = metrics.parse_time_verbose(TIME_OUTPUT)
    assert parsed is not None
    result = metrics.validate_time_metrics(parsed)
    assert result.wall_ms == 2000.0
    assert result.user_cpu_ms == 1250.0
    assert result.system_cpu_ms == 500.0
    assert result.cpu_utilization_percent == 87.0
    assert result.peak_rss_bytes == 12345 * 1024


def test_parse_time_verbose_rejects_locale_or_missing_fields():
    assert metrics.parse_time_verbose("Benutzerzeit (Sekunden): 1.0") is None
    bad = metrics.parse_time_verbose(TIME_OUTPUT.replace("87%", "87 percent"))
    assert bad is not None
    with pytest.raises(metrics.ResourceMetricError):
        metrics.validate_time_metrics(bad)


def test_parse_elapsed_handles_seconds_minutes_and_hours():
    assert metrics.parse_elapsed_ms("2.5") == 2500.0
    assert metrics.parse_elapsed_ms("1:02.50") == 62500.0
    assert metrics.parse_elapsed_ms("1:02:03.00") == 3723000.0


def test_percentile_math_is_interpolated_and_bounded():
    assert metrics.percentile([1.0, 2.0, 3.0, 4.0], 50) == 2.5
    assert metrics.percentile([1.0, 2.0, 3.0, 4.0], 95) == pytest.approx(3.85)
    with pytest.raises(metrics.ResourceMetricError):
        metrics.percentile([], 95)


def test_run_one_repetition_redacts_child_output_and_reports_success(tmp_path):
    executable = make_executable(tmp_path / "native_vad_smoke")
    spec = metrics.TaskSpec(
        task="vad",
        candidate_id="silero-vad-v4",
        build_command=("cargo",),
        integration_test_name="native_vad_smoke",
        test_args=("silero_vad_matches_phase4_kws_pcm16_fixture", "--exact", "--nocapture"),
        env={},
        workload_duration_ms=1000.0,
    )
    completed = subprocess.CompletedProcess(
        args=["fake"],
        returncode=0,
        stdout="Ask not what your country can do for you /home/private",
        stderr=TIME_OUTPUT + "LIGHT UP /tmp/private 0xabc\n",
    )
    with patch.object(metrics, "run_timed_command", return_value=completed):
        result = metrics.run_one_repetition(
            spec,
            executable=executable,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            timeout_seconds=1.0,
        )
    payload = metrics.repetition_to_json(1, result)
    rendered = json.dumps(payload, sort_keys=True)
    assert result.status == "ok"
    assert "Ask not what" not in rendered
    assert "/home/" not in rendered
    assert "LIGHT UP" not in rendered


def test_run_one_repetition_timeout_and_child_failure_are_redacted(tmp_path):
    executable = make_executable(tmp_path / "native_kws_smoke")
    spec = metrics.TaskSpec(
        task="kws",
        candidate_id="sherpa-gigaspeech-kws-en",
        build_command=("cargo",),
        integration_test_name="native_kws_smoke",
        test_args=("light_up_detection_matches_phase4_wav_with_inline_keywords", "--exact"),
        env={},
        workload_duration_ms=1000.0,
    )
    with patch.object(
        metrics, "run_timed_command", side_effect=subprocess.TimeoutExpired("fake", 1)
    ):
        timeout = metrics.run_one_repetition(
            spec,
            executable=executable,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            timeout_seconds=1.0,
        )
    assert timeout.status == "failed"
    assert timeout.failure_bucket == "timeout"
    completed = subprocess.CompletedProcess(
        args=["fake"],
        returncode=2,
        stdout="/tmp/private transcript",
        stderr=TIME_OUTPUT,
    )
    with patch.object(metrics, "run_timed_command", return_value=completed):
        failed = metrics.run_one_repetition(
            spec,
            executable=executable,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            timeout_seconds=1.0,
        )
    assert failed.status == "failed"
    assert failed.failure_bucket == "child_failed"
    assert failed.metrics is not None


def test_run_one_repetition_times_native_test_executable_directly(tmp_path):
    executable = make_executable(tmp_path / "target" / "debug" / "deps" / "native_vad_smoke-abc")
    spec = metrics.TaskSpec(
        task="vad",
        candidate_id="silero-vad-v4",
        build_command=("cargo",),
        integration_test_name="native_vad_smoke",
        test_args=("silero_vad_matches_phase4_kws_pcm16_fixture", "--exact", "--nocapture"),
        env={},
        workload_duration_ms=1000.0,
    )
    completed = subprocess.CompletedProcess(
        args=["fake"], returncode=0, stdout="", stderr=TIME_OUTPUT
    )

    with patch.object(metrics, "run_timed_command", return_value=completed) as timed:
        result = metrics.run_one_repetition(
            spec,
            executable=executable,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            timeout_seconds=1.0,
        )

    assert result.status == "ok"
    timed.assert_called_once()
    command = timed.call_args.args[0]
    assert command == [
        "/usr/bin/time",
        "-v",
        str(executable),
        "silero_vad_matches_phase4_kws_pcm16_fixture",
        "--exact",
        "--nocapture",
    ]
    assert "cargo" not in command


def test_parse_cargo_test_executable_uses_matching_compiler_artifact(tmp_path):
    ignored = make_executable(tmp_path / "ignored")
    executable = make_executable(tmp_path / "native_kws_smoke-123")
    stdout = "\n".join(
        [
            "Compiling aurora",
            json.dumps(
                {
                    "reason": "compiler-artifact",
                    "target": {"name": "other_test", "kind": ["test"]},
                    "executable": str(ignored),
                }
            ),
            json.dumps(
                {
                    "reason": "compiler-artifact",
                    "target": {"name": "native_kws_smoke", "kind": ["test"]},
                    "executable": str(executable),
                }
            ),
            json.dumps({"reason": "build-finished", "success": True}),
        ]
    )

    assert metrics.parse_cargo_test_executable(stdout, "native_kws_smoke") == executable.resolve()


def test_parse_cargo_test_executable_rejects_missing_or_ambiguous_artifacts(tmp_path):
    first = make_executable(tmp_path / "native_stt_smoke-1")
    second = make_executable(tmp_path / "native_stt_smoke-2")
    ambiguous = "\n".join(
        json.dumps(
            {
                "reason": "compiler-artifact",
                "target": {"name": "native_stt_smoke", "kind": ["test"]},
                "executable": str(path),
            }
        )
        for path in (first, second)
    )

    with pytest.raises(metrics.ResourceMetricError):
        metrics.parse_cargo_test_executable("", "native_stt_smoke")
    with pytest.raises(metrics.ResourceMetricError):
        metrics.parse_cargo_test_executable(ambiguous, "native_stt_smoke")


def test_run_task_builds_outside_time_and_redacts_build_failures(tmp_path):
    spec = metrics.TaskSpec(
        task="stt",
        candidate_id="moonshine-tiny-en-stt",
        build_command=("cargo",),
        integration_test_name="native_stt_smoke",
        test_args=("moonshine_stt_matches_phase4_wav_exactly_and_reuses_new_streams", "--exact"),
        env={},
        workload_duration_ms=1000.0,
    )
    completed = subprocess.CompletedProcess(
        args=["cargo"],
        returncode=101,
        stdout="/home/private/target/native_stt_smoke",
        stderr="linker RSS 999999 /tmp/private",
    )

    with (
        patch.object(metrics, "run_build_command", return_value=completed) as build,
        patch.object(metrics, "run_timed_command") as timed,
    ):
        payload = metrics.run_task(
            spec,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            repetitions=2,
            timeout_seconds=1.0,
            surface="linux-x86_64",
        )

    build.assert_called_once()
    timed.assert_not_called()
    rendered = json.dumps(payload, sort_keys=True)
    assert payload["status"] == "failed"
    assert payload["failure_buckets"] == ["build_failed"]
    assert "/home/private" not in rendered
    assert "/tmp/private" not in rendered
    assert "999999" not in rendered


def test_invalid_cli_ranges_identifiers_paths_and_physical_claim(tmp_path):
    with pytest.raises(metrics.ResourceMetricError):
        metrics.validate_repetitions(0)
    with pytest.raises(metrics.ResourceMetricError):
        metrics.validate_repetitions(metrics.MAX_REPETITIONS + 1)
    with pytest.raises(metrics.ResourceMetricError):
        metrics.validate_identifier("../secret", "surface")
    with pytest.raises(metrics.ResourceMetricError):
        metrics.validate_repo_root(tmp_path)
    args = SimpleNamespace(
        repo_root=tmp_path,
        artifact_root=tmp_path,
        repetitions=1,
        timeout_seconds=1.0,
        output=None,
        physical_device_claim="true",
        surface="linux-x86_64",
        task=["vad"],
    )
    with pytest.raises(metrics.ResourceMetricError):
        metrics.run(args)


def test_atomic_output_is_deterministic_and_rejects_sensitive_json(tmp_path):
    payload = {
        "schema_version": metrics.SCHEMA_VERSION,
        "generated_at_utc": "2026-08-07T00:00:00Z",
        "physical_device_claim": False,
        "thermal_state": "unavailable_in_linux_ci",
        "host": {"arch": "x86_64", "os": "linux"},
        "tasks": [],
        "summary": {"ok": True, "task_count": 0, "failed_task_count": 0},
    }
    out = tmp_path / "nested" / "report.json"
    metrics.atomic_write_json(out, payload)
    first = out.read_text(encoding="utf-8")
    metrics.atomic_write_json(out, payload)
    assert out.read_text(encoding="utf-8") == first
    assert not list(out.parent.glob("*.tmp"))
    with pytest.raises(metrics.ResourceMetricError):
        metrics.stable_json(payload | {"leak": "/home/developer/private.wav"})


def test_atomic_output_removes_temp_file_when_replace_fails(tmp_path):
    payload = {
        "schema_version": metrics.SCHEMA_VERSION,
        "generated_at_utc": "2026-08-07T00:00:00Z",
        "physical_device_claim": False,
        "thermal_state": "unavailable_in_linux_ci",
        "host": {"arch": "x86_64", "os": "linux"},
        "tasks": [],
        "summary": {"ok": True, "task_count": 0, "failed_task_count": 0},
    }
    out = tmp_path / "report.json"
    with (
        patch.object(metrics.os, "replace", side_effect=OSError("replace failed")),
        pytest.raises(OSError),
    ):
        metrics.atomic_write_json(out, payload)

    assert not list(tmp_path.glob("*.tmp"))


def test_run_timed_command_kills_process_group_when_timeout_survives_sigterm(tmp_path):
    class HangingProcess:
        pid = 12345
        returncode = None

        def __init__(self):
            self.calls = 0

        def communicate(self, timeout=None):
            self.calls += 1
            if self.calls <= 2:
                raise subprocess.TimeoutExpired("fake", timeout)
            self.returncode = -9
            return "", ""

    process = HangingProcess()
    signals: list[tuple[int, int]] = []

    with (
        patch.object(metrics.subprocess, "Popen", return_value=process),
        patch.object(metrics.os, "killpg", side_effect=lambda pid, sig: signals.append((pid, sig))),
        pytest.raises(subprocess.TimeoutExpired),
    ):
        metrics.run_timed_command(["fake"], cwd=tmp_path, env={}, timeout=1.0)

    assert signals == [(12345, signal.SIGTERM), (12345, signal.SIGKILL)]


def test_aggregate_repetitions_reports_p50_p95_and_max():
    runs = [
        {
            "status": "ok",
            "metrics": {
                "wall_ms": value,
                "user_cpu_ms": value,
                "system_cpu_ms": value,
                "cpu_utilization_percent": value,
                "peak_rss_bytes": value,
            },
            "rtf_ms_per_second": value,
        }
        for value in (10.0, 20.0, 30.0)
    ]
    aggregate = metrics.aggregate_repetitions(runs)
    assert aggregate["wall_ms"] == {"p50": 20.0, "p95": 29.0, "max": 30.0}
    assert aggregate["rtf_ms_per_second"]["max"] == 30.0


def test_wav_duration_uses_private_path_without_reporting_it(tmp_path):
    wav_path = tmp_path / "private.wav"
    write_pcm16_wav(wav_path, sample_rate=16_000, frames=16_000)
    assert metrics.wav_duration_ms(wav_path) == 1000.0


def test_vad_task_spec_builds_exact_native_test_and_counts_replayed_workload(tmp_path):
    repo_root, artifact_root = create_resource_fixture(tmp_path)

    spec = metrics.build_task_spec("vad", repo_root=repo_root, artifact_root=artifact_root)

    assert spec.build_command == (
        "cargo",
        "+1.88.0",
        "test",
        "--locked",
        "--manifest-path",
        str(repo_root / "rust" / "Cargo.toml"),
        "-p",
        "aurora-voice-sherpa-sys",
        "--features",
        "native-vad",
        "--test",
        "native_vad_smoke",
        "--no-run",
        "--message-format=json",
    )
    assert spec.integration_test_name == "native_vad_smoke"
    assert spec.test_args == (
        "silero_vad_matches_phase4_kws_pcm16_fixture",
        "--exact",
        "--nocapture",
    )
    assert spec.workload_duration_ms == pytest.approx(3032.0)


def test_kws_task_spec_builds_exact_native_test_and_counts_tail_padding(tmp_path):
    repo_root, artifact_root = create_resource_fixture(tmp_path)

    spec = metrics.build_task_spec("kws", repo_root=repo_root, artifact_root=artifact_root)
    try:
        assert spec.build_command[-4:] == (
            "--test",
            "native_kws_smoke",
            "--no-run",
            "--message-format=json",
        )
        assert spec.integration_test_name == "native_kws_smoke"
        assert spec.test_args == (
            "light_up_detection_matches_phase4_wav_with_inline_keywords",
            "--exact",
            "--nocapture",
        )
        assert spec.workload_duration_ms == pytest.approx(3000.0)
    finally:
        metrics.cleanup_specs([spec])


def test_stt_task_spec_builds_exact_native_test_and_counts_two_decodes(tmp_path):
    repo_root, artifact_root = create_resource_fixture(tmp_path)

    spec = metrics.build_task_spec("stt", repo_root=repo_root, artifact_root=artifact_root)

    assert spec.build_command[-4:] == (
        "--test",
        "native_stt_smoke",
        "--no-run",
        "--message-format=json",
    )
    assert spec.integration_test_name == "native_stt_smoke"
    assert spec.test_args == (
        "moonshine_stt_matches_phase4_wav_exactly_and_reuses_new_streams",
        "--exact",
        "--nocapture",
    )
    assert spec.workload_duration_ms == pytest.approx(2000.0)


def test_kws_smoke_dir_maps_expected_encoder_name_to_int8_source_and_cleans_up(tmp_path):
    source = tmp_path / "kws-pack"
    (source / "test_wavs").mkdir(parents=True)
    files = {
        "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx": b"int8-encoder",
        "decoder-epoch-12-avg-2-chunk-16-left-64.onnx": b"decoder",
        "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx": b"joiner",
        "tokens.txt": b"tokens",
        "test_wavs/0.wav": b"wav",
    }
    for relative, body in files.items():
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)

    temp_dir = metrics.build_kws_int8_smoke_dir(source)
    smoke_dir = Path(temp_dir.name)
    expected_encoder = smoke_dir / "encoder-epoch-12-avg-2-chunk-16-left-64.onnx"
    assert expected_encoder.is_symlink()
    assert (
        expected_encoder.resolve()
        == (source / "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx").resolve()
    )
    rendered = json.dumps(
        {
            "candidate_id": "sherpa-gigaspeech-kws-en",
            "physical_device_claim": False,
        },
        sort_keys=True,
    )
    assert str(smoke_dir) not in rendered

    metrics.cleanup_specs(
        [
            metrics.TaskSpec(
                task="kws",
                candidate_id="sherpa-gigaspeech-kws-en",
                build_command=("cargo",),
                integration_test_name="native_kws_smoke",
                test_args=("fake",),
                env={},
                workload_duration_ms=1.0,
                temp_dir=temp_dir,
            )
        ]
    )
    assert not smoke_dir.exists()


def test_child_env_forces_dynamic_linking_without_reporting_paths(monkeypatch):
    monkeypatch.setenv("LD_LIBRARY_PATH", "/existing/private")
    child_env = metrics.build_child_env(
        {
            "AURORA_SHERPA_ONNX_LIB_DIR": "/tmp/private-lib",
            "AURORA_SHERPA_ONNX_LINK_KIND": "dynamic",
        }
    )
    assert child_env["AURORA_SHERPA_ONNX_LINK_KIND"] == "dynamic"
    assert child_env["LC_ALL"] == "C"
    lib_path_key = "DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
    assert child_env[lib_path_key].startswith(f"/tmp/private-lib{os.pathsep}")
    report = {
        "schema_version": metrics.SCHEMA_VERSION,
        "generated_at_utc": "2026-08-07T00:00:00Z",
        "physical_device_claim": False,
        "thermal_state": "unavailable_in_linux_ci",
        "host": {"arch": "x86_64", "os": "linux"},
        "tasks": [
            {
                "task": "kws",
                "candidate_id": "sherpa-gigaspeech-kws-en",
                "surface": "linux-x86_64",
                "arch": "x86_64",
                "status": "failed",
                "failure_buckets": ["child_failed"],
                "workload_duration_ms": 1.0,
                "thermal_state": "unavailable_in_linux_ci",
                "physical_device_claim": False,
                "repetitions": [],
                "aggregates": {},
            }
        ],
        "summary": {"ok": False, "task_count": 1, "failed_task_count": 1},
    }
    rendered = metrics.stable_json(report)
    assert "/tmp/private-lib" not in rendered
    assert "AURORA_SHERPA" not in rendered


def test_kws_task_spec_cleans_temp_dir_when_late_validation_fails(tmp_path, monkeypatch):
    repo_root = tmp_path / "repo"
    (repo_root / "rust").mkdir(parents=True)
    (repo_root / "rust" / "Cargo.toml").write_text("[workspace]\n", encoding="utf-8")
    artifact_root = tmp_path / "artifact"
    kws_source = (
        artifact_root
        / "models"
        / "extracted"
        / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
    )
    (artifact_root / "builds" / "linux-x86_64" / "install" / "lib").mkdir(parents=True)
    (kws_source / "test_wavs").mkdir(parents=True)
    for relative in (
        "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "tokens.txt",
        "test_wavs/0.wav",
    ):
        path = kws_source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")

    original_temporary_directory = stdlib_tempfile.TemporaryDirectory
    monkeypatch.setattr(
        metrics.tempfile,
        "TemporaryDirectory",
        lambda prefix: original_temporary_directory(prefix=prefix, dir=tmp_path),
    )
    monkeypatch.setattr(
        metrics,
        "wav_duration_ms",
        lambda _path: (_ for _ in ()).throw(metrics.ResourceMetricError("bad wav")),
    )

    with pytest.raises(metrics.ResourceMetricError):
        metrics.build_task_spec("kws", repo_root=repo_root, artifact_root=artifact_root)

    assert not list(tmp_path.glob("aurora-kws-int8-smoke-*"))


def test_failure_report_has_redacted_bucket_only():
    report = metrics.failure_report("/tmp/private/model missing")
    rendered = json.dumps(report, sort_keys=True)
    assert report["physical_device_claim"] is False
    assert report["summary"]["failure_bucket"] == "missing_required_input"
    assert "/tmp/private" not in rendered


def create_resource_fixture(tmp_path: Path) -> tuple[Path, Path]:
    repo_root = tmp_path / "repo"
    (repo_root / "rust").mkdir(parents=True)
    (repo_root / "rust" / "Cargo.toml").write_text("[workspace]\n", encoding="utf-8")

    artifact_root = tmp_path / "artifact"
    (artifact_root / "builds" / "linux-x86_64" / "install" / "lib").mkdir(parents=True)
    (artifact_root / "models").mkdir(parents=True)
    (artifact_root / "models" / "silero-vad-v4.0.onnx").write_bytes(b"vad")

    kws_root = (
        artifact_root
        / "models"
        / "extracted"
        / "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
    )
    (kws_root / "test_wavs").mkdir(parents=True)
    for relative in (
        "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
        "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
        "tokens.txt",
    ):
        (kws_root / relative).write_bytes(b"x")
    write_pcm16_wav(kws_root / "test_wavs" / "0.wav", sample_rate=16_000, frames=16_000)

    stt_root = (
        artifact_root
        / "models"
        / "extracted"
        / "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27"
    )
    (stt_root / "test_wavs").mkdir(parents=True)
    write_pcm16_wav(stt_root / "test_wavs" / "0.wav", sample_rate=24_000, frames=24_000)

    return repo_root, artifact_root


def write_pcm16_wav(path: Path, *, sample_rate: int, frames: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(sample_rate)
        sink.writeframes(b"\x00\x00" * frames)


def make_executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
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
    spec = metrics.TaskSpec(
        task="vad",
        candidate_id="silero-vad-v4",
        command=("fake",),
        env={},
        input_duration_ms=1000.0,
    )
    completed = subprocess.CompletedProcess(
        args=["fake"],
        returncode=0,
        stdout="Ask not what your country can do for you /home/private",
        stderr=TIME_OUTPUT + "LIGHT UP /tmp/private 0xabc\n",
    )
    with patch.object(metrics.subprocess, "run", return_value=completed):
        result = metrics.run_one_repetition(
            spec,
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
    spec = metrics.TaskSpec(
        task="kws",
        candidate_id="sherpa-gigaspeech-kws-en",
        command=("fake",),
        env={},
        input_duration_ms=1000.0,
    )
    with patch.object(metrics.subprocess, "run", side_effect=subprocess.TimeoutExpired("fake", 1)):
        timeout = metrics.run_one_repetition(
            spec,
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
    with patch.object(metrics.subprocess, "run", return_value=completed):
        failed = metrics.run_one_repetition(
            spec,
            repo_root=tmp_path,
            time_bin=Path("/usr/bin/time"),
            timeout_seconds=1.0,
        )
    assert failed.status == "failed"
    assert failed.failure_bucket == "child_failed"
    assert failed.metrics is not None


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
    with wave.open(str(wav_path), "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(16_000)
        sink.writeframes(b"\x00\x00" * 16_000)
    assert metrics.wav_duration_ms(wav_path) == 1000.0


def test_failure_report_has_redacted_bucket_only():
    report = metrics.failure_report("/tmp/private/model missing")
    rendered = json.dumps(report, sort_keys=True)
    assert report["physical_device_claim"] is False
    assert report["summary"]["failure_bucket"] == "missing_required_input"
    assert "/tmp/private" not in rendered

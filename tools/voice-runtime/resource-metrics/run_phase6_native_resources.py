#!/usr/bin/env python3
"""Measure native Phase 6 voice candidates with redacted resource reports."""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "aurora.voice.phase6.native_resources.v1"
TASKS = ("vad", "kws", "stt")
MAX_REPETITIONS = 20
TIME_FIELDS = {
    "user_seconds": "User time (seconds)",
    "system_seconds": "System time (seconds)",
    "cpu_percent": "Percent of CPU this job got",
    "elapsed": "Elapsed (wall clock) time (h:mm:ss or m:ss)",
    "peak_rss_kib": "Maximum resident set size (kbytes)",
}
PHASE4_KWS_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
PHASE4_STT_NAME = "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27"


class ResourceMetricError(RuntimeError):
    """Raised when a resource report cannot be produced safely."""


@dataclass(frozen=True)
class TaskSpec:
    task: str
    candidate_id: str
    command: tuple[str, ...]
    env: dict[str, str]
    input_duration_ms: float | None


@dataclass(frozen=True)
class TimeMetrics:
    wall_ms: float
    user_cpu_ms: float
    system_cpu_ms: float
    cpu_utilization_percent: float
    peak_rss_bytes: int


@dataclass(frozen=True)
class RepetitionResult:
    status: str
    failure_bucket: str | None
    metrics: TimeMetrics | None
    rtf_ms_per_second: float | None


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        report, ok = run(args)
    except ResourceMetricError as exc:
        report = failure_report(str(exc))
        ok = False
    if args.output:
        atomic_write_json(args.output, report)
    else:
        sys.stdout.write(stable_json(report))
    return 0 if ok else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path(__file__).resolve().parents[3],
        help="Aurora repository root.",
    )
    parser.add_argument(
        "--artifact-root",
        type=Path,
        required=True,
        help="Phase 4 native voice artifact root.",
    )
    parser.add_argument(
        "--task",
        action="append",
        choices=TASKS,
        help="Task to measure. Repeatable. Defaults to vad, kws, and stt.",
    )
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=float, default=180.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--surface",
        default=default_surface(),
        help="Redacted target surface label; Linux host diagnostics only.",
    )
    parser.add_argument(
        "--physical-device-claim",
        default="false",
        choices=("false", "true"),
        help="Must remain false for Linux/emulator diagnostics.",
    )
    return parser


def run(args: argparse.Namespace) -> tuple[dict[str, Any], bool]:
    repo_root = validate_repo_root(args.repo_root)
    artifact_root = validate_artifact_root(args.artifact_root)
    repetitions = validate_repetitions(args.repetitions)
    timeout_seconds = validate_timeout(args.timeout_seconds)
    surface = validate_identifier(args.surface, "surface")
    if args.physical_device_claim != "false":
        raise ResourceMetricError("physical_device_claim must remain false")
    if args.output is not None:
        validate_output_path(args.output)
    selected_tasks = tuple(args.task or TASKS)
    time_bin = find_time_binary()
    specs = [
        build_task_spec(task, repo_root=repo_root, artifact_root=artifact_root)
        for task in selected_tasks
    ]

    results = [
        run_task(
            spec,
            repo_root=repo_root,
            time_bin=time_bin,
            repetitions=repetitions,
            timeout_seconds=timeout_seconds,
            surface=surface,
        )
        for spec in specs
    ]
    ok = all(result["status"] == "ok" for result in results)
    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "physical_device_claim": False,
        "thermal_state": "unavailable_in_linux_ci",
        "host": {
            "os": safe_host_os(),
            "arch": normalize_arch(platform.machine()),
        },
        "tasks": results,
        "summary": {
            "ok": ok,
            "task_count": len(results),
            "failed_task_count": sum(1 for result in results if result["status"] != "ok"),
        },
    }
    ensure_redacted(report)
    return report, ok


def build_task_spec(task: str, *, repo_root: Path, artifact_root: Path) -> TaskSpec:
    task = validate_identifier(task, "task")
    if task not in TASKS:
        raise ResourceMetricError(f"unsupported task: {task}")

    rust_manifest = repo_root / "rust" / "Cargo.toml"
    lib_dir = require_dir(
        artifact_root / "builds" / "linux-x86_64" / "install" / "lib",
        "sherpa native library directory",
    )
    env = {"AURORA_SHERPA_ONNX_LIB_DIR": str(lib_dir)}
    if task == "vad":
        model = require_file(artifact_root / "models" / "silero-vad-v4.0.onnx", "VAD model")
        wav = require_file(
            artifact_root / "models" / "extracted" / PHASE4_KWS_NAME / "test_wavs" / "0.wav",
            "VAD input WAV",
        )
        command = (
            "cargo",
            "+1.88.0",
            "run",
            "--quiet",
            "--manifest-path",
            str(rust_manifest),
            "-p",
            "aurora-voice-sherpa-sys",
            "--features",
            "native-vad",
            "--example",
            "vad_parity_driver",
            "--",
            "--model",
            str(model),
            "--wav",
            str(wav),
        )
        return TaskSpec(
            task="vad",
            candidate_id="silero-vad-v4",
            command=command,
            env=env,
            input_duration_ms=wav_duration_ms(wav),
        )
    if task == "kws":
        kws_dir = require_dir(
            artifact_root / "models" / "extracted" / PHASE4_KWS_NAME,
            "KWS model directory",
        )
        wav = require_file(kws_dir / "test_wavs" / "0.wav", "KWS input WAV")
        env |= {
            "AURORA_SHERPA_ONNX_KWS_DIR": str(kws_dir),
            "AURORA_SHERPA_ONNX_TEST_WAV": str(wav),
        }
        command = (
            "cargo",
            "+1.88.0",
            "test",
            "--locked",
            "--manifest-path",
            str(rust_manifest),
            "-p",
            "aurora-voice-sherpa-sys",
            "--features",
            "native-kws",
            "--test",
            "native_kws_smoke",
            "--",
            "--nocapture",
        )
        return TaskSpec(
            task="kws",
            candidate_id="sherpa-gigaspeech-kws-en",
            command=command,
            env=env,
            input_duration_ms=wav_duration_ms(wav),
        )
    stt_dir = require_dir(
        artifact_root / "models" / "extracted" / PHASE4_STT_NAME,
        "STT model directory",
    )
    wav = require_file(stt_dir / "test_wavs" / "0.wav", "STT input WAV")
    env |= {
        "AURORA_SHERPA_ONNX_STT_MODEL_DIR": str(stt_dir),
        "AURORA_SHERPA_ONNX_STT_TEST_WAV": str(wav),
    }
    command = (
        "cargo",
        "+1.88.0",
        "test",
        "--locked",
        "--manifest-path",
        str(rust_manifest),
        "-p",
        "aurora-voice-sherpa-sys",
        "--features",
        "native-stt",
        "--test",
        "native_stt_smoke",
        "--",
        "--nocapture",
    )
    return TaskSpec(
        task="stt",
        candidate_id="moonshine-tiny-en-stt",
        command=command,
        env=env,
        input_duration_ms=wav_duration_ms(wav),
    )


def run_task(
    spec: TaskSpec,
    *,
    repo_root: Path,
    time_bin: Path,
    repetitions: int,
    timeout_seconds: float,
    surface: str,
) -> dict[str, Any]:
    repetitions_payload: list[dict[str, Any]] = []
    for index in range(repetitions):
        result = run_one_repetition(
            spec,
            repo_root=repo_root,
            time_bin=time_bin,
            timeout_seconds=timeout_seconds,
        )
        repetitions_payload.append(repetition_to_json(index + 1, result))

    ok_repetitions = [
        item for item in repetitions_payload if item["status"] == "ok" and item.get("metrics")
    ]
    status = "ok" if len(ok_repetitions) == repetitions else "failed"
    return {
        "task": spec.task,
        "candidate_id": spec.candidate_id,
        "surface": surface,
        "arch": normalize_arch(platform.machine()),
        "status": status,
        "failure_buckets": sorted(
            {
                item["failure_bucket"]
                for item in repetitions_payload
                if item.get("failure_bucket") is not None
            }
        ),
        "input_duration_ms": round_float(spec.input_duration_ms),
        "thermal_state": "unavailable_in_linux_ci",
        "physical_device_claim": False,
        "repetitions": repetitions_payload,
        "aggregates": aggregate_repetitions(ok_repetitions),
    }


def run_one_repetition(
    spec: TaskSpec,
    *,
    repo_root: Path,
    time_bin: Path,
    timeout_seconds: float,
) -> RepetitionResult:
    env = build_child_env(spec.env)
    command = [str(time_bin), "-v", *spec.command]
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env=env,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return RepetitionResult(
            status="failed",
            failure_bucket="timeout",
            metrics=None,
            rtf_ms_per_second=None,
        )

    parsed = parse_time_verbose(completed.stderr)
    if parsed is None:
        return RepetitionResult(
            status="failed",
            failure_bucket="missing_time_metrics",
            metrics=None,
            rtf_ms_per_second=None,
        )
    try:
        metrics = validate_time_metrics(parsed)
    except ResourceMetricError:
        return RepetitionResult(
            status="failed",
            failure_bucket="invalid_time_metrics",
            metrics=None,
            rtf_ms_per_second=None,
        )
    if completed.returncode != 0:
        return RepetitionResult(
            status="failed",
            failure_bucket=classify_failure(completed.returncode),
            metrics=metrics,
            rtf_ms_per_second=rtf(metrics.wall_ms, spec.input_duration_ms),
        )
    return RepetitionResult(
        status="ok",
        failure_bucket=None,
        metrics=metrics,
        rtf_ms_per_second=rtf(metrics.wall_ms, spec.input_duration_ms),
    )


def build_child_env(extra: dict[str, str]) -> dict[str, str]:
    env = os.environ.copy()
    env.update(extra)
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    lib_dir = extra.get("AURORA_SHERPA_ONNX_LIB_DIR")
    if lib_dir:
        key = "DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
        prior = env.get(key)
        env[key] = lib_dir if not prior else f"{lib_dir}{os.pathsep}{prior}"
    return env


def parse_time_verbose(stderr: str) -> dict[str, str] | None:
    values: dict[str, str] = {}
    for line in stderr.splitlines():
        stripped = line.strip()
        for key in TIME_FIELDS.values():
            prefix = f"{key}:"
            if stripped.startswith(prefix):
                values[key] = stripped.removeprefix(prefix).strip()
                break
    if set(TIME_FIELDS.values()) - set(values):
        return None
    return values


def validate_time_metrics(values: dict[str, str]) -> TimeMetrics:
    user_seconds = parse_float(values[TIME_FIELDS["user_seconds"]])
    system_seconds = parse_float(values[TIME_FIELDS["system_seconds"]])
    cpu_percent = parse_cpu_percent(values[TIME_FIELDS["cpu_percent"]])
    wall_ms = parse_elapsed_ms(values[TIME_FIELDS["elapsed"]])
    peak_rss_kib = parse_int(values[TIME_FIELDS["peak_rss_kib"]])
    metrics = TimeMetrics(
        wall_ms=wall_ms,
        user_cpu_ms=user_seconds * 1000.0,
        system_cpu_ms=system_seconds * 1000.0,
        cpu_utilization_percent=cpu_percent,
        peak_rss_bytes=peak_rss_kib * 1024,
    )
    for value in (
        metrics.wall_ms,
        metrics.user_cpu_ms,
        metrics.system_cpu_ms,
        metrics.cpu_utilization_percent,
        float(metrics.peak_rss_bytes),
    ):
        if not math.isfinite(value) or value < 0:
            raise ResourceMetricError("non-finite or negative time metric")
    if metrics.peak_rss_bytes <= 0:
        raise ResourceMetricError("peak RSS must be positive")
    return metrics


def parse_elapsed_ms(value: str) -> float:
    text = value.strip()
    if not re.fullmatch(r"\d+:\d\d(?:\.\d+)?|\d+:\d\d:\d\d(?:\.\d+)?|\d+(?:\.\d+)?", text):
        raise ResourceMetricError("elapsed time is not LC_ALL=C /usr/bin/time format")
    parts = text.split(":")
    if len(parts) == 1:
        seconds = float(parts[0])
    elif len(parts) == 2:
        seconds = int(parts[0]) * 60 + float(parts[1])
    else:
        seconds = int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if not math.isfinite(seconds) or seconds < 0:
        raise ResourceMetricError("elapsed time is invalid")
    return seconds * 1000.0


def parse_cpu_percent(value: str) -> float:
    if not value.endswith("%"):
        raise ResourceMetricError("CPU percent missing percent suffix")
    return parse_float(value[:-1])


def parse_float(value: str) -> float:
    parsed = float(value.strip())
    if not math.isfinite(parsed):
        raise ResourceMetricError("non-finite float")
    return parsed


def parse_int(value: str) -> int:
    parsed = int(value.strip())
    return parsed


def repetition_to_json(index: int, result: RepetitionResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "index": index,
        "status": result.status,
        "failure_bucket": result.failure_bucket,
        "rtf_ms_per_second": round_float(result.rtf_ms_per_second),
    }
    if result.metrics is not None:
        payload["metrics"] = {
            "wall_ms": round_float(result.metrics.wall_ms),
            "user_cpu_ms": round_float(result.metrics.user_cpu_ms),
            "system_cpu_ms": round_float(result.metrics.system_cpu_ms),
            "cpu_utilization_percent": round_float(result.metrics.cpu_utilization_percent),
            "peak_rss_bytes": result.metrics.peak_rss_bytes,
        }
    else:
        payload["metrics"] = None
    return payload


def aggregate_repetitions(repetitions: list[dict[str, Any]]) -> dict[str, Any]:
    fields = (
        "wall_ms",
        "user_cpu_ms",
        "system_cpu_ms",
        "cpu_utilization_percent",
        "peak_rss_bytes",
    )
    aggregates: dict[str, Any] = {"ok_repetitions": len(repetitions)}
    for field in fields:
        values = [float(item["metrics"][field]) for item in repetitions]
        aggregates[field] = aggregate_values(values)
    rtf_values = [
        float(item["rtf_ms_per_second"])
        for item in repetitions
        if item.get("rtf_ms_per_second") is not None
    ]
    aggregates["rtf_ms_per_second"] = aggregate_values(rtf_values)
    return aggregates


def aggregate_values(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"p50": None, "p95": None, "max": None}
    return {
        "p50": round_float(percentile(values, 50)),
        "p95": round_float(percentile(values, 95)),
        "max": round_float(max(values)),
    }


def percentile(values: list[float], percent: float) -> float:
    if not values:
        raise ResourceMetricError("percentile needs values")
    if percent < 0 or percent > 100:
        raise ResourceMetricError("percentile out of range")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (percent / 100.0) * (len(ordered) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[int(rank)]
    fraction = rank - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def rtf(wall_ms: float, input_duration_ms: float | None) -> float | None:
    if input_duration_ms is None or input_duration_ms <= 0:
        return None
    return wall_ms / (input_duration_ms / 1000.0)


def wav_duration_ms(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        frames = source.getnframes()
        rate = source.getframerate()
    if frames < 0 or rate <= 0:
        raise ResourceMetricError("invalid WAV duration")
    return (frames / rate) * 1000.0


def validate_repo_root(path: Path) -> Path:
    root = path.resolve()
    if not (root / "rust" / "Cargo.toml").is_file():
        raise ResourceMetricError("repo_root must contain rust/Cargo.toml")
    return root


def validate_artifact_root(path: Path) -> Path:
    root = path.resolve()
    if not root.is_dir():
        raise ResourceMetricError("artifact_root must be an existing directory")
    return root


def validate_output_path(path: Path) -> Path:
    if path.exists() and path.is_dir():
        raise ResourceMetricError("output must be a file path")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def validate_repetitions(value: int) -> int:
    if value < 1 or value > MAX_REPETITIONS:
        raise ResourceMetricError(f"repetitions must be between 1 and {MAX_REPETITIONS}")
    return value


def validate_timeout(value: float) -> float:
    if not math.isfinite(value) or value <= 0 or value > 3600:
        raise ResourceMetricError("timeout_seconds must be in (0, 3600]")
    return value


def validate_identifier(value: str, label: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,96}", value):
        raise ResourceMetricError(f"{label} is not a bounded safe identifier")
    return value


def require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file():
        raise ResourceMetricError(f"{label} is missing")
    return resolved


def require_dir(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_dir():
        raise ResourceMetricError(f"{label} is missing")
    return resolved


def find_time_binary() -> Path:
    candidates = [Path("/usr/bin/time")]
    found = shutil.which("time")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    raise ResourceMetricError("/usr/bin/time is required for native resource metrics")


def classify_failure(returncode: int) -> str:
    if returncode < 0:
        return "terminated_by_signal"
    return "child_failed"


def default_surface() -> str:
    return f"{sys.platform}-{normalize_arch(platform.machine())}"


def normalize_arch(value: str) -> str:
    arch = value.lower()
    if arch in {"amd64", "x86_64"}:
        return "x86_64"
    if arch in {"aarch64", "arm64"}:
        return "arm64"
    return re.sub(r"[^a-z0-9_.:-]", "_", arch)[:64] or "unknown"


def safe_host_os() -> str:
    name = sys.platform.lower()
    return re.sub(r"[^a-z0-9_.:-]", "_", name)[:64] or "unknown"


def round_float(value: float | None) -> float | None:
    if value is None:
        return None
    if not math.isfinite(value):
        raise ResourceMetricError("non-finite numeric value")
    return round(float(value), 3)


def stable_json(value: dict[str, Any]) -> str:
    ensure_redacted(value)
    return json.dumps(value, indent=2, sort_keys=True) + "\n"


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    validate_output_path(path)
    text = stable_json(payload)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        tmp_path = Path(handle.name)
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp_path, path)


def ensure_redacted(value: Any) -> None:
    text = json.dumps(value, sort_keys=True)
    forbidden_patterns = (
        r"/home/",
        r"/tmp/",
        r"target/",
        r"Cargo\.toml",
        r"test_wavs",
        r"Ask not what",
        r"LIGHT UP",
        r"0x[0-9a-fA-F]+",
        r"AURORA_SHERPA",
        r"LD_LIBRARY_PATH",
        r"DYLD_LIBRARY_PATH",
    )
    for pattern in forbidden_patterns:
        if re.search(pattern, text):
            raise ResourceMetricError(f"report contains forbidden sensitive detail: {pattern}")


def failure_report(reason: str) -> dict[str, Any]:
    report = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "physical_device_claim": False,
        "thermal_state": "unavailable_in_linux_ci",
        "host": {
            "os": safe_host_os(),
            "arch": normalize_arch(platform.machine()),
        },
        "tasks": [],
        "summary": {
            "ok": False,
            "task_count": 0,
            "failed_task_count": 0,
            "failure_bucket": bucket_from_reason(reason),
        },
    }
    ensure_redacted(report)
    return report


def bucket_from_reason(reason: str) -> str:
    lowered = reason.lower()
    if "physical_device_claim" in lowered:
        return "physical_device_claim_rejected"
    if "time" in lowered:
        return "time_metrics_unavailable"
    if "repetition" in lowered:
        return "invalid_repetitions"
    if "identifier" in lowered:
        return "invalid_identifier"
    if "missing" in lowered:
        return "missing_required_input"
    return "invalid_invocation"


if __name__ == "__main__":
    raise SystemExit(main())

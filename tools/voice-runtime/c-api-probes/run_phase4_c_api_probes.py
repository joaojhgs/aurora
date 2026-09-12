#!/usr/bin/env python3
"""Build and run sherpa-onnx C API Phase 4 probes."""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ARTIFACT_ROOT_ENV = "AURORA_VOICE_P4_ARTIFACT_ROOT"
MOONSHINE_NAME = "sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27"
KWS_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01"
TTS_NAME = "vits-piper-en_US-ljspeech-medium"


class ProbeError(RuntimeError):
    """Raised when probe setup cannot be completed."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--artifact-root",
        type=Path,
        default=None,
        help=f"Phase 4 artifact root containing builds/ and models/. May also be set by {ARTIFACT_ROOT_ENV}.",
    )
    parser.add_argument("--install-dir", type=Path, help="sherpa install directory.")
    parser.add_argument("--models-dir", type=Path, help="directory containing extracted models.")
    parser.add_argument("--silero-model", type=Path, help="upstream Silero ONNX path.")
    parser.add_argument(
        "--build-dir",
        type=Path,
        help="directory for compiled probe executable and intermediate outputs.",
    )
    parser.add_argument("--result-json", type=Path, help="write combined JSON result here.")
    parser.add_argument("--cc", default=os.environ.get("CC", "cc"), help="C compiler.")
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument(
        "--mode",
        action="append",
        choices=("stt", "vad", "kws", "tts", "tts_cancel"),
        help="Probe mode to run. Repeatable. Defaults to all modes.",
    )
    parser.add_argument("--text", default="Aurora local voice probe.")
    parser.add_argument("--cancel-after-callbacks", type=int, default=1)
    parser.add_argument("--print-compile-command", action="store_true")
    return parser


def _artifact_root_default() -> Path | None:
    value = os.environ.get("AURORA_VOICE_P4_ARTIFACT_ROOT")
    return Path(value) if value else None


def require_path(path: Path, label: str) -> Path:
    if not path.exists():
        raise ProbeError(f"{label} does not exist: {path}")
    return path


def resolve_paths(args: argparse.Namespace) -> dict[str, Path]:
    artifact_root_arg = args.artifact_root or os.environ.get(ARTIFACT_ROOT_ENV)
    if artifact_root_arg is None:
        raise ProbeError(f"missing --artifact-root or {ARTIFACT_ROOT_ENV}")

    artifact_root = Path(artifact_root_arg).resolve()
    install_dir = (args.install_dir or artifact_root / "builds/linux-x86_64/install").resolve()
    models_dir = (args.models_dir or artifact_root / "models/extracted").resolve()
    build_dir = (args.build_dir or artifact_root / "reports/c-api-probes/build").resolve()
    silero_model = (args.silero_model or artifact_root / "models/silero-vad-v4.0.onnx").resolve()

    paths = {
        "artifact_root": artifact_root,
        "install_dir": install_dir,
        "include_dir": install_dir / "include",
        "lib_dir": install_dir / "lib",
        "models_dir": models_dir,
        "moonshine_dir": models_dir / MOONSHINE_NAME,
        "kws_dir": models_dir / KWS_NAME,
        "tts_dir": models_dir / TTS_NAME,
        "silero_model": silero_model,
        "vad_wav": models_dir / KWS_NAME / "test_wavs/0.wav",
        "kws_wav": models_dir / KWS_NAME / "test_wavs/1.wav",
        "build_dir": build_dir,
        "source": SCRIPT_DIR / "phase4_sherpa_probe.c",
        "executable": build_dir / "phase4_sherpa_probe",
    }
    for key in (
        "include_dir",
        "lib_dir",
        "moonshine_dir",
        "kws_dir",
        "tts_dir",
        "silero_model",
        "vad_wav",
        "kws_wav",
        "source",
    ):
        require_path(paths[key], key)
    return paths


def compile_probe(args: argparse.Namespace, paths: dict[str, Path]) -> list[str]:
    paths["build_dir"].mkdir(parents=True, exist_ok=True)
    command = [
        args.cc,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        f"-I{paths['include_dir']}",
        str(paths["source"]),
        f"-L{paths['lib_dir']}",
        "-lsherpa-onnx-c-api",
        f"-Wl,-rpath,{paths['lib_dir']}",
        "-o",
        str(paths["executable"]),
    ]
    if args.print_compile_command:
        print(" ".join(command), file=sys.stderr)
    subprocess.run(command, check=True, text=True, capture_output=True)
    return command


def parse_probe_stdout(stdout: str, mode: str) -> dict[str, Any]:
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        return {"ok": False, "mode": mode, "reason": "probe produced no JSON"}
    try:
        result = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        return {"ok": False, "mode": mode, "reason": f"invalid probe JSON: {exc}"}
    if not isinstance(result, dict):
        return {"ok": False, "mode": mode, "reason": "probe JSON is not an object"}
    return result


def run_mode(args: argparse.Namespace, paths: dict[str, Path], mode: str) -> dict[str, Any]:
    command = [
        str(paths["executable"]),
        "--mode",
        mode,
        "--moonshine-dir",
        str(paths["moonshine_dir"]),
        "--kws-dir",
        str(paths["kws_dir"]),
        "--tts-dir",
        str(paths["tts_dir"]),
        "--silero-model",
        str(paths["silero_model"]),
        "--vad-wav",
        str(paths["vad_wav"]),
        "--kws-wav",
        str(paths["kws_wav"]),
        "--text",
        args.text,
        "--cancel-after-callbacks",
        str(args.cancel_after_callbacks),
    ]
    env = os.environ.copy()
    lib_path_name = "DYLD_LIBRARY_PATH" if platform.system() == "Darwin" else "LD_LIBRARY_PATH"
    existing = env.get(lib_path_name)
    env[lib_path_name] = (
        str(paths["lib_dir"]) if not existing else f"{paths['lib_dir']}{os.pathsep}{existing}"
    )
    completed = subprocess.run(
        command,
        text=True,
        capture_output=True,
        timeout=args.timeout_seconds,
        env=env,
        check=False,
    )
    result = parse_probe_stdout(completed.stdout, mode)
    result["returncode"] = completed.returncode
    result["stderr_tail"] = completed.stderr[-2000:]
    result["command"] = command
    if completed.returncode != 0 and result.get("ok") is True:
        result["ok"] = False
        result["reason"] = f"probe exited {completed.returncode}"
    return result


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        paths = resolve_paths(args)
        compile_command = compile_probe(args, paths)
    except ProbeError as exc:
        payload = {"ok": False, "stage": "setup", "reason": str(exc)}
        if args.result_json:
            write_json(args.result_json, payload)
        print(json.dumps(payload, sort_keys=True), file=sys.stderr)
        return 2
    except subprocess.CalledProcessError as exc:
        payload = {
            "ok": False,
            "stage": "setup",
            "reason": str(exc),
            "stdout": exc.stdout,
            "stderr": exc.stderr,
        }
        if args.result_json:
            write_json(args.result_json, payload)
        print(json.dumps(payload, sort_keys=True), file=sys.stderr)
        return 2

    modes = args.mode or ["stt", "vad", "kws", "tts", "tts_cancel"]
    results = [run_mode(args, paths, mode) for mode in modes]
    payload = {
        "ok": all(item.get("ok") is True and item.get("returncode") == 0 for item in results),
        "compile_command": compile_command,
        "executable": str(paths["executable"]),
        "modes": results,
    }
    result_json = args.result_json or paths["artifact_root"] / "reports/c-api-probes/results.json"
    write_json(result_json, payload)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

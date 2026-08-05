from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys
from pathlib import Path
from typing import Any


TOOL_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TOOL_ROOT.parents[1]
ARTIFACT_ROOT = REPO_ROOT / ".artifacts" / "pockettts" / "w0-kws"

LANGUAGE_TTS_BACKEND = {"en": "piper", "pt": "voxcpm"}


def write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def inspect_environment() -> dict[str, Any]:
    modules = ["numpy", "onnxruntime", "openwakeword", "livekit.wakeword"]
    availability: dict[str, dict[str, Any]] = {}
    for module in modules:
        try:
            available = importlib.util.find_spec(module) is not None
        except ModuleNotFoundError as exc:
            availability[module] = {
                "available": False,
                "first_failure": {"type": type(exc).__name__, "message": str(exc)},
            }
        else:
            availability[module] = {"available": available}
    return {
        "schema_version": 1,
        "python": sys.version,
        "platform": platform.platform(),
        "tool_root": str(TOOL_ROOT),
        "artifact_root": str(ARTIFACT_ROOT),
        "module_availability": availability,
        "root_dependency_policy": "no training dependencies are required by Aurora root manifests",
    }


def training_plan(language: str, phrase: str) -> dict[str, Any]:
    if language not in LANGUAGE_TTS_BACKEND:
        raise SystemExit(f"unsupported training language for this spike: {language}")
    model_name = f"aurora_{language}_{phrase.lower().replace(' ', '_')}"
    config = {
        "model_name": model_name,
        "target_phrases": [phrase],
        "n_samples": 10000,
        "target_fp_per_hour": 0.2,
        "model": {"model_type": "conv_attention", "model_size": "small"},
        "aurora": {
            "language": language,
            "tts_backend": LANGUAGE_TTS_BACKEND[language],
            "output_policy": "write only under .artifacts/pockettts/w0-kws/",
        },
    }
    config_path = ARTIFACT_ROOT / "training-configs" / f"{model_name}.json"
    write_json(config_path, config)
    return {
        "schema_version": 1,
        "language": language,
        "phrase": phrase,
        "config_path": str(config_path),
        "recommended_commands": [
            "uv sync --extra livekit-train",
            f"uv run livekit-wakeword setup --config {config_path}",
            f"uv run livekit-wakeword run {config_path}",
            f"uv run livekit-wakeword export {config_path}",
            f"uv run livekit-wakeword eval {config_path}",
        ],
        "status": "planned_not_executed",
        "reason": "Training downloads models/data and may require GPU; this tool records the isolated command boundary.",
    }


def smoke_python_import() -> dict[str, Any]:
    failures = []
    for module in ["numpy", "onnxruntime", "openwakeword"]:
        try:
            __import__(module)
        except Exception as exc:  # noqa: BLE001
            failures.append({"module": module, "type": type(exc).__name__, "message": str(exc)})
            break
    return {
        "schema_version": 1,
        "status": "available" if not failures else "unavailable",
        "first_failure": failures[0] if failures else None,
        "import_boundary": "Python OpenWakeWord-compatible classifier import/score",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("inspect")
    subparsers.add_parser("smoke-python-import")
    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("--language", choices=sorted(LANGUAGE_TTS_BACKEND), required=True)
    plan_parser.add_argument("--phrase", required=True)
    args = parser.parse_args(argv)
    if args.command == "inspect":
        print(json.dumps(inspect_environment(), indent=2, sort_keys=True))
        return 0
    if args.command == "plan":
        print(json.dumps(training_plan(args.language, args.phrase), indent=2, sort_keys=True))
        return 0
    if args.command == "smoke-python-import":
        payload = smoke_python_import()
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0 if payload["status"] == "available" else 2
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Emit Docker build settings derived from Aurora config.

This keeps process-mode image variants aligned with the runtime
``services.*`` config layout without importing application code.
"""

from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
DEFAULTS_PATH = ROOT / "app/services/config/config_defaults.json"


def _load_config(path: Path) -> dict[str, Any]:
    if path.exists():
        with path.open() as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("services"):
            return data

    with DEFAULTS_PATH.open() as f:
        data = json.load(f)
    if not isinstance(data, dict):
        msg = f"Config defaults must contain a JSON object: {DEFAULTS_PATH}"
        raise ValueError(msg)
    return data


def _get(data: dict[str, Any], path: str, default: Any = None) -> Any:
    value: Any = data
    for part in path.split("."):
        if not isinstance(value, dict):
            return default
        value = value.get(part)
        if value is None:
            return default
    return value


def _hardware(enabled: Any) -> str:
    return "cuda" if bool(enabled) else "cpu"


def _llm_mode(provider: Any) -> str:
    normalized = str(provider or "openai").strip().lower().replace("_", "-")
    return {
        "openai": "openai",
        "huggingface-endpoint": "huggingface-endpoint",
        "huggingface-pipeline": "huggingface-local",
        "llama-cpp": "llama-cpp",
    }.get(normalized, "openai")


def docker_env(config: dict[str, Any]) -> dict[str, str]:
    """Return Docker build args derived from services.* config."""
    stt_hardware = _hardware(_get(config, "services.stt.hardware_acceleration", False))
    return {
        "DB_EMBEDDINGS_MODE": "local"
        if _get(config, "services.db.embeddings.use_local", False)
        else "openai",
        "ORCHESTRATOR_LLM_MODE": _llm_mode(
            _get(config, "services.orchestrator.llm.provider", "openai")
        ),
        "ORCHESTRATOR_HARDWARE": _hardware(
            _get(config, "services.orchestrator.hardware_acceleration", False)
        ),
        "TTS_HARDWARE": _hardware(_get(config, "services.tts.hardware_acceleration", False)),
        "STT_TRANSCRIPTION_HARDWARE": stt_hardware,
        "STT_WAKEWORD_HARDWARE": stt_hardware,
    }


def _shell_lines(values: dict[str, str]) -> str:
    return "\n".join(f"export {key}={shlex.quote(value)}" for key, value in sorted(values.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help="Config file to read; falls back to config_defaults.json when missing or uninitialized.",
    )
    parser.add_argument(
        "--format",
        choices=("shell", "env", "json"),
        default="shell",
        help="Output format.",
    )
    args = parser.parse_args()

    values = docker_env(_load_config(args.config))
    if args.format == "json":
        print(json.dumps(values, indent=2, sort_keys=True))
    elif args.format == "env":
        print("\n".join(f"{key}={value}" for key, value in sorted(values.items())))
    else:
        print(_shell_lines(values))


if __name__ == "__main__":
    main()

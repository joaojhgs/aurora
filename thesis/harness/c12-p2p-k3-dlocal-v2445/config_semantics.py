"""Exact retained helper functions; no historical runner/bootstrap entrypoint."""
from __future__ import annotations
from typing import Any


def _config_value(config: dict[str, Any], dotted_path: str) -> dict[str, Any]:
    value: Any = config
    for part in dotted_path.split("."):
        if not isinstance(value, dict) or part not in value:
            return {"present": False}
        value = value[part]
    return {"present": True, "value": value}


def _enabled_flags(value: Any, prefix: str = "services") -> dict[str, Any]:
    flags: dict[str, Any] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}"
            if key == "enabled":
                flags[path] = child
            elif isinstance(child, (dict, list)):
                flags.update(_enabled_flags(child, path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            flags.update(_enabled_flags(child, f"{prefix}[{index}]"))
    return flags


def _active_config_semantics(config: dict[str, Any]) -> dict[str, Any]:
    languages = {}
    for path in (
        "services.stt.language", "system.primary_language", "system.voice_language",
    ):
        field = _config_value(config, path)
        if field.get("present") and field.get("value") == "en-US":
            field["value"] = "en-us"
        languages[path] = field
    return {
        "llm_provider": _config_value(config, "services.orchestrator.llm.provider"),
        "llama_cpp_options": _config_value(
            config, "services.orchestrator.llm.local.llama_cpp.options"
        ),
        "stt_transcription": _config_value(config, "services.stt.transcription"),
        "tts": _config_value(config, "services.tts"),
        "service_enabled_flags": _enabled_flags(config.get("services", {})),
        "stt_coordinator_enabled": _config_value(config, "services.stt.coordinator.enabled"),
        "stt_wakeword_enabled": _config_value(config, "services.stt.wakeword.enabled"),
        "automatic_tts_readback": config.get("ui", {}).get("assistant", {}).get(
            "automatic_tts_readback", False
        ),
        "global_languages": languages,
    }


def _changed_config_paths(before: Any, after: Any, prefix: str = "") -> list[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        paths: list[str] = []
        for key in sorted(set(before) | set(after)):
            child_path = f"{prefix}.{key}" if prefix else str(key)
            if key not in before or key not in after:
                paths.append(child_path)
            else:
                paths.extend(_changed_config_paths(before[key], after[key], child_path))
        return paths
    if isinstance(before, list) and isinstance(after, list):
        paths = []
        for index in range(max(len(before), len(after))):
            child_path = f"{prefix}[{index}]"
            if index >= len(before) or index >= len(after):
                paths.append(child_path)
            else:
                paths.extend(_changed_config_paths(before[index], after[index], child_path))
        return paths
    return [] if before == after else [prefix]

"""Environment variable mapping for Aurora configuration.

Config and .env live in parallel. Resolution order: config.json (if set) > .env > default.
Secrets should be stored in .env; config.json can override at runtime for hot-reload.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


def _to_bool(x: str) -> bool:
    return x.lower() in ("true", "1", "yes")


def _list_comma(x: str) -> list[str]:
    """Convert comma-separated env string to list."""
    return [s.strip() for s in x.split(",") if s.strip()]


# config_path -> (env_var, converter)
ENV_CONFIG_MAP: dict[str, tuple[str, Callable[[str], Any]]] = {
    # UI
    "ui.activate": ("AURORA_UI_ACTIVATE", _to_bool),
    "ui.dark_mode": ("AURORA_DARK_MODE", _to_bool),
    "ui.debug": ("AURORA_UI_DEBUG", _to_bool),
    # LLM
    "services.orchestrator.llm.provider": ("LLM_PROVIDER", str),
    "services.orchestrator.llm.third_party.openai.options.api_key": ("OPENAI_API_KEY", str),
    "services.orchestrator.llm.third_party.openai.options.model": ("OPENAI_MODEL", str),
    "services.orchestrator.llm.third_party.huggingface_endpoint.options.endpoint_url": (
        "HUGGINGFACE_ENDPOINT_URL",
        str,
    ),
    "services.orchestrator.llm.third_party.huggingface_endpoint.options.model": (
        "HUGGINGFACE_MODEL_NAME",
        str,
    ),
    "services.orchestrator.llm.third_party.huggingface_endpoint.options.access_token": (
        "HUGGINGFACE_ACCESS_TOKEN",
        str,
    ),
    "services.orchestrator.llm.local.huggingface_pipeline.options.model": (
        "HUGGINGFACE_PIPELINE_MODEL",
        str,
    ),
    "services.orchestrator.llm.local.huggingface_pipeline.options.device": (
        "HUGGINGFACE_PIPELINE_DEVICE",
        str,
    ),
    "services.orchestrator.llm.local.huggingface_pipeline.options.torch_dtype": (
        "HUGGINGFACE_PIPELINE_TORCH_DTYPE",
        str,
    ),
    "services.orchestrator.llm.local.llama_cpp.options.model_path": (
        "AURORA_LLAMA_CPP_MODEL_PATH",
        str,
    ),
    # Embeddings
    "services.db.embeddings.use_local": ("USE_LOCAL_EMBEDDINGS", _to_bool),
    # Speech-to-text
    "services.stt.language": ("STT_LANGUAGE", str),
    "services.stt.wakeword.model_path": (
        "AURORA_WAKE_WORD_MODEL_PATH",
        str,
    ),
    "services.stt.transcription.vad_enabled": (
        "STT_SILERO_DEACTIVITY_DETECTION",
        _to_bool,
    ),
    "services.stt.wakeword.speedx_noise_reduction": (
        "STT_WAKEWORD_SPEEDX_NOISE_REDUCTION",
        _to_bool,
    ),
    # Text-to-speech
    "services.tts.model_file_path": (
        "AURORA_TTS_MODEL_FILE_PATH",
        str,
    ),
    "services.tts.model_config_file_path": (
        "AURORA_TTS_MODEL_CONFIG_FILE_PATH",
        str,
    ),
    "services.tts.model_sample_rate": (
        "AURORA_TTS_MODEL_SAMPLE_RATE",
        int,
    ),
    "services.tts.piper_path": ("PIPER_PATH", str),
    # Hardware
    "services.tts.hardware_acceleration": ("USE_CUDA_TTS", _to_bool),
    "services.stt.hardware_acceleration": ("USE_CUDA_STT", _to_bool),
    "services.tooling.hardware_acceleration.ocr_bg": ("USE_CUDA_OCR_BG", _to_bool),
    "services.tooling.hardware_acceleration.ocr_curr": ("USE_CUDA_OCR_CURR", _to_bool),
    "services.orchestrator.hardware_acceleration": ("USE_CUDA_LLM", _to_bool),
    # Models dir
    "system.models_dir": ("AURORA_MODELS_DIR", str),
    # Plugins
    "services.tooling.plugins.jira.activate": ("JIRA_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.jira.api_token": ("JIRA_API_TOKEN", str),
    "services.tooling.plugins.jira.username": ("JIRA_USERNAME", str),
    "services.tooling.plugins.jira.instance_url": ("JIRA_INSTANCE_URL", str),
    "services.tooling.plugins.openrecall.activate": ("OPENRECALL_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.brave_search.activate": ("BRAVE_SEARCH_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.brave_search.api_key": ("BRAVE_API_KEY", str),
    "services.tooling.plugins.github.activate": ("GITHUB_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.github.app_id": ("GITHUB_APP_ID", str),
    "services.tooling.plugins.github.app_private_key": ("GITHUB_APP_PRIVATE_KEY", str),
    "services.tooling.plugins.github.repository": ("GITHUB_REPOSITORY", str),
    "services.tooling.plugins.slack.activate": ("SLACK_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.slack.user_token": ("SLACK_USER_TOKEN", str),
    "services.tooling.plugins.gmail.activate": ("GMAIL_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.gcalendar.activate": ("GCALENDAR_ACTIVATE_PLUGIN", _to_bool),
    "services.tooling.plugins.google.credentials_file": ("GOOGLE_CREDENTIALS_FILE", str),
    # Gateway
    "services.gateway.api.token_secret": ("AURORA_TOKEN_SECRET", str),
    "services.gateway.webrtc.password": ("AURORA_WEBRTC_PASSWORD", str),
    "services.auth.api_keys": ("AURORA_GATEWAY_API_KEYS", _list_comma),
}

# Config paths that are sensitive (secrets, keys, tokens) - for schema format: "password"
SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        "services.orchestrator.llm.third_party.openai.options.api_key",
        "services.orchestrator.llm.third_party.huggingface_endpoint.options.access_token",
        "services.tooling.plugins.jira.api_token",
        "services.tooling.plugins.brave_search.api_key",
        "services.tooling.plugins.github.app_private_key",
        "services.tooling.plugins.slack.user_token",
        "services.tooling.plugins.google.credentials_file",
        "services.gateway.api.token_secret",
        "services.gateway.webrtc.password",
        "services.auth.api_keys",
    }
)

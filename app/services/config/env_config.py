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
    "general.llm.provider": ("LLM_PROVIDER", str),
    "general.llm.third_party.openai.options.api_key": ("OPENAI_API_KEY", str),
    "general.llm.third_party.openai.options.model": ("OPENAI_MODEL", str),
    "general.llm.third_party.huggingface_endpoint.options.endpoint_url": (
        "HUGGINGFACE_ENDPOINT_URL",
        str,
    ),
    "general.llm.third_party.huggingface_endpoint.options.model": (
        "HUGGINGFACE_MODEL_NAME",
        str,
    ),
    "general.llm.third_party.huggingface_endpoint.options.access_token": (
        "HUGGINGFACE_ACCESS_TOKEN",
        str,
    ),
    "general.llm.local.huggingface_pipeline.options.model": (
        "HUGGINGFACE_PIPELINE_MODEL",
        str,
    ),
    "general.llm.local.huggingface_pipeline.options.device": (
        "HUGGINGFACE_PIPELINE_DEVICE",
        str,
    ),
    "general.llm.local.huggingface_pipeline.options.torch_dtype": (
        "HUGGINGFACE_PIPELINE_TORCH_DTYPE",
        str,
    ),
    "general.llm.local.llama_cpp.options.model_path": (
        "AURORA_LLAMA_CPP_MODEL_PATH",
        str,
    ),
    # Embeddings
    "general.embeddings.use_local": ("USE_LOCAL_EMBEDDINGS", _to_bool),
    # Speech-to-text
    "general.speech_to_text.language": ("STT_LANGUAGE", str),
    "general.speech_to_text.wake_word.model_path": (
        "AURORA_WAKE_WORD_MODEL_PATH",
        str,
    ),
    "general.speech_to_text.silero_deactivity_detection": (
        "STT_SILERO_DEACTIVITY_DETECTION",
        _to_bool,
    ),
    "general.speech_to_text.wakeword_speedx_noise_reduction": (
        "STT_WAKEWORD_SPEEDX_NOISE_REDUCTION",
        _to_bool,
    ),
    # Text-to-speech
    "general.text_to_speech.model_file_path": (
        "AURORA_TTS_MODEL_FILE_PATH",
        str,
    ),
    "general.text_to_speech.model_config_file_path": (
        "AURORA_TTS_MODEL_CONFIG_FILE_PATH",
        str,
    ),
    "general.text_to_speech.model_sample_rate": (
        "AURORA_TTS_MODEL_SAMPLE_RATE",
        int,
    ),
    "general.text_to_speech.piper_path": ("PIPER_PATH", str),
    # Hardware
    "general.hardware_acceleration.tts": ("USE_CUDA_TTS", _to_bool),
    "general.hardware_acceleration.stt": ("USE_CUDA_STT", _to_bool),
    "general.hardware_acceleration.ocr_bg": ("USE_CUDA_OCR_BG", _to_bool),
    "general.hardware_acceleration.ocr_curr": ("USE_CUDA_OCR_CURR", _to_bool),
    "general.hardware_acceleration.llm": ("USE_CUDA_LLM", _to_bool),
    # Models dir
    "general.models_dir": ("AURORA_MODELS_DIR", str),
    # Plugins
    "plugins.jira.activate": ("JIRA_ACTIVATE_PLUGIN", _to_bool),
    "plugins.jira.api_token": ("JIRA_API_TOKEN", str),
    "plugins.jira.username": ("JIRA_USERNAME", str),
    "plugins.jira.instance_url": ("JIRA_INSTANCE_URL", str),
    "plugins.openrecall.activate": ("OPENRECALL_ACTIVATE_PLUGIN", _to_bool),
    "plugins.brave_search.activate": ("BRAVE_SEARCH_ACTIVATE_PLUGIN", _to_bool),
    "plugins.brave_search.api_key": ("BRAVE_API_KEY", str),
    "plugins.github.activate": ("GITHUB_ACTIVATE_PLUGIN", _to_bool),
    "plugins.github.app_id": ("GITHUB_APP_ID", str),
    "plugins.github.app_private_key": ("GITHUB_APP_PRIVATE_KEY", str),
    "plugins.github.repository": ("GITHUB_REPOSITORY", str),
    "plugins.slack.activate": ("SLACK_ACTIVATE_PLUGIN", _to_bool),
    "plugins.slack.user_token": ("SLACK_USER_TOKEN", str),
    "plugins.gmail.activate": ("GMAIL_ACTIVATE_PLUGIN", _to_bool),
    "plugins.gcalendar.activate": ("GCALENDAR_ACTIVATE_PLUGIN", _to_bool),
    "plugins.google.credentials_file": ("GOOGLE_CREDENTIALS_FILE", str),
    # Gateway
    "gateway.token_secret": ("AURORA_TOKEN_SECRET", str),
    "gateway.webrtc.password": ("AURORA_WEBRTC_PASSWORD", str),
    "gateway.auth.api_keys": ("AURORA_GATEWAY_API_KEYS", _list_comma),
}

# Config paths that are sensitive (secrets, keys, tokens) - for schema format: "password"
SENSITIVE_KEYS: frozenset[str] = frozenset({
    "general.llm.third_party.openai.options.api_key",
    "general.llm.third_party.huggingface_endpoint.options.access_token",
    "plugins.jira.api_token",
    "plugins.brave_search.api_key",
    "plugins.github.app_private_key",
    "plugins.slack.user_token",
    "plugins.google.credentials_file",
    "gateway.token_secret",
    "gateway.webrtc.password",
    "gateway.auth.api_keys",
})

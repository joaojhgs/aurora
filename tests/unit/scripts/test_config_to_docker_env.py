import json

from scripts.config_to_docker_env import _load_config, docker_env


def test_docker_env_maps_services_config_to_build_args():
    config = {
        "services": {
            "db": {"embeddings": {"use_local": True}},
            "orchestrator": {
                "hardware_acceleration": True,
                "llm": {"provider": "huggingface_pipeline"},
            },
            "tts": {"hardware_acceleration": False},
            "stt": {"hardware_acceleration": True},
        }
    }

    assert docker_env(config) == {
        "DB_EMBEDDINGS_MODE": "local",
        "ORCHESTRATOR_LLM_MODE": "huggingface-local",
        "ORCHESTRATOR_HARDWARE": "cuda",
        "TTS_HARDWARE": "cpu",
        "STT_TRANSCRIPTION_HARDWARE": "cuda",
        "STT_WAKEWORD_HARDWARE": "cuda",
    }


def test_docker_env_defaults_to_lightweight_modes():
    assert docker_env({"services": {}}) == {
        "DB_EMBEDDINGS_MODE": "openai",
        "ORCHESTRATOR_LLM_MODE": "openai",
        "ORCHESTRATOR_HARDWARE": "cpu",
        "TTS_HARDWARE": "cpu",
        "STT_TRANSCRIPTION_HARDWARE": "cpu",
        "STT_WAKEWORD_HARDWARE": "cpu",
    }


def test_load_config_falls_back_to_defaults_for_uninitialized_config(tmp_path):
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"ui": {"activate": False}}))

    config = _load_config(config_path)

    assert "services" in config
    assert config["services"]["orchestrator"]["llm"]["provider"] == "openai"

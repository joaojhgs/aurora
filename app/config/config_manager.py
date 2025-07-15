import json
import os
from threading import Lock
from typing import Any, Callable

from jsonschema import ValidationError, validate

from app.helpers.aurora_logger import log_error, log_info, log_warning


class ConfigManager:
    """
    Thread-safe configuration manager that handles loading, saving, and runtime updates
    of application configuration from a JSON file.
    """

    _instance = None
    _lock = Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not hasattr(self, "initialized"):
            self.config_file = "config.json"
            self.config_lock = Lock()
            self._config = {}
            self._observers = []
            self._schema = self._get_config_schema()
            self.load_config()
            self.initialized = True

    def load_config(self):
        """Load configuration from JSON file, create default if not exists"""
        try:
            if os.path.exists(self.config_file):
                with open(self.config_file) as f:
                    config_data = json.load(f)

                # Validate the loaded configuration against schema
                try:
                    self._validate_config(config_data)
                    self._config = config_data
                    log_info("Configuration loaded and validated from config.json")
                except ValidationError as e:
                    log_error(f"Configuration validation failed: {e.message}")
                    log_warning("Using default configuration due to validation errors")
                    self._config = self._get_default_config()
                    self.save_config()  # Save the valid default config

            else:
                self._config = self._get_default_config()
                self.save_config()
                log_info("Created default configuration file")
        except Exception as e:
            log_error(f"Error loading config: {e}")
            self._config = self._get_default_config()

    def save_config(self):
        """Save current configuration to JSON file"""
        try:
            # Note: Don't acquire lock here as it might be called from within a locked context
            with open(self.config_file, "w") as f:
                json.dump(self._config, f, indent=2)
            log_info("Configuration saved to config.json")
        except Exception as e:
            log_error(f"Error saving config: {e}")

    def get(self, key_path: str, default: Any = None) -> Any:
        """
        Get configuration value using dot notation (e.g., 'ui.activate')

        Can also retrieve entire sections (e.g., 'llm.third_party.openai')
        """
        keys = key_path.split(".")
        value = self._config

        try:
            for key in keys:
                value = value[key]
            return value
        except (KeyError, TypeError):
            return default

    def get_section(self, section_path: str, default: Any = None) -> Any:
        """
        Get an entire configuration section using dot notation.
        This is an alias for get() but provides clearer intent when retrieving sections.
        """
        return self.get(section_path, default)

    def set(self, key_path: str, value: Any, save: bool = True):
        """
        Set configuration value using dot notation and optionally save to file
        """
        keys = key_path.split(".")
        config_ref = self._config

        with self.config_lock:
            # Navigate to the parent of the target key
            for key in keys[:-1]:
                if key not in config_ref:
                    config_ref[key] = {}
                config_ref = config_ref[key]

            # Set the value
            old_value = config_ref.get(keys[-1])
            config_ref[keys[-1]] = value

            # Validate the entire configuration after the change
            try:
                self._validate_config(self._config)
            except ValidationError as e:
                # Rollback the change if validation fails
                if old_value is not None:
                    config_ref[keys[-1]] = old_value
                else:
                    del config_ref[keys[-1]]
                raise ValueError(f"Configuration change rejected: {e.message}")

            # Save to file if requested
            if save:
                self.save_config()

            # Notify observers of the change
            self._notify_observers(key_path, old_value, value)

    def update_section(self, section: str, values: dict[str, Any], save: bool = True):
        """Update an entire configuration section using dot notation"""
        keys = section.split(".")
        config_ref = self._config

        with self.config_lock:
            # Navigate to the parent of the target section
            for key in keys[:-1]:
                if key not in config_ref:
                    config_ref[key] = {}
                config_ref = config_ref[key]

            # Update the target section
            if keys[-1] not in config_ref:
                config_ref[keys[-1]] = {}

            config_ref[keys[-1]].update(values)

            if save:
                self.save_config()

            # Notify observers for each changed value
            for key, value in values.items():
                self._notify_observers(f"{section}.{key}", None, value)

    def add_observer(self, callback: Callable[[str, Any, Any], None]):
        """Add an observer function that gets called when config changes"""
        self._observers.append(callback)

    def remove_observer(self, callback: Callable[[str, Any, Any], None]):
        """Remove an observer function"""
        if callback in self._observers:
            self._observers.remove(callback)

    def _notify_observers(self, key_path: str, old_value: Any, new_value: Any):
        """Notify all observers of configuration changes"""
        for observer in self._observers:
            try:
                observer(key_path, old_value, new_value)
            except Exception as e:
                log_error(f"Error notifying observer: {e}")

    def _get_default_config(self) -> dict:
        """Return default configuration structure"""
        return {
            "ui": {"activate": False, "dark_mode": False, "debug": False},
            "llm": {
                "provider": "openai",
                "third_party": {
                    "openai": {"options": {"model": "gpt-4o", "temperature": 0.7, "max_tokens": 512}},
                    "huggingface_endpoint": {
                        "options": {
                            "endpoint_url": "",
                            "model": "",
                            "access_token": "",
                            "temperature": 0.7,
                            "max_tokens": 512,
                        }
                    },
                },
                "local": {
                    "huggingface_pipeline": {
                        "options": {
                            "model": "microsoft/DialoGPT-medium",
                            "temperature": 0.7,
                            "torch_dtype": "auto",
                        }
                    },
                    "llama_cpp": {
                        "options": {
                            "model_path": "",
                            "temperature": 1.0,
                            "max_tokens": 512,
                            "n_ctx": 2048,
                            "n_gpu_layers": 0,
                            "n_batch": 1000,
                            "top_p": 0.95,
                            "top_k": 64,
                            "repeat_penalty": 1.0,
                            "min_p": 0.0,
                            "chat_format": "chatml-function-calling",
                        }
                    },
                },
            },
            "embeddings": {"use_local": True},
            "speech_to_text": {
                "language": "",
                "silero_deactivity_detection": False,
                "wakeword_speedx_noise_reduction": False,
                "ambient_transcription": {
                    "enable": False,
                    "chunk_duration": 3.0,
                    "storage_path": "ambient_logs/",
                    "filter_short_transcriptions": True,
                    "min_transcription_length": 10,
                },
            },
            "text_to_speech": {
                "model_file_path": "/voice_models/en_US-lessac-medium.onnx",
                "model_config_file_path": "/voice_models/en_US-lessac-medium.onnx.txt",
                "model_sample_rate": 22050,
                "piper_path": "",
            },
            "hardware_acceleration": {
                "tts": False,
                "stt": False,
                "ocr_bg": False,
                "ocr_curr": False,
                "llm": False,
            },
            # Plugins configuration
            "plugins": {
                "jira": {
                    "activate": False,
                    "api_token": "",
                    "username": "",
                    "instance_url": "https://jira.atlassian.net/",
                },
                "openrecall": {"activate": False},
                "brave_search": {"activate": False, "api_key": ""},
                "github": {
                    "activate": False,
                    "app_id": "",
                    "app_private_key": "",
                    "repository": "",
                },
                "slack": {"activate": False, "user_token": ""},
                "gmail": {"activate": False},
                "gcalendar": {"activate": False},
            },
            "google": {"credentials_file": "google_credentials.json"},
        }

    def migrate_from_env(self):
        """Migrate existing environment variables to config.json"""
        migration_map = {
            "AURORA_UI_ACTIVATE": ("ui.activate", lambda x: x.lower() == "true"),
            "AURORA_DARK_MODE": ("ui.dark_mode", lambda x: x.lower() == "true"),
            "AURORA_UI_DEBUG": ("ui.debug", lambda x: x.lower() == "true"),
            "LLM_PROVIDER": ("llm.provider", str),
            "LLAMMA_CPP_MODEL_PATH": ("llm.local.llama_cpp.options.model_path", str),
            "OPENAI_MODEL": ("llm.third_party.openai.options.model", str),
            "OPENAI_CHAT_MODEL": ("llm.third_party.openai.options.model", str),
            "HUGGINGFACE_ACCESS_TOKEN": (
                "llm.third_party.huggingface_endpoint.options.access_token",
                str,
            ),
            "HUGGINGFACE_ENDPOINT_URL": (
                "llm.third_party.huggingface_endpoint.options.endpoint_url",
                str,
            ),
            "HUGGINGFACE_MODEL_NAME": ("llm.third_party.huggingface_endpoint.options.model", str),
            "HUGGINGFACE_PIPELINE_MODEL": ("llm.local.huggingface_pipeline.options.model", str),
            "HUGGINGFACE_PIPELINE_DEVICE": ("llm.local.huggingface_pipeline.options.device", str),
            "HUGGINGFACE_PIPELINE_TORCH_DTYPE": (
                "llm.local.huggingface_pipeline.options.torch_dtype",
                str,
            ),
            "USE_LOCAL_EMBEDDINGS": ("embeddings.use_local", lambda x: x.lower() == "true"),
            "STT_LANGUAGE": ("speech_to_text.language", str),
            "STT_SILERO_DEACTIVITY_DETECTION": (
                "speech_to_text.silero_deactivity_detection",
                lambda x: x.lower() == "true",
            ),
            "STT_WAKEWORD_SPEEDX_NOISE_REDUCTION": (
                "speech_to_text.wakeword_speedx_noise_reduction",
                lambda x: x.lower() == "true",
            ),
            "TTS_MODEL_FILE_PATH": ("text_to_speech.model_file_path", str),
            "TTS_MODEL_CONFIG_FILE_PATH": ("text_to_speech.model_config_file_path", str),
            "TTS_MODEL_SAMPLE_RATE": ("text_to_speech.model_sample_rate", int),
            "PIPER_PATH": ("text_to_speech.piper_path", str),
            "USE_CUDA_TTS": ("cuda.use_cuda_tts", lambda x: x.lower() == "true"),
            "USE_CUDA_STT": ("cuda.use_cuda_stt", lambda x: x.lower() == "true"),
            "USE_CUDA_OCR_BG": ("cuda.use_cuda_ocr_bg", lambda x: x.lower() == "true"),
            "USE_CUDA_OCR_CURR": ("cuda.use_cuda_ocr_curr", lambda x: x.lower() == "true"),
            "JIRA_ACTIVATE_PLUGIN": ("plugins.jira.activate", lambda x: x.lower() == "true"),
            "JIRA_API_TOKEN": ("plugins.jira.api_token", str),
            "JIRA_USERNAME": ("plugins.jira.username", str),
            "JIRA_INSTANCE_URL": ("plugins.jira.instance_url", str),
            "OPENRECALL_ACTIVATE_PLUGIN": (
                "plugins.openrecall.activate",
                lambda x: x.lower() == "true",
            ),
            "BRAVE_SEARCH_ACTIVATE_PLUGIN": (
                "plugins.brave_search.activate",
                lambda x: x.lower() == "true",
            ),
            "BRAVE_API_KEY": ("plugins.brave_search.api_key", str),
            "GITHUB_ACTIVATE_PLUGIN": ("plugins.github.activate", lambda x: x.lower() == "true"),
            "GITHUB_APP_ID": ("plugins.github.app_id", str),
            "GITHUB_APP_PRIVATE_KEY": ("plugins.github.app_private_key", str),
            "GITHUB_REPOSITORY": ("plugins.github.repository", str),
            "SLACK_ACTIVATE_PLUGIN": ("plugins.slack.activate", lambda x: x.lower() == "true"),
            "SLACK_USER_TOKEN": ("plugins.slack.user_token", str),
            "GMAIL_ACTIVATE_PLUGIN": ("plugins.gmail.activate", lambda x: x.lower() == "true"),
            "GCALENDAR_ACTIVATE_PLUGIN": (
                "plugins.gcalendar.activate",
                lambda x: x.lower() == "true",
            ),
            "GOOGLE_CREDENTIALS_FILE": ("google.credentials_file", str),
        }

        migrated = False
        for env_var, (config_path, converter) in migration_map.items():
            env_value = os.environ.get(env_var)
            if env_value is not None and env_value != "":
                try:
                    converted_value = converter(env_value)
                    self.set(config_path, converted_value, save=False)
                    migrated = True
                except (ValueError, TypeError) as e:
                    log_warning(f"Failed to convert {env_var}={env_value}: {e}")

        if migrated:
            self.save_config()
            log_info("Migrated environment variables to config.json")

    def get_config_dict(self) -> dict[str, Any]:
        """Get a copy of the entire configuration dictionary"""
        with self.config_lock:
            return json.loads(json.dumps(self._config))  # Deep copy

    def _get_config_schema(self) -> dict[str, Any]:
        """Return the JSON schema for configuration validation"""
        return {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "required": [
                "ui",
                "llm",
                "embeddings",
                "speech_to_text",
                "text_to_speech",
                "hardware_acceleration",
                "plugins",
                "google",
            ],
            "properties": {
                "ui": {
                    "type": "object",
                    "required": ["activate", "dark_mode", "debug"],
                    "properties": {
                        "activate": {"type": "boolean"},
                        "dark_mode": {"type": "boolean"},
                        "debug": {"type": "boolean"},
                    },
                    "additionalProperties": False,
                },
                "llm": {
                    "type": "object",
                    "required": ["provider", "third_party", "local"],
                    "properties": {
                        "provider": {
                            "type": "string",
                            "enum": [
                                "openai",
                                "huggingface_endpoint",
                                "huggingface_pipeline",
                                "llama_cpp",
                            ],
                        },
                        "third_party": {
                            "type": "object",
                            "required": ["openai", "huggingface_endpoint"],
                            "properties": {
                                "openai": {
                                    "type": "object",
                                    "required": ["options"],
                                    "properties": {
                                        "options": {
                                            "type": "object",
                                            "required": ["model", "temperature", "max_tokens"],
                                            "properties": {
                                                "model": {"type": "string"},
                                                "temperature": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 2,
                                                },
                                                "max_tokens": {"type": "integer", "minimum": 1},
                                            },
                                            "additionalProperties": False,
                                        }
                                    },
                                    "additionalProperties": False,
                                },
                                "huggingface_endpoint": {
                                    "type": "object",
                                    "required": ["options"],
                                    "properties": {
                                        "options": {
                                            "type": "object",
                                            "required": [
                                                "endpoint_url",
                                                "model",
                                                "access_token",
                                                "temperature",
                                                "max_tokens",
                                            ],
                                            "properties": {
                                                "endpoint_url": {"type": "string"},
                                                "model": {"type": "string"},
                                                "access_token": {"type": "string"},
                                                "temperature": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 2,
                                                },
                                                "max_tokens": {"type": "integer", "minimum": 1},
                                            },
                                            "additionalProperties": False,
                                        }
                                    },
                                    "additionalProperties": False,
                                },
                            },
                            "additionalProperties": False,
                        },
                        "local": {
                            "type": "object",
                            "required": ["huggingface_pipeline", "llama_cpp"],
                            "properties": {
                                "huggingface_pipeline": {
                                    "type": "object",
                                    "required": ["options"],
                                    "properties": {
                                        "options": {
                                            "type": "object",
                                            "required": ["model"],
                                            "properties": {
                                                "model": {"type": "string"},
                                                "temperature": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 2,
                                                },
                                                "max_tokens": {"type": "integer", "minimum": 1},
                                                "torch_dtype": {"type": "string"},
                                                "pipeline_kwargs": {"type": "object"},
                                                "model_kwargs": {"type": "object"},
                                            },
                                            "additionalProperties": True,
                                        }
                                    },
                                    "additionalProperties": False,
                                },
                                "llama_cpp": {
                                    "type": "object",
                                    "required": ["options"],
                                    "properties": {
                                        "options": {
                                            "type": "object",
                                            "required": [
                                                "model_path",
                                                "temperature",
                                                "max_tokens",
                                                "n_ctx",
                                                "n_gpu_layers",
                                                "n_batch",
                                                "top_p",
                                                "top_k",
                                                "repeat_penalty",
                                                "min_p",
                                            ],
                                            "properties": {
                                                "model_path": {"type": "string"},
                                                "temperature": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 2,
                                                },
                                                "max_tokens": {"type": "integer", "minimum": 1},
                                                "n_ctx": {"type": "integer", "minimum": 1},
                                                "n_gpu_layers": {"type": "integer", "minimum": 0},
                                                "n_batch": {"type": "integer", "minimum": 1},
                                                "top_p": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 1,
                                                },
                                                "top_k": {"type": "integer", "minimum": 1},
                                                "repeat_penalty": {"type": "number", "minimum": 0},
                                                "min_p": {
                                                    "type": "number",
                                                    "minimum": 0,
                                                    "maximum": 1,
                                                },
                                                "chat_format": {"type": "string"},
                                            },
                                            "additionalProperties": True,
                                        }
                                    },
                                    "additionalProperties": False,
                                },
                            },
                            "additionalProperties": False,
                        },
                    },
                    "additionalProperties": False,
                },
                "embeddings": {
                    "type": "object",
                    "required": ["use_local"],
                    "properties": {"use_local": {"type": "boolean"}},
                    "additionalProperties": False,
                },
                "speech_to_text": {
                    "type": "object",
                    "required": [
                        "language",
                        "silero_deactivity_detection",
                        "wakeword_speedx_noise_reduction",
                        "ambient_transcription",
                    ],
                    "properties": {
                        "language": {"type": "string"},
                        "silero_deactivity_detection": {"type": "boolean"},
                        "wakeword_speedx_noise_reduction": {"type": "boolean"},
                        "ambient_transcription": {
                            "type": "object",
                            "required": [
                                "enable",
                                "chunk_duration",
                                "storage_path",
                                "filter_short_transcriptions",
                                "min_transcription_length",
                            ],
                            "properties": {
                                "enable": {"type": "boolean"},
                                "chunk_duration": {"type": "number", "minimum": 0.5, "maximum": 60.0},
                                "storage_path": {"type": "string"},
                                "filter_short_transcriptions": {"type": "boolean"},
                                "min_transcription_length": {"type": "integer", "minimum": 0},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "additionalProperties": False,
                },
                "text_to_speech": {
                    "type": "object",
                    "required": [
                        "model_file_path",
                        "model_config_file_path",
                        "model_sample_rate",
                        "piper_path",
                    ],
                    "properties": {
                        "model_file_path": {"type": "string"},
                        "model_config_file_path": {"type": "string"},
                        "model_sample_rate": {"type": "integer", "minimum": 8000, "maximum": 48000},
                        "piper_path": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
                "hardware_acceleration": {
                    "type": "object",
                    "required": ["tts", "stt", "ocr_bg", "ocr_curr", "llm"],
                    "properties": {
                        "tts": {"type": "boolean"},
                        "stt": {"type": "boolean"},
                        "ocr_bg": {"type": "boolean"},
                        "ocr_curr": {"type": "boolean"},
                        "llm": {"type": "boolean"},
                    },
                    "additionalProperties": False,
                },
                "plugins": {
                    "type": "object",
                    "required": [
                        "jira",
                        "openrecall",
                        "brave_search",
                        "github",
                        "slack",
                        "gmail",
                        "gcalendar",
                    ],
                    "properties": {
                        "jira": {
                            "type": "object",
                            "required": ["activate", "api_token", "username", "instance_url"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "api_token": {"type": "string"},
                                "username": {"type": "string"},
                                "instance_url": {"type": "string", "format": "uri"},
                            },
                            "additionalProperties": False,
                        },
                        "openrecall": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {"activate": {"type": "boolean"}},
                            "additionalProperties": False,
                        },
                        "brave_search": {
                            "type": "object",
                            "required": ["activate", "api_key"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "api_key": {"type": "string"},
                            },
                            "additionalProperties": False,
                        },
                        "github": {
                            "type": "object",
                            "required": ["activate", "app_id", "app_private_key", "repository"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "app_id": {"type": "string"},
                                "app_private_key": {"type": "string"},
                                "repository": {"type": "string"},
                            },
                            "additionalProperties": False,
                        },
                        "slack": {
                            "type": "object",
                            "required": ["activate", "user_token"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "user_token": {"type": "string"},
                            },
                            "additionalProperties": False,
                        },
                        "gmail": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {"activate": {"type": "boolean"}},
                            "additionalProperties": False,
                        },
                        "gcalendar": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {"activate": {"type": "boolean"}},
                            "additionalProperties": False,
                        },
                    },
                    "additionalProperties": False,
                },
                "google": {
                    "type": "object",
                    "required": ["credentials_file"],
                    "properties": {"credentials_file": {"type": "string"}},
                    "additionalProperties": False,
                },
            },
            "additionalProperties": False,
        }

    def _validate_config(self, config_data: dict[str, Any]) -> None:
        """Validate configuration data against the schema"""
        try:
            validate(instance=config_data, schema=self._schema)
        except ValidationError as e:
            # Re-raise with more context
            raise ValidationError(f"Configuration validation failed at '{e.json_path}': {e.message}")

    def validate_current_config(self) -> list[str]:
        """Validate current configuration and return list of validation errors"""
        errors = []

        try:
            self._validate_config(self._config)
        except ValidationError as e:
            errors.append(str(e))

        # Additional semantic validation
        semantic_errors = self.validate_config()
        errors.extend(semantic_errors)

        return errors

    def validate_config(self) -> list[str]:
        """Validate configuration and return list of validation errors"""
        errors = []

        # Validate LLM configuration
        provider = self.get("llm.provider")
        if not provider:
            errors.append("No LLM provider specified")
        else:
            if provider == "openai":
                if not self.get("llm.third_party.openai.options.model"):
                    errors.append("OpenAI model not specified")
            elif provider == "huggingface_endpoint":
                if not self.get("llm.third_party.huggingface_endpoint.options.endpoint_url"):
                    errors.append("HuggingFace endpoint URL not specified")
                if not self.get("llm.third_party.huggingface_endpoint.options.access_token"):
                    errors.append("HuggingFace access token not specified")
            elif provider == "huggingface_pipeline":
                if not self.get("llm.local.huggingface_pipeline.options.model"):
                    errors.append("HuggingFace Pipeline model not specified")
            elif provider == "llama_cpp":
                model_path = self.get("llm.local.llama_cpp.options.model_path")
                if not model_path:
                    errors.append("Llama.cpp model path not specified")
                elif not os.path.exists(model_path):
                    errors.append(f"Llama.cpp model file not found: {model_path}")

        # Validate TTS model paths exist
        tts_model = self.get("text_to_speech.model_file_path")
        if tts_model and not os.path.exists(tts_model.lstrip("/")):
            errors.append(f"TTS model file not found: {tts_model}")

        # Validate hardware acceleration configuration
        hw_accel_keys = ["tts", "stt", "ocr_bg", "ocr_curr", "llm"]
        for key in hw_accel_keys:
            value = self.get(f"hardware_acceleration.{key}")
            if not isinstance(value, bool):
                errors.append(f"Hardware acceleration setting hardware_acceleration.{key} must be boolean, got {type(value)}")

        return errors


# Global instance
config_manager = ConfigManager()

import json
import os
from collections.abc import Callable
from threading import Lock
from typing import Any

from jsonschema import ValidationError, validate

from app.helpers.aurora_logger import log_error, log_info, log_warning

from app.services.config.env_config import ENV_CONFIG_MAP


class ConfigManager:
    """
    Thread-safe configuration manager that handles loading, saving, and runtime updates
    of application configuration from a JSON file.
    """

    _instance = None
    _lock = Lock()
    _schema = None

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
            self._schema = self._get_config_schema()  # Ensure schema is loaded
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
                    raise RuntimeError(f"Configuration validation failed: {e.message}") from e
            else:
                self._config = self._get_default_config()
                self.save_config()
                log_info("Created default configuration file")
        except Exception as e:
            log_error(f"Error loading config: {e}")
            raise RuntimeError(f"Error loading config: {e}") from e

    def save_config(self):
        """Save current configuration to JSON file"""
        try:
            # Note: Don't acquire lock here as it might be called from within a locked context
            with open(self.config_file, "w") as f:
                json.dump(self._config, f, indent=2)
            log_info("Configuration saved to config.json")
        except Exception as e:
            log_error(f"Error saving config: {e}")

    def _is_value_set(self, value: Any) -> bool:
        """Return True if value is considered 'set' (non-empty, config override)."""
        if value is None:
            return False
        if isinstance(value, str):
            return value.strip() != ""
        if isinstance(value, (list, dict)):
            return len(value) > 0
        return True

    def get(self, key_path: str, default: Any = None) -> Any:
        """
        Get configuration value using dot notation (e.g., 'ui.activate').

        Resolution order: config.json (if set) > .env > default.
        Config overrides allow runtime changes without reloading .env.
        """
        keys = key_path.split(".")
        config_val = self._config
        try:
            for key in keys:
                config_val = config_val[key]
        except (KeyError, TypeError):
            config_val = None
        if self._is_value_set(config_val):
            return config_val
        env_info = ENV_CONFIG_MAP.get(key_path)
        if env_info:
            env_var, converter = env_info
            env_val = os.environ.get(env_var)
            if env_val is not None and env_val != "":
                try:
                    return converter(env_val)
                except (ValueError, TypeError):
                    pass
        return config_val if config_val is not None else default

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
                raise ValueError(f"Configuration change rejected: {e.message}") from e

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
        """Return default configuration structure loaded from config_defaults.json"""
        defaults_path = os.path.join(os.path.dirname(__file__), "config_defaults.json")
        try:
            with open(defaults_path) as f:
                return json.load(f)
        except Exception as e:
            log_error(f"Failed to load default config from {defaults_path}: {e}")
            # Fallback to minimal config if defaults file is missing
            return {
                "general": {
                    "llm": {"provider": "openai"},
                    "embeddings": {"use_local": True},
                    "speech_to_text": {"language": "", "ambient_transcription": {"enable": False}},
                    "text_to_speech": {},
                    "hardware_acceleration": {},
                },
                "ui": {"activate": False, "dark_mode": False, "debug": False},
                "plugins": {},
                "mcp": {"enabled": True, "servers": {}},
            }

    def clean_empty_strings(self, save: bool = True) -> int:
        """Remove empty string values from configuration and return count of cleaned fields"""

        def clean_dict(d: dict) -> int:
            cleaned = 0
            keys_to_remove = []

            for key, value in d.items():
                if isinstance(value, dict):
                    cleaned += clean_dict(value)
                elif isinstance(value, str) and value.strip() == "":
                    keys_to_remove.append(key)
                    cleaned += 1

            for key in keys_to_remove:
                del d[key]

            return cleaned

        with self.config_lock:
            cleaned_count = clean_dict(self._config)

            if cleaned_count > 0 and save:
                self.save_config()
                log_info(f"Cleaned {cleaned_count} empty string fields from configuration")

            return cleaned_count

    def migrate_secrets_to_env(self) -> bool:
        """One-time migration: move secrets from config.json to .env.

        Returns True if any migration occurred.
        """
        migrated = False
        env_path = ".env"
        try:
            from dotenv import set_key

            from app.services.config.env_config import ENV_CONFIG_MAP, SENSITIVE_KEYS

            if not os.path.exists(env_path):
                open(env_path, "a").close()
            for config_path in SENSITIVE_KEYS:
                if config_path not in ENV_CONFIG_MAP:
                    continue
                env_var, _ = ENV_CONFIG_MAP[config_path]
                keys = config_path.split(".")
                d = self._config
                try:
                    for key in keys:
                        d = d[key]
                except (KeyError, TypeError):
                    continue
                if not self._is_value_set(d):
                    continue
                if isinstance(d, list):
                    set_key(env_path, env_var, ",".join(str(x) for x in d))
                else:
                    set_key(env_path, env_var, str(d))
                self.set(config_path, [] if isinstance(d, list) else "", save=False)
                migrated = True
                log_info(f"Migrated {config_path} from config.json to .env")
        except Exception as e:
            log_warning(f"Could not migrate secrets to .env: {e}")
        if migrated:
            self.save_config()
        return migrated

    def migrate_from_env(self):
        """One-time migration: move secrets from config.json to .env.

        Config and .env now live in parallel. No env→config migration.
        """
        self.migrate_secrets_to_env()

    def get_config_dict(self) -> dict[str, Any]:
        """Get a copy of the entire configuration dictionary with env fallbacks resolved."""
        with self.config_lock:
            config_copy = json.loads(json.dumps(self._config))
        return self._resolve_env_fallbacks(config_copy)

    def _resolve_env_fallbacks(self, config: dict[str, Any]) -> dict[str, Any]:
        """Merge env fallback values into config (config overrides env)."""
        for config_path, (env_var, converter) in ENV_CONFIG_MAP.items():
            keys = config_path.split(".")
            d = config
            try:
                val = d
                for key in keys:
                    val = val[key]
                if self._is_value_set(val):
                    continue
            except (KeyError, TypeError):
                pass
            env_val = os.environ.get(env_var)
            if env_val is None or env_val == "":
                continue
            try:
                resolved = converter(env_val)
            except (ValueError, TypeError):
                continue
            d = config
            for key in keys[:-1]:
                d = d.setdefault(key, {})
            d[keys[-1]] = resolved
        return config

    def _get_config_schema(self) -> dict[str, Any]:
        """Return the JSON schema for configuration validation with UI metadata"""
        # Load schema from external file "config_schema.json" in the same directory
        schema_path = os.path.join(os.path.dirname(__file__), "config_schema.json")
        try:
            with open(schema_path) as f:
                return json.load(f)

        except Exception as e:
            log_error(f"Failed to load config schema from {schema_path}: {e}")
            return {}

    def get_field_metadata(self) -> dict[str, dict[str, Any]]:
        """Extract field metadata from the configuration schema for UI generation"""
        metadata = {}
        self._schema = self._get_config_schema()  # Ensure schema is loaded

        def extract_metadata(schema: dict, path: str = ""):
            """Recursively extract metadata from schema"""
            # If 'properties' is present, iterate through them
            if "properties" in schema:
                for key, prop in schema["properties"].items():
                    current_path = f"{path}.{key}" if path else key

                    # Start with a copy of all properties (excluding nested dicts)
                    field_meta = {k: v for k, v in prop.items() if not isinstance(v, dict)}

                    # Determine UI type - prioritize ui_type over JSON schema type mapping
                    if "ui_type" in prop:
                        # Use explicit ui_type when specified
                        field_meta["type"] = prop["ui_type"]
                    else:
                        # Map JSON schema types to UI types
                        json_type = prop.get("type", "string")
                        if json_type == "boolean":
                            field_meta["type"] = "bool"
                        elif json_type == "integer":
                            field_meta["type"] = "int"
                        elif json_type == "number":
                            field_meta["type"] = "float"
                        elif json_type == "string":
                            if "enum" in prop or "ui_choices" in prop:
                                field_meta["type"] = "choice"
                                # Use ui_choices if available, otherwise use enum
                                field_meta["choices"] = prop.get("ui_choices", prop.get("enum", []))
                            else:
                                field_meta["type"] = "string"
                        elif json_type == "object":
                            field_meta["type"] = "dict"
                        elif json_type == "array":
                            field_meta["type"] = "list"
                        else:
                            field_meta["type"] = "string"

                    # Handle choices for choice type fields (in case ui_type="choice" is used)
                    if field_meta["type"] == "choice" and "choices" not in field_meta:
                        field_meta["choices"] = prop.get("ui_choices", prop.get("enum", []))

                    # Extract constraints with consistent naming
                    if "minimum" in prop:
                        field_meta["min"] = prop["minimum"]
                    if "maximum" in prop:
                        field_meta["max"] = prop["maximum"]

                    # Handle file filter for file type fields
                    if field_meta["type"] == "file" and "ui_file_filter" in prop:
                        field_meta["file_filter"] = prop["ui_file_filter"]

                    # Store metadata for this field
                    metadata[current_path] = field_meta

                    # Recursively process nested objects
                    json_type = prop.get("type", "string")
                    if json_type == "object" and "properties" in prop:
                        extract_metadata(prop, current_path)

        # Extract metadata from the schema
        extract_metadata(self._schema)

        # Add some special cases that aren't directly in the schema
        metadata.update(
            {
                # Dictionaries that should NOT be expanded (treat as single JSON fields)
                "plugins.jira.env": {
                    "expand_dict": False,
                    "type": "dict",
                    "description": "Environment variables for Jira plugin",
                }
            }
        )

        return metadata

    def _validate_config(self, config_data: dict[str, Any]) -> None:
        """Validate configuration data against the schema"""
        try:
            validate(instance=config_data, schema=self._schema)
        except ValidationError as e:
            # Re-raise with more context
            raise ValidationError(
                f"Configuration validation failed at '{e.json_path}': {e.message}"
            ) from e

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
                errors.append(
                    f"Hardware acceleration setting hardware_acceleration.{key} must be boolean, got {type(value)}"
                )

        return errors


# Global instance
config_manager = ConfigManager()

import json
import os
from typing import Any, Dict, Optional, Callable, List
from threading import Lock
import logging
from pathlib import Path
import jsonschema
from jsonschema import validate, ValidationError

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
                    cls._instance = super(ConfigManager, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        if not hasattr(self, 'initialized'):
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
                with open(self.config_file, 'r') as f:
                    config_data = json.load(f)
                
                # Validate the loaded configuration against schema
                try:
                    self._validate_config(config_data)
                    self._config = config_data
                    logging.info("Configuration loaded and validated from config.json")
                except ValidationError as e:
                    logging.error(f"Configuration validation failed: {e.message}")
                    logging.warning("Using default configuration due to validation errors")
                    self._config = self._get_default_config()
                    self.save_config()  # Save the valid default config
                    
            else:
                self._config = self._get_default_config()
                self.save_config()
                logging.info("Created default configuration file")
        except Exception as e:
            logging.error(f"Error loading config: {e}")
            self._config = self._get_default_config()
    
    def save_config(self):
        """Save current configuration to JSON file"""
        try:
            # Note: Don't acquire lock here as it might be called from within a locked context
            with open(self.config_file, 'w') as f:
                json.dump(self._config, f, indent=2)
            logging.info("Configuration saved to config.json")
        except Exception as e:
            logging.error(f"Error saving config: {e}")
    
    def get(self, key_path: str, default: Any = None) -> Any:
        """
        Get configuration value using dot notation (e.g., 'ui.activate')
        """
        keys = key_path.split('.')
        value = self._config
        
        try:
            for key in keys:
                value = value[key]
            return value
        except (KeyError, TypeError):
            return default
    
    def set(self, key_path: str, value: Any, save: bool = True):
        """
        Set configuration value using dot notation and optionally save to file
        """
        keys = key_path.split('.')
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
    
    def update_section(self, section: str, values: Dict[str, Any], save: bool = True):
        """Update an entire configuration section"""
        if section not in self._config:
            self._config[section] = {}
        
        with self.config_lock:
            self._config[section].update(values)
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
                logging.error(f"Error notifying observer: {e}")
    
    def _get_default_config(self) -> Dict:
        """Return default configuration structure"""
        return {
            "ui": {
                "activate": False,
                "dark_mode": False,
                "debug": False
            },
            "llm": {
                "llama_cpp_model_path": "",
                "openai_model": "",
                "openai_chat_model": ""
            },
            "embeddings": {
                "use_local": False
            },
            "speech_to_text": {
                "language": "",
                "silero_deactivity_detection": False,
                "wakeword_speedx_noise_reduction": False
            },
            "text_to_speech": {
                "model_file_path": "/voice_models/en_US-lessac-medium.onnx",
                "model_config_file_path": "/voice_models/en_US-lessac-medium.onnx.txt",
                "model_sample_rate": 22050,
                "piper_path": ""
            },
            "cuda": {
                "use_cuda_tts": False,
                "use_cuda_stt": False,
                "use_cuda_ocr_bg": False,
                "use_cuda_ocr_curr": True
            },
            # Plugins configuration
            "plugins": {
                "jira": {
                    "activate": False,
                    "api_token": "",
                    "username": "",
                    "instance_url": "https://jira.atlassian.net/"
                },
                "openrecall": {
                    "activate": False
                },
                "brave_search": {
                    "activate": False,
                    "api_key": ""
                },
                "github": {
                    "activate": False,
                    "app_id": "",
                    "app_private_key": "",
                    "repository": ""
                },
                "slack": {
                    "activate": False,
                    "user_token": ""
                },
                "gmail": {
                    "activate": False
                },
                "gcalendar": {
                    "activate": False
                }
            },
            "google": {
                "credentials_file": "google_credentials.json"
            }
        }
    
    def migrate_from_env(self):
        """Migrate existing environment variables to config.json"""
        migration_map = {
            'AURORA_UI_ACTIVATE': ('ui.activate', lambda x: x.lower() == 'true'),
            'AURORA_DARK_MODE': ('ui.dark_mode', lambda x: x.lower() == 'true'),
            'AURORA_UI_DEBUG': ('ui.debug', lambda x: x.lower() == 'true'),
            'LLAMMA_CPP_MODEL_PATH': ('llm.llama_cpp_model_path', str),
            'OPENAI_MODEL': ('llm.openai_model', str),
            'OPENAI_CHAT_MODEL': ('llm.openai_chat_model', str),
            'USE_LOCAL_EMBEDDINGS': ('embeddings.use_local', lambda x: x.lower() == 'true'),
            'STT_LANGUAGE': ('speech_to_text.language', str),
            'STT_SILERO_DEACTIVITY_DETECTION': ('speech_to_text.silero_deactivity_detection', lambda x: x.lower() == 'true'),
            'STT_WAKEWORD_SPEEDX_NOISE_REDUCTION': ('speech_to_text.wakeword_speedx_noise_reduction', lambda x: x.lower() == 'true'),
            'TTS_MODEL_FILE_PATH': ('text_to_speech.model_file_path', str),
            'TTS_MODEL_CONFIG_FILE_PATH': ('text_to_speech.model_config_file_path', str),
            'TTS_MODEL_SAMPLE_RATE': ('text_to_speech.model_sample_rate', int),
            'PIPER_PATH': ('text_to_speech.piper_path', str),
            'USE_CUDA_TTS': ('cuda.use_cuda_tts', lambda x: x.lower() == 'true'),
            'USE_CUDA_STT': ('cuda.use_cuda_stt', lambda x: x.lower() == 'true'),
            'USE_CUDA_OCR_BG': ('cuda.use_cuda_ocr_bg', lambda x: x.lower() == 'true'),
            'USE_CUDA_OCR_CURR': ('cuda.use_cuda_ocr_curr', lambda x: x.lower() == 'true'),
            'JIRA_ACTIVATE_PLUGIN': ('plugins.jira.activate', lambda x: x.lower() == 'true'),
            'JIRA_API_TOKEN': ('plugins.jira.api_token', str),
            'JIRA_USERNAME': ('plugins.jira.username', str),
            'JIRA_INSTANCE_URL': ('plugins.jira.instance_url', str),
            'OPENRECALL_ACTIVATE_PLUGIN': ('plugins.openrecall.activate', lambda x: x.lower() == 'true'),
            'BRAVE_SEARCH_ACTIVATE_PLUGIN': ('plugins.brave_search.activate', lambda x: x.lower() == 'true'),
            'BRAVE_API_KEY': ('plugins.brave_search.api_key', str),
            'GITHUB_ACTIVATE_PLUGIN': ('plugins.github.activate', lambda x: x.lower() == 'true'),
            'GITHUB_APP_ID': ('plugins.github.app_id', str),
            'GITHUB_APP_PRIVATE_KEY': ('plugins.github.app_private_key', str),
            'GITHUB_REPOSITORY': ('plugins.github.repository', str),
            'SLACK_ACTIVATE_PLUGIN': ('plugins.slack.activate', lambda x: x.lower() == 'true'),
            'SLACK_USER_TOKEN': ('plugins.slack.user_token', str),
            'GMAIL_ACTIVATE_PLUGIN': ('plugins.gmail.activate', lambda x: x.lower() == 'true'),
            'GCALENDAR_ACTIVATE_PLUGIN': ('plugins.gcalendar.activate', lambda x: x.lower() == 'true'),
            'GOOGLE_CREDENTIALS_FILE': ('google.credentials_file', str)
        }
        
        migrated = False
        for env_var, (config_path, converter) in migration_map.items():
            env_value = os.environ.get(env_var)
            if env_value is not None and env_value != '':
                try:
                    converted_value = converter(env_value)
                    self.set(config_path, converted_value, save=False)
                    migrated = True
                except (ValueError, TypeError) as e:
                    logging.warning(f"Failed to convert {env_var}={env_value}: {e}")
        
        if migrated:
            self.save_config()
            logging.info("Migrated environment variables to config.json")
    
    def get_config_dict(self) -> Dict[str, Any]:
        """Get a copy of the entire configuration dictionary"""
        with self.config_lock:
            return json.loads(json.dumps(self._config))  # Deep copy

    def _get_config_schema(self) -> Dict[str, Any]:
        """Return the JSON schema for configuration validation"""
        return {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "required": ["ui", "llm", "embeddings", "speech_to_text", "text_to_speech", "cuda", "plugins", "google"],
            "properties": {
                "ui": {
                    "type": "object",
                    "required": ["activate", "dark_mode", "debug"],
                    "properties": {
                        "activate": {"type": "boolean"},
                        "dark_mode": {"type": "boolean"},
                        "debug": {"type": "boolean"}
                    },
                    "additionalProperties": False
                },
                "llm": {
                    "type": "object",
                    "required": ["llama_cpp_model_path", "openai_model", "openai_chat_model"],
                    "properties": {
                        "llama_cpp_model_path": {"type": "string"},
                        "openai_model": {"type": "string"},
                        "openai_chat_model": {"type": "string"}
                    },
                    "additionalProperties": False
                },
                "embeddings": {
                    "type": "object",
                    "required": ["use_local"],
                    "properties": {
                        "use_local": {"type": "boolean"}
                    },
                    "additionalProperties": False
                },
                "speech_to_text": {
                    "type": "object",
                    "required": ["language", "silero_deactivity_detection", "wakeword_speedx_noise_reduction"],
                    "properties": {
                        "language": {"type": "string"},
                        "silero_deactivity_detection": {"type": "boolean"},
                        "wakeword_speedx_noise_reduction": {"type": "boolean"}
                    },
                    "additionalProperties": False
                },
                "text_to_speech": {
                    "type": "object",
                    "required": ["model_file_path", "model_config_file_path", "model_sample_rate", "piper_path"],
                    "properties": {
                        "model_file_path": {"type": "string"},
                        "model_config_file_path": {"type": "string"},
                        "model_sample_rate": {"type": "integer", "minimum": 8000, "maximum": 48000},
                        "piper_path": {"type": "string"}
                    },
                    "additionalProperties": False
                },
                "cuda": {
                    "type": "object",
                    "required": ["use_cuda_tts", "use_cuda_stt", "use_cuda_ocr_bg", "use_cuda_ocr_curr"],
                    "properties": {
                        "use_cuda_tts": {"type": "boolean"},
                        "use_cuda_stt": {"type": "boolean"},
                        "use_cuda_ocr_bg": {"type": "boolean"},
                        "use_cuda_ocr_curr": {"type": "boolean"}
                    },
                    "additionalProperties": False
                },
                "plugins": {
                    "type": "object",
                    "required": ["jira", "openrecall", "brave_search", "github", "slack", "gmail", "gcalendar"],
                    "properties": {
                        "jira": {
                            "type": "object",
                            "required": ["activate", "api_token", "username", "instance_url"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "api_token": {"type": "string"},
                                "username": {"type": "string"},
                                "instance_url": {"type": "string", "format": "uri"}
                            },
                            "additionalProperties": False
                        },
                        "openrecall": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {
                                "activate": {"type": "boolean"}
                            },
                            "additionalProperties": False
                        },
                        "brave_search": {
                            "type": "object",
                            "required": ["activate", "api_key"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "api_key": {"type": "string"}
                            },
                            "additionalProperties": False
                        },
                        "github": {
                            "type": "object",
                            "required": ["activate", "app_id", "app_private_key", "repository"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "app_id": {"type": "string"},
                                "app_private_key": {"type": "string"},
                                "repository": {"type": "string"}
                            },
                            "additionalProperties": False
                        },
                        "slack": {
                            "type": "object",
                            "required": ["activate", "user_token"],
                            "properties": {
                                "activate": {"type": "boolean"},
                                "user_token": {"type": "string"}
                            },
                            "additionalProperties": False
                        },
                        "gmail": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {
                                "activate": {"type": "boolean"}
                            },
                            "additionalProperties": False
                        },
                        "gcalendar": {
                            "type": "object",
                            "required": ["activate"],
                            "properties": {
                                "activate": {"type": "boolean"}
                            },
                            "additionalProperties": False
                        }
                    },
                    "additionalProperties": False
                },
                "google": {
                    "type": "object",
                    "required": ["credentials_file"],
                    "properties": {
                        "credentials_file": {"type": "string"}
                    },
                    "additionalProperties": False
                }
            },
            "additionalProperties": False
        }

    def _validate_config(self, config_data: Dict[str, Any]) -> None:
        """Validate configuration data against the schema"""
        try:
            validate(instance=config_data, schema=self._schema)
        except ValidationError as e:
            # Re-raise with more context
            raise ValidationError(f"Configuration validation failed at '{e.json_path}': {e.message}")

    def validate_current_config(self) -> List[str]:
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

    def validate_config(self) -> List[str]:
        """Validate configuration and return list of validation errors"""
        errors = []
        
        # Validate LLM configuration
        if not self.get('llm.openai_chat_model') and not self.get('llm.llama_cpp_model_path'):
            errors.append("No LLM configured. Set either openai_chat_model or llama_cpp_model_path")
        
        # Validate TTS model paths exist
        tts_model = self.get('text_to_speech.model_file_path')
        if tts_model and not os.path.exists(tts_model.lstrip('/')):
            errors.append(f"TTS model file not found: {tts_model}")
        
        # Validate CUDA configuration
        cuda_keys = ['use_cuda_tts', 'use_cuda_stt', 'use_cuda_ocr_bg', 'use_cuda_ocr_curr']
        for key in cuda_keys:
            value = self.get(f'cuda.{key}')
            if not isinstance(value, bool):
                errors.append(f"CUDA setting cuda.{key} must be boolean, got {type(value)}")
        
        return errors

# Global instance
config_manager = ConfigManager()

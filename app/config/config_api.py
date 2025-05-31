from app.config.config_manager import config_manager
from app.helpers.aurora_logger import log_error
from typing import Any, Dict, List

class ConfigAPI:
    """API for runtime configuration changes"""
    
    @staticmethod
    def get_config(section: str = None) -> Dict[str, Any]:
        """Get entire config or specific section"""
        if section:
            return config_manager.get(section, {})
        return config_manager.get_config_dict()
    
    @staticmethod
    def update_config(key_path: str, value: Any) -> bool:
        """Update a specific configuration value"""
        try:
            config_manager.set(key_path, value)
            return True
        except Exception as e:
            log_error(f"Error updating config: {e}")
            return False
    
    @staticmethod
    def update_plugin_status(plugin_name: str, active: bool) -> bool:
        """Enable/disable a plugin"""
        return ConfigAPI.update_config(f'plugins.{plugin_name}.activate', active)
    
    @staticmethod
    def get_plugin_status(plugin_name: str) -> bool:
        """Check if a plugin is active"""
        return config_manager.get(f'plugins.{plugin_name}.activate', False)
    
    @staticmethod
    def validate_config() -> List[str]:
        """Validate current configuration"""
        return config_manager.validate_config()
    
    @staticmethod
    def add_config_observer(callback):
        """Add observer for configuration changes"""
        config_manager.add_observer(callback)
    
    @staticmethod
    def remove_config_observer(callback):
        """Remove observer for configuration changes"""
        config_manager.remove_observer(callback)
    
    @staticmethod
    def reload_from_file():
        """Reload configuration from file"""
        config_manager.load_config()
    
    @staticmethod
    def save_to_file():
        """Force save configuration to file"""
        config_manager.save_config()

# Global API instance
config_api = ConfigAPI()

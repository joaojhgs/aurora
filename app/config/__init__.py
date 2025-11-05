"""Legacy config module for backward compatibility.

This module provides backward compatibility imports.
The actual config functionality has been moved to:
- app/services/config/ - Config service implementation
- app/shared/config/interface.py - ConfigAPI interface

Note: This module may be removed in a future version.
"""

# Re-export ConfigManager for backward compatibility
from app.services.config.config_manager import ConfigManager, config_manager

__all__ = ["ConfigManager", "config_manager"]

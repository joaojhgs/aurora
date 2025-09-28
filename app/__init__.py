"""
Aurora Voice Assistant
======================

Intelligent Voice Assistant for Local Automation and Productivity.
"""

__version__ = "1.0.0"
__author__ = "Aurora Team"
__email__ = "aurora@example.com"
__license__ = "MIT"

# Main application components
from .config.config_manager import config_manager

__all__ = [
    "__version__",
    "__author__",
    "__email__",
    "__license__",
    "config_manager",
]

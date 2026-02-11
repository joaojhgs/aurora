"""Entry point module for Aurora console script.

This module provides the entry point for the 'aurora' console script.
It imports the main function from the root main.py file.
"""

import sys
from pathlib import Path

# Add project root to Python path to ensure main.py can be imported
project_root = Path(__file__).parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

# Import main function from root main.py
from main import main  # noqa: E402

# Export for console script entry point
__all__ = ["main"]

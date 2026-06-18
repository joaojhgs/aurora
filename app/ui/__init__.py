"""UI service module for Aurora.

The PyQt bridge is optional; keep package imports lightweight so headless SDK
and backend tests do not require PyQt6.
"""

from typing import Any

__all__ = ["UIBridge"]


def __getattr__(name: str) -> Any:
    if name == "UIBridge":
        from app.ui.bridge_service import UIBridge

        return UIBridge
    raise AttributeError(name)

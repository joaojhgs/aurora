"""Service implementations for Aurora's parallel architecture.

Subpackages are loaded on demand so ``unittest.mock.patch("app.services.auth.AuthService")``
and similar paths resolve without requiring every service extra at import time.
"""

from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

# Common subpackages referenced by patch strings and dynamic imports
_LAZY_SUBMODULES = frozenset(
    {
        "auth",
        "config",
        "db",
        "gateway",
        "orchestrator",
        "scheduler",
        "stt_coordinator",
        "stt_transcription",
        "stt_wakeword",
        "tooling",
        "tts",
    }
)

if TYPE_CHECKING:
    pass

__all__: list[str] = []


def __getattr__(name: str):
    if name in _LAZY_SUBMODULES:
        return importlib.import_module(f"app.services.{name}")
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

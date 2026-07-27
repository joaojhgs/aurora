"""Tests for the optional TTS runtime dependency boundary."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_tts_contract_surface_imports_without_audio_runtime_dependencies() -> None:
    """Contract discovery must not require the optional audio runtime stack."""
    script = """
import builtins

original_import = builtins.__import__
blocked_modules = {
    "RealtimeTTS",
    "app.services.tts.piper_engine",
    "pyaudio",
}

def guarded_import(name, *args, **kwargs):
    if name in blocked_modules:
        raise ModuleNotFoundError(f"blocked optional dependency: {name}")
    return original_import(name, *args, **kwargs)

builtins.__import__ = guarded_import

from app.services.tts.service import TTSService

TTSService()
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr

"""Tests for the optional transcription runtime dependency boundary."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_transcription_contract_surface_imports_without_model_dependencies() -> None:
    """Contract discovery must not require VAD or Whisper model packages."""
    script = """
import builtins

original_import = builtins.__import__
blocked_modules = {
    "faster_whisper",
    "webrtcvad",
}

def guarded_import(name, *args, **kwargs):
    if name in blocked_modules:
        raise ModuleNotFoundError(f"blocked optional dependency: {name}")
    return original_import(name, *args, **kwargs)

builtins.__import__ = guarded_import

from app.services.stt_transcription.service import TranscriptionService

TranscriptionService()
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr

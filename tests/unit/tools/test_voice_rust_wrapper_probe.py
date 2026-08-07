from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
WRAPPER = REPO / "tools/voice-runtime/c-api-probes/rust-wrapper"


def test_rust_wrapper_fails_closed_without_artifact_root() -> None:
    install_dir = os.environ.get("SHERPA_ONNX_INSTALL_DIR")
    if not install_dir or not Path(install_dir).exists():
        pytest.skip("SHERPA_ONNX_INSTALL_DIR is required for the Rust wrapper runtime test")

    env = os.environ.copy()
    env.pop("AURORA_VOICE_P4_ARTIFACT_ROOT", None)

    result = subprocess.run(
        ["cargo", "+1.88.0", "run", "--locked", "--quiet", "--"],
        cwd=WRAPPER,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert '"stage":"setup"' in result.stderr
    assert "missing --artifact-root or AURORA_VOICE_P4_ARTIFACT_ROOT" in result.stderr


def test_rust_wrapper_uses_local_target_ignore() -> None:
    assert "target/" in (WRAPPER / ".gitignore").read_text(encoding="utf-8")


def test_rust_wrapper_declares_rust_188_and_no_runtime_dependencies() -> None:
    cargo_toml = (WRAPPER / "Cargo.toml").read_text(encoding="utf-8")

    assert 'rust-version = "1.88"' in cargo_toml
    assert "[dependencies]\n" in cargo_toml

"""Tests for shared path resolution."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.shared import path_utils


def _unexpected_project_root() -> Path:
    raise AssertionError("project root must not be used")


def test_frozen_data_dir_uses_xdg_app_data_without_project_root(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A frozen Linux sidecar must not depend on an unpacked pyproject.toml."""
    xdg_root = tmp_path / "xdg"
    monkeypatch.delenv("AURORA_DATA_DIR", raising=False)
    monkeypatch.setenv("XDG_DATA_HOME", str(xdg_root))
    monkeypatch.setattr(path_utils.sys, "frozen", True, raising=False)
    monkeypatch.setattr(path_utils.sys, "platform", "linux")
    monkeypatch.setattr(
        path_utils,
        "get_project_root",
        _unexpected_project_root,
    )

    data_dir = path_utils.get_data_dir()

    assert data_dir == xdg_root / "aurora" / "data"
    assert data_dir.is_dir()


def test_frozen_data_dir_uses_macos_application_support(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A frozen macOS sidecar uses the user's Application Support directory."""
    home = tmp_path / "home"
    monkeypatch.delenv("AURORA_DATA_DIR", raising=False)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(path_utils.sys, "frozen", True, raising=False)
    monkeypatch.setattr(path_utils.sys, "platform", "darwin")
    monkeypatch.setattr(path_utils, "get_project_root", _unexpected_project_root)

    data_dir = path_utils.get_data_dir()

    assert data_dir == home / "Library" / "Application Support" / "Aurora" / "data"
    assert data_dir.is_dir()


def test_frozen_data_dir_uses_windows_local_app_data(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A frozen Windows sidecar uses LOCALAPPDATA when it is available."""
    local_app_data = tmp_path / "local-app-data"
    monkeypatch.delenv("AURORA_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(local_app_data))
    monkeypatch.setattr(path_utils.sys, "frozen", True, raising=False)
    monkeypatch.setattr(path_utils.sys, "platform", "win32")
    monkeypatch.setattr(path_utils, "get_project_root", _unexpected_project_root)

    data_dir = path_utils.get_data_dir()

    assert data_dir == local_app_data / "Aurora" / "data"
    assert data_dir.is_dir()

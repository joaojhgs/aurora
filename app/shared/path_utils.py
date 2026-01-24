"""Shared utilities for path resolution relative to project root.

This module provides consistent path resolution for model files, config files,
and other resources relative to the Aurora project root directory.
"""

import os
from pathlib import Path


def get_project_root() -> Path:
    """Get the Aurora project root directory.

    The project root is determined by finding the directory containing
    pyproject.toml, starting from the current file's location and walking up.

    Returns:
        Path: Absolute path to the project root directory
    """
    # Start from this file's location: app/shared/path_utils.py
    current_file = Path(__file__).resolve()
    # Go up: app/shared -> app -> project root
    project_root = current_file.parent.parent.parent

    # Verify by checking for pyproject.toml
    if not (project_root / "pyproject.toml").exists():
        # Fallback: try one more level up (in case we're in a different structure)
        project_root = project_root.parent
        if not (project_root / "pyproject.toml").exists():
            raise RuntimeError(
                f"Could not find project root (pyproject.toml) starting from {current_file}"
            )

    return project_root


def resolve_path(path: str | Path, base_dir: Path | None = None) -> Path:
    """Resolve a path relative to project root or a specified base directory.

    This function handles:
    - Absolute paths: Returns as-is if the path exists
    - Relative paths: Resolves relative to project root (or base_dir if provided)
    - Paths starting with "/" that don't exist: Treated as relative to project root
      (e.g., "/voice_models/..." -> "voice_models/...")

    Args:
        path: Path string to resolve. Can be absolute, relative, or start with "/"
        base_dir: Optional base directory. If None, uses project root.

    Returns:
        Path: Resolved absolute path

    Examples:
        >>> resolve_path("voice_models/model.onnx")
        Path("/home/user/aurora/voice_models/model.onnx")

        >>> resolve_path("/voice_models/model.onnx")  # Doesn't exist as absolute
        Path("/home/user/aurora/voice_models/model.onnx")

        >>> resolve_path("/home/user/model.onnx")  # Exists as absolute
        Path("/home/user/model.onnx")
    """
    if base_dir is None:
        base_dir = get_project_root()

    path_str = str(path)

    # If it's already a Path object, convert to string
    if isinstance(path, Path):
        path_str = str(path)

    # Handle absolute paths that actually exist
    if os.path.isabs(path_str) and os.path.exists(path_str):
        return Path(path_str).resolve()

    # Handle paths starting with "/" that don't exist as absolute
    # These are treated as relative to project root (legacy behavior)
    if path_str.startswith("/") and not os.path.exists(path_str):
        # Remove leading "/" and resolve relative to project root
        relative_path = path_str.lstrip("/")
        resolved = base_dir / relative_path
        return resolved.resolve()

    # Handle relative paths
    if not os.path.isabs(path_str):
        resolved = base_dir / path_str
        return resolved.resolve()

    # Fallback: return as-is (absolute path that might not exist yet)
    return Path(path_str).resolve()


def resolve_model_path(path: str | Path | None, default: str | None = None) -> Path | None:
    """Resolve a model file path relative to project root.

    Convenience function for resolving model paths with optional defaults.

    Args:
        path: Model path from config or env var. Can be None.
        default: Default relative path if path is None or empty.

    Returns:
        Path: Resolved absolute path, or None if path and default are both None/empty
    """
    if not path:
        if default:
            return resolve_path(default)
        return None

    return resolve_path(path)

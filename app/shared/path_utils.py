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
    # Legacy: "/voice_models/foo" was stored with a leading slash but meant project-relative.
    # Docker Compose often sets absolute paths under /app (e.g. /app/models/...) that are not
    # present at import time; those must NOT be joined to project root (would yield /app/app/...).
    if path_str.startswith("/") and not os.path.exists(path_str):
        if path_str.startswith("/app/"):
            return Path(path_str).resolve()
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


def get_data_dir() -> Path:
    """Return the writable data directory for persistent DB and cache files.

    Resolution order:
    1. ``AURORA_DATA_DIR`` env var (set explicitly in Docker Compose)
    2. ``get_project_root() / "data"``

    The directory is created if it doesn't exist. A write probe verifies the
    process can actually create files there — if not, a clear ``RuntimeError``
    is raised so operators see the permission mismatch immediately.
    """
    env_dir = os.environ.get("AURORA_DATA_DIR")
    data_dir = Path(env_dir) if env_dir else get_project_root() / "data"

    data_dir.mkdir(parents=True, exist_ok=True)

    probe = data_dir / ".aurora_write_probe"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"Data directory {data_dir} is not writable by UID {os.getuid()}. "
            f"Set AURORA_DATA_DIR to a writable path or fix volume mount permissions. "
            f"Original error: {exc}"
        ) from exc

    return data_dir


def ensure_path_writable_or_tmp(preferred: str, *, tmp_leaf: str) -> str:
    """Create ``preferred`` if possible and verify write access.

    Bind-mounted ``./data`` on the host is often root-owned while the container runs as
    non-root (e.g. Tilt ``working_dir: /app/host``). In that case fall back to a path
    under the system temp directory so downloads and caches still work.
    """
    p = os.path.abspath(preferred)
    try:
        os.makedirs(p, exist_ok=True)
        probe = os.path.join(p, ".aurora_write_probe")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return p
    except OSError:
        import tempfile

        fb = os.path.join(tempfile.gettempdir(), "aurora", tmp_leaf)
        os.makedirs(fb, mode=0o700, exist_ok=True)
        return fb

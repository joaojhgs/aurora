from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools/local-inference/build_llama_native.py"


def load_builder() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_llama_native", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def archive_tool() -> str:
    tool = shutil.which("llvm-ar") or shutil.which("ar")
    if tool is None:
        pytest.skip("an ar-compatible archiver is required for archive comparison")
    return tool


def write_archive(root: Path, name: str, member_name: str, payload: bytes, tool: str) -> Path:
    member = root / member_name
    member.write_bytes(payload)
    archive = root / name
    subprocess.run([tool, "rcs", str(archive), str(member)], check=True, capture_output=True)
    return archive


def test_archive_comparison_accepts_metadata_only_difference(tmp_path: Path) -> None:
    builder = load_builder()
    tool = archive_tool()
    installed = write_archive(tmp_path, "installed.a", "member.o", b"same member bytes", tool)
    built = write_archive(tmp_path, "built.a", "member.o", b"same member bytes", tool)

    # Change only the archive member timestamp field (bytes 16..27 of its
    # 60-byte header); the member name and payload remain real ar data.
    installed_bytes = bytearray(installed.read_bytes())
    assert installed_bytes[:8] == b"!<arch>\n"
    installed_bytes[8 + 16 : 8 + 28] = b"0000000001  "
    installed.write_bytes(installed_bytes)

    assert builder.static_archives_have_same_objects(installed, built, tool) is True


def test_archive_comparison_rejects_changed_object_bytes(tmp_path: Path) -> None:
    builder = load_builder()
    tool = archive_tool()
    installed = write_archive(tmp_path, "installed.a", "member.o", b"installed member", tool)
    built = write_archive(tmp_path, "built.a", "member.o", b"changed member", tool)

    assert builder.static_archives_have_same_objects(installed, built, tool) is False

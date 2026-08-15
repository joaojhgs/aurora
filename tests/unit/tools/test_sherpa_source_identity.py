from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import tarfile
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / "tools/voice-runtime/run_sherpa_cmake.py"


def load_wrapper() -> ModuleType:
    spec = importlib.util.spec_from_file_location("run_sherpa_cmake", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_fixture(tmp_path: Path, expected_commit: str = "1" * 40) -> tuple[Path, Path, Path]:
    artifact_root = tmp_path / "artifacts"
    source_root = artifact_root / "sources/extracted/sherpa"
    source_root.mkdir(parents=True)
    (source_root / "CMakeLists.txt").write_text("project(sherpa)\n", encoding="utf-8")
    (source_root / "link").symlink_to("CMakeLists.txt")
    archive = artifact_root / "sources/sherpa.tar.gz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(source_root, arcname="sherpa", recursive=True)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "artifacts": [
                    {
                        "id": "sherpa-onnx-source-v1.13.5",
                        "archive_path": "sources/sherpa.tar.gz",
                        "extraction_path": "sources/extracted/sherpa",
                        "size_bytes": archive.stat().st_size,
                        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                        "commit": expected_commit,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return manifest, artifact_root, source_root


def test_wrapper_suppresses_git_identity_inherited_from_outer_worktree(
    tmp_path: Path,
) -> None:
    wrapper = load_wrapper()
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    manifest, artifact_root, source_root = write_fixture(tmp_path)

    evidence, build_env = wrapper.verify_source_identity(manifest, artifact_root, source_root)

    assert evidence["status"] == "verified"
    assert evidence["source_has_own_git"] is False
    assert Path(evidence["inherited_git_root_suppressed"]) == tmp_path
    leaked = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "--show-toplevel"],
        env=build_env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert leaked.returncode != 0


def test_wrapper_rejects_wrong_source_archive_hash(tmp_path: Path) -> None:
    wrapper = load_wrapper()
    manifest, artifact_root, source_root = write_fixture(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["artifacts"][0]["sha256"] = "0" * 64
    manifest.write_text(json.dumps(data), encoding="utf-8")

    with pytest.raises(wrapper.SourceIdentityError, match="archive hash"):
        wrapper.verify_source_identity(manifest, artifact_root, source_root)


def test_wrapper_rejects_source_root_outside_pinned_extraction_path(tmp_path: Path) -> None:
    wrapper = load_wrapper()
    manifest, artifact_root, _ = write_fixture(tmp_path)
    other_source = tmp_path / "other-sherpa"
    other_source.mkdir()

    with pytest.raises(wrapper.SourceIdentityError, match="pinned extraction path"):
        wrapper.verify_source_identity(manifest, artifact_root, other_source)


def test_wrapper_rejects_mutated_extracted_tree(tmp_path: Path) -> None:
    wrapper = load_wrapper()
    manifest, artifact_root, source_root = write_fixture(tmp_path)
    (source_root / "CMakeLists.txt").write_text("project(tampered)\n", encoding="utf-8")

    with pytest.raises(wrapper.SourceIdentityError, match="does not match the pinned archive"):
        wrapper.verify_source_identity(manifest, artifact_root, source_root)


def test_wrapper_rejects_cmake_source_mismatch(tmp_path: Path) -> None:
    wrapper = load_wrapper()
    _, _, source_root = write_fixture(tmp_path)

    with pytest.raises(wrapper.SourceIdentityError, match="expected verified source"):
        wrapper.validate_cmake_command(["cmake", "-S", str(tmp_path)], source_root.resolve())


def test_wrapper_requires_direct_cmake_with_separate_source_flag(tmp_path: Path) -> None:
    wrapper = load_wrapper()
    _, _, source_root = write_fixture(tmp_path)

    with pytest.raises(wrapper.SourceIdentityError, match="invoke cmake directly"):
        wrapper.validate_cmake_command(["sh", "-c", "cmake -S elsewhere"], source_root.resolve())
    with pytest.raises(wrapper.SourceIdentityError, match="separate -S"):
        wrapper.validate_cmake_command(["cmake", f"-S{source_root}"], source_root.resolve())

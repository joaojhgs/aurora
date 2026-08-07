from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
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
    archive = artifact_root / "sources/sherpa.tar.gz"
    archive.write_bytes(b"pinned sherpa archive")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "artifacts": [
                    {
                        "id": "sherpa-onnx-source-v1.13.4",
                        "archive_path": "sources/sherpa.tar.gz",
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

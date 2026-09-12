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
PATCH_DIR = REPO / "tools/voice-runtime/sherpa-patches"


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


def test_patched_tree_allows_only_the_two_pinned_escaping_symlinks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wrapper = load_wrapper()
    monkeypatch.setattr(wrapper, "AURORA_SHERPA_PATCHED_FILES", {})
    regular = ("file", "1", hashlib.sha256(b"x").hexdigest())
    archive_records = {
        "CMakeLists.txt": regular,
        **{
            relative: ("symlink", target)
            for relative, target in wrapper.OMITTED_PINNED_UPSTREAM_SYMLINKS.items()
        },
    }
    source_records = {"CMakeLists.txt": regular}

    _, entry_count = wrapper._verify_patched_tree(archive_records, source_records, tmp_path)

    assert entry_count == 1


def test_patched_tree_rejects_a_retained_escaping_symlink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wrapper = load_wrapper()
    monkeypatch.setattr(wrapper, "AURORA_SHERPA_PATCHED_FILES", {})
    archive_records = {
        relative: ("symlink", target)
        for relative, target in wrapper.OMITTED_PINNED_UPSTREAM_SYMLINKS.items()
    }
    retained_path = next(iter(archive_records))
    source_records = {retained_path: archive_records[retained_path]}

    with pytest.raises(wrapper.SourceIdentityError, match="unsafe_link"):
        wrapper._verify_patched_tree(archive_records, source_records, tmp_path)


def test_patched_tree_rejects_changed_omitted_symlink_target(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wrapper = load_wrapper()
    monkeypatch.setattr(wrapper, "AURORA_SHERPA_PATCHED_FILES", {})
    archive_records = {
        relative: ("symlink", target)
        for relative, target in wrapper.OMITTED_PINNED_UPSTREAM_SYMLINKS.items()
    }
    changed_path = next(iter(archive_records))
    archive_records[changed_path] = ("symlink", "/unexpected/upstream/target")

    with pytest.raises(wrapper.SourceIdentityError, match="omitted sherpa symlink changed"):
        wrapper._verify_patched_tree(archive_records, {}, tmp_path)


def test_patched_tree_manifest_covers_every_patch_queue_target() -> None:
    patch_targets: set[str] = set()
    for patch_name in (PATCH_DIR / "series").read_text(encoding="utf-8").splitlines():
        patch_name = patch_name.strip()
        if not patch_name or patch_name.startswith("#"):
            continue
        for line in (PATCH_DIR / patch_name).read_text(encoding="utf-8").splitlines():
            if line.startswith("+++ b/"):
                patch_targets.add(line.removeprefix("+++ b/"))

    wrapper = load_wrapper()

    assert set(wrapper.AURORA_SHERPA_PATCHED_FILES) == patch_targets


@pytest.mark.parametrize(
    ("relative_path", "expected_digest"),
    [
        (
            "wasm/vad-asr/CMakeLists.txt",
            "3fd71985745374ae49c39dda296880326588159c42b01d474a18b06454c6a553",
        ),
        (
            "wasm/kws/CMakeLists.txt",
            "333eb9872949a142c3941e10f72833a9073670e90530a400b3c3fc51b6b55737",
        ),
        (
            "cmake/onnxruntime-osx-arm64-static.cmake",
            "b8422656f5379ff338c810351a22981185894f6b4b0b9dc932b38e998320bf6e",
        ),
    ],
)
def test_patched_tree_manifest_includes_verified_runtime_metadata(
    relative_path: str, expected_digest: str
) -> None:
    wrapper = load_wrapper()

    assert wrapper.AURORA_SHERPA_PATCHED_FILES[relative_path] == expected_digest


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

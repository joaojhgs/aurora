from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
APPLY = REPO / "tools/voice-runtime/sherpa-patches/apply_sherpa_patches.py"
SERIES = REPO / "tools/voice-runtime/sherpa-patches/series"
ATTRIBUTES = REPO / "tools/voice-runtime/sherpa-patches/.gitattributes"
ARCHIVE = REPO / ".artifacts/sherpa-onnx/sherpa-onnx-v1.13.5.tar.gz"


def test_series_matches_pinned_patch_digests() -> None:
    spec = __import__("importlib.util").util.spec_from_file_location("apply_sherpa_patches", APPLY)
    assert spec is not None and spec.loader is not None
    module = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(module)
    names = [
        line.strip()
        for line in SERIES.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert names == list(module.PATCH_SHA256)
    for name, digest in module.PATCH_SHA256.items():
        path = REPO / "tools/voice-runtime/sherpa-patches" / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest


def test_patch_bytes_keep_lf_endings_on_every_ci_host() -> None:
    assert ATTRIBUTES.read_text(encoding="utf-8").splitlines() == ["*.patch text eol=lf"]


def test_apply_queue_disables_git_line_ending_conversion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = __import__("importlib.util").util.spec_from_file_location("apply_sherpa_patches", APPLY)
    assert spec is not None and spec.loader is not None
    module = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(module)

    patch_dir = tmp_path / "patches"
    patch_dir.mkdir()
    patch = patch_dir / "line-endings.patch"
    patch.write_text(
        "--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-before\n+after\n",
        encoding="utf-8",
    )
    source_root = tmp_path / "outer" / "source"
    source_root.mkdir(parents=True)
    (source_root / "value.txt").write_bytes(b"before\n")
    subprocess.run(["git", "init", "-q", str(source_root.parent)], check=True)
    subprocess.run(
        ["git", "-C", str(source_root.parent), "config", "core.autocrlf", "true"],
        check=True,
    )
    monkeypatch.setattr(module, "PATCH_DIR", patch_dir)
    monkeypatch.setattr(
        module,
        "verify_patches",
        lambda: [{"name": patch.name, "sha256": hashlib.sha256(patch.read_bytes()).hexdigest()}],
    )
    commands: list[list[str]] = []
    real_run = module.subprocess.run

    def capture_run(
        command: list[str], *args: object, **kwargs: object
    ) -> subprocess.CompletedProcess:
        commands.append(command)
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(module.subprocess, "run", capture_run)

    module.apply_patches(source_root)

    assert commands[0][:6] == [
        "git",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "apply",
    ]
    assert (source_root / "value.txt").read_bytes() == b"after\n"


def test_patches_have_no_trailing_whitespace_on_added_lines() -> None:
    spec = __import__("importlib.util").util.spec_from_file_location("apply_sherpa_patches", APPLY)
    assert spec is not None and spec.loader is not None
    module = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for name in module.PATCH_SHA256:
        path = REPO / "tools/voice-runtime/sherpa-patches" / name
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if line.startswith("+") and not line.startswith("+++"):
                assert line[1:] == line[1:].rstrip(), f"{name}:{line_no} has trailing whitespace"


def test_pinned_source_extract_allows_in_tree_relative_symlink(tmp_path: Path) -> None:
    import io
    import tarfile

    spec = __import__("importlib.util").util.spec_from_file_location("apply_sherpa_patches", APPLY)
    assert spec is not None and spec.loader is not None
    module = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(module)
    archive = tmp_path / "pinned.tar"
    dest = tmp_path / "out"
    with tarfile.open(archive, "w") as tar:
        payload = b"shared\n"
        target = tarfile.TarInfo(name="src/shared.txt")
        target.size = len(payload)
        tar.addfile(target, fileobj=io.BytesIO(payload))
        link = tarfile.TarInfo(name="src/copy.txt")
        link.type = tarfile.SYMTYPE
        link.linkname = "shared.txt"
        tar.addfile(link)
    module.extract_pinned_source_tar(archive, dest)
    assert (dest / "src" / "shared.txt").read_bytes() == b"shared\n"
    assert (dest / "src" / "copy.txt").is_symlink()
    assert (dest / "src" / "copy.txt").read_bytes() == b"shared\n"

    escape = tmp_path / "escape.tar"
    with tarfile.open(escape, "w") as tar:
        link = tarfile.TarInfo(name="link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tar.addfile(link)
    with pytest.raises(module.PatchQueueError, match="escaping symlink"):
        module.extract_pinned_source_tar(escape, tmp_path / "escape")


def test_pinned_source_extract_can_omit_verified_upstream_escape_symlink(
    tmp_path: Path,
) -> None:
    import io
    import tarfile

    spec = __import__("importlib.util").util.spec_from_file_location("apply_sherpa_patches", APPLY)
    assert spec is not None and spec.loader is not None
    module = __import__("importlib.util").util.module_from_spec(spec)
    spec.loader.exec_module(module)

    archive = tmp_path / "pinned.tar"
    with tarfile.open(archive, "w") as tar:
        payload = b"required\n"
        required = tarfile.TarInfo(name="src/required.txt")
        required.size = len(payload)
        tar.addfile(required, fileobj=io.BytesIO(payload))
        stale = tarfile.TarInfo(name="src/stale-example-link")
        stale.type = tarfile.SYMTYPE
        stale.linkname = "/Users/upstream/example.txt"
        tar.addfile(stale)

    dest = tmp_path / "out"
    module.extract_pinned_source_tar(
        archive,
        dest,
        omit_escaping_symlinks=True,
    )
    assert (dest / "src" / "required.txt").read_bytes() == payload
    assert not (dest / "src" / "stale-example-link").exists()


def test_apply_script_rejects_wrong_archive(tmp_path: Path) -> None:
    archive = tmp_path / "bad.tar.gz"
    archive.write_bytes(b"not-sherpa")
    result = subprocess.run(
        [
            sys.executable,
            str(APPLY),
            "--archive",
            str(archive),
            "--staging-root",
            str(tmp_path / "staged"),
        ],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0


@pytest.mark.skipif(not ARCHIVE.is_file(), reason="pinned sherpa archive is not cached locally")
def test_apply_queue_onto_official_v1_13_5_archive(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            sys.executable,
            str(APPLY),
            "--archive",
            str(ARCHIVE),
            "--staging-root",
            str(tmp_path / "staged"),
            "--json",
        ],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["upstream"]["version"] == "v1.13.5"
    assert payload["upstream"]["sha256"] == (
        "99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262"
    )
    assert len(payload["patches"]) == 4
    source = Path(payload["source_root"])
    pocket = (source / "sherpa-onnx/csrc/offline-tts-pocket-model.cc").read_text(encoding="utf-8")
    assert "ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16" in pocket
    assert "insert_bos_before_voice" in pocket
    assert "fixed_voice_state" in pocket
    assert "SeedFixedVoiceState" in pocket
    assert "ReadPocketFile(AAssetManager" in pocket
    pocket_impl = (source / "sherpa-onnx/csrc/offline-tts-pocket-impl.h").read_text(
        encoding="utf-8"
    )
    assert "Fixed packs start from the seeded" in pocket_impl
    wasm = (source / "wasm/tts/CMakeLists.txt").read_text(encoding="utf-8")
    assert "AURORA_SHERPA_WASM_TTS_NEUTRAL" in wasm
    assert "-sMODULARIZE=1" in wasm
    assert "-sEXPORT_ES6=1" in wasm
    assert "sherpa-onnx-tts.esm.js" in wasm
    assert "export { createOfflineTts, getDefaultOfflineTtsModelType };" in wasm
    macos_ort = (source / "cmake/onnxruntime-osx-arm64-static.cmake").read_text(encoding="utf-8")
    assert "b9a84d5d1770818a8bb2a12d9adb45fc2cf5062b930176914cd4e7150ce3fcd2" in macos_ort
    assert "3c043b1d5231881d940f0184bd1aaeef29d8e816f2865feed0a268bddcf8b628" not in macos_ort

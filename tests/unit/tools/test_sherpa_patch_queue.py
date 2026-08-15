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
    assert len(payload["patches"]) == 2
    source = Path(payload["source_root"])
    pocket = (source / "sherpa-onnx/csrc/offline-tts-pocket-model.cc").read_text(
        encoding="utf-8"
    )
    assert "ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT16" in pocket
    assert "insert_bos_before_voice" in pocket
    wasm = (source / "wasm/tts/CMakeLists.txt").read_text(encoding="utf-8")
    assert "AURORA_SHERPA_WASM_TTS_NEUTRAL" in wasm

from __future__ import annotations

import json
import subprocess
import sys
import tarfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "tools/voice-runtime/browser-engine-release/stage_browser_engine_release.py"


def write_asset(root: Path, relative: str, body: bytes = b"asset") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)


def create_neutral_source_roots(tmp_path: Path) -> tuple[Path, Path]:
    source_root = tmp_path / "sherpa-onnx-1.13.5-neutral"
    tts_root = tmp_path / "sherpa-onnx-1.13.5-neutral-tts"
    write_asset(
        source_root,
        "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.js",
    )
    write_asset(
        source_root,
        "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-wasm-main-vad-asr.wasm",
    )
    write_asset(
        source_root,
        "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-vad.js",
    )
    write_asset(
        source_root,
        "build-wasm-simd-vad-asr/install/bin/wasm/vad-asr/sherpa-onnx-asr.js",
    )
    write_asset(
        source_root,
        "build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.js",
    )
    write_asset(
        source_root,
        "build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-wasm-kws-main.wasm",
    )
    write_asset(source_root, "build-wasm-simd-kws/install/bin/wasm/sherpa-onnx-kws.js")
    write_asset(tts_root, "sherpa-onnx-wasm-main-tts.js")
    write_asset(tts_root, "sherpa-onnx-wasm-main-tts.wasm")
    write_asset(tts_root, "sherpa-onnx-tts.js")
    write_asset(tts_root, "sherpa-onnx-tts.worker.js")
    return source_root, tts_root


def run_stage(
    output_root: Path, source_root: Path, tts_root: Path
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(SCRIPT),
        "--source-root",
        str(source_root),
        "--tts-artifact-root",
        str(tts_root),
        "--output-root",
        str(output_root),
    ]
    return subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)


def test_stages_engine_code_without_model_payloads(tmp_path: Path) -> None:
    source_root, tts_root = create_neutral_source_roots(tmp_path)
    result = run_stage(tmp_path / "release", source_root, tts_root)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["capabilities"] == {"kws": True, "stt": True, "tts": True, "vad": True}

    report_path = Path(payload["report"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["source"]["id"] == "sherpa-onnx-source-v1.13.5"
    assert (
        report["source"]["sha256"]
        == "99f520db7364a06be0c174a385d03f9ccdbfe08f61146055229e4a990e285262"
    )
    assert report["policy"]["contains_model_weights"] is False

    files = [
        path.relative_to(tmp_path / "release")
        for path in (tmp_path / "release").rglob("*")
        if path.is_file()
    ]
    assert Path("assets/vad-stt/sherpa-onnx-wasm-main-vad-asr.wasm") in files
    assert Path("assets/kws/sherpa-onnx-wasm-kws-main.wasm") in files
    assert Path("assets/tts/sherpa-onnx-wasm-main-tts.wasm") in files
    forbidden_suffixes = {
        ".data",
        ".onnx",
        ".ort",
        ".wav",
        ".model",
        ".bin",
        ".tar",
        ".bz2",
        ".zip",
    }
    leaked = [str(path) for path in files if path.suffix.lower() in forbidden_suffixes]
    assert leaked == []


def test_rejects_forbidden_payloads(tmp_path: Path) -> None:
    source_root, tts_root = create_neutral_source_roots(tmp_path)
    release = tmp_path / "release"
    result = run_stage(release, source_root, tts_root)
    assert result.returncode == 0, result.stderr
    leak = release / "assets" / "kws" / "tokens.txt"
    leak.write_text("not allowed in engine release\n", encoding="utf-8")

    command = [
        sys.executable,
        str(SCRIPT),
        "--source-root",
        str(source_root),
        "--tts-artifact-root",
        str(tts_root),
        "--output-root",
        str(release),
        "--skip-stage",
    ]
    check = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)
    assert check.returncode == 0

    # The validator is called during staging; prove its forbidden-path rule directly
    # against the leaked tree because --skip-stage intentionally avoids mutations.
    import importlib.util

    spec = importlib.util.spec_from_file_location("stage_browser_engine_release", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    assert module.validate_release_tree(release) == ["assets/kws/tokens.txt"]


def test_archive_sources_extract_outside_release_tree(tmp_path: Path, monkeypatch) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("stage_browser_engine_release_extract", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

    archive = tmp_path / "source.tar.gz"
    with tarfile.open(archive, "w:gz"):
        pass
    release = tmp_path / "release"
    staging = tmp_path / ".release-source-test"

    def fake_extract(_archive: Path, destination: Path, *, mode: str) -> None:
        assert mode == "r:gz"
        (destination / "sherpa-onnx-1.13.5").mkdir(parents=True)

    monkeypatch.setattr(module, "_extract_pinned_source_tar", fake_extract)
    extracted = module.extract_source_archive(archive, staging)

    assert extracted.is_dir()
    assert release not in extracted.parents

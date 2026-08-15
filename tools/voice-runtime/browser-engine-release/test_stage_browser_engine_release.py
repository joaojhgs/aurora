from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "tools/voice-runtime/browser-engine-release/stage_browser_engine_release.py"
NEUTRAL_SOURCE = Path(
    "/home/developer/projects/aurora/.artifacts/sherpa-onnx-1.13.4-neutral-20260814053955"
)
NEUTRAL_TTS = Path(
    "/home/developer/projects/aurora/.artifacts/sherpa-onnx-1.13.4-neutral-tts-wasm-202608140712"
)
PHASE4_ROOT = Path("/home/developer/projects/aurora/.artifacts/pockettts/p4-native-voice")


def run_stage(output_root: Path) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(SCRIPT),
        "--artifact-root",
        str(PHASE4_ROOT),
        "--source-root",
        str(NEUTRAL_SOURCE),
        "--tts-artifact-root",
        str(NEUTRAL_TTS),
        "--output-root",
        str(output_root),
    ]
    return subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=False)


def test_stages_engine_code_without_model_payloads(tmp_path: Path) -> None:
    result = run_stage(tmp_path / "release")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["capabilities"] == {"kws": True, "stt": True, "tts": True, "vad": True}

    report_path = Path(payload["report"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["source"]["id"] == "sherpa-onnx-source-v1.13.4"
    assert (
        report["source"]["sha256"]
        == "3243cb386d3a4ac87596adf7d2c89fddf23e2948b154942b987b4d91c1fee295"
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
    release = tmp_path / "release"
    result = run_stage(release)
    assert result.returncode == 0, result.stderr
    leak = release / "assets" / "kws" / "tokens.txt"
    leak.write_text("not allowed in engine release\n", encoding="utf-8")

    command = [
        sys.executable,
        str(SCRIPT),
        "--source-root",
        str(NEUTRAL_SOURCE),
        "--tts-artifact-root",
        str(NEUTRAL_TTS),
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

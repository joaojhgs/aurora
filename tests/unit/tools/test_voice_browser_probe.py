import importlib.util
from pathlib import Path
from types import ModuleType

MODULE_PATH = (
    Path(__file__).resolve().parents[3]
    / "tools"
    / "voice-runtime"
    / "browser-probe"
    / "run_phase4_browser_probe.py"
)
REPO_ROOT = Path(__file__).resolve().parents[3]


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("run_phase4_browser_probe", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_validate_artifact_root_lists_missing_required_files(tmp_path: Path) -> None:
    runner = load_runner()

    missing = runner.validate_artifact_root(tmp_path)

    assert missing
    assert "builds/wasm-vad-asr/bin/sherpa-onnx-wasm-main-vad-asr.js" in missing
    assert "builds/wasm-kws/bin/sherpa-onnx-wasm-kws-main.js" in missing


def test_validate_artifact_root_accepts_required_files(tmp_path: Path) -> None:
    runner = load_runner()
    for relative in runner.REQUIRED_ARTIFACTS:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")

    assert runner.validate_artifact_root(tmp_path) == []


def test_worker_uses_dedicated_worker_and_real_vad_asr_assets() -> None:
    runner = load_runner()

    assert "new Worker('/probe-worker.js')" in runner.INDEX_HTML
    assert "new Worker('/kws-worker.js')" in runner.INDEX_HTML
    assert "sherpa-onnx-wasm-main-vad-asr.js" in runner.WORKER_JS
    assert "new OfflineRecognizer" in runner.WORKER_JS
    assert "createVad" in runner.WORKER_JS
    assert "sherpa-onnx-wasm-kws-main.js" in runner.KWS_WORKER_JS
    assert "createKws" in runner.KWS_WORKER_JS
    assert "FOREVER" in runner.KWS_WORKER_JS
    assert "LOVELY CHILD" in runner.KWS_WORKER_JS
    assert "normalizedText === expectedText" in runner.WORKER_JS
    assert "expectedKeywords.every" in runner.KWS_WORKER_JS
    assert "results.kws && results.kws.ok" in runner.INDEX_HTML
    assert "workerScope && sharedArrayBuffer && crossOriginIsolated" in runner.INDEX_HTML
    assert "workers[0].worker.postMessage" in runner.INDEX_HTML


def test_wasm_tts_builder_stages_every_browser_runtime_asset() -> None:
    build_script = (REPO_ROOT / "tools/voice-runtime/build_sherpa_wasm_tts.sh").read_text(
        encoding="utf-8"
    )
    stage_script = (
        REPO_ROOT / "tools/voice-runtime/browser-engine-release/stage_browser_engine_release.py"
    ).read_text(encoding="utf-8")

    required_assets = (
        "sherpa-onnx-wasm-main-tts.js",
        "sherpa-onnx-wasm-main-tts.wasm",
        "sherpa-onnx-tts.js",
        "sherpa-onnx-tts.worker.js",
    )
    for asset in required_assets:
        assert f'"$INSTALL_ROOT/{asset}"' in build_script
        assert asset in stage_script


def test_probe_result_passes_requires_every_runtime_gate() -> None:
    runner = load_runner()
    passing = {
        "ok": True,
        "workerScope": True,
        "sharedArrayBuffer": True,
        "crossOriginIsolated": True,
        "vad": {"ok": True},
        "asr": {"ok": True},
        "kws": {"ok": True},
    }

    assert runner.probe_result_passes(passing)
    for key in ("ok", "workerScope", "sharedArrayBuffer", "crossOriginIsolated"):
        assert not runner.probe_result_passes({**passing, key: False})
    for key in ("vad", "asr", "kws"):
        assert not runner.probe_result_passes({**passing, key: {"ok": False}})


def test_main_fails_when_any_requested_browser_fails(tmp_path: Path, monkeypatch) -> None:
    runner = load_runner()
    for relative in runner.REQUIRED_ARTIFACTS:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x")

    results = iter(
        (
            {"browser": "chromium", "ok": True},
            {"browser": "firefox", "ok": False},
        )
    )
    monkeypatch.setattr(runner, "run_browser_probe", lambda *_args: next(results))

    exit_code = runner.main(
        [
            "--artifact-root",
            str(tmp_path),
            "--browser",
            "chromium",
            "--browser",
            "firefox",
        ]
    )

    assert exit_code == 1


def test_server_serves_emscripten_default_wasm_basename(tmp_path: Path) -> None:
    runner = load_runner()
    wasm = tmp_path / runner.VAD_ASR_BUILD / "sherpa-onnx-wasm-main-vad-asr.wasm"
    wasm.parent.mkdir(parents=True, exist_ok=True)
    wasm.write_bytes(b"\x00asm")

    with runner.serve_probe(tmp_path) as url:
        import urllib.request

        response = urllib.request.urlopen(f"{url}sherpa-onnx-wasm-main-vad-asr.wasm", timeout=5)

    assert response.headers["Content-Type"] == "application/wasm"
    assert response.read() == b"\x00asm"


def test_server_serves_kws_emscripten_default_wasm_basename(tmp_path: Path) -> None:
    runner = load_runner()
    wasm = tmp_path / runner.KWS_BUILD / "sherpa-onnx-wasm-kws-main.wasm"
    wasm.parent.mkdir(parents=True, exist_ok=True)
    wasm.write_bytes(b"\x00asm")

    with runner.serve_probe(tmp_path) as url:
        import urllib.request

        response = urllib.request.urlopen(f"{url}sherpa-onnx-wasm-kws-main.wasm", timeout=5)

    assert response.headers["Content-Type"] == "application/wasm"
    assert response.read() == b"\x00asm"


def test_server_headers_enable_cross_origin_isolation(tmp_path: Path) -> None:
    runner = load_runner()

    with runner.serve_probe(tmp_path) as url:
        import urllib.request

        response = urllib.request.urlopen(url, timeout=5)

    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert response.headers["Cross-Origin-Embedder-Policy"] == "require-corp"
    assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"

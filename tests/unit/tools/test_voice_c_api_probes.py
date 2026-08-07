import importlib.util
import json
from pathlib import Path
from types import ModuleType

MODULE_PATH = (
    Path(__file__).resolve().parents[3]
    / "tools"
    / "voice-runtime"
    / "c-api-probes"
    / "run_phase4_c_api_probes.py"
)


def load_runner() -> ModuleType:
    spec = importlib.util.spec_from_file_location("run_phase4_c_api_probes", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_parse_probe_stdout_uses_last_json_line() -> None:
    runner = load_runner()

    result = runner.parse_probe_stdout(
        "ignored loader output\n{\"ok\":true,\"mode\":\"stt\",\"text\":\"hello\"}\n",
        "stt",
    )

    assert result == {"ok": True, "mode": "stt", "text": "hello"}


def test_parse_probe_stdout_reports_invalid_json() -> None:
    runner = load_runner()

    result = runner.parse_probe_stdout("not-json\n", "vad")

    assert result["ok"] is False
    assert result["mode"] == "vad"
    assert "invalid probe JSON" in result["reason"]


def test_resolve_paths_supports_injected_artifact_root(tmp_path: Path) -> None:
    runner = load_runner()
    artifact_root = tmp_path / "artifact"
    install = artifact_root / "builds" / "linux-x86_64" / "install"
    include = install / "include"
    lib = install / "lib"
    models = artifact_root / "models" / "extracted"
    for path in (
        include,
        lib,
        models / runner.MOONSHINE_NAME,
        models / runner.KWS_NAME / "test_wavs",
        models / runner.TTS_NAME,
    ):
        path.mkdir(parents=True)
    silero = artifact_root / "models" / "silero-vad-v4.0.onnx"
    silero.parent.mkdir(parents=True, exist_ok=True)
    silero.write_bytes(b"onnx")
    for wav in ("0.wav", "1.wav"):
        (models / runner.KWS_NAME / "test_wavs" / wav).write_bytes(b"RIFF")

    args = runner.build_parser().parse_args(["--artifact-root", str(artifact_root)])

    paths = runner.resolve_paths(args)

    assert paths["include_dir"] == include.resolve()
    assert paths["lib_dir"] == lib.resolve()
    assert paths["moonshine_dir"] == (models / runner.MOONSHINE_NAME).resolve()
    assert paths["silero_model"] == silero.resolve()
    assert paths["vad_wav"] == (models / runner.KWS_NAME / "test_wavs/0.wav").resolve()
    assert paths["kws_wav"] == (models / runner.KWS_NAME / "test_wavs/1.wav").resolve()


def test_main_writes_setup_failure_json(tmp_path: Path) -> None:
    runner = load_runner()
    result_json = tmp_path / "result.json"

    code = runner.main(
        [
            "--artifact-root",
            str(tmp_path / "missing-artifact-root"),
            "--result-json",
            str(result_json),
        ]
    )

    assert code == 2
    payload = json.loads(result_json.read_text(encoding="utf-8"))
    assert payload["ok"] is False
    assert payload["stage"] == "setup"

from pathlib import Path


WRAPPER_DIR = (
    Path(__file__).resolve().parents[3]
    / "tools"
    / "voice-runtime"
    / "c-api-probes"
    / "rust-wrapper"
)


def test_rust_wrapper_is_probe_local_and_not_production_dependency() -> None:
    cargo = (WRAPPER_DIR / "Cargo.toml").read_text(encoding="utf-8")

    assert 'name = "aurora-phase4-sherpa-rust-probe"' in cargo
    assert "publish = false" in cargo
    assert "rust-version = \"1.88\"" in cargo


def test_rust_wrapper_links_only_from_injected_sherpa_lib_dir() -> None:
    build_rs = (WRAPPER_DIR / "build.rs").read_text(encoding="utf-8")

    assert "SHERPA_ONNX_LIB_DIR" in build_rs
    assert "sherpa-onnx-c-api" in build_rs
    assert "/home/developer/projects" not in build_rs


def test_rust_wrapper_exercises_callback_cancellation_path() -> None:
    main_rs = (WRAPPER_DIR / "src" / "main.rs").read_text(encoding="utf-8")

    assert "SherpaOnnxOfflineTtsGenerateWithConfig" in main_rs
    assert "cancel_after_callback" in main_rs
    assert "callback_calls" in main_rs
    assert "return Err(\"tts generation failed\".to_string())" in main_rs

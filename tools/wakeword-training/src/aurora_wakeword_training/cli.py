from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import platform
import sys
import time
from pathlib import Path
from typing import Any


TOOL_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = TOOL_ROOT.parents[1]
ARTIFACT_ROOT = REPO_ROOT / ".artifacts" / "pockettts" / "w0-kws"

LANGUAGE_TTS_BACKEND = {"en": "piper", "pt": "voxcpm"}
LIVEKIT_WAKEWORD_VERSION = "0.2.1"
VOXCPM_VERSION = "2.0.3"
VOXCPM2_REVISION = "bffb3df5a29440629464e5e839f4d214c8714c3d"
MIT_RIRS_REVISION = "b824a1ef2821f112fda0b9cb26e4278c62b425bb"
MUSAN_REVISION = "3edcfdf89b56dbe6a395ff29f9c29489e03d1321"
OFFICIAL_LIVEKIT_CONFIG_HASHES = {
    "test.yaml": "876733065d8700b168f540441c01fde35c60960989d8b1872f22b39974617c07",
    "test_voxcpm.yaml": "0509957a4fb4340dce653c594d2ea89b895d3641056562e97db8160b3f657072",
}
ESPEAK_DEB_SHA256 = {
    "espeak-ng-data_1.51+dfsg-12build1_amd64.deb": "60057f68ba6f79e69aafd943e67e7d9a844de0531e77dc86b1971c43782e4d88",
    "espeak-ng_1.51+dfsg-12build1_amd64.deb": "ffeac730f1f43b5cdbca708a8215d6b7310bf3bd40d7dcf0affd6a62f86aa6df",
    "libespeak-ng1_1.51+dfsg-12build1_amd64.deb": "aab65c41ccd62c3998d0fc45cdb9e7e3a2d91031d7ee51b913775718b3f0f60e",
    "libpcaudio0_1.2-2build3_amd64.deb": "a0528a39edac8a05174a219315392422e54ce9f85364a3ca001fdbf25da2dc4e",
    "libsonic0_0.2.0-13build1_amd64.deb": "2cdd82b71f417cd41725452e91649708e129b4f706eca7a11a7815acb0ed4ad1",
}


def write_json(path: Path, payload: dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def write_text(path: Path, payload: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    return path


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(REPO_ROOT))
    except ValueError:
        return f"<outside-repo>/{resolved.name}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_environment() -> dict[str, Any]:
    modules = ["numpy", "onnxruntime", "openwakeword", "livekit.wakeword"]
    availability: dict[str, dict[str, Any]] = {}
    for module in modules:
        try:
            available = importlib.util.find_spec(module) is not None
        except ModuleNotFoundError as exc:
            availability[module] = {
                "available": False,
                "first_failure": {"type": type(exc).__name__, "message": str(exc)},
            }
        else:
            availability[module] = {"available": available}
    return {
        "schema_version": 1,
        "python": sys.version,
        "platform": platform.platform(),
        "tool_root": str(TOOL_ROOT),
        "artifact_root": str(ARTIFACT_ROOT),
        "module_availability": availability,
        "root_dependency_policy": "no training dependencies are required by Aurora root manifests",
    }


def training_plan(language: str, phrase: str) -> dict[str, Any]:
    if language not in LANGUAGE_TTS_BACKEND:
        raise SystemExit(f"unsupported training language for this spike: {language}")
    model_name = f"aurora_{language}_{phrase.lower().replace(' ', '_')}"
    config = {
        "model_name": model_name,
        "target_phrases": [phrase],
        "n_samples": 10000,
        "target_fp_per_hour": 0.2,
        "model": {"model_type": "conv_attention", "model_size": "small"},
        "aurora": {
            "language": language,
            "tts_backend": LANGUAGE_TTS_BACKEND[language],
            "output_policy": "write only under .artifacts/pockettts/w0-kws/",
        },
    }
    config_path = ARTIFACT_ROOT / "training-configs" / f"{model_name}.json"
    write_json(config_path, config)
    sync_command = (
        "uv sync --extra livekit-train-voxcpm"
        if language == "pt"
        else "uv sync --extra livekit-train"
    )
    return {
        "schema_version": 1,
        "language": language,
        "phrase": phrase,
        "config_path": str(config_path),
        "status": "template_only_not_executable",
        "replacement": "Use `aurora-wakeword-training write-feasibility-configs` for the reproducible W0 LiveKit 0.2.1 YAML runbook.",
        "reason": "This legacy scaffold is retained only as planning metadata; it does not match the verified LiveKit 0.2.1 YAML commands.",
        "non_executable_sync_hint": sync_command,
    }


def livekit_config(language: str) -> tuple[str, str]:
    run_root = ARTIFACT_ROOT / "livekit-run"
    if language == "en":
        return (
            "aurora_en_test.yaml",
            f"""model_name: aurora_en_hey_aurora_test
target_phrases:
  - "hey aurora"
tts_backend: piper
n_samples: 8
n_samples_val: 4
n_background_samples: 8
n_background_samples_val: 4
tts_batch_size: 2
custom_negative_phrases:
  - "aurora"
  - "hey"
  - "hey laura"
data_dir: {run_root / "en-data"}
output_dir: {run_root / "en-output"}
augmentation:
  clip_duration: 2.0
  batch_size: 4
  rounds: 1
  background_paths: [{run_root / "en-data/backgrounds"}]
  rir_paths: [{run_root / "en-data/rirs"}]
model:
  model_type: dnn
  model_size: tiny
steps: 10
learning_rate: 0.001
max_negative_weight: 1000
target_fp_per_hour: 1.0
batch_n_per_class:
  positive: 2
  adversarial_negative: 2
  ACAV100M_sample: 4
  background_noise: 2
""",
        )
    if language == "pt":
        return (
            "aurora_pt_one_clip.yaml",
            f"""model_name: aurora_pt_ola_aurora_one_clip
target_phrases:
  - "ola aurora"
tts_backend: voxcpm
voxcpm_tts:
  voice_design_prompts:
    - "A Portuguese speaker with clear diction"
  cfg_values: [1.0]
  inference_timesteps_list: [1]
n_samples: 1
n_samples_val: 1
n_background_samples: 0
n_background_samples_val: 0
tts_batch_size: 1
custom_negative_phrases:
  - "aurora"
data_dir: {run_root / "pt-data"}
output_dir: {run_root / "pt-output"}
augmentation:
  clip_duration: 2.0
  batch_size: 1
  rounds: 1
  background_paths: [{run_root / "pt-data/backgrounds"}]
  rir_paths: [{run_root / "pt-data/rirs"}]
model:
  model_type: dnn
  model_size: tiny
steps: 1
learning_rate: 0.001
max_negative_weight: 1000
target_fp_per_hour: 1.0
batch_n_per_class:
  positive: 1
  adversarial_negative: 1
  ACAV100M_sample: 0
  background_noise: 0
""",
        )
    raise SystemExit(f"unsupported feasibility language: {language}")


def write_feasibility_configs() -> dict[str, Any]:
    config_dir = ARTIFACT_ROOT / "livekit-run" / "configs"
    configs = {}
    for language in ("en", "pt"):
        filename, text = livekit_config(language)
        path = write_text(config_dir / filename, text)
        configs[language] = {"path": repo_relative(path), "sha256": sha256(path)}

    runbook = {
        "schema_version": 1,
        "purpose": "Reproduce W0 LiveKit wakeword feasibility without committing datasets or models.",
        "versions": {
            "livekit-wakeword": LIVEKIT_WAKEWORD_VERSION,
            "voxcpm": VOXCPM_VERSION,
            "voxcpm2_hf_revision": VOXCPM2_REVISION,
            "mit_rirs_revision": MIT_RIRS_REVISION,
            "musan_revision": MUSAN_REVISION,
            "official_livekit_config_sha256": OFFICIAL_LIVEKIT_CONFIG_HASHES,
            "espeak_ng_deb_sha256": ESPEAK_DEB_SHA256,
        },
        "configs": configs,
        "hermetic_espeak_env": {
            "ESPEAK_ROOT": repo_relative(ARTIFACT_ROOT / "espeak-root"),
            "PATH_PREFIX": "$ESPEAK_ROOT/usr/bin",
            "LD_LIBRARY_PATH_PREFIX": "$ESPEAK_ROOT/usr/lib/x86_64-linux-gnu",
            "ESPEAK_DATA_PATH": "$ESPEAK_ROOT/usr/lib/x86_64-linux-gnu/espeak-ng-data",
        },
        "bounded_commands": [
            "cd tools/wakeword-training",
            "uv sync --extra runtime-smoke --extra livekit-train-voxcpm",
            "uv run livekit-wakeword setup --config ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_en_test.yaml",
            "ESPEAK_ROOT=\"$PWD/../../.artifacts/pockettts/w0-kws/espeak-root\" timeout 300 env PATH=\"$ESPEAK_ROOT/usr/bin:$PATH\" LD_LIBRARY_PATH=\"$ESPEAK_ROOT/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH\" ESPEAK_DATA_PATH=\"$ESPEAK_ROOT/usr/lib/x86_64-linux-gnu/espeak-ng-data\" uv run livekit-wakeword generate ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_en_test.yaml",
            "timeout 300 uv run livekit-wakeword augment ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_en_test.yaml",
            "timeout 300 uv run livekit-wakeword train ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_en_test.yaml",
            "timeout 300 uv run livekit-wakeword export ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_en_test.yaml",
            "uv run aurora-wakeword-training validate-export --model ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/aurora_en_hey_aurora_test.onnx --positive-dir ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/positive_test --negative-dir ../../.artifacts/pockettts/w0-kws/livekit-run/en-output/aurora_en_hey_aurora_test/negative_test --label en",
            "uv run livekit-wakeword setup --config ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_pt_one_clip.yaml",
            "timeout 420 uv run livekit-wakeword generate ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_pt_one_clip.yaml",
            "timeout 300 uv run livekit-wakeword augment ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_pt_one_clip.yaml",
            "timeout 300 uv run livekit-wakeword train ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_pt_one_clip.yaml",
            "timeout 300 uv run livekit-wakeword export ../../.artifacts/pockettts/w0-kws/livekit-run/configs/aurora_pt_one_clip.yaml",
            "uv run aurora-wakeword-training validate-export --model ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/aurora_pt_ola_aurora_one_clip.onnx --positive-dir ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/positive_test --negative-dir ../../.artifacts/pockettts/w0-kws/livekit-run/pt-output/aurora_pt_ola_aurora_one_clip/negative_test --label pt",
        ],
        "known_outcome": {
            "en": "Export is loadable but scores do not separate positives from negatives on the tiny synthetic feasibility set.",
            "pt": "One-clip export is loadable but reports high false positives; full 8/4 VoxCPM CPU generation timed out.",
            "typescript_import": "absent until complete Python/browser mel+embedding+classifier frame-score parity exists.",
        },
        "output_policy": "All generated audio, datasets, models, and reports stay under .artifacts/pockettts/w0-kws/.",
    }
    runbook_path = write_json(ARTIFACT_ROOT / "reports" / "livekit-w0-feasibility-runbook.json", runbook)
    return {"schema_version": 1, "runbook": repo_relative(runbook_path), "configs": configs}


def score_separation(positive_scores: list[float], negative_scores: list[float], threshold: float) -> dict[str, Any]:
    if not positive_scores:
        return {"passed": False, "reason": "no positive WAVs were scored"}
    if not negative_scores:
        return {"passed": False, "reason": "no negative WAVs were scored"}
    min_positive = min(positive_scores)
    max_negative = max(negative_scores)
    positive_all_above_threshold = all(score >= threshold for score in positive_scores)
    negatives_below_threshold = all(score < threshold for score in negative_scores)
    separated = min_positive > max_negative
    passed = positive_all_above_threshold and negatives_below_threshold and separated
    return {
        "passed": passed,
        "reason": "scores separate positives and negatives" if passed else "scores do not cleanly separate positives and negatives",
        "threshold": threshold,
        "min_positive": min_positive,
        "max_negative": max_negative,
        "positive_all_above_threshold": positive_all_above_threshold,
        "negatives_below_threshold": negatives_below_threshold,
        "separated": separated,
    }


def validate_export(model: Path, positive_dir: Path, negative_dir: Path, label: str, threshold: float) -> dict[str, Any]:
    resources = TOOL_ROOT / ".venv" / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages" / "livekit" / "wakeword" / "resources"
    melspec = resources / "melspectrogram.onnx"
    embedding = resources / "embedding_model.onnx"
    required = {
        "classifier": model,
        "melspectrogram": melspec,
        "embedding": embedding,
        "positive_dir": positive_dir,
        "negative_dir": negative_dir,
    }
    missing = {name: repo_relative(path) for name, path in required.items() if not path.exists()}
    if missing:
        return {
            "schema_version": 1,
            "status": "failed",
            "label": label,
            "missing": missing,
            "reason": "export validation is fail-closed when any frontend component or sample directory is missing",
        }

    import onnxruntime as ort
    from openwakeword import Model

    positive_wavs = sorted(positive_dir.glob("*.wav"))
    negative_wavs = sorted(negative_dir.glob("*.wav"))
    start = time.perf_counter()
    wakeword = Model(
        wakeword_models=[str(model)],
        inference_framework="onnx",
        melspec_model_path=str(melspec),
        embedding_model_path=str(embedding),
    )
    init_wall_ms = (time.perf_counter() - start) * 1000.0

    def score(path: Path) -> dict[str, Any]:
        wakeword.reset()
        start_score = time.perf_counter()
        frames = wakeword.predict_clip(str(path), padding=1)
        scores = [float(list(frame.values())[0]) for frame in frames if frame]
        return {
            "wav": repo_relative(path),
            "frames": len(frames),
            "max_score": max(scores) if scores else 0.0,
            "wall_ms": (time.perf_counter() - start_score) * 1000.0,
        }

    positives = [score(path) for path in positive_wavs]
    negatives = [score(path) for path in negative_wavs]
    separation = score_separation(
        [item["max_score"] for item in positives],
        [item["max_score"] for item in negatives],
        threshold,
    )
    if label == "en" and not separation["passed"]:
        expected_boundary = "EN scores do not separate positives and negatives on the tiny synthetic feasibility set."
    elif label == "pt" and not separation["passed"]:
        expected_boundary = "PT one-clip export has high false positives on its negative samples."
    else:
        expected_boundary = "Unexpected pass; this still requires a real corpus before product integration."
    return {
        "schema_version": 1,
        "status": "passed" if separation["passed"] else "failed",
        "label": label,
        "model": repo_relative(model),
        "frontend": {
            "melspectrogram": repo_relative(melspec),
            "embedding": repo_relative(embedding),
            "classifier": repo_relative(model),
        },
        "onnxruntime_version": ort.__version__,
        "init_wall_ms": init_wall_ms,
        "positive_count": len(positives),
        "negative_count": len(negatives),
        "positive_scores": positives,
        "negative_scores": negatives,
        "separation": separation,
        "expected_boundary": expected_boundary,
        "typescript_trained_pack_import": "absent",
        "quality_claim": "unavailable until validated with a real labeled corpus and browser parity",
    }


def smoke_python_import() -> dict[str, Any]:
    failures = []
    for module in ["numpy", "onnxruntime", "openwakeword"]:
        try:
            __import__(module)
        except Exception as exc:  # noqa: BLE001
            failures.append({"module": module, "type": type(exc).__name__, "message": str(exc)})
            break
    return {
        "schema_version": 1,
        "status": "available" if not failures else "unavailable",
        "first_failure": failures[0] if failures else None,
        "import_boundary": "Python OpenWakeWord-compatible classifier import/score",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("inspect")
    subparsers.add_parser("smoke-python-import")
    subparsers.add_parser("write-feasibility-configs")
    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("--language", choices=sorted(LANGUAGE_TTS_BACKEND), required=True)
    plan_parser.add_argument("--phrase", required=True)
    validate_parser = subparsers.add_parser("validate-export")
    validate_parser.add_argument("--model", required=True)
    validate_parser.add_argument("--positive-dir", required=True)
    validate_parser.add_argument("--negative-dir", required=True)
    validate_parser.add_argument("--label", choices=sorted(LANGUAGE_TTS_BACKEND), required=True)
    validate_parser.add_argument("--threshold", type=float, default=0.5)
    args = parser.parse_args(argv)
    if args.command == "inspect":
        print(json.dumps(inspect_environment(), indent=2, sort_keys=True))
        return 0
    if args.command == "plan":
        print(json.dumps(training_plan(args.language, args.phrase), indent=2, sort_keys=True))
        return 0
    if args.command == "write-feasibility-configs":
        print(json.dumps(write_feasibility_configs(), indent=2, sort_keys=True))
        return 0
    if args.command == "validate-export":
        payload = validate_export(Path(args.model), Path(args.positive_dir), Path(args.negative_dir), args.label, args.threshold)
        report = write_json(ARTIFACT_ROOT / "reports" / f"livekit-{args.label}-validate-export.json", payload)
        print(json.dumps({"report": repo_relative(report), **payload}, indent=2, sort_keys=True))
        return 0 if payload["status"] == "passed" else 2
    if args.command == "smoke-python-import":
        payload = smoke_python_import()
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0 if payload["status"] == "available" else 2
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())

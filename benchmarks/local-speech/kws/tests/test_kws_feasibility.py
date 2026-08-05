from __future__ import annotations

import contextlib
import io
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kws_benchmark = load_module("kws_benchmark", Path(__file__).resolve().parents[1] / "kws_benchmark.py")
trained_pack_parity = load_module("trained_pack_parity", Path(__file__).resolve().parents[1] / "trained_pack_parity.py")
wakeword_cli = load_module(
    "aurora_wakeword_training_cli",
    Path(__file__).resolve().parents[4] / "tools" / "wakeword-training" / "src" / "aurora_wakeword_training" / "cli.py",
)


class KwsFeasibilityTests(unittest.TestCase):
    def test_sherpa_phrase_profiles_are_configuration_not_training(self) -> None:
        profiles = kws_benchmark.build_phrase_profiles("en")
        self.assertTrue(profiles)
        self.assertEqual(profiles[0].custom_keyword_mode, "keyword_file_no_retrain")
        self.assertIn("#0.35", profiles[0].keywords_txt_line())

    def test_unsupported_portuguese_sherpa_fails_before_listening(self) -> None:
        with self.assertRaisesRegex(ValueError, "No official sherpa KWS Portuguese pack"):
            kws_benchmark.build_phrase_profiles("pt")

    def test_lifecycle_stop_probe_has_strict_budget(self) -> None:
        result = kws_benchmark.lifecycle_stop_probe(iterations=3)
        self.assertLessEqual(result["max_ms"], result["target_ms"])
        self.assertTrue(result["passed"])

    def test_sherpa_model_file_selection_prefers_quantized_suffix(self) -> None:
        names = [
            "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            "encoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            "decoder-epoch-12-avg-2-chunk-16-left-64.onnx",
            "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
            "joiner-epoch-12-avg-2-chunk-16-left-64.onnx",
            "tokens.txt",
            "test_wavs/test_keywords.txt",
        ]
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
            files = kws_benchmark._model_files(root, quantized=True)
            self.assertTrue(files["encoder"].name.endswith(".int8.onnx"))
            files = kws_benchmark._model_files(root, quantized=False)
            self.assertFalse(files["encoder"].name.endswith(".int8.onnx"))

    def test_sherpa_model_file_selection_reports_missing(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(FileNotFoundError, "missing fp32 sherpa encoder model"):
                kws_benchmark._model_files(root, quantized=False)

    def test_sherpa_model_file_selection_reports_ambiguous(self) -> None:
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in [
                "encoder-a.onnx",
                "encoder-b.onnx",
                "decoder-a.onnx",
                "joiner-a.onnx",
                "tokens.txt",
                "test_wavs/test_keywords.txt",
            ]:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ambiguous sherpa encoder model"):
                kws_benchmark._model_files(root, quantized=False)

    def test_sherpa_positive_samples_require_all_detected(self) -> None:
        payload = {
            "positive_samples": {
                "total": 2,
                "detected": 1,
                "all_detected": False,
            }
        }
        with (
            patch.object(kws_benchmark, "run_sherpa_model", return_value=payload),
            patch.object(kws_benchmark, "write_artifact", return_value="/tmp/report.json"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            exit_code = kws_benchmark.main(
                [
                    "sherpa-run",
                    "--model-dir",
                    "/tmp/model",
                    "--language",
                    "en",
                    "--wav",
                    "/tmp/sample.wav",
                ]
            )

        self.assertEqual(exit_code, 2)

    def test_artifact_paths_are_repo_relative_or_redacted(self) -> None:
        repo_path = kws_benchmark.REPO_ROOT / ".artifacts" / "example.wav"
        self.assertEqual(kws_benchmark._artifact_path(repo_path), ".artifacts/example.wav")
        outside = Path("/tmp/outside.wav")
        self.assertEqual(kws_benchmark._artifact_path(outside), "<outside-repo>/outside.wav")

    def test_trained_pack_browser_import_absent_without_complete_frontend(self) -> None:
        decision = trained_pack_parity.decide()
        self.assertEqual(decision["decision"]["typescript_trained_pack_import"], "absent")
        self.assertTrue(decision["browser_frontend_missing"])
        self.assertEqual(decision["remote_continuous_wake_audio"], "rejected")

    def test_legacy_training_plan_is_not_executable(self) -> None:
        plan = wakeword_cli.training_plan("en", "hey aurora")
        self.assertEqual(plan["status"], "template_only_not_executable")
        self.assertNotIn("recommended_commands", plan)
        self.assertIn("write-feasibility-configs", plan["replacement"])

    def test_livekit_feasibility_configs_use_verified_schema(self) -> None:
        en_name, en_config = wakeword_cli.livekit_config("en")
        pt_name, pt_config = wakeword_cli.livekit_config("pt")
        self.assertEqual(wakeword_cli.LIVEKIT_WAKEWORD_VERSION, "0.2.1")
        self.assertEqual(en_name, "aurora_en_test.yaml")
        self.assertIn("tts_backend: piper", en_config)
        self.assertIn("n_samples: 8", en_config)
        self.assertEqual(pt_name, "aurora_pt_one_clip.yaml")
        self.assertIn("tts_backend: voxcpm", pt_config)
        self.assertIn("inference_timesteps_list: [1]", pt_config)
        self.assertIn("steps: 1", pt_config)

    def test_score_separation_fails_closed_for_w0_scores(self) -> None:
        en_result = wakeword_cli.score_separation([0.308, 0.307], [0.306, 0.311], 0.5)
        pt_result = wakeword_cli.score_separation([0.568, 0.561], [0.564, 0.553], 0.5)
        self.assertFalse(en_result["passed"])
        self.assertFalse(en_result["positive_all_above_threshold"])
        self.assertFalse(pt_result["passed"])
        self.assertFalse(pt_result["negatives_below_threshold"])

    def test_validate_export_fails_closed_when_frontend_missing(self) -> None:
        result = wakeword_cli.validate_export(
            Path("/tmp/missing-model.onnx"),
            Path("/tmp/missing-positive"),
            Path("/tmp/missing-negative"),
            "en",
            0.5,
        )
        self.assertEqual(result["status"], "failed")
        self.assertIn("classifier", result["missing"])


if __name__ == "__main__":
    unittest.main()

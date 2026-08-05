from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


kws_benchmark = load_module("kws_benchmark", Path(__file__).resolve().parents[1] / "kws_benchmark.py")
trained_pack_parity = load_module("trained_pack_parity", Path(__file__).resolve().parents[1] / "trained_pack_parity.py")


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

    def test_trained_pack_browser_import_absent_without_complete_frontend(self) -> None:
        decision = trained_pack_parity.decide()
        self.assertEqual(decision["decision"]["typescript_trained_pack_import"], "absent")
        self.assertTrue(decision["browser_frontend_missing"])
        self.assertEqual(decision["remote_continuous_wake_audio"], "rejected")


if __name__ == "__main__":
    unittest.main()

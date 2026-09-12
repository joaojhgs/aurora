import argparse
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_vad_parity.py")
SPEC = importlib.util.spec_from_file_location("run_vad_parity", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class VadParityRunnerTests(unittest.TestCase):
    def test_worker_constants_are_generated_from_python_policy(self) -> None:
        expected_config = json.dumps(runner.BROWSER_CONFIG, separators=(",", ":"))

        self.assertIn(f"const CONFIG = {expected_config};", runner.WORKER_JS)
        self.assertIn(
            f"const ACCEPT_P95_LIMIT_MS = {runner.ACCEPT_P95_LIMIT_MS};",
            runner.WORKER_JS,
        )
        self.assertIn(
            "const EXPECTED_SEGMENT = "
            + json.dumps(runner.EXPECTED_SEGMENT, separators=(",", ":"))
            + ";",
            runner.WORKER_JS,
        )
        self.assertNotIn("__AURORA_", runner.WORKER_JS)

    def test_reads_pcm16_mono_16khz_and_uses_32768_scale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "fixture.wav"
            wav.write_bytes(make_wav([0, 32767, -32768]))

            samples = runner.read_pcm16_mono_16khz_wav(wav)

        self.assertEqual(samples[0], 0.0)
        self.assertAlmostEqual(samples[1], 32767 / 32768.0)
        self.assertEqual(samples[2], -1.0)

    def test_rejects_non_mono_16khz_pcm16(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wav = Path(tmp) / "fixture.wav"
            wav.write_bytes(make_wav([0], channels=2, block_align=4))

            with self.assertRaisesRegex(ValueError, "PCM16 mono 16 kHz"):
                runner.read_pcm16_mono_16khz_wav(wav)

    def test_segment_comparison_allows_one_window_tolerance(self) -> None:
        native = {
            "cases": {
                "full_flush": {
                    "segments": [{"start": 1000, "length": 4096}],
                }
            }
        }
        browser = {
            "cases": {
                "full_flush": {
                    "segments": [{"start": 1512, "length": 3584}],
                }
            }
        }

        comparison = runner.compare_segments(native, browser)

        self.assertTrue(comparison["ok"])

    def test_segment_comparison_rejects_beyond_one_window_tolerance(self) -> None:
        native = {
            "cases": {
                "full_flush": {
                    "segments": [{"start": 1000, "length": 4096}],
                }
            }
        }
        browser = {
            "cases": {
                "full_flush": {
                    "segments": [{"start": 1513, "length": 4096}],
                }
            }
        }

        comparison = runner.compare_segments(native, browser)

        self.assertFalse(comparison["ok"])

    def test_sha256_verification_records_exact_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            payload = b"fixture"
            path = Path(tmp) / "fixture.bin"
            path.write_bytes(payload)
            expected = hashlib.sha256(payload).hexdigest()

            actual = runner.verify_sha256(path, expected, "fixture")

        self.assertEqual(actual, expected)

    def test_full_matrix_gate_rejects_skip_modes_and_partial_browsers(self) -> None:
        passing_case = {
            "ok": True,
            "physical_device_claim": False,
            "workerScope": True,
            "sharedArrayBuffer": True,
            "crossOriginIsolated": True,
            "cases": {"full_flush": {"feed_timing": {"accept": {"p95_ms": 31.999}}}},
        }

        self.assertFalse(
            runner.full_matrix_gate_ok(
                native=passing_case,
                browser_results=[passing_case, passing_case, passing_case],
                comparisons=[{"ok": True}, {"ok": True}, {"ok": True}],
                requested_browsers=["chromium", "firefox", "webkit"],
                skip_native=True,
                skip_browsers=False,
            )
        )
        self.assertFalse(
            runner.full_matrix_gate_ok(
                native=passing_case,
                browser_results=[passing_case],
                comparisons=[{"ok": True}],
                requested_browsers=["chromium"],
                skip_native=False,
                skip_browsers=False,
            )
        )

    def test_full_matrix_gate_rejects_playwright_withheld_no_promotion(self) -> None:
        native = passing_result()
        browser_results = [
            passing_result(),
            {
                "ok": False,
                "withheld": True,
                "reason": "playwright unavailable",
                "physical_device_claim": False,
            },
            passing_result(),
        ]

        self.assertFalse(
            runner.full_matrix_gate_ok(
                native=native,
                browser_results=browser_results,
                comparisons=[{"ok": True}, {"ok": False}, {"ok": True}],
                requested_browsers=["chromium", "firefox", "webkit"],
                skip_native=False,
                skip_browsers=False,
            )
        )

    def test_full_matrix_gate_rejects_worker_sab_or_coi_false(self) -> None:
        native = passing_result()
        browser = passing_result()
        browser["sharedArrayBuffer"] = False

        self.assertFalse(
            runner.full_matrix_gate_ok(
                native=native,
                browser_results=[passing_result(), browser, passing_result()],
                comparisons=[{"ok": True}, {"ok": True}, {"ok": True}],
                requested_browsers=["chromium", "firefox", "webkit"],
                skip_native=False,
                skip_browsers=False,
            )
        )

    def test_full_matrix_gate_rejects_physical_device_claim_true(self) -> None:
        native = passing_result()
        browser = passing_result()
        browser["physical_device_claim"] = True

        self.assertFalse(
            runner.full_matrix_gate_ok(
                native=native,
                browser_results=[passing_result(), browser, passing_result()],
                comparisons=[{"ok": True}, {"ok": True}, {"ok": True}],
                requested_browsers=["chromium", "firefox", "webkit"],
                skip_native=False,
                skip_browsers=False,
            )
        )

    def test_duplicate_browser_request_is_rejected(self) -> None:
        with self.assertRaisesRegex(SystemExit, "duplicate browser request: chromium"):
            runner.normalize_browsers(["chromium", "firefox", "chromium", "webkit"])

    def test_timing_gate_is_strictly_less_than_32ms(self) -> None:
        self.assertTrue(
            runner.timing_ok(
                {"cases": {"full_flush": {"feed_timing": {"accept": {"p95_ms": 31.999}}}}}
            )
        )
        self.assertFalse(
            runner.timing_ok(
                {"cases": {"full_flush": {"feed_timing": {"accept": {"p95_ms": 32.0}}}}}
            )
        )

    def test_artifact_path_rejects_traversal_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            outside = Path(tmp) / "outside.bin"
            outside.write_bytes(b"outside")

            with self.assertRaisesRegex(SystemExit, "escapes artifact root"):
                runner.resolve_artifact_path(
                    artifact_root,
                    Path("..") / outside.name,
                    "artifact",
                )

    def test_artifact_path_rejects_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            outside = Path(tmp) / "outside.bin"
            outside.write_bytes(b"outside")
            link = artifact_root / "link.bin"
            link.symlink_to(outside)

            with self.assertRaisesRegex(SystemExit, "escapes artifact root"):
                runner.resolve_artifact_path(artifact_root, link, "artifact")

    def test_resolve_inputs_reports_missing_browser_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()

            with self.assertRaisesRegex(SystemExit, "missing browser artifacts"):
                runner.resolve_inputs(
                    argparse.Namespace(
                        artifact_root=artifact_root,
                        wav_path=None,
                        model_path=None,
                        lib_dir=None,
                    )
                )

    def test_resolve_inputs_rejects_hash_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            create_minimal_artifact_tree(artifact_root)

            with self.assertRaisesRegex(SystemExit, "Silero model SHA mismatch"):
                runner.resolve_inputs(
                    argparse.Namespace(
                        artifact_root=artifact_root,
                        wav_path=None,
                        model_path=None,
                        lib_dir=None,
                    )
                )

    def test_find_lib_dir_prefers_host_native_before_android(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            android = artifact_root / "builds/android-arm64-v8a/install/lib"
            android.mkdir(parents=True)
            (android / "libsherpa-onnx-c-api.so").write_bytes(b"android")
            host_root = runner.host_native_lib_roots()[0]
            host = artifact_root / host_root
            host.mkdir(parents=True)
            (host / "libsherpa-onnx-c-api.so").write_bytes(b"linux")

            self.assertEqual(runner.find_lib_dir(artifact_root), host_root)

    def test_browser_request_symlink_escape_is_not_served(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_root = Path(tmp) / "artifacts"
            artifact_root.mkdir()
            outside = Path(tmp) / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            (artifact_root / "escape.txt").symlink_to(outside)
            wav = artifact_root / "input.wav"
            wav.write_bytes(make_wav([0]))

            with runner.serve_parity(artifact_root.resolve(), wav.resolve()) as url:
                status = fetch_status(url + "artifacts/escape.txt")

            self.assertEqual(status, 400)


def make_wav(
    samples: list[int],
    *,
    channels: int = 1,
    sample_rate: int = 16_000,
    bits_per_sample: int = 16,
    block_align: int = 2,
) -> bytes:
    payload = b"".join(sample.to_bytes(2, "little", signed=True) for sample in samples)
    fmt = (
        (1).to_bytes(2, "little")
        + channels.to_bytes(2, "little")
        + sample_rate.to_bytes(4, "little")
        + (sample_rate * block_align).to_bytes(4, "little")
        + block_align.to_bytes(2, "little")
        + bits_per_sample.to_bytes(2, "little")
    )
    return (
        b"RIFF"
        + (4 + 8 + len(fmt) + 8 + len(payload)).to_bytes(4, "little")
        + b"WAVE"
        + b"fmt "
        + len(fmt).to_bytes(4, "little")
        + fmt
        + b"data"
        + len(payload).to_bytes(4, "little")
        + payload
    )


def passing_result() -> dict:
    return {
        "ok": True,
        "physical_device_claim": False,
        "workerScope": True,
        "sharedArrayBuffer": True,
        "crossOriginIsolated": True,
        "cases": {"full_flush": {"feed_timing": {"accept": {"p95_ms": 31.999}}}},
    }


def create_minimal_artifact_tree(artifact_root: Path) -> None:
    for artifact in runner.REQUIRED_BROWSER_ARTIFACTS:
        path = artifact_root / artifact
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"browser")
    model = artifact_root / runner.VAD_MODEL_CANDIDATES[0]
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_bytes(b"wrong model")
    wav = artifact_root / runner.KWS_TEST_WAV
    wav.parent.mkdir(parents=True, exist_ok=True)
    wav.write_bytes(make_wav([0]))
    lib_dir = artifact_root / "builds" / "native" / "lib"
    lib_dir.mkdir(parents=True, exist_ok=True)
    (lib_dir / "libsherpa-onnx-c-api.so").write_bytes(b"native lib")


def fetch_status(url: str) -> int:
    from urllib.error import HTTPError
    from urllib.request import urlopen

    try:
        with urlopen(url, timeout=5) as response:
            return int(response.status)
    except HTTPError as exc:
        return int(exc.code)


if __name__ == "__main__":
    unittest.main()

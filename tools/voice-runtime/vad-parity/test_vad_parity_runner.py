import importlib.util
import hashlib
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("run_vad_parity.py")
SPEC = importlib.util.spec_from_file_location("run_vad_parity", MODULE_PATH)
runner = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(runner)


class VadParityRunnerTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()

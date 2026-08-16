#!/usr/bin/env python3
"""Prove Sherpa PocketTTS packs synthesize real audio.

Native proof uses the ordinary Rust ONNX Runtime path. WASM proof is invoked
separately after the sequential WASM TTS build. Generated WAVs stay in
.artifacts/ and are not committed.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CACHE = REPO_ROOT / ".artifacts/pockettts/language-packs"
OVERLAY_CATALOG = Path(__file__).resolve().parent / "aurora_pockettts_language_pack_catalog.json"
REQUIRED = (
    "lm_flow.int8.onnx",
    "lm_main.int8.onnx",
    "encoder.onnx",
    "decoder.int8.onnx",
    "text_conditioner.onnx",
    "vocab.json",
    "token_scores.json",
    "README.md",
)


def write_reference_wav(path: Path, sample_rate: int = 24_000, seconds: float = 1.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(sample_rate * seconds)
    with wave.open(str(path), "w") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for index in range(n):
            sample = int(16000 * math.sin(2 * math.pi * 220 * index / sample_rate))
            frames.extend(struct.pack("<h", sample))
        wav.writeframes(frames)


def overlay_entry(pack_dir: Path) -> dict | None:
    overlay = json.loads(OVERLAY_CATALOG.read_text(encoding="utf-8"))
    for entry in overlay["entries"]:
        if entry["archive"]["root"] == pack_dir.name:
            return entry
    return None


def assert_pack(pack_dir: Path) -> None:
    missing = [name for name in REQUIRED if not (pack_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"{pack_dir} missing {missing}")
    entry = overlay_entry(pack_dir)
    if entry is None:
        return
    if not (pack_dir / "pocket_protocol.json").is_file():
        raise FileNotFoundError(f"{pack_dir} missing pocket_protocol.json")
    prefix = f"{entry['archive']['root']}/"
    for relative in entry["bindings"].values():
        if not isinstance(relative, str) or not relative.startswith(prefix):
            continue
        if not (pack_dir / relative[len(prefix) :]).is_file():
            raise FileNotFoundError(f"{pack_dir} missing catalog binding {relative}")


def _cargo() -> str:
    explicit = os.environ.get("CARGO")
    if explicit:
        return explicit
    home = Path.home() / ".cargo" / "bin" / "cargo"
    if home.is_file():
        return str(home)
    return "cargo"


def native_smoke(pack_dir: Path, reference: Path | None, text: str) -> None:
    assert_pack(pack_dir)
    env = dict(os.environ)
    default_lib_dir = REPO_ROOT / ".artifacts/sherpa-onnx/builds/linux-x86_64/install/lib"
    lib_dir = Path(os.environ.get("AURORA_SHERPA_ONNX_LIB_DIR", str(default_lib_dir)))
    env["AURORA_SHERPA_ONNX_ENABLE_LIVE_POCKETTTS"] = "1"
    env["AURORA_SHERPA_ONNX_LIB_DIR"] = str(lib_dir)
    env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"
    env["AURORA_POCKETTTS_PACK_DIR"] = str(pack_dir.resolve())
    if reference is None:
        env.pop("AURORA_POCKETTTS_REF_WAV", None)
    else:
        env["AURORA_POCKETTTS_REF_WAV"] = str(reference.resolve())
    env["AURORA_POCKETTTS_TEXT"] = text
    result = subprocess.run(
        [
            _cargo(),
            "test",
            "-p",
            "aurora-voice-sherpa-sys",
            "--features",
            "native-tts",
            "tests::native_tts_pockettts_real_synthesis_smoke",
            "--",
            "--nocapture",
            "--exact",
        ],
        cwd=REPO_ROOT / "rust",
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def wasm_smoke(pack_dir: Path, reference: Path | None, text: str) -> None:
    assert_pack(pack_dir)
    assets = Path(
        os.environ.get(
            "AURORA_SHERPA_WASM_TTS_ROOT",
            REPO_ROOT / ".artifacts/sherpa-onnx/wasm-tts-neutral",
        )
    )
    wasm = assets / "sherpa-onnx-wasm-main-tts.wasm"
    helper = assets / "sherpa-onnx-tts.js"
    if not wasm.is_file() or not helper.is_file():
        raise SystemExit(
            "WASM TTS assets missing. Build sequentially with "
            "AURORA_SHERPA_WASM_TTS_NEUTRAL=1 via "
            "tools/voice-runtime/build_sherpa_wasm_tts.sh"
        )
    package = REPO_ROOT / "packages/aurora-voice-web"
    if not (package / "dist/browser.js").is_file():
        build = subprocess.run(
            ["pnpm", "--filter", "@aurora/voice-web", "run", "build"],
            cwd=REPO_ROOT,
            check=False,
        )
        if build.returncode != 0:
            raise SystemExit(build.returncode)
    env = dict(os.environ)
    env["AURORA_POCKETTTS_PACK_DIR"] = str(pack_dir.resolve())
    if reference is None:
        env.pop("AURORA_POCKETTTS_REF_WAV", None)
    else:
        env["AURORA_POCKETTTS_REF_WAV"] = str(reference.resolve())
    env["AURORA_POCKETTTS_TEXT"] = text
    env["AURORA_SHERPA_WASM_TTS_ROOT"] = str(assets.resolve())
    env["AURORA_ARTIFACTS_ROOT"] = str(REPO_ROOT / ".artifacts")
    result = subprocess.run(
        [
            "pnpm",
            "exec",
            "playwright",
            "test",
            "--config",
            "tests/playwright/sherpa-pockettts-browser-smoke.playwright.config.ts",
        ],
        cwd=package,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", choices=("native", "wasm", "pack-check"), required=True)
    parser.add_argument("--pack-dir", type=Path)
    parser.add_argument("--cache-root", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--reference-wav", type=Path)
    parser.add_argument("--text", default="")
    return parser.parse_args()


def main() -> int:
    args = _args()
    packs = (
        [args.pack_dir]
        if args.pack_dir is not None
        else [
            args.cache_root / "aurora-pockettts-en-2026-04",
            args.cache_root / "aurora-pockettts-fr-24l",
        ]
    )
    default_reference = args.reference_wav or (args.cache_root / "reference-smoke.wav")
    for pack_dir in packs:
        if pack_dir is None:
            continue
        if args.runtime == "pack-check":
            assert_pack(pack_dir)
            print(f"pack-check ok {pack_dir}")
            continue
        entry = overlay_entry(pack_dir)
        reference_required = (
            entry is None or entry.get("capability", {}).get("reference_audio_mode") != "internal"
        )
        reference = default_reference if reference_required else None
        if reference is not None and not reference.is_file():
            write_reference_wav(reference)
        if args.runtime == "wasm":
            text = args.text or (
                "Bonjour, ceci est un essai."
                if "fr-24l" in pack_dir.name
                else "Hello, this is a voice check."
            )
            wasm_smoke(pack_dir, reference, text)
            continue
        text = args.text or (
            "Bonjour, ceci est un essai."
            if "fr-24l" in pack_dir.name
            else "Hello, this is a voice check."
        )
        native_smoke(pack_dir, reference, text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

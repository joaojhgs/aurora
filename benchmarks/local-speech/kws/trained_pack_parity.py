#!/usr/bin/env python3
"""OpenWakeWord trained-pack ABI and TypeScript parity decision scaffold."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACT_ROOT = REPO_ROOT / ".artifacts" / "pockettts" / "w0-kws"


@dataclass(frozen=True)
class TrainedPackAbi:
    schema_version: int
    model_family: str
    sample_rate_hz: int
    frame_ms: int
    mel_frontend: str
    embedding_frontend: str
    window_state: str
    classifier_format: str
    reset_required: bool
    warmup_frames: int


OPENWAKEWORD_ABI = TrainedPackAbi(
    schema_version=1,
    model_family="openwakeword-compatible",
    sample_rate_hz=16000,
    frame_ms=80,
    mel_frontend="openwakeword-melspectrogram.onnx",
    embedding_frontend="openwakeword-embedding_model.onnx",
    window_state="temporal-frame-score-buffer",
    classifier_format="onnx",
    reset_required=True,
    warmup_frames=16,
)


def deterministic_golden_pcm(seconds: float = 1.6, rate: int = 16000) -> list[int]:
    values: list[int] = []
    for i in range(int(seconds * rate)):
        sample = 0.2 * math.sin(2.0 * math.pi * 440.0 * (i / rate))
        values.append(int(sample * 32767))
    return values


def synthetic_score_stream(pcm: list[int], frame_samples: int = 1280) -> list[float]:
    scores = []
    for offset in range(0, len(pcm), frame_samples):
        frame = pcm[offset : offset + frame_samples]
        if frame:
            energy = sum(abs(sample) for sample in frame) / (len(frame) * 32768.0)
            scores.append(round(energy, 8))
    return scores


def has_browser_frontend() -> tuple[bool, list[str]]:
    required = [
        "packages/aurora-ui/src/local-speech/wakeword/openwakeword-mel.ts",
        "packages/aurora-ui/src/local-speech/wakeword/openwakeword-embedding.ts",
        "packages/aurora-ui/src/local-speech/wakeword/openwakeword-window.ts",
        "packages/aurora-ui/src/local-speech/wakeword/openwakeword-classifier.ts",
    ]
    missing = [path for path in required if not (REPO_ROOT / path).exists()]
    return not missing, missing


def decide() -> dict[str, Any]:
    browser_ready, missing = has_browser_frontend()
    pcm = deterministic_golden_pcm()
    scores = synthetic_score_stream(pcm)
    has_openwakeword = importlib.util.find_spec("openwakeword") is not None
    has_onnxruntime = importlib.util.find_spec("onnxruntime") is not None
    status = "supported" if browser_ready and has_openwakeword and has_onnxruntime else "absent"
    return {
        "schema_version": 1,
        "decision": {
            "typescript_trained_pack_import": status,
            "reason": (
                "complete browser frontend and Python runtime are present"
                if status == "supported"
                else "complete browser mel+embedding+window+classifier frame-score parity is not present"
            ),
        },
        "required_abi": asdict(OPENWAKEWORD_ABI),
        "browser_frontend_missing": missing,
        "python_runtime_available": {
            "openwakeword": has_openwakeword,
            "onnxruntime": has_onnxruntime,
        },
        "golden_pcm": {
            "generated_at_runtime": True,
            "sample_rate_hz": OPENWAKEWORD_ABI.sample_rate_hz,
            "sha256": hashlib.sha256(
                b"".join(v.to_bytes(2, "little", signed=True) for v in pcm)
            ).hexdigest(),
            "frames": len(scores),
        },
        "reference_score_stream": scores,
        "remote_continuous_wake_audio": "rejected",
    }


def write_artifact(name: str, payload: dict[str, Any]) -> Path:
    target = ARTIFACT_ROOT / "reports" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("decide")
    args = parser.parse_args(argv)
    if args.command == "decide":
        payload = decide()
        print(write_artifact("trained-pack-parity-decision.json", payload))
        return 0
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())

"""Manual metadata/input check. Never loads a model or launches a campaign."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import sys
import time
import wave


def binding(path: pathlib.Path) -> dict:
    raw = path.read_bytes()
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def main() -> int:
    started = time.monotonic()
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent / "profiles/padded-capital-v1.json")
    parser.add_argument("--output", type=pathlib.Path, required=True,
                        help="Fresh receipt path; an existing receipt is never overwritten.")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Choose a fresh output path to preserve previous receipts.")
    receipt = {
        "schema": "aurora.thesis.manual-preflight.v1",
        "startedAt": started_at,
        "command": [sys.executable, *sys.argv],
        "python": sys.version,
        "cwd": str(pathlib.Path.cwd()),
        "newMeasuredRequests": 0,
        "modelsOrServicesLoaded": False,
        "modelAvailabilityChecked": False,
        "hardwareOrRoutesAdmitted": False,
        "scope": "Pinned profile and fixed WAV metadata only; not full setup, launch, performance or product acceptance.",
        "source": binding(pathlib.Path(__file__).resolve()),
    }
    code = 0
    try:
        if sys.version_info[:2] != (3, 11):
            raise ValueError("This pinned reproduction profile requires Python3.11.")
        profile_path = args.profile.resolve(strict=True)
        profile = json.loads(profile_path.read_text())
        if profile["schema"] != "aurora.thesis.performance-profile.v1":
            raise ValueError("Unsupported profile schema.")
        counts = profile["measurement"]
        if (counts["measuredPerApplicableCondition"], counts["excludedWarmups"],
                counts["requestDeadlineSeconds"]) != (900, 15, 180):
            raise ValueError("Declared sample allocation differs from the pinned methodology.")
        fixture_path = (profile_path.parent / profile["fixture"]).resolve(strict=True)
        fixture = json.loads(fixture_path.read_text())
        audio_path = (fixture_path.parent / fixture["audio"]).resolve(strict=True)
        audio = binding(audio_path)
        if (audio["bytes"], audio["sha256"]) != (fixture["bytes"], fixture["sha256"]):
            raise ValueError("Fixed audio size/hash mismatch.")
        with wave.open(str(audio_path), "rb") as stream:
            actual = (stream.getframerate(), stream.getnchannels(),
                      stream.getsampwidth(), stream.getnframes(), stream.getcomptype())
        expected = (fixture["sampleRate"], fixture["channels"],
                    fixture["sampleWidthBytes"], fixture["frames"], "NONE")
        if actual != expected:
            raise ValueError("Fixed PCM WAV profile mismatch.")
        reference = hashlib.sha256(fixture["referenceTranscript"].encode()).hexdigest()
        if reference != fixture["referenceTranscriptSHA256"]:
            raise ValueError("Reference transcript hash mismatch.")
        for model in profile["models"].values():
            if len(model["weightSHA256"]) != 64 or model["bytes"] <= 0:
                raise ValueError("Incomplete declared model weight binding.")
        receipt.update(status="passed", profile=binding(profile_path),
                       fixture=binding(fixture_path), audio=audio,
                       wavProfile=list(actual), referenceTranscriptSHA256=reference)
    except (OSError, ValueError, KeyError, TypeError, wave.Error) as exc:
        code = 1
        receipt.update(status="failed", errorClass=type(exc).__name__, error=str(exc))
    receipt.update(exitCode=code, durationSeconds=time.monotonic() - started,
                   finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps({"status": receipt["status"], "exitCode": code,
                      "receipt": str(args.output), "newMeasuredRequests": 0}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

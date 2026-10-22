"""Check the preserved production source without changing a checkout or running it."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import pathlib
import sys
import time

from preflight import binding


def main() -> int:
    start = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=pathlib.Path, required=True)
    parser.add_argument("--lock", type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent / "source/production-lock-v1.json")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Choose a fresh receipt path.")
    receipt = {
        "schema": "aurora.thesis.source-verification.v1",
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "command": [sys.executable, *sys.argv],
        "python": sys.version,
        "checker": binding(pathlib.Path(__file__).resolve()),
        "helper": binding(pathlib.Path(__file__).resolve().with_name("preflight.py")),
        "newMeasuredRequests": 0,
        "modelsOrServicesLoaded": False,
        "checkoutModified": False,
        "scope": "Exact locked production files and overlay artifact only; not dependency, hardware, route or runtime acceptance.",
    }
    code = 0
    try:
        source = args.source.resolve(strict=True)
        lock_path = args.lock.resolve(strict=True)
        lock = json.loads(lock_path.read_text())
        if lock["schema"] != "aurora.thesis.production-source-lock.v1":
            raise ValueError("Unsupported production source lock.")
        overlay_path = (lock_path.parent / lock["overlay"]["path"]).resolve(strict=True)
        overlay = binding(overlay_path)
        if (overlay["bytes"], overlay["sha256"]) != (
                lock["overlay"]["bytes"], lock["overlay"]["sha256"]):
            raise ValueError("Preserved production overlay size/hash mismatch.")
        failures = []
        for expected in lock["sourceFiles"]:
            relative = pathlib.PurePosixPath(expected["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Source lock contains an invalid relative path.")
            path = source.joinpath(*relative.parts)
            if not path.is_file() or path.is_symlink():
                failures.append({"path": str(relative), "reason": "missing_or_symlinked"})
                continue
            if not path.resolve(strict=True).is_relative_to(source):
                raise ValueError("Source file resolves outside the selected tree.")
            raw = path.read_bytes()
            actual_sha = hashlib.sha256(raw).hexdigest()
            if len(raw) != expected["bytes"] or actual_sha != expected["sha256"]:
                failures.append({"path": str(relative), "reason": "size_or_hash_mismatch",
                                 "observedBytes": len(raw), "observedSHA256": actual_sha})
        code = int(bool(failures))
        receipt.update(status="failed" if failures else "passed", sourceRoot=str(source),
                       lock=binding(lock_path), overlay=overlay,
                       expectedFiles=len(lock["sourceFiles"]), mismatches=failures,
                       verifiedFiles=len(lock["sourceFiles"]) - len(failures))
    except (OSError, ValueError, TypeError, KeyError) as exc:
        code = 1
        receipt.update(status="failed", errorClass=type(exc).__name__, error=str(exc))
    receipt.update(exitCode=code, durationSeconds=time.monotonic() - start)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(json.dumps({"status": receipt["status"], "exitCode": code,
                      "receipt": str(args.output), "newMeasuredRequests": 0}))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

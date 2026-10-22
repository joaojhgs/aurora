"""Explicitly launch a prepared900-case Linux CPU condition; never a default test."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument(
        "--execute-measurements",
        action="store_true",
        help="Explicitly admit15warmups+900 real full-audio requests.",
    )
    args = parser.parse_args()
    if not args.execute_measurements:
        parser.error("Measurement execution requires --execute-measurements.")
    if sys.version_info[:2] != (3, 11) or sys.platform != "linux":
        parser.error("This adapter requires Linux and Python3.11.")
    root = args.run_dir.resolve(strict=True)
    if (root / "runtime").exists():
        parser.error("Preserve this attempt; prepare a fresh directory for another condition.")
    receipt = json.loads((root / "PREPARED.json").read_text())
    manifest_path = root / "measurement-admission.json"
    manifest_raw = manifest_path.read_bytes()
    manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
    if manifest_sha != receipt["manifest"]["sha256"]:
        parser.error("Prepared manifest drift; execution refused.")
    manifest = json.loads(manifest_raw)
    controller = root / "controller.py"
    if (
        hashlib.sha256(controller.read_bytes()).hexdigest()
        != manifest["implementation"]["controllerSha256"]
    ):
        parser.error("Prepared controller drift; execution refused.")
    env = os.environ.copy()
    env.update(
        AURORA_THESIS_EXECUTE="900-measured",
        AURORA_THESIS_RUNNER_SHA256=manifest["implementation"]["runnerSha256"],
        AURORA_THESIS_CONTROLLER_SHA256=manifest["implementation"]["controllerSha256"],
        AURORA_THESIS_CONDITION_MANIFEST_SHA256=manifest_sha,
        PYTHONDONTWRITEBYTECODE="1",
    )
    # The controller acquires the same nonblocking global reservation before
    # creating runtime data, loading models, or starting its one owned backend.
    return subprocess.run([sys.executable, str(controller)], env=env).returncode


if __name__ == "__main__":
    raise SystemExit(main())

"""Private, explicitly bound bootstrap for a future K1 HTTP condition."""

from __future__ import annotations

import importlib.metadata
import json
import os
import runpy
import sys
import time
from pathlib import Path


def main() -> None:
    root = Path(os.environ["AURORA_K1_CONTROL_ROOT"]).resolve(strict=True)
    runner = Path(os.environ["AURORA_K1_RUNNER_PATH"]).resolve(strict=True)
    bindings = Path(os.environ["AURORA_K1_BINDINGS_PATH"]).resolve(strict=True)
    telemetry = Path(os.environ["AURORA_K1_TELEMETRY_PATH"]).resolve(strict=True)
    observer = Path(os.environ["AURORA_V409_OBSERVER_PATH"]).resolve(strict=True)
    if any(
        path.is_symlink() or not path.is_file() for path in (runner, bindings, telemetry, observer)
    ):
        raise SystemExit("k1_source_binding_unavailable")
    sys.path.insert(0, str(bindings.parent))
    import bindings as bindings_module  # noqa: PLC0415

    bindings_module.install()
    sys.path.insert(0, str(telemetry.parent))
    namespace = runpy.run_path(str(telemetry))
    install = namespace.get("install")
    if not callable(install):
        raise SystemExit("k1_observer_install_missing")
    install()
    stage_output = Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"])
    stage_output.with_suffix(".installed.json").write_text(
        json.dumps({"pid": os.getpid(), "installed": True, "monotonic_ns": time.monotonic_ns()})
        + "\n"
    )
    versions = {}
    for package in (
        "faster-whisper",
        "ctranslate2",
        "llama-cpp-python",
        "piper-tts",
        "onnxruntime",
        "numpy",
    ):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    stage_output.with_name("runtime-versions.json").write_text(
        json.dumps({"pid": os.getpid(), "packages": versions}, sort_keys=True) + "\n"
    )
    runpy.run_path(str(runner), run_name="__main__")


if __name__ == "__main__":
    main()

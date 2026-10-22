"""Install the admitted voice observers, then run the real Aurora main entrypoint."""
from __future__ import annotations

import importlib.metadata
import json
import os
import runpy
import time
from pathlib import Path


def main() -> None:
    root = Path(os.environ["AURORA_K1_PROVIDER_ROOT"])
    source = Path(os.environ["AURORA_K1_SOURCE_ROOT"])
    hook = root / "hook"
    stage = Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"])
    import sys

    sys.path[:0] = [str(hook), str(source)]
    import bindings  # noqa: PLC0415

    bindings.install()
    from aurora_voice_telemetry_v430 import install  # noqa: PLC0415

    install()
    stage.with_suffix(".installed.json").write_text(
        json.dumps({"pid": os.getpid(), "installed": True, "monotonic_ns": time.monotonic_ns()}) + "\n"
    )
    packages = (
        "faster-whisper", "ctranslate2", "llama-cpp-python",
        "piper-tts", "onnxruntime", "numpy",
    )
    versions: dict[str, str | None] = {}
    for package in packages:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    versions_path = stage.with_name("runtime-versions.json")
    versions_path.write_text(json.dumps({"pid": os.getpid(), "packages": versions}, sort_keys=True) + "\n")
    frozen = json.loads(Path(os.environ["AURORA_K1_PROVIDER_FROZEN_MANIFEST"]).read_bytes())
    if versions != frozen.get("runtime_versions", {}).get("packages"):
        raise SystemExit("provider_runtime_version_drift")
    runpy.run_path(str(source / "main.py"), run_name="__main__")


if __name__ == "__main__":
    main()

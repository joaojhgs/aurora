from __future__ import annotations

import importlib.metadata
import json
import os
import pathlib
import runpy
import time


def main():
    import bindings

    bindings.install()
    from aurora_voice_telemetry_v430 import install

    install()

    stage_output = pathlib.Path(os.environ["AURORA_VOICE_STAGE_OUTPUT"])
    stage_output.with_suffix(".installed.json").write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "entrypoint": "private-cpu-full-audio-900-condition",
                "installed": True,
                "monotonic_ns": time.monotonic_ns(),
            }
        )
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
        json.dumps({"pid": os.getpid(), "packages": versions}) + "\n"
    )

    assert versions == {'faster-whisper': '1.1.1', 'ctranslate2': '4.7.1', 'llama-cpp-python': '0.3.19', 'piper-tts': '1.2.0', 'onnxruntime': '1.20.1', 'numpy': '2.2.6'}, "matched backend version drift"

    runpy.run_path(
        str(pathlib.Path(__file__).resolve().with_name("runner.py")),
        run_name="__main__",
    )


if __name__ == "__main__":
    if os.environ.get("AURORA_THESIS_EXECUTE") != "900-measured":
        raise SystemExit("Use the manual launcher with explicit measurement opt-in.")
    main()

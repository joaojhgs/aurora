"""Run the normal main.py with the already-approved private observers."""
import functools
import hashlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import runpy
import sys
import time

root = Path(__file__).parent
http = Path("/home/developer/projects/aurora/.git/aurora-handoff-import-20261006/http-full-audio-v497")
source = http / "source"
manifest_path = root / "frozen-manifest.json"
manifest_bytes = manifest_path.read_bytes()
assert hashlib.sha256(manifest_bytes).hexdigest() == os.environ["AURORA_FROZEN_MANIFEST_SHA256"], "browser_frozen_manifest_mismatch"
frozen = json.loads(manifest_bytes)
sys.path[:0] = [str(root / "hook"), str(source)]
import bindings
bindings.install()
from aurora_voice_telemetry_v430 import install
install()

versions = {name: importlib.metadata.version(name) for name in frozen["runtimeVersions"]["packages"]}
assert versions == frozen["runtimeVersions"]["packages"], "same_frozen_runtime_versions_required"
(root / "runtime/runtime-versions.json").write_text(json.dumps({"pid": os.getpid(), "packages": versions}) + "\n")

import app.services.gateway.fastapi_app as gateway
original = gateway.create_gateway_app
actual = Path(inspect.getsourcefile(original)).resolve()
expected = source / "app/services/gateway/fastapi_app.py"
expected_sha = frozen["sourceFiles"]["app/services/gateway/fastapi_app.py"]["sha256"]
assert actual == expected and hashlib.sha256(actual.read_bytes()).hexdigest() == expected_sha, "actual_gateway_source_mismatch"

@functools.wraps(original)
def guarded(*args, **kwargs):
    app = original(*args, **kwargs)
    receipt = {"pid": os.getpid(), "actualImportedModuleFile": str(actual), "actualImportedModuleSHA256": expected_sha, "factoryCalledAndReturned": True, "monotonicNs": time.monotonic_ns()}
    with (root / "runtime/source-guard.json").open("x") as out:
        out.write(json.dumps(receipt) + "\n")
    return app

gateway.create_gateway_app = guarded
(root / "runtime/voice-stages.installed.json").write_text(json.dumps({"pid": os.getpid(), "installed": True, "entrypoint": "normal_main.py", "monotonicNs": time.monotonic_ns()}) + "\n")
runpy.run_path(str(source / "main.py"), run_name="__main__")

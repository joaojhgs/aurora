"""One authenticated excluded HTTP flow, paired with the provider-local flow."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys
import time

ROOT = Path("/home/developer/projects/aurora")
SOURCE = ROOT / "thesis/sources/k1-speech-contract-compat-v2151/worker/source"
OUT = ROOT / "thesis/campaigns/c12-mixed-local-http-readiness-v2414/requester"


def write(path, value):
    with path.open("x") as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


def main():
    os.umask(0o077)
    assert not (OUT / "RESULT-worker-http.json").exists(), "Never retry an already recorded flow"
    sys.path[:0] = [str(Path(__file__).parent), str(SOURCE)]
    from paired_case import run_case

    actual = json.loads((OUT / "PROVIDER-READINESS-MANIFEST.json").read_bytes())
    raw = (OUT / "PROVIDER-READINESS-MANIFEST.json").read_bytes()
    expected = json.loads((OUT / "PILOT-TRIGGER.json").read_bytes())
    assert hashlib.sha256(raw).hexdigest() == expected["readinessManifestSha256"]
    actual.update(
        output=str(OUT),
        audioPath=str(
            ROOT / "thesis/harness/distributed-k3-http-remaining-v1682/candidate-input.wav"
        ),
        readinessManifestSha256=expected["readinessManifestSha256"],
    )
    remaining = (
        datetime.fromisoformat(actual["resourceAdmission"]["absoluteDeadlineUtc"]).timestamp()
        - time.time()
    )
    assert remaining > 400
    lock = Path("/tmp/aurora-global-build.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    credential = runpy.run_path(
        str(ROOT / "thesis/harness/existing_worker_desktop_http_bearer_v2223.py")
    )
    auth = credential["protected_read"]()
    write(OUT / "AUTHENTICATED-HEALTH.json", auth)
    assert auth.get("httpStatus") == 200, "No inference on failed authenticated admission"
    os.environ["AURORA_HOSTED_PEER_GATEWAY_API_KEY"] = credential["existing_bearer"]()
    gap = datetime.fromisoformat(expected["releaseAtUtc"]).timestamp() - time.time()
    assert -45 <= gap <= 120, "Reconcile expired trigger, no retry"
    write(
        OUT / "DRIVER-ARMED.json",
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "pid": os.getpid(),
            "releaseAtUtc": expected["releaseAtUtc"],
            "maximumFlowCalls": 1,
            "measured": 0,
        },
    )
    time.sleep(max(0, gap))
    sample = runpy.run_path(
        str(ROOT / "thesis/harness/distributed-k3-http-remaining-v1682/resource_sample.py")
    )["sample_resources"]

    async def execute():
        stop = asyncio.Event()

        async def monitor():
            with (OUT / "resources.jsonl").open("x") as stream:
                while not stop.is_set():
                    row = {
                        "at": datetime.now(timezone.utc).isoformat(),
                        "monotonic_ns": time.monotonic_ns(),
                        "pid": os.getpid(),
                        "resource_context": sample(os.getpid()),
                    }
                    stream.write(json.dumps(row, sort_keys=True) + "\n")
                    stream.flush()
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=1)
                    except asyncio.TimeoutError:
                        pass

        task = asyncio.create_task(monitor())
        try:
            return await run_case(actual, "worker-http")
        finally:
            stop.set()
            await task

    result = asyncio.run(execute())
    os.environ.pop("AURORA_HOSTED_PEER_GATEWAY_API_KEY", None)
    return 0 if result["status"] == "completed_correct" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        OUT.mkdir(parents=True, exist_ok=True)
        p = OUT / "DRIVER-FAILURE.json"
        if not p.exists():
            write(
                p,
                {
                    "at": datetime.now(timezone.utc).isoformat(),
                    "exceptionType": type(exc).__name__,
                    "modelQualityInference": False,
                    "reconcileBeforeAnyRetry": True,
                },
            )
        raise SystemExit(2) from None

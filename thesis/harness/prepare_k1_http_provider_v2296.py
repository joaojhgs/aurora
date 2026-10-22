"""Prepare a separate finite K1 HTTP SUT lifecycle on Personal; no inference."""

from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import shutil
import socket

ROOT = Path("/home/developer/projects/aurora")
OLD = ROOT / "thesis/campaigns/worker-desktop-k1-http-provider-v2220/provider"
PRIVATE = ROOT / ".git/aurora-handoff-import-20261006/k1-http-provider-v2296"
OUTPUT = ROOT / "thesis/campaigns/worker-desktop-k1-http-provider-v2296/provider"
OLD_SHA = "950d449e3c337764a654ae4dd08c66623f50f96617615328be0cd8c54a4eaea2"
CONTROLLER_SHA = "6d8cc38e24bda0ff32546845880e68479fa945e2fdd4e2e6fa21fa9b593b6e5b"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def prepare(allocation):
    os.umask(0o077)
    os.nice(10)
    assert socket.gethostname() == "personal.skyron-server"
    assert not PRIVATE.exists() and not OUTPUT.exists(), (
        "Reconcile existing operation; never duplicate"
    )
    assert all(not Path("/proc", str(pid)).exists() for pid in [1440195, 1440196])
    assert json.loads((OLD / "terminal.json").read_bytes())["receiverAbsent"] is True
    assert json.loads((OLD / "STATUS.json").read_bytes())["ownRuntimeRetired"] is True
    assert sha(OLD / "provider-manifest.json") == OLD_SHA
    m = json.loads((OLD / "provider-manifest.json").read_bytes())
    assert (
        sha(m["config"])
        == m["configSha256"]
        == "1b2e464a9dd2a191954504161862d3aa19a991126eb2b08c4de55a40778fd002"
    )
    assert (
        sha(m["sourceInventory"]["inventory_path"])
        == "25026c4031e07d2e7cdac2afe269f78611ed375e53d3b64cd751b31867a552cf"
    )
    controller = Path(m["privateRoot"]) / "controller.py"
    assert sha(controller) == CONTROLLER_SHA
    diagnostic = Path(m["guardDiagnosticSource"])
    assert sha(diagnostic) == m["guardDiagnosticSha256"]
    start = datetime.fromisoformat(allocation["startedAtUtc"])
    root_deadline = datetime.fromisoformat(allocation["absoluteDeadlineUtc"])
    assert (root_deadline - start).total_seconds() == 43200
    assert allocation["state"] == "CLOCK_FROZEN_BEFORE_ANY_LIFECYCLE_ACTION"
    assert allocation["globalFirst"] == 451 and allocation["globalLast"] == 900
    assert allocation["postprocessingReserveSeconds"] == 2400
    provider_deadline = root_deadline - timedelta(seconds=2400)
    now = datetime.now(timezone.utc)
    assert start <= now and now + timedelta(seconds=39000 + 225) < provider_deadline
    memory = next(
        int(v.split()[1]) * 1024
        for v in Path("/proc/meminfo").read_text().splitlines()
        if v.startswith("MemAvailable:")
    )
    assert memory > 4 * 1024**3 and shutil.disk_usage(ROOT).free > 2 * 1024**3 + 256 * 1024**2
    for field in ["model", "voiceConfig", "piperExecutable", "llmModel", "sttModel"]:
        item = m["actualFiles"][field]
        assert Path(item["path"]).stat().st_size == item["bytes"]
    PRIVATE.mkdir(mode=0o700)
    OUTPUT.mkdir(parents=True, mode=0o700)
    (PRIVATE / "controller.py").write_bytes(controller.read_bytes())
    (PRIVATE / "guard_diagnostic.py").write_bytes(diagnostic.read_bytes())
    receivers = {}
    for field, label in [
        ("remoteMeshTtsReceiver", "piper"),
        ("remoteMeshAssistantReceiver", "qwen"),
        ("remoteMeshSttReceiver", "whisper"),
    ]:
        receivers[field] = dict(m[field], receiver_id="personal-k1-http-" + label + "-v2296")
    actual = {
        "at": now.isoformat(),
        "actualFiles": m["actualFiles"],
        "sourceInventory": m["sourceInventory"],
        "configurationReference": m["config"],
        "configSha256": m["configSha256"],
        "freshControllerHashesPendingStartup": True,
        "memAvailableBytes": memory,
        "fileCopyScope": "controller and diagnostic code only; no config/env/credential/model copies",
    }
    write(OUTPUT / "ACTUAL-FILES-v2296.json", actual)
    old_history = m.get("retiredPredecessorPids", [])
    m.update(
        at=now.isoformat(),
        privateRoot=str(PRIVATE),
        output=str(OUTPUT),
        controllerSha256=CONTROLLER_SHA,
        guardDiagnosticSource=str(PRIVATE / "guard_diagnostic.py"),
        actualFileReceiptSha256=sha(OUTPUT / "ACTUAL-FILES-v2296.json"),
        lifetimeSeconds=39000,
        originalProviderAbsoluteDeadlineUtc=provider_deadline.isoformat(),
        retiredPredecessorPids=[1440195, 1440196],
        historicalRetiredPredecessorPids=old_history,
        prospectiveSessionAllocation=allocation,
        priorProviderManifestSha256=OLD_SHA,
        priorEffectiveDeadlineUtc="2026-10-21T22:45:52.468654+00:00",
        lifecyclePolicy="New explicitly bounded idle-after-terminal SUT lifecycle, not an extension of the original provider",
        comparisonStagePlacement={
            "stt": "workerCPU",
            "llm": "workerCPU",
            "tts": "Personal PiperCPU via existing Orca-relayed HTTP",
        },
        residencyPolicy="Same configured three-service context as latestP2P; native constructors/resources record actual residency, no uninvoked GPU-performance claim",
        **receivers,
    )
    write(OUTPUT / "provider-manifest.json", m)
    result = {
        "at": datetime.now(timezone.utc).isoformat(),
        "host": socket.gethostname(),
        "status": "K1_HTTP_PROVIDER_PREPARED_NOT_LAUNCHED",
        "manifest": m,
        "manifestPath": str(OUTPUT / "provider-manifest.json"),
        "manifestSha256": sha(OUTPUT / "provider-manifest.json"),
        "controller": str(PRIVATE / "controller.py"),
        "configSha256": m["configSha256"],
        "controllerSha256": CONTROLLER_SHA,
        "modelsAudioDecodingSettingsUnchanged": True,
        "oldOriginalProviderRetired": True,
        "oldOriginalSourcePreserved": True,
        "existingConfigAndEnvReferencedNoCopy": True,
        "sutCalls": 0,
        "newWorker": False,
    }
    write(OUTPUT / "PREPARATION-v2296.json", result)
    return result

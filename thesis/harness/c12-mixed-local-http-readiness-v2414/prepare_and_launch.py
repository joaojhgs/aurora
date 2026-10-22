"""One new bounded C12 provider lifecycle; exact old K1 runtime is retired."""

from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import shutil
import socket
import subprocess
import time

ROOT = Path("/home/developer/projects/aurora")
OLD = ROOT / "thesis/campaigns/worker-desktop-k1-http-provider-v2296/provider"
OUT = ROOT / "thesis/campaigns/c12-mixed-local-http-readiness-v2414/provider"
PRIVATE = ROOT / ".git/aurora-handoff-import-20261006/c12-mixed-local-http-readiness-v2414"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1048576), b""):
            h.update(b)
    return h.hexdigest()


def write(path, data):
    with Path(path).open("x") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())


def actor(pid):
    s = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "startTicks": int(s[19]), "state": s[0]}


def main(files, source_hashes, allocation):
    os.umask(0o077)
    assert socket.gethostname() == "personal.skyron-server"
    assert not OUT.exists() and not PRIVATE.exists(), "Reconcile existing operation, no duplicate"
    assert all(not Path("/proc", str(x)).exists() for x in (1820862, 1820863, 2454776, 2454777))
    assert (
        json.loads(
            (
                ROOT
                / "thesis/campaigns/c12-mixed-local-http-readiness-v2407/provider/terminal-v2411/SEAL.json"
            ).read_bytes()
        )["oldActorsAbsent"]
        is True
    )
    assert json.loads((OLD / "terminal.json").read_bytes())["receiverAbsent"] is True
    assert json.loads((OLD / "STATUS.json").read_bytes())["ownRuntimeRetired"] is True
    assert (
        sha(OLD / "provider-manifest.json")
        == "0f4a4bf0e7638b63b8d046331e1e7393e4f108f406802f0e4f0d543feca5ffa2"
    )
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
    now = datetime.now(timezone.utc)
    end = datetime.fromisoformat(allocation["absoluteDeadlineUtc"])
    assert 525 < (end - now).total_seconds() <= 1800
    assert shutil.disk_usage(ROOT).free >= 2 * 1024**3 + 128 * 1024**2
    available = next(
        int(x.split()[1]) * 1024
        for x in Path("/proc/meminfo").read_text().splitlines()
        if x.startswith("MemAvailable:")
    )
    assert available >= 4 * 1024**3
    audio = ROOT / "thesis/harness/c12-mixed-local-http-readiness-v2414/candidate.wav"
    candidates = [audio, ROOT / "thesis/harness/c12-mixed-local-http-readiness-v2407/candidate.wav"]
    audio_source = next(
        (
            x
            for x in candidates
            if x.is_file()
            and x.stat().st_size == 219794
            and sha(x) == "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
        ),
        None,
    )
    assert audio_source is not None, (
        "Exact retained padded input unavailable at bounded known paths; no replacement input"
    )
    for name, data in files.items():
        assert hashlib.sha256(data.encode()).hexdigest() == source_hashes[name]
        compile(data, name, "exec")
    for item in m["actualFiles"].values():
        assert Path(item["path"]).is_file() and Path(item["path"]).stat().st_size == item["bytes"]
    OUT.mkdir(parents=True)
    PRIVATE.mkdir(mode=0o700)
    public = audio.parent
    public.mkdir(parents=True, exist_ok=True)
    if not audio.exists():
        shutil.copyfile(audio_source, audio)
    assert sha(audio) == "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
    for name, data in files.items():
        for dest in [PRIVATE / name, public / name]:
            with dest.open("x") as f:
                f.write(data)
    readym = {
        "schema": "aurora.c12.mixed_readiness.v1",
        "at": now.isoformat(),
        "phase": "finite_excluded_readiness_only",
        "condition": "C12 mixed local user plus Orca-relayed HTTP K3, concurrency2",
        "output": str(OUT),
        "audioPath": str(audio),
        "audioSha256": sha(audio),
        "referenceTranscript": "What is the capital of France? Answer with only the city name.",
        "expectedReplyWords": ["paris"],
        "requestCapSeconds": 180,
        "triggerWaitCapSeconds": 150,
        "maximumFlows": {"desktop-local": 1, "worker-http": 1},
        "measuredRequests": 0,
        "prospectiveMeasuredTargetPerEligibleCondition": 900,
        "providerManifestSha256ExpectedConfig": m["configSha256"],
        "endpoints": {
            s: "http://127.0.0.1:18000/api/" + path
            for s, path in [
                ("stt", "Transcription/Transcribe"),
                ("assistant", "Orchestrator/ExternalUserInput"),
                ("tts", "TTS/Synthesize"),
            ]
        },
        "resourceAdmission": allocation,
        "sourceHashes": source_hashes,
        "stageMap": {
            "localUser": "D STT + D LLM + D TTS, production typed bus",
            "remoteUser": "W authenticated HTTP -> same D STT + D LLM + D TTS",
        },
        "oldComparisons": "Closed K3 HTTP full900 remains reference with explicit source/auth/residency lineage, never replayed",
        "physicalExclusions": ["Personal notebook", "physical phone", "Waydroid"],
        "eligibility": "Actual overlap/native joins/correct valid WAV/capacity before any new measured admission",
    }
    write(OUT / "READINESS-MANIFEST.json", readym)
    actual = {
        "at": now.isoformat(),
        "actualFiles": m["actualFiles"],
        "sourceInventory": m["sourceInventory"],
        "configSha256": m["configSha256"],
        "memAvailableBytes": available,
        "codeCopiesOnly": True,
    }
    write(OUT / "ACTUAL-FILES.json", actual)
    old_history = m.get("retiredPredecessorPids", [])
    m.update(
        privateRoot=str(PRIVATE),
        output=str(OUT),
        controllerSha256=source_hashes["provider_controller.py"],
        c12ReadinessManifest=str(OUT / "READINESS-MANIFEST.json"),
        lifetimeSeconds=300,
        noRequesterDeadlineSeconds=240,
        retiredPredecessorPids=[2468063, 2468064],
        historicalRetiredPredecessorPids=old_history,
        originalProviderAbsoluteDeadlineUtc=end.isoformat(),
        actualFileReceiptSha256=sha(OUT / "ACTUAL-FILES.json"),
        prospectiveSessionAllocation=allocation,
        lifecyclePolicy="NEW C12 readiness pilot allocation, not extension/repeat of any closed condition",
        comparisonStagePlacement=readym["stageMap"],
    )
    write(OUT / "provider-manifest.json", m)
    write(
        OUT / "ROOT-LAUNCH-INTENT.json",
        {
            "at": now.isoformat(),
            "maximumPopen": 1,
            "manifestSha256": sha(OUT / "provider-manifest.json"),
        },
    )
    with (PRIVATE / "controller.private.log").open("xb") as f:
        child = subprocess.Popen(
            [
                m["python"],
                str(PRIVATE / "provider_controller.py"),
                "--control",
                str(OUT / "provider-manifest.json"),
            ],
            cwd=PRIVATE,
            stdin=subprocess.DEVNULL,
            stdout=f,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    receipt = {
        "at": datetime.now(timezone.utc).isoformat(),
        "host": socket.gethostname(),
        "controller": actor(child.pid),
        "manifestSha256": sha(OUT / "provider-manifest.json"),
        "readinessManifestSha256": sha(OUT / "READINESS-MANIFEST.json"),
        "newWorker": False,
        "measured": 0,
        "pilotCallsStarted": False,
        "deadline": end.isoformat(),
    }
    write(OUT / "ROOT-LAUNCH.json", receipt)
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        if child.poll() is not None:
            break
        if (OUT / "LOCAL-DRIVER-ARMED.json").exists():
            break
        time.sleep(1)
    receipt.update(
        controllerState=actor(child.pid) if Path("/proc", str(child.pid)).exists() else "ABSENT",
        localDriverArmed=(OUT / "LOCAL-DRIVER-ARMED.json").exists(),
    )
    if (OUT / "controller-launch.json").exists():
        receipt["runtime"] = json.loads((OUT / "controller-launch.json").read_bytes())
    return receipt

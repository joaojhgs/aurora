"""One explicitly allocated C12 campaign lifecycle on the existing Personal host."""

from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import socket
import subprocess
import time

ROOT = Path("/home/developer/projects/aurora")
OUTPUT = ROOT / "thesis/campaigns/c12-p2p-k3-dlocal-v2445/provider"
PRIVATE = ROOT / ".git/aurora-handoff-import-20261006/c12-p2p-k3-dlocal-v2445"
PUBLIC = ROOT / "thesis/harness/c12-p2p-k3-dlocal-v2445"
OLD = ROOT / "thesis/campaigns/c12-mixed-local-http-remaining640-v2453/provider"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for b in iter(lambda: stream.read(1048576), b""):
            h.update(b)
    return h.hexdigest()


def write(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def actor(pid):
    f = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "startTicks": int(f[19]), "state": f[0]}


FLOOR = 2 * 1024**3


def validate_allocation(allocation):
    assert allocation['conditionId']=='C12-P2P-K3-DLOCAL'
    assert allocation['measuredPrimaryTarget']==allocation['measuredCompanionTarget']==900
    assert allocation['warmupPairsExcluded']==15
    assert allocation['maximumPrimaryFlowCalls']==allocation['maximumCompanionFlowCalls']==915
    assert allocation['diskFreeFloorBytes']==FLOOR
    assert type(allocation['workerRawBudgetBytes']) is int and allocation['workerRawBudgetBytes']>0
    keys=('startedAtUtc','setupDeadlineUtc','collectionDeadlineUtc','producerDeadlineUtc','providerDeadlineUtc','absoluteDeadlineUtc')
    clocks=[datetime.fromisoformat(allocation[k]) for k in keys]
    assert all(x.tzinfo is not None for x in clocks)
    assert all(a<b for a,b in zip(clocks,clocks[1:]))
    assert 0 <= (datetime.now(timezone.utc)-clocks[0]).total_seconds() <= 300
    assert allocation['requestCapSeconds']==180 and allocation['pairCapSeconds']==600
    assert allocation['rootRun']=='run_e6054e76e9fc'
    assert allocation['rootNativeGoalThread']=='01a112a5-d6bb-74e2-bf7c-ace73cb513b5'


def main(files, hashes, allocation, worker):
    os.umask(0o077)
    assert socket.gethostname() == "personal.skyron-server"
    assert not OUTPUT.exists() and not PRIVATE.exists() and not PUBLIC.exists(), (
        "Reconcile existing preparation, no duplicate"
    )
    assert all(not Path("/proc", str(pid)).exists() for pid in [2866664, 2866665])
    assert json.loads((OLD / "terminal.json").read_bytes())["receiverAbsent"] is True
    assert json.loads((OLD / "STATUS.json").read_bytes())["ownRuntimeRetired"] is True
    assert (
        sha(OLD / "provider-manifest.json")
        == "1535884cdd504a1dd76b6df7b5e9815d5acdea4867a9fbda1cacd5cef168a15f"
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
    validate_allocation(allocation)
    now = time.time()
    # Directly reconcile the completed predecessor's provider rows, not a
    # copied claim of900 successes. Definitive failures still consume indices.
    rows=[json.loads(p.read_bytes()) for p in sorted((OLD/'cases').glob('*/CASE.json'))]
    measured=[x for x in rows if x['phase']=='measured']
    assert len(rows)==655 and len(measured)==640
    assert {x['global_measured_index'] for x in measured}==set(range(261,901))
    assert len({x['correlation_id'] for x in rows})==655
    assert worker['expectedLocalPeerId']==m['expectedRequesterPeerId']
    assert worker['expectedDesktopPeerIdSha256']==hashlib.sha256(m['expectedStablePeerId'].encode()).hexdigest()
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 512 * 1024**2
    available = next(
        int(x.split()[1]) * 1024
        for x in Path("/proc/meminfo").read_text().splitlines()
        if x.startswith("MemAvailable:")
    )
    assert available >= 8 * 1024**3
    gpu = [
        {"total": int(p.read_text()), "used": int(p.with_name("mem_info_vram_used").read_text())}
        for p in Path("/sys/class/drm").glob("card[0-9]*/device/mem_info_vram_total")
    ]
    assert any(x["total"] >= 8_000_000_000 and x["total"] - x["used"] >= 2 * 1024**3 for x in gpu)
    audio = ROOT / "thesis/harness/c12-mixed-local-http-readiness-v2407/candidate.wav"
    assert sha(audio) == "da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb"
    for name, source in files.items():
        assert hashlib.sha256(source.encode()).hexdigest() == hashes[name]
        if name.endswith(".py"):
            compile(source, name, "exec")
        else:
            json.loads(source)
    for item in m["actualFiles"].values():
        assert (
            Path(item["path"]).stat().st_size == item["bytes"]
            and sha(item["path"]) == item["sha256"]
        )
    OUTPUT.mkdir(parents=True)
    PRIVATE.mkdir(mode=0o700)
    PUBLIC.mkdir(parents=True)
    for name, source in files.items():
        for destination in [PRIVATE / name, PUBLIC / name]:
            with destination.open("x") as stream:
                stream.write(source)
    actual = {
        "at": datetime.now(timezone.utc).isoformat(),
        "actualFiles": m["actualFiles"],
        "sourceInventory": m["sourceInventory"],
        "configSha256": m["configSha256"],
        "gpuMetadata": gpu,
        "availableMemoryBytes": available,
        "modelConfigCredentialsCopied": False,
    }
    write(OUTPUT / "ACTUAL-FILES.json", actual)
    m.update(
        privateRoot=str(PRIVATE),
        output=str(OUTPUT),
        controllerSha256=hashes["provider_controller.py"],
        backendLogPath=str(PRIVATE / "backend.private.log"),
        c12CampaignManifest=str(OUTPUT / "CAMPAIGN-MANIFEST.json"),
        retiredPredecessorPids=[2866664, 2866665],
        actualFileReceiptSha256=sha(OUTPUT / "ACTUAL-FILES.json"),
        lifetimeSeconds=int(
            datetime.fromisoformat(allocation["providerDeadlineUtc"]).timestamp() - now - 300
        ),
        providerAbsoluteDeadlineUtc=allocation["providerDeadlineUtc"],
        originalProviderAbsoluteDeadlineUtc=allocation["providerDeadlineUtc"],
        noRequesterDeadlineSeconds=900,
        prospectiveSessionAllocation=allocation,
        comparisonStagePlacement={
            "primary": "W -> D STT+LLM+TTS through production exact-peer MQTT/ICE P2P",
            "companion": "D production local UserInput/Response STT+LLM+TTS",
        },
        lifecyclePolicy="New required C12 actual-P2P mixed-local counterpart after entire HTTP condition sealed and released; no unloaded baseline repeat",
    )
    for key, label in [
        ("remoteMeshSttReceiver", "whisper"),
        ("remoteMeshAssistantReceiver", "qwen"),
        ("remoteMeshTtsReceiver", "piper"),
    ]:
        m[key] = dict(m[key], receiver_id="personal-c12-p2p-" + label + "-v2445")
    write(OUTPUT / "provider-manifest.json", m)
    cohort = {
        "schema": "aurora.c12.mixed_paired900.p2p.v1",
        "conditionId": "C12-P2P-K3-DLOCAL",
        "cohortId": "aurora-c12-p2p-k3-dlocal-v2445",
        "at": datetime.now(timezone.utc).isoformat(),
        "output": str(OUTPUT),
        "providerOutput": str(OUTPUT),
        "requesterOutput": str(ROOT / "thesis/campaigns/c12-p2p-k3-dlocal-v2445/requester"),
        "audioPath": str(audio),
        "requesterAudioPath": str(
            ROOT / "thesis/harness/distributed-k3-http-remaining-v1682/candidate-input.wav"
        ),
        "audioSha256": sha(audio),
        "referenceTranscript": "What is the capital of France? Answer with only the city name.",
        "expectedReplyWords": ["paris"],
        "warmupPairs": 15,
        "priorAcceptedWarmupPairs": 0,
        "warmupInterpretation": "15fresh excluded paired actual-P2P+local warmups; no HTTP warmup reuse, standalone pilot, old measured replay or new review gate.",
        "measuredPairs": 900,
        "populations": {"P2Pprimary": 900, "localCompanion": 900, "excludedWarmupPerStream": 15},
        "pairDesign": "One closed-loop exact-peer P2P primary; one local UserInput companion triggered by its actual primary-prefixed remote STT native arrival; wait for both terminal outcomes and verified physical custody before next distinct primary",
        "requestCapSeconds": 180,
        "pairCapSeconds": 600,
        "producerCapSeconds": int(
            datetime.fromisoformat(allocation["producerDeadlineUtc"]).timestamp() - now
        ),
        "noPairArrivalCapSeconds": 600,
        "workerDiskFreeFloorBytes": 2 * 1024**3,
        "sourceHashes": hashes,
        "providerManifestSha256": sha(OUTPUT / "provider-manifest.json"),
        "providerManifestSha256ExpectedConfig": m["configSha256"],
        "resourceAdmission": allocation,
        "endpoints": {s: "mesh://"+m["expectedStablePeerId"] for s in ["stt","assistant","tts"]},
        "modelFiles": m["actualFiles"],
        "sourceInventory": m["sourceInventory"],
        "actualEffectiveLlmSettings": m["remoteAssistantEffectiveSettings"],
        "actualEffectiveSttSettings": m["remoteSttEffectiveSettings"],
        "automaticTtsReadback": False,
        "remoteAutomaticTtsReadbackDisabled": True,
        "routeAdmissionCapSeconds": 180,
        "controlHelperSha256": worker["controlHelperSha256"],
        "peerSelectionAdmission": "PENDING_FRESH_NORMAL_CATALOGUE_ROUTE_AND_15_PAIRED_WARMUPS",
        "HTTPSubstitution": False,
        "sourceEpochNote": "Worker1907 exact qualified P2P source, unlike HTTP2151; D25026 and all effective models/audio/config/decoding unchanged. No pure protocol-overhead claim.",
        "modelsAudioDecodingChangedFromQualifiedPilot": False,
        "reference": "Closed unloaded W-D K3 P2P900 and completed C12 mixed HTTP900 references retained; source/auth/residency/operational epoch limits explicit, no replay or pure protocol/causal claim",
        "failurePolicy": "Any warmup failure stops; measured definitive transcript/answer failure retained then next distinct index, all ambiguous/system/harness errors stop; never retry/top-up consumed requests",
        "metrics": "Per-stream all outcome denominators; HF7 p50/p90/p95 milliseconds over declared populations only; actual enqueue bounds/native stages/resources/offered-completed rates and control-copy gaps",
        "copies": "Both repos preserve raw/case/audio from first request; provider capsules copied and hashed between flows; compressed exact control receipts retained once; no overwriting prefixes",
        "externalContext": "N/phone are separately owned and cannot use W-D models/GPU. Existing network/control background is observed by aggregate interface counters; no pure network/protocol-overhead or isolated network claim",
        "physicalScope": "Worker and Personal desktop only; native/headless service boundaries; no Waydroid, phone, UI rendering or microphone claim",
        "totalTargetNotWholeAggregateGoal": True,
        **worker,
    }
    write(OUTPUT / "CAMPAIGN-MANIFEST.json", cohort)
    identity = {
        "at": datetime.now(timezone.utc).isoformat(),
        "maximumPopen": 1,
        "providerManifestSha256": sha(OUTPUT / "provider-manifest.json"),
        "campaignManifestSha256": sha(OUTPUT / "CAMPAIGN-MANIFEST.json"),
        "newOrcaWorker": False,
    }
    write(OUTPUT / "ROOT-LAUNCH-INTENT.json", identity)
    with (PRIVATE / "controller.private.log").open("xb") as stream:
        child = subprocess.Popen(
            [
                m["python"],
                str(PRIVATE / "provider_controller.py"),
                "--control",
                str(OUTPUT / "provider-manifest.json"),
            ],
            cwd=PRIVATE,
            stdin=subprocess.DEVNULL,
            stdout=stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    receipt = dict(
        identity,
        host=socket.gethostname(),
        controller=actor(child.pid),
        nativeMeasurementAdmitted=False,
        deadline=allocation["providerDeadlineUtc"],
    )
    write(OUTPUT / "ROOT-LAUNCH.json", receipt)
    end = time.monotonic() + 25
    while time.monotonic() < end and child.poll() is None:
        if (OUTPUT / "LOCAL-PRODUCER-ARMED.json").exists():
            break
        time.sleep(1)
    receipt.update(
        localProducerArmed=(OUTPUT / "LOCAL-PRODUCER-ARMED.json").exists(),
        controllerState=actor(child.pid) if Path("/proc", str(child.pid)).exists() else "ABSENT",
    )
    if (OUTPUT / "controller-launch.json").exists():
        receipt["runtime"] = json.loads((OUTPUT / "controller-launch.json").read_bytes())
    receipt["campaignManifestRawB64"] = (
        __import__("base64").b64encode((OUTPUT / "CAMPAIGN-MANIFEST.json").read_bytes()).decode()
    )
    return receipt

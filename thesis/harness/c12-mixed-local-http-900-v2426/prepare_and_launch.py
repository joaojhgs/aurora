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
OUTPUT = ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2426/provider"
PRIVATE = ROOT / ".git/aurora-handoff-import-20261006/c12-mixed-local-http-900-v2426"
PUBLIC = ROOT / "thesis/harness/c12-mixed-local-http-900-v2426"
OLD = ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2421/provider"


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


def main(files, hashes, allocation):
    os.umask(0o077)
    assert socket.gethostname() == "personal.skyron-server"
    assert not OUTPUT.exists() and not PRIVATE.exists() and not PUBLIC.exists(), (
        "Reconcile existing preparation, no duplicate"
    )
    assert all(not Path("/proc", str(pid)).exists() for pid in [2516853, 2516854, 2474823, 2474824])
    assert json.loads((OLD / "terminal.json").read_bytes())["receiverAbsent"] is True
    assert json.loads((OLD / "STATUS.json").read_bytes())["ownRuntimeRetired"] is True
    assert (
        sha(OLD / "provider-manifest.json")
        == "e102c9a57c9da8cd60a8a74012249c7e4290f017fc157fea4336143a2a90b4cf"
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
    start = datetime.fromisoformat(allocation["startedAtUtc"]).timestamp()
    now = time.time()
    assert 0 <= now - start <= 3600, "New clock was frozen before lifecycle; no idle renewal"
    assert datetime.fromisoformat(allocation["absoluteDeadlineUtc"]).timestamp() - start == 50400
    assert datetime.fromisoformat(allocation["providerDeadlineUtc"]).timestamp() - start == 46200
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
        compile(source, name, "exec")
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
        c12CampaignManifest=str(OUTPUT / "CAMPAIGN-MANIFEST.json"),
        retiredPredecessorPids=[2516853, 2516854],
        actualFileReceiptSha256=sha(OUTPUT / "ACTUAL-FILES.json"),
        lifetimeSeconds=int(
            datetime.fromisoformat(allocation["providerDeadlineUtc"]).timestamp() - now - 300
        ),
        providerAbsoluteDeadlineUtc=allocation["providerDeadlineUtc"],
        originalProviderAbsoluteDeadlineUtc=allocation["providerDeadlineUtc"],
        noRequesterDeadlineSeconds=900,
        prospectiveSessionAllocation=allocation,
        comparisonStagePlacement={
            "primary": "W -> D STT+LLM+TTS via existing Orca-relayed authenticated HTTP",
            "companion": "D production local UserInput/Response STT+LLM+TTS",
        },
        lifecyclePolicy="New required C12 mixed-load campaign; no closed baseline replay or readiness-clock renewal",
    )
    for key, label in [
        ("remoteMeshSttReceiver", "whisper"),
        ("remoteMeshAssistantReceiver", "qwen"),
        ("remoteMeshTtsReceiver", "piper"),
    ]:
        m[key] = dict(m[key], receiver_id="personal-c12-mixed-" + label + "-v2421")
    write(OUTPUT / "provider-manifest.json", m)
    cohort = {
        "schema": "aurora.c12.mixed_paired900.v1",
        "cohortId": "aurora-c12-mixed-local-orca-http-900pairs-v2421",
        "at": datetime.now(timezone.utc).isoformat(),
        "output": str(OUTPUT),
        "providerOutput": str(OUTPUT),
        "requesterOutput": str(ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2426/requester"),
        "audioPath": str(audio),
        "requesterAudioPath": str(
            ROOT / "thesis/harness/distributed-k3-http-remaining-v1682/candidate-input.wav"
        ),
        "audioSha256": sha(audio),
        "referenceTranscript": "What is the capital of France? Answer with only the city name.",
        "expectedReplyWords": ["paris"],
        "warmupPairs": 1,
        "priorAcceptedWarmupPairs": 15,
        "retainedWarmupReceiptSha256": allocation["priorWarmupReceiptSha256"],
        "warmupInterpretation": "15 prior correct paired model/audio/native/GPU warmups retained; one additional excluded fresh-process pair qualifies corrected inner-LocalBus enqueue observer and actual current GPU. No repeated15 or old measured request.",
        "measuredPairs": 900,
        "populations": {"HTTPprimary": 900, "localCompanion": 900, "excludedWarmupPerStream": 1},
        "pairDesign": "One closed-loop HTTP primary; one local UserInput companion triggered by its actual remote STT native arrival; Root waits for both and verified physical custody before next distinct primary",
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
        "endpoints": {
            s: "http://127.0.0.1:18000/api/" + path
            for s, path in [
                ("stt", "Transcription/Transcribe"),
                ("assistant", "Orchestrator/ExternalUserInput"),
                ("tts", "TTS/Synthesize"),
            ]
        },
        "modelFiles": m["actualFiles"],
        "sourceInventory": m["sourceInventory"],
        "actualEffectiveLlmSettings": m["remoteAssistantEffectiveSettings"],
        "actualEffectiveSttSettings": m["remoteSttEffectiveSettings"],
        "automaticTtsReadback": False,
        "modelsAudioDecodingChangedFromQualifiedPilot": False,
        "reference": "Closed W-D K3 HTTP900 and local references retained, compatible setup mapping only; source/auth/residency epoch limits persist; no rerun or pure protocol/causal claim",
        "failurePolicy": "Any warmup failure stops; measured definitive transcript/answer failure retained then next distinct index, all ambiguous/system/harness errors stop; never retry/top-up consumed requests",
        "metrics": "Per-stream all outcome denominators; HF7 p50/p90/p95 milliseconds over declared populations only; actual enqueue bounds/native stages/resources/offered-completed rates and control-copy gaps",
        "copies": "Provider writes raw/case/audio to its physical repository from first request; Root copies and hashes every completed pair capsule between primary flows; immutable cumulative byte offsets",
        "externalContext": "N/phone are separately owned and cannot use W-D models/GPU. Existing network/control background is observed by aggregate interface counters; no pure network/protocol-overhead or isolated network claim",
        "physicalScope": "Worker and Personal desktop only; native/headless service boundaries; no Waydroid, phone, UI rendering or microphone claim",
        "totalTargetNotWholeAggregateGoal": True,
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
    end = time.monotonic() + 100
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

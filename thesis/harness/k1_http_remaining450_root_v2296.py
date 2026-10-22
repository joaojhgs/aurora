"""Launch only reconciled K1 HTTP indices451-900 after a frozen finite allocation."""

from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[2]
H = ROOT / ".git/aurora-handoff-import-20261006"
OP = H / "distributed-k1-orca-relayed-http-launch-v2296"
CELL = H / "distributed-k1-orca-relayed-http-cell-v2296"
STAGE = H / "distributed-k1-http-requester-v2296"
PUBLIC_STAGE = ROOT / "thesis/harness/distributed-k1-http-remaining450-v2296"
DEST = ROOT / "thesis/campaigns/worker-desktop-k1-orca-relayed-http-remaining450-v2296"
PARENT = ROOT / "thesis/campaigns/worker-desktop-k1-orca-relayed-http-first270-v2234"
ELIGIBILITY = ROOT / "thesis/evidence/k1-http-remaining450-admission-v2294"
SOURCE = ROOT / "thesis/sources/k1-speech-contract-compat-v2151/worker/source"
PYTHON = H / "cpu-audio-campaign-v491/env/bin/python"
CONFIG = H / "distributed-k1-orca-relayed-launch-v1197/runtime-config.json"
ENDPOINT = "http://127.0.0.1:18000/api/TTS/Synthesize"
PARENT_SHA = "11bbea3fc1e45e65da1ecb7b501aee77739870cb087d792e5bc5197f9b1027be"
INVENTORY_SHA = "000202cdddb9803d503fc44f8aaf58eb469475890751a310193418330aa79937"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def actor(pid):
    fields = Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    return {"pid": pid, "state": fields[0], "startTicks": int(fields[19])}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def launch():
    os.umask(0o077)
    assert os.uname().nodename == "code-worker"
    assert not CELL.exists() and not DEST.exists() and not (OP / "LAUNCH-INTENT.json").exists()
    assert all(
        not Path("/proc", str(pid)).exists()
        for pid in [3751414, 3751426, 3751415, 3929022, 3929126]
    )
    with Path("/tmp/aurora-global-build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    allocation = json.loads((OP / "SESSION-ALLOCATION.json").read_bytes())
    start = datetime.fromisoformat(allocation["startedAtUtc"])
    deadline = datetime.fromisoformat(allocation["absoluteDeadlineUtc"])
    assert (deadline - start).total_seconds() == 43200
    assert allocation["state"] == "CLOCK_FROZEN_BEFORE_ANY_LIFECYCLE_ACTION"
    assert allocation["globalFirst"] == 451 and allocation["globalLast"] == 900
    assert (
        allocation["newMeasured"] == 450
        and allocation["prospective900AccountingCapSeconds"] == 115200
    )
    expected_prior = (
        allocation["historicalOriginalActualChargeSeconds"]
        + allocation["priorParentElapsedSecondsAtFreeze"]
    )
    assert abs(expected_prior - allocation["priorChargedTotalSecondsAtFreeze"]) < 0.000001
    assert expected_prior + 43200 <= 115200
    eligibility = json.loads((ELIGIBILITY / "ELIGIBILITY.json").read_bytes())
    assert eligibility["completedMeasured"] == 450 and eligibility["completedFailed"] == 1
    assert sha(ELIGIBILITY / "ELIGIBLE-INDICES.json") == eligibility["eligibleIndicesSha256"]
    assert json.loads((STAGE / "eligible-indices.json").read_bytes()) == list(range(451, 901))
    assert sha(STAGE / "eligible-indices.json") == eligibility["eligibleIndicesSha256"]
    assert sha(PARENT / "condition-frozen.json") == PARENT_SHA
    closed = json.loads((PARENT / "ROOT-EPOCH-COMPLETE-v2293.json").read_bytes())
    assert closed["status"] == "FROZEN270_REQUESTER_PROVIDER_CUSTODY_AND_SAVED_ANALYSIS_COMPLETE"
    assert closed["epochMeasured"]["attempted"] == 270 and not closed["positiveNativeGaps"]
    ready = json.loads((OP / "provider-admission.json").read_bytes())
    assert ready["status"] == "K1_HTTP_PROVIDER_LIVE_METADATA_ADMITTED_NATIVE_WARMUPS_PENDING"
    assert datetime.fromisoformat(ready["providerDeadlineUtc"]) <= deadline - timedelta(
        seconds=2400
    )
    preparation = json.loads((PUBLIC_STAGE / "PREPARATION.json").read_bytes())
    for item in preparation["sourceFiles"]:
        path = STAGE / item["path"]
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == item["bytes"] and sha(path) == item["sha256"]
    assert sha(STAGE / "source-inventory.json") == INVENTORY_SHA
    assert sha(CONFIG) == allocation["workerConfigSha256AtFreeze"]
    config = json.loads(CONFIG.read_bytes())
    assert config["ui"]["assistant"]["automatic_tts_readback"] is False
    memory = next(
        int(line.split()[1]) * 1024
        for line in Path("/proc/meminfo").read_text().splitlines()
        if line.startswith("MemAvailable:")
    )
    assert memory > 2_500_000_000 and shutil.disk_usage(ROOT).free > 2 * 1024**3 + 768 * 1024**2
    key = runpy.run_path(str(ROOT / "thesis/harness/existing_worker_desktop_http_bearer_v2223.py"))[
        "existing_bearer"
    ]()
    opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(
        "http://127.0.0.1:18000/api/services", headers={"Authorization": "Bearer " + key}
    )
    with opener.open(request, timeout=20) as response:
        assert response.status == 200
        body = response.read(256 * 1024 + 1)
        assert len(body) <= 256 * 1024
        json.loads(body)
    auth = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "EXISTING_PEER_BEARER_PROTECTED_HTTP_READ_PASSED",
        "httpStatus": 200,
        "responseSha256": hashlib.sha256(body).hexdigest(),
        "credentialValuesLoggedOrCopied": False,
        "scope": "Protected metadata read only; real15nativefullflows remain required before measurement",
    }
    write(OP / "existing-route-health-new-provider.json", auth)
    m = json.loads((PARENT / "condition-frozen.json").read_bytes())
    prior_lineage = m["epochLineage"]
    implementation = {
        "runnerSha256": "runner.py",
        "controllerSha256": "controller.py",
        "adapterSha256": "tts_http_adapter.py",
        "bootstrapSha256": "bootstrap.py",
        "bindingsSha256": "bindings.py",
        "observerSha256": "observer.py",
        "telemetrySha256": "aurora_voice_telemetry_v430.py",
        "resourceSamplerSha256": "resource_sample.py",
        "receiverProofSha256": "receiver_proof.py",
    }
    m.update(
        schema="aurora.k1.http_remaining_condition.v2296",
        cohortId="aurora-worker-desktop-k1-orca-relayed-http-remaining450-v2296",
        freezeAt=datetime.now(timezone.utc).isoformat(),
        status="FROZEN_ONLY451_900_REAL15_NATIVE_WARMUPS_PENDING",
        implementation={name: sha(STAGE / file) for name, file in implementation.items()},
        runtimeConfigSha256=sha(CONFIG),
        immutableRuntimeConfigInput={
            "path": str(CONFIG),
            "bytes": CONFIG.stat().st_size,
            "sha256": sha(CONFIG),
            "referenceOnlyNoCredentialCopy": True,
        },
        measurementPlan={
            "plannedMeasuredPerCondition": 900,
            "plannedWarmups": 15,
            "plannedEpochMeasured": 450,
            "requestCapSeconds": 180,
            "conditionOverallCapSeconds": 39000,
            "controllerOuterCapSeconds": 39600,
            "sessionAllInclusiveCapSeconds": 43200,
        },
        prospectiveSessionAllocation=allocation,
        cumulativeConditionBudget={
            "conditionCapSeconds": 115200,
            "priorUsedSeconds": allocation["priorChargedTotalSecondsAtFreeze"],
            "historicalParentOperationalCapSeconds": 57600,
            "priorAccountingCapSeconds": 72000,
            "policy": "Explicit prospective30.74.6 allocation after actual terminal; preserve original charge plus all inclusive old parent elapsed, no overlapping-child double count, old clocks unchanged; no native goal budget",
        },
        priorEpochLineage=prior_lineage,
        epochLineage={
            "epochId": "V2296",
            "parentManifestSha256": PARENT_SHA,
            "parentSealSha256": sha(PARENT / "terminal-v2251/REQUESTER-SEAL.json"),
            "originalManifestSha256": eligibility["originalManifestSha256"],
            "priorAttemptedMeasured": 450,
            "priorCorrect": 449,
            "priorFailed": 1,
            "plannedEpochMeasured": 450,
            "firstConditionMeasuredIndex": 451,
            "lastConditionMeasuredIndex": 900,
            "conditionTargetMeasured": 900,
            "eligibleIndicesSha256": eligibility["eligibleIndicesSha256"],
            "failed180Retried": False,
        },
        providerWarmupPrefixStart={
            name: {"bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}
            for name in ["voice-stages.jsonl", "actual-provider-bindings.jsonl"]
        },
        priorActual15NativeProof={
            "path": str((PARENT / "admission/receiver-warmup-proof.json").relative_to(ROOT)),
            "scope": "Named old epoch comparison only; fresh process15nativefullflow admission required, no reuse as current proof",
        },
        remoteTtsReceiver=ready["manifest"]["remoteMeshTtsReceiver"],
        providerManifestSha256=ready["manifestSha256"],
        providerDeadlineUtc=ready["providerDeadlineUtc"],
        providerReceiver=ready["receiver"],
        providerRuntimeConfigSha256=ready["configSha256"],
        providerOutput=ready["manifest"]["output"],
        remoteTtsEndpointSha256=hashlib.sha256(ENDPOINT.encode()).hexdigest(),
        remoteTtsAuthBinding="existing_authorized_peer_bearer",
        authAdmission=auth,
        comparisonPolicy="Same effective scientific source/audio/models/settings/auth/route/placement as V2234; new process IDs and prospective caps, separately retained epoch; original180 has separate auth/source/residency stratum, no unlike latency pooling",
        freshWorkerResources={
            "at": datetime.now(timezone.utc).isoformat(),
            "memAvailableBytes": memory,
            "freeBytes": shutil.disk_usage(ROOT).free,
        },
        remainingActualAdmission=[
            "15correct excluded ordinary fullaudio warmups",
            "actual WSTT+LLM/D TTS native joins",
            "postwarmup conservative450 capacity",
            "firstnew451case+validWAV",
        ],
    )
    m["effectiveSetup"]["tts"]["provider"] = m["remoteTtsReceiver"]
    DEST.mkdir(parents=True, exist_ok=False)
    write(OP / "config-reference.json", m["immutableRuntimeConfigInput"])
    frozen = OP / "condition-frozen-v2296.json"
    write(frozen, m)
    write(DEST / "condition-frozen.json", m)
    write(DEST / "EXISTING-ROUTE-HEALTH.json", auth)
    write(
        OP / "LAUNCH-INTENT.json",
        {
            "at": datetime.now(timezone.utc).isoformat(),
            "maximumControllerPopen": 1,
            "maximumCopierPopen": 1,
            "maximumProofFinalizerPopen": 1,
            "frozenManifestSha256": sha(frozen),
            "newOrcaWorkers": 0,
        },
    )
    env = os.environ.copy()
    env.update(m["effectiveEnvironment"])
    env.update(
        VIRTUAL_ENV=str(PYTHON.parent.parent),
        PATH=str(PYTHON.parent) + os.pathsep + env.get("PATH", ""),
        AURORA_TOKEN_SECRET=config["services"]["gateway"]["api"]["token_secret"],
        AURORA_CONFIG_FILE=str(CONFIG),
        AURORA_OUTPUT_DIR=str(CELL / "campaign"),
        AURORA_FROZEN_MANIFEST=str(frozen),
        AURORA_FROZEN_MANIFEST_SHA256=sha(frozen),
        AURORA_K1_SOURCE_ROOT=str(SOURCE),
        AURORA_K1_PYTHON=str(PYTHON),
        AURORA_K1_REMOTE_TTS_ENDPOINT=ENDPOINT,
        AURORA_K1_HTTP_BEARER=key,
        HF_HOME=str(CELL / "hf-cache"),
        UV_CACHE_DIR=str(CELL / "uv-cache"),
    )
    for name, field in [
        ("CONTROLLER", "controllerSha256"),
        ("RUNNER", "runnerSha256"),
        ("ADAPTER", "adapterSha256"),
    ]:
        env["AURORA_K1_" + name + "_SHA256"] = m["implementation"][field]
    for name, item in m["canonicalModelFiles"].items():
        env[
            "AURORA_K1_"
            + ("TTS_CONFIG_PATH" if name == "tts_config" else name.upper() + "_MODEL_PATH")
        ] = item["path"]
    with (OP / "requester-controller.private.log").open("xb") as log:
        controller = subprocess.Popen(
            [str(PYTHON), str(STAGE / "controller.py")],
            cwd=SOURCE,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    identity = actor(controller.pid)
    launched = {
        "at": datetime.now(timezone.utc).isoformat(),
        "status": "HTTP_REMAINING450_REQUESTER_CONTROLLER_STARTED_NATIVE_ADMISSION_PENDING",
        "controllerPid": controller.pid,
        "controllerStartTicks": identity["startTicks"],
        "frozenManifestSha256": sha(frozen),
        "plannedMeasured": 450,
        "firstGlobalIndex": 451,
        "lastGlobalIndex": 900,
        "excludedWarmups": 15,
        "warmupsObserved": 0,
        "measuredObserved": 0,
        "providerReceiver": ready["receiver"],
        "sourceInventorySha256": INVENTORY_SHA,
        "newWorker": False,
        "sourceReadyIsNotMeasurement": True,
    }
    write(OP / "requester-launch.json", launched)
    write(DEST / "REQUESTER-LAUNCH.json", launched)
    children = {}
    for label, script, args in [
        (
            "requesterCopier",
            "custody_k1_http_requester_v2296.py",
            ["--follow", "--condition-sha256", sha(frozen)],
        ),
        ("warmupFinalizer", "k1_http_warmup_finalize_v2296.py", []),
    ]:
        with (OP / (label + ".private.log")).open("xb") as log:
            child = subprocess.Popen(
                [str(PYTHON), str(ROOT / "thesis/harness" / script), *args],
                cwd=ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        children[label] = actor(child.pid)
        write(
            OP / (label + "-launch.json"),
            {"at": datetime.now(timezone.utc).isoformat(), **children[label]},
        )
    write(OP / "operator-launch.json", {"requester": launched, "auxiliary": children})
    print(json.dumps({"requester": launched, "auxiliary": children}), flush=True)


if __name__ == "__main__":
    launch()

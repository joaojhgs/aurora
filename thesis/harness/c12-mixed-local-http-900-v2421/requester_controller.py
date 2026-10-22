"""Root-owned sequential paired campaign and incremental, copy-only custody."""

from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import shlex
import subprocess
import sys
import tarfile
import time

from campaign import (
    TOTAL_PAIRS,
    WARMUP_PAIRS,
    acceptable,
    atomic,
    now,
    phase,
    population,
    sha,
    write_once,
)
from paired_case import run_case

ROOT = Path("/home/developer/projects/aurora")
HANDOFF = ROOT / ".git/aurora-handoff-import-20261006"
SOURCE = ROOT / "thesis/sources/k1-speech-contract-compat-v2151/worker/source"
OUTPUT = ROOT / "thesis/campaigns/c12-mixed-local-http-900-v2421"
STAGE = ROOT / "thesis/harness/c12-mixed-local-http-900-v2421"
HELPER = ROOT / "thesis/harness/orca_copy_control_raw_read_v1652.py"


def control(name, source, marker):
    command = HANDOFF / (name + "-command.txt")
    with command.open("x") as stream:
        stream.write("python3 -c " + shlex.quote(source) + "\n")
    # One send only. If an observation fails, preserve the accepted command and
    # stop model traffic; the Root reconciles the same handle/results later.
    result = subprocess.run(
        [sys.executable, str(HELPER), name, str(command), marker],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=210,
    )
    if result.returncode != 0:
        write_once(
            OUTPUT / "CONTROL-OBSERVATION-FAILED.json",
            {
                "at": now(),
                "operation": name,
                "exitCode": result.returncode,
                "inputAcceptance": "Reconcile saved SEND/READ receipts; never resend blindly",
            },
        )
        raise RuntimeError("control_observation_failed_reconcile_same_handle")
    path = HANDOFF / (name + "-RESULT.json")
    value = json.loads(path.read_bytes())
    destination = OUTPUT / "control" / path.name
    destination.parent.mkdir(exist_ok=True)
    destination.write_bytes(path.read_bytes())
    return value


def fetch_pair(ordinal, parent_stt, manifest_sha, provider_output):
    saved = OUTPUT / "provider-custody" / f"{ordinal:04d}"
    saved.mkdir(parents=True)
    parts = []
    receipt = None
    page = 0
    begin = time.monotonic_ns()
    while True:
        operation = f"c12-v2421-pair-{ordinal:04d}-page-{page:02d}"
        marker = "AURORA_C12_PAIR_CAPSULE_V2421"
        source = f"""import sys,json
from pathlib import Path
assert __import__('socket').gethostname()=='personal.skyron-server'
sys.path.insert(0,{str(STAGE)!r})
from collect_pair import collect,emit
output=Path({provider_output!r})
receipt=collect(output,{ordinal},{parent_stt!r},{manifest_sha!r})
emit(receipt,{page},{marker!r})
"""
        value = control(operation, source, marker)
        data = base64.b64decode(value["data"], validate=True)
        assert (
            len(data) == value["pageBytes"]
            and hashlib.sha256(data).hexdigest() == value["pageSha256"]
        )
        assert value["offset"] == len(b"".join(parts))
        parts.append(data)
        if page == 0:
            receipt = value["receipt"]
            write_once(saved / "PROVIDER-RECEIPT.json", receipt)
        if sum(map(len, parts)) == value["totalBytes"]:
            break
        assert page < 15, "Bounded capsule exceeded frozen page budget"
        page += 1
    payload = b"".join(parts)
    assert (
        len(payload) == receipt["bytes"]
        and hashlib.sha256(payload).hexdigest() == receipt["sha256"]
    )
    archive = saved / "provider-pair.tar.gz"
    with archive.open("xb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    verified = []
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            assert member.isfile() and member.name in receipt["members"]
            raw = tar.extractfile(member).read()
            expected = receipt["members"][member.name]
            assert (
                len(raw) == expected["bytes"]
                and hashlib.sha256(raw).hexdigest() == expected["sha256"]
            )
            verified.append(member.name)
    assert set(verified) == set(receipt["members"])
    custody = {
        "at": now(),
        "status": "COMPLETE_EVERY_CAPSULE_MEMBER_SHA256_VERIFIED",
        "archive": str(archive),
        "receipt": receipt,
        "verifiedMembers": verified,
        "copyDurationMs": (time.monotonic_ns() - begin) / 1e6,
        "inferenceByCopy": 0,
    }
    write_once(saved / "CUSTODY.json", custody)
    return receipt["localCase"]


def provider_proof(manifest_sha, provider_output, mode, proof=None):
    marker = "AURORA_C12_CAMPAIGN_CONTROL_V2421"
    extra = ""
    if mode == "admit":
        extra = f"""from campaign import write_once
write_once(output/'MEASURED-ADMITTED.json',{proof!r})
r['measuredAdmissionWritten']=True
"""
    elif mode == "stop":
        extra = """from campaign import write_once
write_once(output/'STOP-REQUESTED.json',{'at':r['at'],'reason':'Root campaign terminal, preserve all raw'})
r['stopRequested']=True
"""
    source = f"""import base64,json,hashlib,datetime,re,sys
from pathlib import Path
assert __import__('socket').gethostname()=='personal.skyron-server'
sys.path.insert(0,{str(STAGE)!r})
output=Path({provider_output!r});manifest=json.loads((output/'provider-manifest.json').read_bytes())
assert hashlib.sha256((output/'CAMPAIGN-MANIFEST.json').read_bytes()).hexdigest()=={manifest_sha!r}
assert hashlib.sha256(Path(manifest['config']).read_bytes()).hexdigest()==manifest['configSha256']
r={{'host':'personal.skyron-server','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'nativeAcceleration':[]}}
log=Path(manifest['privateRoot'])/'backend.private.log'
if log.exists():
 for line in log.read_text(errors='replace').splitlines():
  match=re.search(r'offloaded (\\d+)/(\\d+) layers to GPU',line)
  if match:r['nativeAcceleration'].append({{'actualOffloadedLayers':int(match[1]),'totalLayers':int(match[2])}})
{extra}
b=base64.b64encode(json.dumps(r).encode()).decode()
for i in range(0,len(b),600):print({marker!r}+' '+json.dumps({{'seq':i//600,'total':(len(b)+599)//600,'data':b[i:i+600]}}),flush=True)
"""
    return control("c12-v2421-provider-" + mode, source, marker)


async def execute(manifest):
    from warmup_gate import verify

    output = Path(manifest["output"])
    primary_rows = []
    local_rows = []
    started = time.monotonic_ns()
    sampler = runpy.run_path(
        str(ROOT / "thesis/harness/distributed-k3-http-remaining-v1682/resource_sample.py")
    )["sample_resources"]
    stop = asyncio.Event()

    async def resources():
        with (output / "resources.jsonl").open("x") as stream:
            while not stop.is_set():
                row = {
                    "at": now(),
                    "monotonic_ns": time.monotonic_ns(),
                    "pid": os.getpid(),
                    "resource_context": sampler(os.getpid()),
                }
                stream.write(json.dumps(row, sort_keys=True) + "\n")
                stream.flush()
                try:
                    await asyncio.wait_for(stop.wait(), timeout=1)
                except asyncio.TimeoutError:
                    pass

    task = asyncio.create_task(resources())
    reason = "finite_or_policy_stop"
    collection_end = datetime.fromisoformat(
        manifest["resourceAdmission"]["collectionDeadlineUtc"]
    ).timestamp()
    try:
        for ordinal in range(1, TOTAL_PAIRS + 1):
            phase_name, index = phase(ordinal)
            if time.time() + manifest["pairCapSeconds"] >= collection_end:
                reason = "frozen_collection_deadline_reserve"
                break
            if (
                __import__("shutil").disk_usage(ROOT).free
                < manifest["workerDiskFreeFloorBytes"] + 8 * 1024**2
            ):
                reason = "worker_free_disk_floor"
                break
            assert all(
                sha(STAGE / name) == digest for name, digest in manifest["sourceHashes"].items()
            )
            if ordinal == WARMUP_PAIRS + 1:
                proof = await asyncio.to_thread(
                    provider_proof,
                    manifest["campaignManifestSha256"],
                    manifest["providerOutput"],
                    "proof",
                )
                gate = verify(
                    OUTPUT, manifest["providerManifestSha256"], proof["nativeAcceleration"]
                )
                gate.update(
                    at=now(),
                    campaignManifestSha256=manifest["campaignManifestSha256"],
                    primaryTarget=900,
                    companionTarget=900,
                )
                await asyncio.to_thread(
                    provider_proof,
                    manifest["campaignManifestSha256"],
                    manifest["providerOutput"],
                    "admit",
                    gate,
                )
                write_once(OUTPUT / "MEASURED-ADMITTED.json", gate)
            write_once(
                output / f"PAIR-{ordinal:04d}-INTENT.json",
                {
                    "at": now(),
                    "ordinal": ordinal,
                    "phase": phase_name,
                    "index": index,
                    "maximumPrimaryFlowCalls": 1,
                    "maximumCompanionFlowCalls": 1,
                },
            )
            primary = await run_case(manifest, "worker-http", ordinal=ordinal)
            primary_rows.append(primary)
            parent = (
                primary.get("case", {})
                .get("stages", {})
                .get("stt", {})
                .get("server_correlation_id")
            )
            if not parent:
                reason = "primary_no_verified_remote_stt_correlation"
                break
            companion = await asyncio.to_thread(
                fetch_pair,
                ordinal,
                parent,
                manifest["campaignManifestSha256"],
                manifest["providerOutput"],
            )
            local_rows.append(companion)
            atomic(
                OUTPUT / "CURRENT.json",
                {
                    "at": now(),
                    "status": "running",
                    "lastOrdinal": ordinal,
                    "phase": phase_name,
                    "lastIndex": index,
                    "pid": os.getpid(),
                    "primary": {p: population(primary_rows, p) for p in ["warmup", "measured"]},
                    "companion": {p: population(local_rows, p) for p in ["warmup", "measured"]},
                    "manifestSha256": manifest["campaignManifestSha256"],
                    "elapsedSeconds": (time.monotonic_ns() - started) / 1e9,
                    "completePairedCapsules": len(local_rows),
                    "lastNativeParent": parent,
                },
            )
            if not acceptable(primary, phase_name) or not acceptable(companion, phase_name):
                reason = "declared_case_failure_policy"
                break
        else:
            reason = "900_measured_pairs_target_reached"
    finally:
        stop.set()
        await task
        terminal = {
            "at": now(),
            "reason": reason,
            "pid": os.getpid(),
            "primary": {p: population(primary_rows, p) for p in ["warmup", "measured"]},
            "companion": {p: population(local_rows, p) for p in ["warmup", "measured"]},
            "elapsedSeconds": (time.monotonic_ns() - started) / 1e9,
            "failedOrPartialCasesRetained": True,
            "extraPrimaryCalls": 0,
            "extraCompanionCalls": 0,
            "fullAggregateGoalComplete": False,
        }
        if len(primary_rows) != len(local_rows):
            for population_name in ["warmup", "measured"]:
                if (
                    terminal["primary"][population_name]["attempted"]
                    > terminal["companion"][population_name]["attempted"]
                ):
                    terminal["companion"][population_name]["unstarted"] = None
                    terminal["companion"][population_name]["unresolvedPotentiallyOffered"] = 1
                    terminal["companion"][population_name]["note"] = (
                        "Missing custody is not proof counterpart never started; reconcile actual provider rows"
                    )
        write_once(OUTPUT / "REQUESTER-TERMINAL.json", terminal)
        # Only the finite Root-owned SUT is asked to retire. Exact process and
        # EOF reconciliation remain a finalization step, never assumed here.
        if not (OUTPUT / "CONTROL-OBSERVATION-FAILED.json").exists():
            await asyncio.to_thread(
                provider_proof,
                manifest["campaignManifestSha256"],
                manifest["providerOutput"],
                "stop",
            )
    return terminal


def main():
    os.umask(0o077)
    sys.path[:0] = [str(STAGE), str(SOURCE)]
    manifest_path = OUTPUT / "CAMPAIGN-MANIFEST.json"
    manifest = json.loads(manifest_path.read_bytes())
    manifest["campaignManifestSha256"] = sha(manifest_path)
    manifest["output"] = manifest["requesterOutput"]
    manifest["audioPath"] = manifest["requesterAudioPath"]
    assert manifest["warmupPairs"] == 15 and manifest["measuredPairs"] == 900
    assert not (OUTPUT / "ROOT-REQUESTER-INTENT.json").exists()
    assert __import__("socket").gethostname() == "code-worker"
    lock = Path("/tmp/aurora-global-build.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    credentials = runpy.run_path(
        str(ROOT / "thesis/harness/existing_worker_desktop_http_bearer_v2223.py")
    )
    auth = credentials["protected_read"]()
    write_once(OUTPUT / "AUTHENTICATED-HEALTH.json", auth)
    assert auth.get("httpStatus") == 200
    os.environ["AURORA_HOSTED_PEER_GATEWAY_API_KEY"] = credentials["existing_bearer"]()
    identity = {
        "at": now(),
        "pid": os.getpid(),
        "startTicks": int(
            Path("/proc", str(os.getpid()), "stat").read_text().rsplit(")", 1)[1].split()[19]
        ),
        "manifestSha256": manifest["campaignManifestSha256"],
        "maximumPrimaryCalls": TOTAL_PAIRS,
        "maximumCompanionCalls": TOTAL_PAIRS,
        "newOrcaWorker": False,
        "nativeAggregateGoal": "01a112a5 ACTIVE",
    }
    write_once(OUTPUT / "ROOT-REQUESTER-INTENT.json", identity)
    return asyncio.run(execute(manifest))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Preserve the original failure and every accepted command; no retry.
        path = OUTPUT / "REQUESTER-EXCEPTION.json"
        if not path.exists():
            write_once(
                path,
                {
                    "at": now(),
                    "exceptionType": type(exc).__name__,
                    "reconcileBeforeAnyNewInference": True,
                    "modelQualityInference": False,
                },
            )
        raise SystemExit(1) from None

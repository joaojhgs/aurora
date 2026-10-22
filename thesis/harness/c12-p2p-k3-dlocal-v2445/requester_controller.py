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
from primary_case import run_case, actual_remote_stt_correlation
from admission_boundary import predecessor_state, require_predecessor_release
from worker_runtime import open_worker_runtime, admit_routes

ROOT = Path("/home/developer/projects/aurora")
HANDOFF = ROOT / ".git/aurora-handoff-import-20261006"
SOURCE = ROOT / "thesis/sources/k3-stt-runtime-v1907/worker/source"
OUTPUT = ROOT / "thesis/campaigns/c12-p2p-k3-dlocal-v2445"
STAGE = ROOT / "thesis/harness/c12-p2p-k3-dlocal-v2445"
HELPER = ROOT / "thesis/harness/orca_copy_control_compact_v2453.py"


def control(name, source, marker):
    command = HANDOFF / (name + "-command.txt")
    with command.open("x") as stream:
        stream.write("python3 -c " + shlex.quote(source) + "\n")
    # One send only. If an observation fails, preserve the accepted command and
    # stop model traffic; the Root reconciles the same handle/results later.
    try:
        result = subprocess.run(
            [sys.executable, str(HELPER), name, str(command), marker],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=210,
        )
    except subprocess.TimeoutExpired:
        write_once(OUTPUT / "CONTROL-OBSERVATION-FAILED.json", {
            "at": now(), "operation": name, "observationTimeout": True,
            "inputAcceptance": "UNKNOWN; reconcile saved SEND/READ, never resend or submit stop blindly",
        })
        raise RuntimeError("control_observation_timeout_reconcile_same_handle") from None
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
    os.link(path, destination)  # Retain both paths with one physical encoded-result allocation.
    return value


def fetch_pair(ordinal, parent_stt, manifest_sha, provider_output, pair_deadline):
    saved = OUTPUT / "provider-custody" / f"{ordinal:04d}"
    saved.mkdir(parents=True)
    parts = []
    receipt = None
    page = 0
    begin = time.monotonic_ns()
    while True:
        operation = f"c12p2p-v2445-pair-{ordinal:04d}-page-{page:02d}"
        marker = "AURORA_C12_PAIR_CAPSULE_P2P_V2445"
        source = f"""import sys,json
from pathlib import Path
assert __import__('socket').gethostname()=='personal.skyron-server'
sys.path.insert(0,{str(STAGE)!r})
from collect_pair import collect,emit
output=Path({provider_output!r})
receipt=collect(output,{ordinal},{parent_stt!r},{manifest_sha!r})
emit(receipt,{page},{marker!r})
"""
        # Do not start another potentially accepted operation without its
        # complete observation allowance inside the declared pair budget.
        if time.monotonic() + 210 > pair_deadline:
            write_once(OUTPUT / "PAIR-BUDGET-STOP.json", {
                "at": now(), "ordinal": ordinal,
                "reason": "insufficient_pair_budget_before_next_copy_operation",
                "lastCompletedPage": page - 1,
            })
            raise RuntimeError("pair_budget_before_next_control_operation")
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
    marker = "AURORA_C12_CAMPAIGN_CONTROL_P2P_V2445"
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
assert hashlib.sha256((output/'provider-manifest.json').read_bytes()).hexdigest()==json.loads((output/'CAMPAIGN-MANIFEST.json').read_bytes())['providerManifestSha256']
assert hashlib.sha256(Path(manifest['config']).read_bytes()).hexdigest()==manifest['configSha256']
r={{'host':'personal.skyron-server','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'nativeAcceleration':[]}}
log=Path(manifest['backendLogPath'])
if log.exists():
 for line in log.read_text(errors='replace').splitlines():
  match=re.search(r'offloaded (\\d+)/(\\d+) layers to GPU',line)
  if match:r['nativeAcceleration'].append({{'actualOffloadedLayers':int(match[1]),'totalLayers':int(match[2])}})
{extra}
b=base64.b64encode(json.dumps(r).encode()).decode()
for i in range(0,len(b),600):print({marker!r}+' '+json.dumps({{'seq':i//600,'total':(len(b)+599)//600,'data':b[i:i+600]}}),flush=True)
"""
    return control("c12p2p-v2445-provider-" + mode, source, marker)


async def execute(manifest, supervisor):
    from warmup_gate import verify

    output = Path(manifest["output"])
    primary_rows = []
    local_rows = []
    started = time.monotonic_ns()
    sampler = runpy.run_path(
        str(STAGE / "resource_sample.py")
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
                # Full route/dispatch/native proof stays physical on W. D's
                # local driver needs only this small authenticated control marker.
                marker = {
                    "status": gate["status"], "at": gate["at"],
                    "campaignManifestSha256": manifest["campaignManifestSha256"],
                    "primaryTarget": 900, "companionTarget": 900,
                    "correctP2P": gate["correctP2P"], "correctLocal": gate["correctLocal"],
                    "fullGateCanonicalObjectSha256": hashlib.sha256(
                        json.dumps(gate, sort_keys=True, separators=(",", ":")).encode()
                    ).hexdigest(),
                }
                await asyncio.to_thread(
                    provider_proof,
                    manifest["campaignManifestSha256"],
                    manifest["providerOutput"],
                    "admit",
                    marker,
                )
                write_once(OUTPUT / "MEASURED-ADMITTED.json", gate)
            if time.time() + manifest["pairCapSeconds"] >= collection_end:
                reason = "frozen_collection_deadline_after_admission"
                break
            pair_deadline = time.monotonic() + manifest["pairCapSeconds"]
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
            primary = await run_case(manifest, supervisor, ordinal=ordinal)
            primary_rows.append(primary)
            parent = actual_remote_stt_correlation(primary)
            if not parent:
                reason = "primary_no_verified_remote_stt_correlation"
                break
            companion = await asyncio.to_thread(
                fetch_pair,
                ordinal,
                parent,
                manifest["campaignManifestSha256"],
                manifest["providerOutput"],
                pair_deadline,
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


async def with_worker_runtime(manifest):
    require_predecessor_release()
    entered_collection = False
    try:
        async with open_worker_runtime(manifest) as supervisor:
            await admit_routes(supervisor, manifest)
            entered_collection = True
            return await execute(manifest, supervisor)
    finally:
        # execute owns its terminal stop. Before it starts, reconcile failure by
        # requesting the same Root-owned provider's ordinary stop exactly once.
        if not entered_collection and not (OUTPUT / "CONTROL-OBSERVATION-FAILED.json").exists():
            await asyncio.to_thread(provider_proof, manifest["campaignManifestSha256"], manifest["providerOutput"], "stop")


def main(manifest_path):
    require_predecessor_release()
    os.umask(0o077)
    assert manifest_path.resolve() == (OUTPUT / "CAMPAIGN-MANIFEST.json").resolve()
    manifest = json.loads(manifest_path.read_bytes())
    manifest["campaignManifestSha256"] = sha(manifest_path)
    assert manifest["conditionId"] == "C12-P2P-K3-DLOCAL"
    assert manifest["warmupPairs"] == 15 and manifest["measuredPairs"] == 900
    assert manifest["workerSourceRoot"] == str(SOURCE)
    assert Path(manifest["requesterOutput"]).is_dir() and Path(manifest["workerPrivateRoot"]).is_dir()
    assert sha(HELPER) == manifest["controlHelperSha256"]
    assert not (OUTPUT / "ROOT-REQUESTER-INTENT.json").exists()
    assert __import__("socket").gethostname() == "code-worker"
    lock = Path("/tmp/aurora-global-build.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sys.path[:0] = [str(STAGE), str(SOURCE)]
    manifest["output"] = manifest["requesterOutput"]
    manifest["audioPath"] = manifest["requesterAudioPath"]
    write_once(OUTPUT / "ROOT-REQUESTER-INTENT.json", {
        "at": now(), "pid": os.getpid(),
        "startTicks": int(Path("/proc", str(os.getpid()), "stat").read_text().rsplit(")", 1)[1].split()[19]),
        "manifestSha256": manifest["campaignManifestSha256"],
        "maximumPrimaryCalls": TOTAL_PAIRS, "maximumCompanionCalls": TOTAL_PAIRS,
        "newOrcaWorker": False,
        "aggregateGoalThread": "01a112a5-d6bb-74e2-bf7c-ace73cb513b5",
    })
    return asyncio.run(with_worker_runtime(manifest))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--manifest", type=Path, default=OUTPUT / "CAMPAIGN-MANIFEST.json")
    args = parser.parse_args()
    boundary = predecessor_state()
    if not args.execute or not boundary["predecessorReleased"]:
        print(json.dumps({"status": "DEFERRED_NO_NEW_RUNTIME", "boundary": boundary, "newRuntimeNetworkOrInference": 0}, indent=2))
    else:
        try:
            main(args.manifest)
        except Exception as exc:
            path = OUTPUT / "REQUESTER-EXCEPTION.json"
            if not path.exists():
                write_once(path, {"at": now(), "exceptionType": type(exc).__name__, "reconcileBeforeAnyNewInference": True, "modelQualityInference": False})
            raise SystemExit(1) from None

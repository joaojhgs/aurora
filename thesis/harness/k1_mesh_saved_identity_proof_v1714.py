"""Repair only an omitted collector field using the saved live peer observation.

No source/config/raw identity is edited, no model is called, and no Orca
command is sent. The original strict proof generator is reused unchanged.
"""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import runpy
import time

R=Path(__file__).resolve().parents[2]
H=R/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k1-mesh-launch-v1711'
CELL=H/'distributed-k1-mesh-cell-v1711'
STAGE=H/'distributed-k1-mesh-requester-v1711'
DEST=R/'thesis/campaigns/worker-desktop-k1-p2p-tts-v1711'


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,j):
    with Path(p).open('x')as f:
        json.dump(j,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())


def main():
    os.umask(0o077)
    end=time.monotonic()+1800
    failed=OP/'warmup-finalizer-failure.json'
    target=CELL/'campaign/receiver-warmup-proof.json'
    while not failed.exists():
        if target.exists():return
        assert time.monotonic()<end,'bounded_saved_identity_wait_expired'
        time.sleep(1)
    failure=json.loads(failed.read_bytes())
    assert failure['error']=='receiver_mesh_peer_identity_mismatch','different_failure_requires_its_own_saved_evidence_diagnosis'
    mpath=OP/'condition-frozen-v1711.json';m=json.loads(mpath.read_bytes())
    custody=DEST/'provider-warmup-prefixes'
    original=custody/'receiver-identity.json';identity=json.loads(original.read_bytes())
    assert 'peer_id_sha256'not in identity,'existing_peer_field_must_not_be_replaced'
    observed_path=R/'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/PROVIDER-READY-v1710.json'
    observed=json.loads(observed_path.read_bytes());files=observed['files']
    status=files['STATUS.json'];peer=status['catalogue']['local_peer_id']
    assert peer==status['mesh']['local']['peer_id']
    assert files['controller-launch.json']['receiverPid']==identity['receiver_pid']==m['providerReceiver']['pid']
    assert files['controller-launch.json']['receiverStartTicks']==m['providerReceiver']['startTicks']
    assert files['controller-launch.json']['manifestSha256']==m['providerManifestSha256']
    assert identity['manifest_sha256']==m['providerManifestSha256']
    digest=hashlib.sha256(peer.encode()).hexdigest()
    assert digest==identity['provider']['peer_id_sha256']==m['remoteMeshTtsReceiver']['peer_id_sha256']
    identity['peer_id_sha256']=digest
    derivative=custody/'receiver-identity.from-observed-peer.json';write(derivative,identity)
    proof=runpy.run_path(str(STAGE/'receiver_proof.py'))['build_proof'](
        attempts_dir=CELL/'campaign/attempts',stage_path=custody/'voice-stages.jsonl',
        bindings_path=custody/'actual-provider-bindings.jsonl',
        requester_calls_path=CELL/'requester-mesh-calls.jsonl',
        route_observations_path=CELL/'requester-mesh-route-observations.jsonl',
        route_sink_status_path=CELL/'requester-mesh-route-sink-status.json',
        route_runtime_pins_path=CELL/'requester-mesh-route-runtime-pins.json',
        cohort_manifest=m,cohort_sha=sha(mpath),identity_path=derivative,
        candidate_sha=m['candidateManifestSha256'],expected=m['remoteMeshTtsReceiver'])
    rows=[json.loads((CELL/f'campaign/attempts/attempt-{i:04d}-warmup.jsonl').read_bytes())for i in range(1,16)]
    assert all(row['status']=='completed_correct'for row in rows)
    values=sorted(float(row['flow_duration_ms'])for row in rows);h=14*.95
    p95=values[int(h)]+(values[int(h)+1]-values[int(h)])*(h-int(h))
    forecast=900*p95/1000*1.2+300
    now=datetime.now(timezone.utc)
    launch=json.loads((OP/'requester-launch.json').read_bytes())
    remaining_provider=(datetime.fromisoformat(m['providerDeadlineUtc'])-now).total_seconds()
    remaining_condition=72000-(now-datetime.fromisoformat(launch['at'])).total_seconds()
    assert forecast<min(remaining_provider,remaining_condition),'unchanged_fixed_lifetime_insufficient'
    complete=OP/'completed-receiver-warmup-proof-from-observed-identity.json';write(complete,proof)
    os.link(complete,target)
    record={'at':now.isoformat(),'status':'SAME15_SAVED_WARMUPS_STRICT_NATIVE_AND_ROUTE_PROOF_PUBLISHED',
            'originalIdentity':{'path':str(original.relative_to(R)),'sha256':sha(original)},
            'actualPeerObservation':{'path':str(observed_path.relative_to(R)),'sha256':sha(observed_path)},
            'derivativeIdentity':{'path':str(derivative.relative_to(R)),'sha256':sha(derivative)},
            'receiverPid':identity['receiver_pid'],'peerIdSha256':digest,
            'proofSha256':sha(target),'nativeCalls':len(proof['calls']),
            'excludedWarmups':15,'warmupP95MsType7':p95,'forecast900SecondsWith20PercentPlus300':forecast,
            'remainingProviderSeconds':remaining_provider,'remainingConditionSeconds':remaining_condition,
            'reason':'HTTP-derived controller omitted the top-level mesh peer field. Added only to a derivative from actual live catalogue+mesh peer on the same receiver PID/start/manifest; original record and failed collector are retained.',
            'newSutCalls':0,'newOrcaCommands':0,'frozenSourceOrManifestEdited':False,
            'nextGate':'Frozen runner independently validates localSTT+LLM and this original strict native/route proof before measured1'}
    write(OP/'warmup-finalizer-result.json',record);write(DEST/'ORDINARY-WARMUP-ADMISSION.json',record)
    print(json.dumps(record),flush=True)


if __name__=='__main__':
    try:main()
    except Exception as exc:
        record={'at':datetime.now(timezone.utc).isoformat(),'errorCategory':type(exc).__name__,
                'error':str(exc),'automaticRetry':False,'newSutCalls':0}
        write(OP/'saved-identity-proof-failure.json',record)
        print(json.dumps(record),flush=True)
        raise SystemExit(1)from None

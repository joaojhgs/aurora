"""One bounded saved-data admission for 15 ordinary P2P audio warmups.

This utility never calls an inference method and never resends an ambiguous
accepted Orca command. The frozen runner independently validates the proof.
"""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
import runpy
import shlex
import subprocess
import sys
import time

R=Path(__file__).resolve().parents[2]
H=R/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k1-mesh-launch-v2143'
CELL=H/'distributed-k1-mesh-cell-v2143'
STAGE=H/'distributed-k1-mesh-requester-v2143'
DEST=R/'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2143'
NAME='k1-mesh-ordinary-warmup-prefix-v2143'
MARKER='AURORA_K1_NATIVE_WARMUPS_V2143'


def now():return datetime.now(timezone.utc)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def write(p,j):
    p=Path(p)
    with p.open('x')as f:
        json.dump(j,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())


def main():
    os.umask(0o077)
    launch=json.loads((OP/'requester-launch.json').read_bytes())
    manifest_path=OP/'condition-frozen-v2143.json';m=json.loads(manifest_path.read_bytes())
    policy=runpy.run_path(str(STAGE/'warmup_policy.py'))
    end=time.monotonic()+3600
    while True:
        assert time.monotonic()<end,'ordinary_warmup_observation_deadline_no_automatic_retry'
        selection=policy['qualified_warmup_records'](CELL/'campaign/attempts',require_complete=False)
        rows=[item['row']for item in selection['selected']]
        if len(rows)==15:break
        p=Path('/proc',str(launch['controllerPid']),'stat')
        assert p.exists(),'requester_retired_before_all15_warmups'
        fields=p.read_text().rsplit(')',1)[1].split()
        assert int(fields[19])==launch['controllerStartTicks']and fields[0]not in ['Z','X','x']
        time.sleep(2)
    durations=sorted(float(r['flow_duration_ms'])for r in rows)
    h=14*.95;p95=durations[int(h)]+(durations[int(h)+1]-durations[int(h)])*(h-int(h))
    forecast=191*p95/1000*1.2+300
    provider_remaining=(datetime.fromisoformat(m['providerDeadlineUtc'])-now()).total_seconds()
    requester_remaining=15000-(now()-datetime.fromisoformat(launch['at'])).total_seconds()
    assert forecast<min(provider_remaining,requester_remaining),'fixed_frozen_lifetime_insufficient_no_measured_admission'
    remote="""from pathlib import Path
import json,base64,hashlib,os,socket,datetime,time
b=Path('/home/developer/projects/aurora/thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1965/provider')
j={'host':socket.gethostname(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sutCalls':0,'files':{}}
try:
 assert j['host']=='personal.skyron-server'
 m=json.loads((b/'provider-manifest.json').read_bytes())
 assert hashlib.sha256((b/'provider-manifest.json').read_bytes()).hexdigest()==EXPECTED_MANIFEST
 p=Path('/proc',str(EXPECTED_PID),'stat');f=p.read_text().rsplit(')',1)[1].split()
 assert int(f[19])==EXPECTED_TICKS and f[0]not in ['Z','X','x']
 for n in ['voice-stages.jsonl','actual-provider-bindings.jsonl','receiver-identity.json','STATUS.json','controller-launch.json']:
  p=b/n
  start=PREFIX_STARTS.get(n) if n.endswith('.jsonl') else None
  with p.open('rb')as stream:
   before=os.fstat(stream.fileno())
   if start is not None:
    assert before.st_ino==start['inode'] and before.st_size>=start['sourceBytes']
    prior=stream.read(start['sourceBytes']);assert hashlib.sha256(prior).hexdigest()==start['sha256']
    assert before.st_size-start['sourceBytes']<=1024**2
    raw=stream.read(before.st_size-start['sourceBytes']);start_byte=start['sourceBytes']
   else:
    assert before.st_size<256*1024;raw=stream.read(before.st_size);start_byte=0
  if n.endswith('.jsonl'):raw=raw[:raw.rfind(bytes([10]))+1]
  j['files'][n]={'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode(),'prefix':n.endswith('.jsonl'),'terminalEOF':False,'sourceStartByte':start_byte,'sourceEndByte':start_byte+len(raw),'priorPrefixBinding':start}
 j['status']='saved_provider_warmup_prefixes_read_once'
except Exception as e:j.update(status='failed_saved_prefix_read',errorCategory=type(e).__name__)
raw=base64.b64encode(json.dumps(j).encode()).decode();parts=[raw[i:i+800]for i in range(0,len(raw),800)]
for i,p in enumerate(parts):print('AURORA_K1_NATIVE_WARMUPS_V2143 '+json.dumps({'seq':i,'total':len(parts),'data':p}),flush=True);time.sleep(.03)
"""
    remote=remote.replace('PREFIX_STARTS',repr(m['providerWarmupPrefixStart']))
    remote=remote.replace('EXPECTED_MANIFEST',repr(m['providerManifestSha256']))
    remote=remote.replace('EXPECTED_PID',str(m['providerReceiver']['pid']))
    remote=remote.replace('EXPECTED_TICKS',str(m['providerReceiver']['startTicks']))
    python='python3'
    command=OP/'collect-provider-warmups.command.txt'
    command.write_text(shlex.quote(python)+' -c '+shlex.quote(remote)+'\n')
    write(OP/'proof-collection-request.json',{'at':now().isoformat(),'maximumSends':1,'sutCalls':0})
    cp=subprocess.run([sys.executable,str(R/'thesis/harness/orca_copy_control_raw_read_v1652.py'),
                       NAME,str(command),MARKER],capture_output=True,text=True,timeout=190)
    (OP/'proof-collection.private.log').write_text(cp.stdout+'\nSTDERR\n'+cp.stderr)
    result_path=H/(NAME+'-RESULT.json')
    assert result_path.exists(),'accepted_proof_read_requires_same_stream_reconciliation_never_resend'
    packet=json.loads(result_path.read_bytes());assert packet['status']=='saved_provider_warmup_prefixes_read_once'
    custody=DEST/'provider-warmup-prefixes';custody.mkdir()
    receipts={}
    for name,entry in packet['files'].items():
        raw=base64.b64decode(entry['data']);assert len(raw)==entry['bytes']and sha(raw)==entry['sha256']
        with (custody/name).open('xb')as f:f.write(raw);f.flush();os.fsync(f.fileno())
        assert sha((custody/name).read_bytes())==entry['sha256']
        receipts[name]={k:v for k,v in entry.items()if k!='data'}
    write(custody/'CUSTODY.json',{'at':now().isoformat(),'files':receipts,'prefixesOnly':True,'sutCalls':0})
    identity=json.loads((custody/'receiver-identity.json').read_bytes())
    observed=json.loads((custody/'STATUS.json').read_bytes())
    actual_launch=json.loads((custody/'controller-launch.json').read_bytes())
    peer=observed['catalogue']['local_peer_id']
    assert peer==observed['mesh']['local']['peer_id']
    assert actual_launch['receiverPid']==identity['receiver_pid']==m['providerReceiver']['pid']
    assert actual_launch['receiverStartTicks']==m['providerReceiver']['startTicks']
    assert actual_launch['manifestSha256']==m['providerManifestSha256']==identity['manifest_sha256']
    digest=hashlib.sha256(peer.encode()).hexdigest()
    assert digest==identity['provider']['peer_id_sha256']==m['remoteMeshTtsReceiver']['peer_id_sha256']
    assert identity['provider']==m['providerBaseTtsIdentity']
    assert identity['actual_provider_files']['source_receipt_sha256']==m['providerActualFileReceiptSha256']
    assert m['providerHardwareFingerprintSha256']==m['remoteMeshTtsReceiver']['hardware_fingerprint_sha256']
    identity['provider']=m['remoteMeshTtsReceiver']
    identity['peer_id_sha256']=digest
    derived=custody/'receiver-identity.from-observed-peer.json';write(derived,identity)
    write(custody/'IDENTITY-DERIVATION.json',{'at':now().isoformat(),'originalSha256':sha((custody/'receiver-identity.json').read_bytes()),'derivedSha256':sha(derived.read_bytes()),'basis':'Original six provider fields, PID/start/manifest/source-receipt retained; peer from actual normal catalogue+mesh; hardware hash from captured current host payload. Expected CPU/sample-rate metadata is independently checked against15actual Piper calls/returned WAV. No original identity rewrite','sutCalls':0})
    helper=runpy.run_path(str(STAGE/'receiver_proof.py'))
    proof=helper['build_proof'](attempts_dir=CELL/'campaign/attempts',
        stage_path=custody/'voice-stages.jsonl',bindings_path=custody/'actual-provider-bindings.jsonl',
        requester_calls_path=CELL/'requester-mesh-calls.jsonl',
        route_observations_path=CELL/'requester-mesh-route-observations.jsonl',
        route_sink_status_path=CELL/'requester-mesh-route-sink-status.json',
        route_runtime_pins_path=CELL/'requester-mesh-route-runtime-pins.json',
        cohort_manifest=m,cohort_sha=sha(manifest_path.read_bytes()),
        identity_path=derived,candidate_sha=m['candidateManifestSha256'],
        expected=m['remoteMeshTtsReceiver'])
    complete=OP/'completed-receiver-warmup-proof.json';write(complete,proof)
    os.link(complete,CELL/'campaign/receiver-warmup-proof.json')
    receipt={'at':now().isoformat(),'status':'15_ORDINARY_P2P_WARMUPS_NATIVE_RECEIVER_AND_ROUTE_PROOF_PUBLISHED',
             'proofSha256':sha(complete.read_bytes()),'providerWarmupCalls':len(proof['calls']),
             'excludedWarmups':selection['attempted'],'correctExcludedWarmups':15,'failedExcludedWarmups':selection['failed'],'warmupP95MsType7':p95,'measured191ForecastSecondsWith20PercentPlus300':forecast,
             'fixedConditionCapSeconds':15000,'requesterRemainingSeconds':requester_remaining,
             'providerRemainingSeconds':provider_remaining,'sutCallsByFinalizer':0,
             'remainingAdmission':'Frozen runner independently checks localSTT/LLM native spans and this exact-peer receiver proof before measured1'}
    write(OP/'warmup-finalizer-result.json',receipt);write(DEST/'ORDINARY-WARMUP-ADMISSION.json',receipt)
    print(json.dumps(receipt),flush=True)


if __name__=='__main__':
    try:main()
    except Exception as exc:
        receipt={'at':now().isoformat(),'errorCategory':type(exc).__name__,'error':str(exc),
                 'automaticRetry':False,'preserveSameAttemptAndAcceptedControl':True}
        write(OP/'warmup-finalizer-failure.json',receipt)
        print(json.dumps(receipt),flush=True)
        raise SystemExit(1)from None

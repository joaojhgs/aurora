"""Assemble saved native proof once after15 warmups; never launch/retry inference."""
from pathlib import Path
from datetime import datetime, timezone
import base64
import ast
import hashlib
import json
import os
import runpy
import shlex
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
H=ROOT/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k1-orca-relayed-http-launch-v2220'
CELL=H/'distributed-k1-orca-relayed-http-cell-v2220'
STAGE=H/'distributed-k1-http-requester-v2220'
DEST=ROOT/'thesis/campaigns/worker-desktop-k1-orca-relayed-http-first300-v2220'


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    raw=(json.dumps(value,indent=2)+'\n').encode();tmp=path.with_name(path.name+'.partial')
    with tmp.open('xb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    assert not path.exists();os.replace(tmp,path)


def q95(values):
    values=sorted(values);index=(len(values)-1)*.95;lo=int(index)
    return values[lo]+(values[min(lo+1,len(values)-1)]-values[lo])*(index-lo)


def main():
    os.umask(0o077)
    manifest=json.loads((OP/'condition-frozen-v2220.json').read_bytes())
    intent=OP/'proof-collection-request.json'
    assert not intent.exists() and not (OP/'warmup-finalizer-result.json').exists()
    limit=time.monotonic()+3600;attempts=CELL/'campaign/attempts';rows=[]
    while time.monotonic()<limit:
        if (CELL/'campaign/summary.json').exists():
            raise RuntimeError('requester_terminal_before_native_proof; preserve same attempt')
        launch=json.loads((OP/'requester-launch.json').read_bytes())
        stat=Path('/proc',str(launch['controllerPid']),'stat')
        if not stat.exists():
            raise RuntimeError('same requester controller retired before proof; do not restart')
        fields=stat.read_text().rsplit(')',1)[1].split()
        assert int(fields[19])==launch['controllerStartTicks'] and fields[0]not in ['Z','X','x']
        paths=[attempts/f'attempt-{n:04d}-warmup.jsonl' for n in range(1,16)]
        rows=[json.loads(p.read_bytes()) for p in paths if p.is_file()]
        if any(v['status']!='completed_correct' for v in rows):
            raise RuntimeError('strict_warmup_failure_no_retry')
        if len(rows)==15:break
        time.sleep(5)
    assert len(rows)==15, 'finite warmup observation bound; no relaunch'
    ready=json.loads((OP/'provider-admission.json').read_bytes())
    receiver=ready['receiver'];provider=ready['manifest']['output']
    marker='AURORA_K1_HTTP_NATIVE_V2220';name='k1-http-native-warmups-v2220'
    code=f'''from pathlib import Path
import base64,hashlib,json,socket,os
s=Path({provider!r});assert socket.gethostname()=='personal.skyron-server'
f=Path('/proc',{str(receiver['pid'])!r},'stat').read_text().rsplit(')',1)[1].split();assert int(f[19])=={receiver['startTicks']} and f[0]not in ['Z','X','x']
mr=(s/'provider-manifest.json').read_bytes();assert hashlib.sha256(mr).hexdigest()=={ready['manifestSha256']!r}
m=json.loads(mr);cfg=Path(m['config']).read_bytes();assert hashlib.sha256(cfg).hexdigest()=={ready['configSha256']!r}
identity=json.loads((s/'receiver-identity.json').read_bytes());assert identity['receiver_pid']=={receiver['pid']} and identity['provider']=={manifest['remoteTtsReceiver']!r}
files={{}}
for name,cap in [('voice-stages.jsonl',8*1024**2),('actual-provider-bindings.jsonl',8*1024**2),('receiver-identity.json',65536)]:
 p=s/name;assert p.is_file()and not p.is_symlink()and p.stat().st_size<cap
 raw=p.read_bytes()
 if name.endswith('.jsonl'):raw=raw[:raw.rfind(bytes([10]))+1]
 files[name]={{'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode()}}
v={{'host':socket.gethostname(),'status':'same_new_receiver_native15_prefixes','receiverPid':{receiver['pid']},'receiverStartTicks':{receiver['startTicks']},'files':files,'sutCalls':0}}
out=base64.b64encode(json.dumps(v,separators=(',',':')).encode()).decode();parts=[out[i:i+800]for i in range(0,len(out),800)]
for i,x in enumerate(parts):print({marker!r}+' '+json.dumps({{'seq':i,'total':len(parts),'data':x}}),flush=True)
'''
    ast.parse(code)
    command=OP/'native15-collection.command.txt'
    with command.open('x') as stream:stream.write('python3 -c '+shlex.quote(code)+'\n')
    write(intent,{'at':datetime.now(timezone.utc).isoformat(),'name':name,'sendLimit':1,
                  'receiver':receiver,'newSutCalls':0,'onObservationFailure':'reconcile this accepted command; never resend or repeat warmups'})
    with (OP/'proof-collection.private.log').open('xb') as log:
        cp=subprocess.run([sys.executable,str(ROOT/'thesis/harness/orca_copy_control_raw_read_v1652.py'),name,str(command),marker],
                          stdout=log,stderr=subprocess.STDOUT,timeout=175)
    assert cp.returncode==0, 'same accepted collection needs reconciliation, not resend'
    packet=json.loads((H/(name+'-RESULT.json')).read_bytes())
    assert shutil.disk_usage(ROOT).free-2*sum(v['bytes'] for v in packet['files'].values())>2*1024**3
    saved=OP/'receiver-warmup-custody';saved.mkdir()
    physical=DEST/'provider-warmup-source';physical.mkdir(parents=True,exist_ok=False)
    records=[]
    for name,item in packet['files'].items():
        assert name in ['voice-stages.jsonl','actual-provider-bindings.jsonl','receiver-identity.json']
        raw=base64.b64decode(item['data'],validate=True)
        assert len(raw)==item['bytes'] and hashlib.sha256(raw).hexdigest()==item['sha256']
        for directory in [saved,physical]:
            with (directory/name).open('xb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
        records.append({'path':str((physical/name).relative_to(ROOT)),'bytes':len(raw),'sha256':item['sha256']})
    sys.path.insert(0,str(STAGE))
    proof=runpy.run_path(str(STAGE/'receiver_proof.py'))['build_proof'](
        attempts_dir=attempts,stage_path=saved/'voice-stages.jsonl',bindings_path=saved/'actual-provider-bindings.jsonl',
        identity_path=saved/'receiver-identity.json',candidate_sha=manifest['candidateManifestSha256'],expected=manifest['remoteTtsReceiver'])
    now=datetime.now(timezone.utc)
    control=json.loads((CELL/'control-launch.json').read_bytes())
    controller_age=(now-datetime.fromisoformat(control['started_at'])).total_seconds()
    root_age=(now-datetime.fromisoformat(manifest['prospectiveSessionAllocation']['startedAtUtc'])).total_seconds()
    observed=q95([v['flow_duration_ms'] for v in rows])/1000
    reference=max(observed,60.3053512957)
    forecast=300*reference*1.2+300+180
    windows={
        'conditionConservativeRemainingSeconds':24000-controller_age,
        'providerRemainingMinus180Seconds':(datetime.fromisoformat(manifest['providerDeadlineUtc'])-now).total_seconds()-180,
        'rootRemainingMinus2400Seconds':(datetime.fromisoformat(manifest['prospectiveSessionAllocation']['absoluteDeadlineUtc'])-now).total_seconds()-2400,
        'conditionAccountingRemainingMinus180Seconds':72000-10027.780472366-root_age-180}
    result={'at':now.isoformat(),'status':'REMOTE_NATIVE_AND_CAPACITY_PROOF_READY_LOCAL_RUNNER_GATE_STILL_ENFORCED',
            'warmups':15,'correct':15,'failed':0,'newMeasuredObserved':0,
            'observedWarmupP95Ms':observed*1000,'estimator':'Hyndman-Fan Type7',
            'forecastReferenceSeconds':reference,'remaining300ForecastSeconds':forecast,
            'availableWindows':windows,'capacityAdmitted':forecast<min(windows.values()),
            'receiver':receiver,'physicalSourceCopies':records,
            'localGate':'Requester runner independently enforces actual local STT/LLM binding/native proof before first181',
            'newInferenceByFinalizer':0,'sameRemoteOperationSendCount':1}
    write(OP/'warmup-finalizer-result.json',result)
    write(physical/'CUSTODY.json',result)
    assert result['capacityAdmitted'], 'actual warmups do not admit remaining300; preserve and stop, never lower bound silently'
    write(CELL/'campaign/receiver-warmup-proof.json',proof)
    print(json.dumps(result),flush=True)


if __name__=='__main__':
    main()

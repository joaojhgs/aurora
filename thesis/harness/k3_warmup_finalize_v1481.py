"""Root's finite saved-data K3 warmup admission; never generates model requests."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zlib

R=Path(__file__).resolve().parents[2]
H=R/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k3-orca-relayed-launch-v1481'
CELL=H/'distributed-k3-orca-relayed-http-cell-v1481'
STAGE=H/'distributed-k3-requester-prep-v1413'
DEST=R/'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481'
NAME='v1481-k3-ordinary-warmup-proof'
MARKER='AURORA_K3_PROOF_V1481 '
CLI='/home/developer/.orca-relay/bin/orca'
TERM='term_d5651d8d-58e2-4b38-85e2-51c668cc933c'


def now():return datetime.now(timezone.utc)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,v):
    with p.open('x') as f:
        json.dump(v,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())


def collect_same_result():
    # Recover only terminal output for the ONE accepted command; never resubmit.
    parts={};total=None;cursor=0
    for p in H.glob(NAME+'-READ-*.json'):
        if p.name.endswith('-READ-BEFORE.json'):
            continue  # Baseline tail may contain historical errors; only inspect output after this accepted command.
        data=json.loads(p.read_text())['result']['terminal']
        cursor=max(cursor,int(data.get('nextCursor',0)))
        for line in data.get('tail',[]):
            assert 'Traceback (most recent call last):' not in line, 'Returned collector traceback; inspect same saved data immediately, no resend'
            if line.startswith(MARKER):
                v=json.loads(line[len(MARKER):]);assert v['seq'] not in parts or parts[v['seq']]==v['data'];parts[v['seq']]=v['data'];total=v['total']
    end=time.monotonic()+90;index=0
    while total is None or len(parts)!=total:
        assert time.monotonic()<end,'Same accepted proof result not yet fully observed; preserve command/stream, no resend'
        p=subprocess.run([CLI,'terminal','read','--terminal',TERM,'--cursor',str(cursor),'--limit','2000','--json'],capture_output=True,text=True,timeout=35)
        data=json.loads(p.stdout[p.stdout.index('{'):]);assert p.returncode==0 and data.get('ok')
        write(H/f'{NAME}-READ-RECOVERY-{index}.json',data);index+=1
        t=data['result']['terminal'];cursor=int(t['nextCursor'])
        for line in t.get('tail',[]):
            assert 'Traceback (most recent call last):' not in line, 'Returned collector traceback; inspect same saved data immediately, no resend'
            if line.startswith(MARKER):
                v=json.loads(line[len(MARKER):]);assert v['seq'] not in parts or parts[v['seq']]==v['data'];parts[v['seq']]=v['data'];total=v['total']
        if total is None or len(parts)!=total:time.sleep(.5)
    raw=base64.b64decode(''.join(parts[i] for i in range(total)));result=json.loads(raw)
    path=H/(NAME+'-RESULT.json')
    if path.exists():assert path.read_bytes()==raw
    else:path.write_bytes(raw)
    return result,cursor


def finalize():
    launch=json.loads((OP/'requester-launch.json').read_text());m=json.loads((OP/'condition-frozen-v1481.json').read_text())
    end=time.monotonic()+3600
    while True:
        assert time.monotonic()<end,'Finite ordinary-warmup observation deadline; no retry'
        rows=[]
        for n in range(1,16):
            p=CELL/f'campaign/attempts/attempt-{n:04d}-warmup.jsonl'
            if not p.exists():break
            row=json.loads(p.read_text());assert row['status']=='completed_correct','Preserve failed warmup; no automatic retry'
            rows.append(row)
        fields=Path(f"/proc/{launch['controllerPid']}/stat").read_text().rsplit(')',1)[1].split();assert int(fields[19])==launch['controllerStartTicks'] and fields[0]!='Z'
        if len(rows)==15:break
        time.sleep(2)
    durations=sorted(float(v['flow_duration_ms']) for v in rows);h=14*.95;p95=durations[int(h)]+(durations[int(h)+1]-durations[int(h)])*(h-int(h));budget=p95/1000*900*1.2+300
    remaining=(datetime.fromisoformat(m['providerDeadlineUtc'])-now()).total_seconds();assert remaining>budget,'Fresh provider lifetime insufficient; no measured admission'
    payload={'attempts':rows,'manifest':m,'cohortSha256':sha(OP/'condition-frozen-v1481.json'),'proofSource':(STAGE/'receiver_proof.py').read_text()}
    encoded=base64.b64encode(zlib.compress(json.dumps(payload).encode())).decode();remote=(R/'thesis/harness/k3_remote_warmup_proof_v1481.py').read_text()
    command="python3 -c \"import base64;exec(base64.b64decode('"+base64.b64encode(remote.encode()).decode()+"'))\" "+encoded+'\n';commandpath=OP/'collect-ordinary-warmup-proof.command.txt';commandpath.write_text(command)
    write(OP/'proof-collection-request.json',{'at':now().isoformat(),'commandSha256':sha(commandpath),'warmups':15,'expectedNativeJoins':45,'modelRequestsByFinalizer':0,'sendCountPlanned':1})
    child=subprocess.run([sys.executable,str(R/'thesis/harness/orca_control_read_v1106.py'),NAME,str(commandpath),'AURORA_K3_PROOF_V1481'],capture_output=True,text=True,timeout=130)
    (OP/'proof-collection.private.log').write_text(child.stdout+'\nSTDERR\n'+child.stderr)
    # SEND receipt must prove the first command was accepted before stream recovery.
    sent=json.loads((H/(NAME+'-SEND.json')).read_text());assert sent['ok'] and sent['result']['send']['accepted']
    packet,cursor=collect_same_result()
    assert packet['status']=='K3_15_ORDINARY_WARMUPS_45_NATIVE_MODEL_JOINS_READY' and packet['actualOffloadedLayers']==25
    proof=packet['proof'];assert proof['cohort_manifest_sha256']==payload['cohortSha256'] and len(proof['calls'])==45
    write(DEST/'ORDINARY-WARMUP-RECEIVER-PACKET-v1481.json',packet)
    # Publish fully written proof atomically; no partial JSON visibility or overwrite.
    source=OP/'completed-native-warmup-proof.json';write(source,proof);target=CELL/'campaign/remote-warmup-proof.json';os.link(source,target)
    receipt={'at':now().isoformat(),'status':'K3_15_EXCLUDED_WARMUPS_45_NATIVE_JOINS_PROOF_PUBLISHED','proofSha256':sha(target),'calls':45,'ordinaryWarmupP95MsType7':p95,'warmupDurationsMs':durations,'forecastWith20PercentMarginPlus300Seconds':budget,'providerRemainingSecondsAtCheck':remaining,'providerDeadlineUtc':m['providerDeadlineUtc'],'providerReceiverPid':m['providerReceiver']['pid'],'actualSttDevice':'cpu','actualSttComputeType':'int8_float32','actualOffloadedLayers':25,'actualTotalLayers':25,'nativeProofHandlers':['stt.model_invoke','resolved_chat_model.astream','tts.model_invoke'],'modelCallsByFinalizer':0,'nextPersonalCursor':str(cursor),'measurementAdmission':'Unchanged reviewed runner must independently verify the published proof before measured1'}
    write(OP/'warmup-finalizer-result.json',receipt);write(DEST/'ORDINARY-WARMUP-ADMISSION-v1481.json',receipt);print(json.dumps(receipt),flush=True)


if __name__=='__main__':
    os.umask(0o077)
    try:finalize()
    except Exception as e:
        failure={'at':now().isoformat(),'errorType':type(e).__name__,'error':str(e),'automaticRetry':False,'sameAttemptMustBePreserved':True}
        p=OP/'warmup-finalizer-failure.json'
        if not p.exists():write(p,failure)
        print(json.dumps(failure),flush=True);raise

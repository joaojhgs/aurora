"""Serial Root-owned SUT control, independent of agent-model availability.

One prepare, one provider launch, then one requester launch. No inference retry,
worker/session creation, clock reset, or lifecycle adoption is performed.
"""
from pathlib import Path
from datetime import datetime, timezone
import ast
import base64
import fcntl
import hashlib
import json
import os
import shlex
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
H=ROOT/'.git/aurora-handoff-import-20261006'
OP=H/'distributed-k1-orca-relayed-http-launch-v2220'
EVIDENCE=ROOT/'thesis/evidence/k1-http-remaining720-admission-v2204'
STATE=OP/'DRIVER-STATE.json'
PYTHON=H/'cpu-audio-campaign-v491/env/bin/python'
HELPER=ROOT/'thesis/harness/orca_copy_control_raw_read_v1652.py'
START=time.monotonic()
state={}


def save(phase,**extra):
    state.update(at=datetime.now(timezone.utc).isoformat(),phase=phase,**extra)
    raw=(json.dumps(state,indent=2)+'\n').encode();temporary=STATE.with_name('DRIVER-STATE.partial')
    with temporary.open('wb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,STATE)
    print(json.dumps({'at':state['at'],'phase':phase,**extra}),flush=True)


def notify(subject,body):
    name='http300-driver-'+str(time.time_ns())
    cp=subprocess.run([sys.executable,'/tmp/aurora-orca-bounded-v43.py',name,'orchestration','send',
        '--to','dispatch:ctx_37b4d0a3c14f','--run','run_e6054e76e9fc',
        '--from','term_6a00d9ee-792a-4daf-8578-236290e33108','--subject',subject,
        '--body',body,'--type','status','--json'],capture_output=True,text=True,timeout=45)
    (OP/(name+'.receipt')).write_text(cp.stdout+'\n'+cp.stderr)


def remote(name,marker,code):
    assert time.monotonic()-START<600
    ast.parse(code)
    command=OP/(name+'.command.txt')
    with command.open('x') as stream:stream.write('python3 -c '+shlex.quote(code)+'\n')
    intent=OP/(name+'.INTENT.json')
    with intent.open('x') as stream:json.dump({'at':datetime.now(timezone.utc).isoformat(),'maximumSends':1,'onObservationFailure':'reconcile same accepted command, never retry'},stream)
    save('REMOTE_OPERATION_SENT_ONCE',operation=name,marker=marker)
    with (OP/(name+'.log')).open('xb') as stream:
        cp=subprocess.run([str(PYTHON),str(HELPER),name,str(command),marker],stdout=stream,stderr=subprocess.STDOUT,timeout=195)
    assert cp.returncode==0, 'Accepted operation needs same-output reconciliation; no resend'
    value=json.loads((H/(name+'-RESULT.json')).read_bytes())
    with (OP/(name+'.RESULT.json')).open('x') as stream:json.dump(value,stream,indent=2);stream.write('\n')
    return value


def framed(code,expression,marker,guard=''):
    return code+'''\nimport base64,traceback
try:
'''+guard+' value='+expression+'''
except Exception as error:
 value={"status":"SAME_OPERATION_REQUIRES_RECONCILIATION","errorCategory":type(error).__name__,"automaticRetry":False,"location":[{"function":v.name,"line":v.lineno}for v in traceback.extract_tb(error.__traceback__)[-4:]]}
out=base64.b64encode(json.dumps(value).encode()).decode();parts=[out[i:i+800]for i in range(0,len(out),800)]
for i,s in enumerate(parts):print('''+repr(marker)+'''+' '+json.dumps({'seq':i,'total':len(parts),'data':s}),flush=True)
'''


def main():
    os.umask(0o077)
    assert not STATE.exists(), 'Existing driver must be reconciled, never duplicated'
    lock=(OP/'driver.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    allocation=json.loads((OP/'SESSION-ALLOCATION.json').read_bytes())
    now=datetime.now(timezone.utc);remaining=(datetime.fromisoformat(allocation['absoluteDeadlineUtc'])-now).total_seconds()
    forecast=(15+300)*60.3053512957*1.2+480
    assert remaining-2400>forecast+300, 'Current unchanged root clock does not admit this batch'
    assert hashlib.sha256((OP/'SESSION-ALLOCATION.json').read_bytes()).hexdigest()=='069d883c8ae6b029feb1c116f34625d6687f4c08a30ba569042ef18fdf8d62c1'
    stat=Path('/proc',str(os.getpid()),'stat').read_text().rsplit(')',1)[1].split()
    save('DRIVER_STARTED',driverPid=os.getpid(),driverStartTicks=int(stat[19]),
         rootDeadlineUtc=allocation['absoluteDeadlineUtc'],allocationNotReset=True,
         operationalNewMeasured=300,globalFirst=181,globalLast=480,remainingAfterActual300=420,
         newWarmups=0,newMeasured=0,newOrcaWorkers=0)
    prepare_source=(ROOT/'thesis/harness/prepare_k1_http_provider_v2220.py').read_text()
    guard=''' gpus=[]
 for p in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_total'):
  gpus.append({'device':str(p.parent),'totalBytes':int(p.read_text()),'usedBytes':int(p.with_name('mem_info_vram_used').read_text())})
 assert any(v['totalBytes']>=8000000000 and v['totalBytes']-v['usedBytes']>2*1024**3 for v in gpus),'gpu_resource_admission_not_met'
'''
    prepared=remote('k1-http-provider-prep-v2220','AURORA_K1_HTTP_PREP_V2220',
                    framed(prepare_source,'prepare('+repr(allocation)+')','AURORA_K1_HTTP_PREP_V2220',guard))
    assert prepared['status']=='K1_HTTP_PROVIDER_PREPARED_NOT_LAUNCHED', prepared.get('status')
    save('PROVIDER_PREPARED',providerManifestSha256=prepared['manifestSha256'])
    launch_source=(ROOT/'thesis/harness/launch_k1_http_provider_v2220.py').read_text()
    ready=remote('k1-http-provider-launch-v2220','AURORA_K1_HTTP_LAUNCH_V2220',
                 framed(launch_source,'launch('+repr(prepared['manifestSha256'])+')','AURORA_K1_HTTP_LAUNCH_V2220'))
    assert ready['status']=='K1_HTTP_PROVIDER_LIVE_METADATA_ADMITTED_NATIVE_WARMUPS_PENDING', ready.get('status')
    with (OP/'provider-admission.json').open('x') as stream:json.dump(ready,stream,indent=2);stream.write('\n')
    save('PROVIDER_READY',providerController=ready['controller'],providerReceiver=ready['receiver'],providerDeadlineUtc=ready['providerDeadlineUtc'])
    notify('HTTP first300 provider live; serial driver starting requester',
           'Same Root driver has actual new provider '+json.dumps(ready['receiver'])+' under original unchanged Root deadline '+allocation['absoluteDeadlineUtc']+'. Now launching exactly300 missing181-480 plus15excludedwarmups; no firstmeasurement claimed. STATE '+str(STATE.relative_to(ROOT))+'. No worker/model/credential/forward change; original monitor sole plan writer.')
    assert time.monotonic()-START<600
    with (OP/'root-launch.log').open('xb') as stream:
        cp=subprocess.run([str(PYTHON),str(ROOT/'thesis/harness/k1_http_partial300_root_v2220.py')],stdout=stream,stderr=subprocess.STDOUT,timeout=90)
    assert cp.returncode==0, 'Reconcile recorded requester launch once; do not retry'
    launch=json.loads((OP/'operator-launch.json').read_bytes())
    save('REQUESTER_CONTROLLER_STARTED_NATIVE_WARMUPS_PENDING',requester=launch['requester'],auxiliary=launch['auxiliary'])
    notify('HTTP first300 requester actually started; native warmups pending',
           'Actual Root-controlled launch '+json.dumps(launch)+'. First181 not yet verified; strict15nativewarmups/capacity proof are autonomous. Same original60000clock ends '+allocation['absoluteDeadlineUtc']+'.300only181-480,420remain afteractual300; no900replay or hidden clockreset. Persisted STATE '+str(STATE.relative_to(ROOT))+'. Please relay actual milestone to Coding through existing route; no new review/owner gate.')


if __name__=='__main__':
    try:
        main()
    except BaseException as error:
        import traceback
        save('STOPPED_RECONCILE_SAME_ATTEMPT',errorCategory=type(error).__name__,
             location=[{'file':Path(v.filename).name,'line':v.lineno,'function':v.name}for v in traceback.extract_tb(error.__traceback__)[-5:]],
             retry=False,clockReset=False)
        try:notify('HTTP serial driver stopped; same-attempt receipt preserved',json.dumps(state))
        except Exception:pass
        raise

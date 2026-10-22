"""Start one prepared finite K1 HTTP SUT; an observation timeout never retries it."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
import socket
import subprocess
import time

ROOT = Path('/home/developer/projects/aurora')
OUTPUT = ROOT / 'thesis/campaigns/worker-desktop-k1-http-provider-v2209/provider'
PRIVATE = ROOT / '.git/aurora-handoff-import-20261006/k1-http-provider-v2209'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def actor(pid):
    fields=Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()
    return {'pid':pid,'state':fields[0],'startTicks':int(fields[19])}


def write(path,value):
    with path.open('x') as stream:
        json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())


def launch(expected_manifest_sha):
    os.umask(0o077)
    assert socket.gethostname()=='personal.skyron-server'
    path=OUTPUT/'provider-manifest.json';assert sha(path)==expected_manifest_sha
    m=json.loads(path.read_bytes());controller=PRIVATE/'controller.py'
    assert sha(controller)==m['controllerSha256']=='6d8cc38e24bda0ff32546845880e68479fa945e2fdd4e2e6fa21fa9b593b6e5b'
    assert sha(m['config'])==m['configSha256']
    assert all(not Path('/proc',str(pid)).exists() for pid in [251472,251473])
    assert not (OUTPUT/'controller-launch.json').exists() and not (OUTPUT/'ROOT-LAUNCH-INTENT-v2210.json').exists()
    start=datetime.now(timezone.utc)
    assert start+timedelta(seconds=m['lifetimeSeconds']+225)<=datetime.fromisoformat(m['originalProviderAbsoluteDeadlineUtc'])
    write(OUTPUT/'ROOT-LAUNCH-INTENT-v2210.json',{'at':start.isoformat(),'manifestSha256':expected_manifest_sha,'maximumPopenCalls':1,'newOrcaWorker':False})
    with (PRIVATE/'controller.private.log').open('xb') as stream:
        child=subprocess.Popen([m['python'],str(controller),'--control',str(path)],cwd=PRIVATE,
                               stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT,start_new_session=True)
    identity=actor(child.pid)
    write(OUTPUT/'ROOT-LAUNCH-v2210.json',{'at':start.isoformat(),'controller':identity,'manifestSha256':expected_manifest_sha,'measuredRequests':0,'newOrcaWorker':False})
    limit=time.monotonic()+100;status={}
    while time.monotonic()<limit:
        assert actor(child.pid)['startTicks']==identity['startTicks']
        if (OUTPUT/'STATUS.json').exists():
            status=json.loads((OUTPUT/'STATUS.json').read_bytes())
            if status.get('phase') in ['normal_services_live','provider_failed']:break
        time.sleep(2)
    value={'at':datetime.now(timezone.utc).isoformat(),'host':socket.gethostname(),
           'status':'K1_HTTP_PROVIDER_LAUNCHED_READINESS_PENDING','phase':status.get('phase'),
           'manifestPath':str(path),'manifestSha256':expected_manifest_sha,'manifest':m,
           'controller':actor(child.pid),'providerDeadlineUtc':(start+timedelta(seconds=m['lifetimeSeconds'])).isoformat(),
           'providerMaximumAbsoluteDeadlineUtc':m['originalProviderAbsoluteDeadlineUtc'],
           'configSha256':sha(m['config']),'oldSutActorsAbsent':True,'newWorker':False,
           'warmupRequests':0,'measuredRequests':0,'nativeAdmission':'PENDING15actualfullflows'}
    if (OUTPUT/'controller-launch.json').exists():
        saved=json.loads((OUTPUT/'controller-launch.json').read_bytes());receiver=actor(saved['receiverPid'])
        assert receiver['startTicks']==saved['receiverStartTicks'];value['receiver']=receiver
    if status.get('phase')=='normal_services_live':
        assert status['sttMethodConstraints'] and status['ttsMethodConstraints']
        assert value['receiver']['state'] not in ['Z','X','x']
        value['status']='K1_HTTP_PROVIDER_LIVE_METADATA_ADMITTED_NATIVE_WARMUPS_PENDING'
    write(OUTPUT/'ROOT-ADMISSION-v2210.json',value)
    return value

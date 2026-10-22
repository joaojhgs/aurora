"""One finite next-condition lifecycle; default only reports the local barrier.

Only the original Root executes --launch after the HTTP condition's actual
seal/release. It creates no Orca worker, profile, credential, grant or forward.
"""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import zlib

from admission_boundary import predecessor_state, require_predecessor_release
from prepare_worker import OUTPUT, PRIVATE, ROOT, STAGE, prepare, sha, write_new

HANDOFF=ROOT/'.git/aurora-handoff-import-20261006'
HELPER=ROOT/'thesis/harness/orca_copy_control_compact_v2453.py'
OPERATION='c12p2p-provider-prepare-v2445'
MARKER='AURORA_C12P2P_PREPARE_V2445'


def remote_command(files, hashes, allocation, worker):
    payload={'files':files,'hashes':hashes,'allocation':allocation,'worker':worker}
    encoded=base64.b64encode(zlib.compress(json.dumps(payload).encode(),9)).decode()
    chunks='\n'.join(repr(encoded[i:i+600]) for i in range(0,len(encoded),600))
    source="""import base64,zlib,json,traceback,socket
assert socket.gethostname()=='personal.skyron-server'
encoded=(CHUNKS)
p=json.loads(zlib.decompress(base64.b64decode(encoded)))
ns={}
exec(compile(p['files']['provider_prepare.py'],'provider_prepare-v2445.py','exec'),ns)
try:r=ns['main'](p['files'],p['hashes'],p['allocation'],p['worker'])
except Exception as exc:
 r={'host':socket.gethostname(),'status':'PREPARATION_OR_LAUNCH_EXCEPTION_RECONCILE_NO_RETRY','exceptionType':type(exc).__name__,'locations':[{'file':x.filename,'line':x.lineno,'function':x.name} for x in traceback.extract_tb(exc.__traceback__)[-5:]]}
e=base64.b64encode(json.dumps(r).encode()).decode()
for i in range(0,len(e),600):print(MARKER+' '+json.dumps({'seq':i//600,'total':(len(e)+599)//600,'data':e[i:i+600]}),flush=True)
""".replace('CHUNKS',chunks).replace('print(MARKER+', 'print('+repr(MARKER)+'+')
    return 'python3 -c '+shlex.quote(source)+'\n'


def launch(allocation):
    require_predecessor_release()
    worker=prepare(allocation)
    worker['controlHelperSha256']=sha(HELPER)
    files={p.name:p.read_text() for p in STAGE.glob('*.py')}
    files['route_runtime_pins.json']=(STAGE/'route_runtime_pins.json').read_text()
    hashes={name:hashlib.sha256(source.encode()).hexdigest() for name,source in files.items()}
    for name,source in files.items():
        if name.endswith('.py'):compile(source,name,'exec')
        else:json.loads(source)
    write_new(OUTPUT/'SOURCE-FREEZE.json',{
        'at':datetime.now(timezone.utc).isoformat(),'sourceHashes':hashes,
        'controlHelperPath':str(HELPER),'controlHelperSha256':worker['controlHelperSha256'],
        'qualifiedModelAudioSettingsUnchanged':True,'newOrcaWorker':False,
        'workerHTTPSourceByteEquivalenceClaim':False,
    })
    command=HANDOFF/(OPERATION+'-command.txt')
    with command.open('x') as stream:
        stream.write(remote_command(files,hashes,allocation,worker))
        stream.flush();os.fsync(stream.fileno())
    write_new(OUTPUT/'ROOT-PROVIDER-LAUNCH-INTENT.json',{
        'at':datetime.now(timezone.utc).isoformat(),'maximumProviderPopen':1,
        'command':str(command),'commandSha256':sha(command),
        'existingTerminal':'term_d5651d8d-58e2-4b38-85e2-51c668cc933c',
        'existingIncarnation':'034ff933-61a3-4c74-b5ad-98a75e8ac21c',
        'newWorker':False,'acceptedInputMustBeReconciledBeforeRetry':True,
    })
    result=subprocess.run(
        [str(Path(os.sys.executable)),str(HELPER),OPERATION,str(command),MARKER],
        capture_output=True,timeout=110,
    )
    write_new(OUTPUT/'PROVIDER-LAUNCH-OBSERVATION.json',{
        'at':datetime.now(timezone.utc).isoformat(),'exitCode':result.returncode,
        'operation':OPERATION,'neverResendAmbiguousCommand':True,
    })
    result_path=HANDOFF/(OPERATION+'-RESULT.json')
    assert result.returncode==0 and result_path.exists(), 'Reconcile original accepted SEND/READ; never relaunch'
    actual=json.loads(result_path.read_bytes())
    os.link(result_path,OUTPUT/'PROVIDER-ACTUAL-LAUNCH.json')
    cli=OUTPUT/'control/cli-custody';cli.mkdir(parents=True)
    for p in HANDOFF.glob(OPERATION+'-*'):
        if p.is_file():os.link(p,cli/p.name)
    assert 'campaignManifestRawB64' in actual, 'Known provider preparation failure; preserve partial state'
    raw=base64.b64decode(actual['campaignManifestRawB64'],validate=True)
    assert hashlib.sha256(raw).hexdigest()==actual['campaignManifestSha256']
    manifest=json.loads(raw)
    assert manifest['conditionId']=='C12-P2P-K3-DLOCAL'
    assert manifest['sourceHashes']==hashes
    with (OUTPUT/'CAMPAIGN-MANIFEST.json').open('xb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    if not actual['localProducerArmed']:
        return {'status':'PROVIDER_STARTED_ARMING_NOT_PROVEN_RECONCILE_SAME_ACTOR','provider':{k:v for k,v in actual.items() if k!='campaignManifestRawB64'},'requesterStarted':False}
    # prepare() already made the required empty requester directory. Reuse the
    # qualified interpreter/environment and exactly this admitted task profile.
    env=os.environ.copy();env.update(worker['workerEffectiveEnvironment'])
    env.update(AURORA_CONFIG_FILE=worker['workerConfigPath'],AURORA_ENV_FILE=worker['workerExistingEnvFile'],
               AURORA_DATA_DIR=worker['workerExistingDataDir'],AURORA_BACKUP_DIR=str(PRIVATE/'backups'),
               PYTHONPATH=os.pathsep.join([str(STAGE),worker['workerSourceRoot']]),
               PYTHONDONTWRITEBYTECODE='1',HF_HUB_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
    write_new(OUTPUT/'ROOT-REQUESTER-PROCESS-LAUNCH-INTENT.json',{
        'at':datetime.now(timezone.utc).isoformat(),'maximumPopen':1,
        'python':worker['workerPython'],'controller':str(STAGE/'requester_controller.py'),
        'manifestSha256':actual['campaignManifestSha256'],'maximumPrimary':915,'maximumCompanion':915,
        'measuredAdmission':'PENDING_FRESH_ROUTE_AND_15_PAIRED_WARMUPS','newWorker':False,
    })
    with (PRIVATE/'backend.private.log').open('xb') as log:
        child=subprocess.Popen([worker['workerPython'],str(STAGE/'requester_controller.py'),'--execute','--manifest',str(OUTPUT/'CAMPAIGN-MANIFEST.json')],
                               cwd=PRIVATE,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    fields=Path('/proc',str(child.pid),'stat').read_text().rsplit(')',1)[1].split()
    receipt={
        'at':datetime.now(timezone.utc).isoformat(),'pid':child.pid,'startTicks':int(fields[19]),'state':fields[0],
        'providerController':actual['controller'],'providerReceiver':actual['runtime'],
        'manifestSha256':actual['campaignManifestSha256'],'maximumPrimary':915,'maximumCompanion':915,
        'newOrcaWorker':False,'modelWarmupOrMeasurementStartStillRequiresActualSavedProof':True,
    }
    write_new(OUTPUT/'ROOT-ACTUAL-LAUNCH.json',receipt)
    return receipt


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--launch',action='store_true')
    parser.add_argument('--allocation',type=Path)
    args=parser.parse_args();boundary=predecessor_state()
    if not args.launch or not boundary['predecessorReleased']:
        print(json.dumps({'status':'DEFERRED_NO_NEW_LIFECYCLE','boundary':boundary,'newActorsModelsNetwork':0},indent=2))
    else:
        assert args.allocation is not None
        print(json.dumps(launch(json.loads(args.allocation.read_bytes())),indent=2))

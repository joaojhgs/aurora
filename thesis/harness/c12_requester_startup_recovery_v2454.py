"""Recover a zero-call missing-directory startup, preserving frozen v2453 source."""
from pathlib import Path
import asyncio
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
import runpy
import sys
import traceback

ROOT = Path('/home/developer/projects/aurora')
OUTPUT = ROOT/'thesis/campaigns/c12-mixed-local-http-remaining640-v2453'
STAGE = ROOT/'thesis/harness/c12-mixed-local-http-remaining640-v2453'
SOURCE = ROOT/'thesis/sources/k1-speech-contract-compat-v2151/worker/source'


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n');stream.flush();os.fsync(stream.fileno())


def main():
    os.umask(0o077)
    prior=json.loads((OUTPUT/'ROOT-REQUESTER-INTENT.json').read_bytes())
    failure=json.loads((OUTPUT/'REQUESTER-EXCEPTION.json').read_bytes())
    assert prior['pid']==461044 and not Path('/proc/461044').exists()
    assert failure['exceptionType']=='FileNotFoundError'
    proof=json.loads((OUTPUT/'ZERO-MODEL-STARTUP-PROOF-v2454.json').read_bytes())
    assert proof['nativeModelStarts']==proof['remoteSttArrivals']==proof['localCaseDirectories']==0
    assert proof['controllerPresent'] and proof['receiverPresent'] and not proof['localProducerStopPresent']
    assert not (OUTPUT/'ROOT-STARTUP-RECOVERY-INTENT-v2454.json').exists()
    path=OUTPUT/'CAMPAIGN-MANIFEST.json';raw=path.read_bytes()
    assert hashlib.sha256(raw).hexdigest()=='3bfca19d2dd0a9eec3981eae256168a5badd9ac2bb58a270ff8a55df1d986cce'
    manifest=json.loads(raw)
    assert manifest['warmupPairs']==15 and manifest['measuredPairs']==640
    for name,digest in manifest['sourceHashes'].items():
        assert hashlib.sha256((STAGE/name).read_bytes()).hexdigest()==digest
    output=Path(manifest['requesterOutput'])
    assert not output.exists(), 'Directory state changed; reconcile instead of replay'
    assert not list(OUTPUT.glob('PAIR-*-INTENT.json'))
    lock=Path('/tmp/aurora-global-build.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    output.mkdir()
    sys.path[:0]=[str(STAGE),str(SOURCE)]
    credentials=runpy.run_path(str(ROOT/'thesis/harness/existing_worker_desktop_http_bearer_v2223.py'))
    auth=credentials['protected_read']()
    write(OUTPUT/'AUTHENTICATED-HEALTH-RECOVERY-v2454.json',auth)
    assert auth.get('httpStatus')==200
    os.environ['AURORA_HOSTED_PEER_GATEWAY_API_KEY']=credentials['existing_bearer']()
    manifest['campaignManifestSha256']=hashlib.sha256(raw).hexdigest()
    manifest['output']=manifest['requesterOutput']
    manifest['audioPath']=manifest['requesterAudioPath']
    fields=Path('/proc',str(os.getpid()),'stat').read_text().rsplit(')',1)[1].split()
    write(OUTPUT/'ROOT-STARTUP-RECOVERY-INTENT-v2454.json',{
        'at':datetime.now(timezone.utc).isoformat(),'pid':os.getpid(),'startTicks':int(fields[19]),
        'manifestSha256':manifest['campaignManifestSha256'],'frozenSourceUnmodified':True,
        'oldStartupZeroCallsProved':True,'maximumNewPrimary':655,'maximumNewCompanion':655,
        'globalMeasuredIndices':[261,900],'modelsReplayed':0,'newWorker':False,
        'fix':'Create the required empty requester output directory before original execute()',
        'wrapperSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    })
    namespace=runpy.run_path(str(STAGE/'requester_controller.py'),run_name='c12_frozen_requester_v2453')
    return asyncio.run(namespace['execute'](manifest))


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        write(OUTPUT/'REQUESTER-RECOVERY-EXCEPTION-v2454.json',{
            'at':datetime.now(timezone.utc).isoformat(),'exceptionType':type(exc).__name__,
            'locations':[{'file':Path(f.filename).name,'line':f.lineno,'function':f.name} for f in traceback.extract_tb(exc.__traceback__)[-8:]],
            'modelQualityInference':False,'reconcileBeforeNewInference':True,
        })
        raise SystemExit(1) from None

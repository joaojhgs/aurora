"""Prepare existing task references only after the entire HTTP condition releases.

Import/default inspection starts no runtime and allocates no clock or campaign.
Private configuration, credentials, data stores and weights are referenced,
never copied. The caller supplies a freshly frozen finite allocation.
"""
from __future__ import annotations

from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import tarfile

from admission_boundary import predecessor_state, require_predecessor_release
from config_semantics import _active_config_semantics

ROOT = Path('/home/developer/projects/aurora')
STAGE = Path(__file__).resolve().parent
OUTPUT = ROOT/'thesis/campaigns/c12-p2p-k3-dlocal-v2445'
PRIVATE = ROOT/'.git/aurora-handoff-import-20261006/c12-p2p-k3-dlocal-v2445/worker'
QUALIFIED = ROOT/'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043/condition-frozen.json'
QUALIFIED_SHA = 'ac92f9ba1455c3778e378c6548f0e518fcf0115c6ea9ebf7624f8c30df14d2c5'
PREVIOUS = ROOT/'thesis/campaigns/c12-mixed-local-http-remaining640-v2453'
FLOOR = 2*1024**3
ENV_ALLOWLIST = {
    'AURORA_STT_WHISPER_DOWNLOAD_ROOT', 'LD_LIBRARY_PATH', 'MKL_NUM_THREADS',
    'NLTK_DATA', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS',
}


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            digest.update(block)
    return digest.hexdigest()


def write_new(path, value):
    raw=(json.dumps(value,sort_keys=True,indent=2)+'\n').encode()
    temporary=path.with_name('.'+path.name+'.partial')
    assert not path.exists()
    with temporary.open('xb') as stream:
        stream.write(raw);stream.flush();os.fsync(stream.fileno())
    assert not path.exists()
    os.replace(temporary,path)


def validate_allocation(allocation):
    assert allocation['conditionId']=='C12-P2P-K3-DLOCAL'
    assert allocation['measuredPrimaryTarget']==allocation['measuredCompanionTarget']==900
    assert allocation['warmupPairsExcluded']==15
    assert allocation['maximumPrimaryFlowCalls']==allocation['maximumCompanionFlowCalls']==915
    assert allocation['diskFreeFloorBytes']==FLOOR
    assert type(allocation['workerRawBudgetBytes']) is int and allocation['workerRawBudgetBytes']>0
    keys=('startedAtUtc','setupDeadlineUtc','collectionDeadlineUtc','producerDeadlineUtc','providerDeadlineUtc','absoluteDeadlineUtc')
    clocks=[datetime.fromisoformat(allocation[k]) for k in keys]
    assert all(x.tzinfo is not None for x in clocks)
    assert all(a<b for a,b in zip(clocks,clocks[1:]))
    assert 0 <= (datetime.now(timezone.utc)-clocks[0]).total_seconds() <= 300
    assert allocation['requestCapSeconds']==180 and allocation['pairCapSeconds']==600
    assert allocation['rootRun']=='run_e6054e76e9fc'
    assert allocation['rootNativeGoalThread']=='01a112a5-d6bb-74e2-bf7c-ace73cb513b5'


def existing_inputs():
    assert sha(QUALIFIED)==QUALIFIED_SHA
    qualified=json.loads(QUALIFIED.read_bytes())
    frozen=Path(qualified['immutableRuntimeConfigInput']['path'])
    assert sha(frozen)==qualified['immutableRuntimeConfigInput']['sha256']
    # The historical frozen input stays immutable. Reuse its existing mutable
    # runtime counterpart, which already contains the same task's credentials.
    config=frozen.with_name('runtime-config.json')
    before=json.loads(frozen.read_bytes());current=json.loads(config.read_bytes())
    assert _active_config_semantics(before)==_active_config_semantics(current)
    for section in ('auth',):
        assert before['services'][section]==current['services'][section]
    for section, key in (('api','token_secret'),('webrtc','password')):
        assert before['services']['gateway'][section][key]==current['services']['gateway'][section][key]
    profile=Path(qualified['existingAuthorizedTaskProfile']['path'])
    assert profile==ROOT/'.git/aurora-handoff-import-20261006/mesh-pair-control-v1535/worker-node-v1538'
    assert profile.is_dir() and (profile/'data').is_dir() and (profile/'.env').is_file()
    source=Path(qualified['sourceClosure']['cpuSourceRoot'])
    inventory=ROOT/'.git/aurora-handoff-import-20261006/distributed-k3-mesh-requester-v2043/source-inventory.json'
    assert sha(inventory)==qualified['sourceClosure']['cpuSourceInventorySha256']
    for item in json.loads(inventory.read_bytes()):
        relative=Path(item['path'])
        assert not relative.is_absolute() and '..' not in relative.parts
        path=source/relative
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size==item['bytes'] and sha(path)==item['sha256']
    python=Path(qualified['runtime']['venvExecutable'])
    assert python.is_file() and sha(python.resolve())==qualified['runtime']['resolvedInterpreterSha256']
    environment=qualified['effectiveEnvironment']
    assert set(environment)<=ENV_ALLOWLIST
    audio=ROOT/'thesis/harness/distributed-k3-http-remaining-v1682/candidate-input.wav'
    assert sha(audio)==qualified['audio']['wavSha256'] and audio.stat().st_size==qualified['audio']['wavBytes']
    return {
        'workerPython':str(python),'workerRuntimeIdentity':qualified['runtime'],
        'workerSourceRoot':str(source),
        'workerSourceInventory':str(inventory),'workerSourceInventorySha256':sha(inventory),
        'workerConfigPath':str(config),'workerConfigSha256':sha(config),
        'historicalFrozenConfigPath':str(frozen),'historicalFrozenConfigSha256':sha(frozen),
        'effectiveConfigSemanticsMatchQualified':True,
        'workerExistingEnvFile':str(profile/'.env'),'workerExistingDataDir':str(profile/'data'),
        'workerEffectiveEnvironment':environment,
        'expectedLocalPeerId':qualified['existingAuthorizedTaskProfile']['expectedLocalPeerId'],
        'expectedDesktopPeerIdSha256':qualified['meshSttPeerIdSha256'],
        'requesterAudioPath':str(audio),'audioSha256':sha(audio),
        'qualifiedManifest':str(QUALIFIED),'qualifiedManifestSha256':QUALIFIED_SHA,
        'credentialOrConfigCopies':0,'profileOrIdentityCreated':False,
    }


def previous_provider():
    custody=json.loads((PREVIOUS/'terminal-v2455/CUSTODY.json').read_bytes())
    archive=Path(custody['archive'])
    assert sha(archive)==custody['seal']['sha256']
    with tarfile.open(archive) as tar:
        raw=tar.extractfile('provider-manifest.json').read()
    campaign=json.loads((PREVIOUS/'CAMPAIGN-MANIFEST.json').read_bytes())
    assert hashlib.sha256(raw).hexdigest()==campaign['providerManifestSha256']
    return json.loads(raw)


def prepare(allocation):
    require_predecessor_release()
    assert not Path('/proc/462924').exists()
    assert __import__('socket').gethostname()=='code-worker'
    validate_allocation(allocation)
    lock=Path('/tmp/aurora-global-build.lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    assert not OUTPUT.exists() and not PRIVATE.exists(), 'Existing preparation requires reconciliation'
    assert shutil.disk_usage(ROOT).free>FLOOR+allocation["workerRawBudgetBytes"], "insufficient_condition_sized_storage_above_preserved_floor"
    inputs=existing_inputs();provider=previous_provider()
    assert inputs['expectedDesktopPeerIdSha256']==hashlib.sha256(provider['expectedStablePeerId'].encode()).hexdigest()
    assert inputs['expectedLocalPeerId']==provider['expectedRequesterPeerId']
    inputs['admittedPeers']={name:{'peer_id':provider['expectedStablePeerId'],'sha256':inputs['expectedDesktopPeerIdSha256']} for name in ('stt','assistant','tts')}
    inputs.update(workerPrivateRoot=str(PRIVATE),requesterOutput=str(OUTPUT/'requester'))
    OUTPUT.mkdir(parents=True)
    (OUTPUT/'requester').mkdir()
    PRIVATE.mkdir(parents=True,mode=0o700)
    (PRIVATE/'backups').mkdir(mode=0o700)
    write_new(OUTPUT/'RESOURCE-ALLOCATION.json',allocation)
    write_new(OUTPUT/'WORKER-PREPARATION.json',{
        'at':datetime.now(timezone.utc).isoformat(),**inputs,
        'runtimeStarted':False,'newModelCalls':0,'newOrcaWorker':False,
        'predecessorBoundary':predecessor_state(),
    })
    return inputs


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare',action='store_true')
    parser.add_argument('--allocation',type=Path)
    args=parser.parse_args();state=predecessor_state()
    if not args.prepare or not state['predecessorReleased']:
        print(json.dumps({'status':'DEFERRED_NO_NEW_LIFECYCLE','boundary':state,'runtimeOrInference':0},indent=2))
    else:
        assert args.allocation is not None
        print(json.dumps(prepare(json.loads(args.allocation.read_bytes())),indent=2))

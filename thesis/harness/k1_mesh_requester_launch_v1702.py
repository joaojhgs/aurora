"""Freeze and launch Root's first actual K1 P2P audio condition once."""
from pathlib import Path
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys

R=Path(__file__).resolve().parents[2]
H=R/'.git/aurora-handoff-import-20261006'
STAGE=H/'distributed-k1-mesh-requester-v1702'
OP=H/'distributed-k1-mesh-launch-v1702'
CELL=H/'distributed-k1-mesh-cell-v1702'
DEST=R/'thesis/campaigns/worker-desktop-k1-p2p-tts-v1702'


def sha(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda:f.read(1048576),b''):h.update(b)
    return h.hexdigest()


def write(p,j):
    with Path(p).open('x') as f:
        json.dump(j,f,indent=2,sort_keys=True);f.write('\n');f.flush();os.fsync(f.fileno())


def main():
    os.umask(0o077)
    assert socket.gethostname()=='code-worker'
    assert not OP.exists() and not CELL.exists() and not STAGE.exists()
    ready=json.loads((R/'thesis/campaigns/worker-desktop-k1-p2p-tts-v1696/PROVIDER-READMISSION-v1703.json').read_bytes())
    provider=ready['files']['provider-manifest.json']
    status=ready['files']['STATUS.json']
    assert status['phase']=='normal_services_live' and status['mesh']['local']['mesh_started']
    assert status['catalogue']['local_peer_id']==provider['expectedStablePeerId']
    assert any(a['topic']=='TTS.Synthesize' and a['bindability']=='model-bindable' and not a['route_blockers']
               for a in status['catalogue']['actions'])
    assert all(a['present'] and a['state'] not in ['Z','X','x']for a in ready['actors'])
    assert (datetime.now(timezone.utc)-datetime.fromisoformat(ready['at'])).total_seconds()<600
    for pid in [2202799,2202983,2202800,2202801,2180819]:
        assert not Path('/proc',str(pid)).exists()
    profile=H/'mesh-pair-control-v1535/worker-node-v1538'
    prior=json.loads((profile/'STATUS.json').read_bytes())
    assert prior['ownRuntimeRetired']
    assert any(p['peerId']==provider['expectedStablePeerId'] and p['inboundStatus']=='approved'
               and p['outboundStatus']=='approved' and 'TTS.Synthesize'in p['outboundPermissions']for p in prior['trust'])
    baseline=json.loads((H/'distributed-k1-orca-relayed-launch-v1197/condition-frozen-v1197.json').read_bytes())
    config=json.loads((H/'distributed-k1-orca-relayed-launch-v1197/runtime-config.json').read_bytes())
    paired=json.loads((profile/'config.json').read_bytes())
    for key in ['webrtc','signaling_mqtt','mesh_network']:
        config['services']['gateway'][key]=paired['services']['gateway'][key]
    config['services']['gateway']['enabled']=True
    config['services']['gateway']['api']['token_secret']=paired['services']['gateway']['api']['token_secret']
    config['services']['auth']['default_pairing_permissions']=[]
    config['services']['auth']['mesh_peer_orphan_pruning_enabled']=False
    assert not config['ui']['assistant']['automatic_tts_readback']
    # Validate the complete qualified config before starting a runtime process.
    source=Path(baseline['sourceClosure']['cpuSourceRoot'])
    sys.path.insert(0,str(source))
    from app.helpers.aurora_logger import logger as aurora_logger
    aurora_logger.logger.addFilter(lambda record:False)
    from app.services.config.config_manager import ConfigManager
    validator=ConfigManager.__new__(ConfigManager)
    validator._schema=json.loads((source/'app/services/config/config_schema.json').read_bytes())
    validator._normalize_config(config)
    assert shutil.disk_usage(R).free>2*1024**3
    assert next(int(l.split()[1])*1024 for l in Path('/proc/meminfo').read_text().splitlines()
                if l.startswith('MemAvailable:'))>2_500_000_000
    shutil.copytree(R/'thesis/harness/distributed-k1-mesh-v1702/requester',STAGE)
    OP.mkdir(mode=0o700);DEST.mkdir(parents=True,exist_ok=True)
    write(OP/'runtime-config.json',config)
    shutil.copyfile(OP/'runtime-config.json',OP/'runtime-config.frozen.json')
    m=json.loads((STAGE/'freeze-template.json').read_bytes())
    fields={'controllerSha256':'controller.py','runnerSha256':'runner.py','adapterSha256':'tts_mesh_adapter.py',
            'receiverProofSha256':'receiver_proof.py','bootstrapSha256':'bootstrap.py','bindingsSha256':'bindings.py',
            'observerSha256':'observer.py','telemetrySha256':'aurora_voice_telemetry_v430.py',
            'resourceSamplerSha256':'resource_sample.py','routeObserverSha256':'mesh_route_observer.py',
            'routeSinkSha256':'route_observation_sink.py','routeRuntimePinsSha256':'route_runtime_pins.json'}
    m['implementation']={k:sha(STAGE/v)for k,v in fields.items()}
    for k in ['models','runtime','runtimeVersions','sourceClosure','effectiveSetup','workerHardware','effectiveEnvironment','canonicalModelFiles']:
        m[k]=baseline[k]
    inventory=H/'distributed-k1-requester-prep-v843/source-inventory.json'
    assert sha(inventory)==m['sourceClosure']['cpuSourceInventorySha256']
    peer=provider['expectedStablePeerId']
    m.update(cohortId='aurora-worker-desktop-k1-actual-p2p-tts-v1702',freezeAt=datetime.now(timezone.utc).isoformat(),
             status='FROZEN_REAL_CATALOGUE_EXACT_PEER_AND_15_NATIVE_WARMUPS_PENDING',
             meshTtsPeerIdSha256=hashlib.sha256(peer.encode()).hexdigest(),remoteMeshTtsReceiver=provider['remoteMeshTtsReceiver'],
             existingAuthorizedTaskProfile={'path':str(profile),'expectedLocalPeerId':provider['expectedRequesterPeerId'],
                                           'existingEnvFileReferencedWithoutCopy':True,'sameRetiredTaskProfileReused':True},
             runtimeConfigSha256=sha(OP/'runtime-config.json'),
             immutableRuntimeConfigInput={'path':str(OP/'runtime-config.frozen.json'),'sha256':sha(OP/'runtime-config.frozen.json')},
             providerManifestSha256=ready['files']['controller-launch.json']['manifestSha256'],
             providerReceiver={'pid':ready['files']['controller-launch.json']['receiverPid'],
                               'startTicks':ready['files']['controller-launch.json']['receiverStartTicks']},
             providerLaunchAt=provider['at'],providerDeadlineUtc=(datetime.fromtimestamp(
                 datetime.fromisoformat(provider['at']).timestamp()+provider['lifetimeSeconds'],timezone.utc)).isoformat(),
             providerNoRequesterDeadlineSeconds=provider['noRequesterDeadlineSeconds'],
             comparisonHttpManifestSha256=sha(H/'distributed-k1-orca-relayed-launch-v1197/condition-frozen-v1197.json'),
             routeClassification='actual_production_mesh_exact_peer_before_after_ice_snapshots_pending_live_warmups',
             correctness='Unchanged full transcript and exact Paris reply; decoded non-silent valid PCM16 WAV',
             physicalMicrophoneOrPlayback=False,newOrcaWorker=False)
    write(OP/'condition-frozen-v1702.json',m)
    write(DEST/'condition-frozen.json',m)
    write(OP/'expected-receiver.json',m['remoteMeshTtsReceiver'])
    env=os.environ.copy();env.update(m['effectiveEnvironment'])
    python=m['runtime']['venvExecutable']
    env.update(VIRTUAL_ENV=str(Path(python).parent.parent),PATH=str(Path(python).parent)+os.pathsep+env.get('PATH',''),
        AURORA_OUTPUT_DIR=str(CELL/'campaign'),AURORA_CONFIG_FILE=str(OP/'runtime-config.json'),
        AURORA_FROZEN_MANIFEST=str(OP/'condition-frozen-v1702.json'),AURORA_FROZEN_MANIFEST_SHA256=sha(OP/'condition-frozen-v1702.json'),
        AURORA_K1_SOURCE_ROOT=str(source),AURORA_K1_SOURCE_INVENTORY=str(inventory),AURORA_K1_PYTHON=python,
        AURORA_K1_MESH_TTS_PEER_ID=peer,PYTHONDONTWRITEBYTECODE='1')
    for envkey,name in [('STT','stt'),('LLM','llm'),('TTS','tts'),('TTS_CONFIG','tts_config')]:
        env['AURORA_K1_'+envkey+'_MODEL_PATH' if envkey!='TTS_CONFIG'else 'AURORA_K1_TTS_CONFIG_PATH']=m['canonicalModelFiles'][name]['path']
    for envkey,field in [('CONTROLLER','controllerSha256'),('RUNNER','runnerSha256'),('ADAPTER','adapterSha256'),
                         ('RECEIVER_PROOF','receiverProofSha256'),('ROUTE_OBSERVER','routeObserverSha256'),
                         ('ROUTE_SINK','routeSinkSha256'),('ROUTE_RUNTIME_PINS','routeRuntimePinsSha256')]:
        env['AURORA_K1_'+envkey+'_SHA256']=m['implementation'][field]
    with (OP/'requester-controller.private.log').open('xb') as log:
        child=subprocess.Popen([python,str(STAGE/'controller.py')],cwd=source,env=env,stdin=subprocess.DEVNULL,
                               stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    ticks=int(Path('/proc',str(child.pid),'stat').read_text().rsplit(')',1)[1].split()[19])
    receipt={'at':datetime.now(timezone.utc).isoformat(),'controllerPid':child.pid,'controllerStartTicks':ticks,
             'conditionManifestSha256':sha(OP/'condition-frozen-v1702.json'),'plannedMeasured':900,'excludedWarmups':15,
             'cell':str(CELL),'providerReceiver':m['providerReceiver'],'sourceRoot':str(STAGE),
             'measurementAdmitted':False,'startupIsNotCompletion':True,'newOrcaWorker':False}
    write(OP/'requester-launch.json',receipt);write(DEST/'ROOT-LAUNCH.json',receipt)
    return receipt


if __name__=='__main__':
    print(json.dumps(main(),sort_keys=True))

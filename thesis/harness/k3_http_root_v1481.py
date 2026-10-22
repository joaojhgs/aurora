"""Original Root's single K3 requester launch; unchanged reviewed APP860 code."""
import ast
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OP = H / 'distributed-k3-orca-relayed-launch-v1481'
CELL = H / 'distributed-k3-orca-relayed-http-cell-v1481'
STAGE = H / 'distributed-k3-requester-prep-v1413'
DEST = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481'
BASE = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1413'
PYTHON = H / 'cpu-audio-campaign-v491/env/bin/python'


def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1048576), b''):
            h.update(b)
    return h.hexdigest()


def write(p, v):
    with p.open('x') as f:
        json.dump(v, f, indent=2, sort_keys=True)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def existing_key():
    source = H / 'audio-campaign-v485/controller.py'
    assert sha(source) == 'f3257b00d1d35674168431fe12f231c753c3d49b6c2d70171380c340236711e1'
    values = {n.value for n in ast.walk(ast.parse(source.read_bytes())) if isinstance(n, ast.Constant) and isinstance(n.value, str) and hashlib.sha256(n.value.encode()).hexdigest() == '31a57e5c47a06a2327840b9a624fe8274f0d536749cebf14a9aa9f0aca87e962'}
    assert len(values) == 1
    return values.pop()


def launch():
    os.umask(0o077)
    assert os.uname().nodename == 'code-worker'
    assert not OP.exists() and not CELL.exists(), 'Reconcile same launch; no retry'
    assert all(not Path('/proc', str(p)).exists() for p in [588011,588053,588275,588276])
    with Path('/tmp/aurora-global-build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert shutil.disk_usage(R).free > 2 * 1024**3
    ready = json.loads((BASE/'provider-runtime/READY-CUSTODY.json').read_text())
    assert ready['status'] == 'K3_LISTENER_READY_COPIER_LAUNCHED_NATIVE_WARMUP_GATE_PENDING'
    assert ready['providerManifestSha256'] == 'b4b95d579c29695832c05d96692f2f15fd51cf3258333b9175091ab357280887'
    assert (datetime.now(timezone.utc)-datetime.fromisoformat(ready['at'])).total_seconds() < 1800
    assert json.loads((BASE/'runtime-admission/EXISTING-ROUTE-HEALTH.json').read_text())['status'] == 200
    staging = json.loads((BASE/'ADMISSION-PREPARED.json').read_text())
    for row in staging['source']['sourceFiles']:
        p = R/row['staged']
        assert p.is_file() and not p.is_symlink() and p.stat().st_size == row['bytes'] and sha(p) == row['sha256']
    oldconfig = H/'distributed-k2-orca-relayed-launch-v1264/runtime-config.json'
    cfg = json.loads(oldconfig.read_text())
    assert cfg['ui']['assistant']['automatic_tts_readback'] is False
    OP.mkdir(mode=0o700)
    m = json.loads((R/'thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/condition-frozen.json').read_text())
    for key in ['existingProviderReuse','priorK1PartialSeal','remoteLoadedGpuProof','providerDeadlinePolicy','remainingActualAdmission']:
        m.pop(key,None)
    source_sha = ready['source']['inventory_sha256']
    common = {'source_sha256':source_sha}
    receivers = {
        'stt': {**common,'receiver_id':'personal-desktop-whisper-base-cpu-k3-http','provider_class':'faster_whisper.transcribe.WhisperModel','model_sha256':m['models']['stt'],'config_sha256':staging['sttMemberExpectations']['config.json']['sha256'],'constructor_directory':staging['sttConstructorDirectory']['priorDeclaredPath'],'tokenizer_sha256':staging['sttMemberExpectations']['tokenizer.json']['sha256'],'vocabulary_sha256':staging['sttMemberExpectations']['vocabulary.txt']['sha256']},
        'assistant': {**common,'receiver_id':'personal-desktop-qwen-vulkan-k3-http','provider_class':'app.services.orchestrator.chat_llama_cpp.ChatLlamaCpp','model_sha256':m['models']['llm'],'config_sha256':ready['configSha256']},
        'tts': {**common,'receiver_id':'personal-desktop-piper-cpu-k3-http','provider_class':'app.services.tts.providers.piper.PiperTTSProvider','model_sha256':m['models']['tts'],'config_sha256':m['models']['ttsConfig']},
    }
    impl = {'runnerSha256':'runner.py','controllerSha256':'controller.py','adapterSha256':'stage_adapter.py','k3CompositionSha256':'k3_composition.py','bootstrapSha256':'bootstrap.py','bindingsSha256':'bindings.py','observerSha256':'observer.py','telemetrySha256':'aurora_voice_telemetry_v430.py','resourceSamplerSha256':'resource_sample.py'}
    m.update(schema='aurora.distributed_k3_http_condition.v1',cohortId='aurora-worker-desktop-k3-orca-relayed-http-stt-llm-tts-v1481',freezeAt=datetime.now(timezone.utc).isoformat(),status='FROZEN_FOR_ORDINARY15_WARMUPS_45_NATIVE_JOINS_PENDING',implementation={k:sha(STAGE/v) for k,v in impl.items()},runtimeConfigSha256=sha(oldconfig),immutableRuntimeConfigInput={'path':str(oldconfig),'bytes':oldconfig.stat().st_size,'sha256':sha(oldconfig),'referenceOnlyNoCredentialCopy':True},remoteReceivers=receivers,remoteAssistantConfigBinding={'config_sha256':ready['configSha256'],'automatic_tts_readback':False},remoteAssistantResponseIdentity={'provider':'llama_cpp','model':'Qwen3.5-0.8B-Q4_0.gguf'},remoteAuthBinding='existing_gateway_api_key',stagePlacement={'stt':'Personal desktop CPU','llm':'Personal desktop RX7600 Vulkan; actual warmup25/25 gate pending','tts':'Personal desktop Piper CPU'},providerManifestSha256=ready['providerManifestSha256'],providerDeadlineUtc=ready['providerDeadlineUtc'],providerReceiver={'pid':ready['providerReceiverPid'],'startTicks':ready['receiverStartTicks']},remoteConfiguredLlm=json.loads((BASE/'provider-runtime/STAGED-RECEIPT.json').read_text())['configuredLlm'],priorCompletedK2='thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264/terminal-v1465/RESULTS.md',remainingActualAdmission=['15 correct ordinary excluded full flows','45 distinct exact model-handler native joins','actual STT CPU/int8_float32 and Vulkan25/25 constructor proof','postwarmup bounded lifetime before measured1'],transportClassification='ORCA_RELAYED_HTTP_EXTRA_INTERMEDIARY_HOP_NOT_P2P_OR_PURE_PROTOCOL_OVERHEAD')
    m['effectiveSetup']['stt'].update(hardware='Personal desktop CPU',weightFiles=staging['sttMemberExpectations'],constructorDirectory=receivers['stt']['constructor_directory'],actualNewConstructorProof='PENDING ordinarywarmups; prior matched setup is expectation only')
    m['effectiveSetup']['tts'].update(provider=receivers['tts']);m['effectiveSetup']['tts'].pop('actualK2WarmupCall',None)
    m['unadmittedPredecessor']={'seal':'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1413/terminal-unadmitted-v1480/SEAL.json','measuredAttempted':0,'reason':'Saved-proof operator input selection corrected; no source/model/audio/settings/predicate change or completed900repeat','excludedWarmupsFromPredecessorNotPooled':True}
    m['canonicalModelFilesScope']='Requester controller verifies these same local weight hashes for source admission; all invoked models are remote. Actual remote file receipts are separately retained.'
    endpoints={'Stt':'http://127.0.0.1:18000/api/Transcription/Transcribe','Assistant':'http://127.0.0.1:18000/api/Orchestrator/ExternalUserInput','Tts':'http://127.0.0.1:18000/api/TTS/Synthesize'}
    for name,endpoint in endpoints.items():m[f'remote{name}EndpointSha256']=hashlib.sha256(endpoint.encode()).hexdigest()
    frozen=OP/'condition-frozen-v1481.json';write(frozen,m);write(DEST/'condition-frozen.json',m);write(OP/'expected-receivers.json',receivers)
    write(OP/'config-reference.json',m['immutableRuntimeConfigInput'])
    env=os.environ.copy();env.update(m['effectiveEnvironment']);env.update(VIRTUAL_ENV=str(PYTHON.parent.parent),PATH=str(PYTHON.parent)+os.pathsep+env.get('PATH',''),HF_HOME=str(CELL/'hf-cache'),UV_CACHE_DIR=str(CELL/'uv-cache'),AURORA_TOKEN_SECRET=cfg['services']['gateway']['api']['token_secret'],AURORA_CONFIG_FILE=str(oldconfig),AURORA_OUTPUT_DIR=str(CELL/'campaign'),AURORA_FROZEN_MANIFEST=str(frozen),AURORA_FROZEN_MANIFEST_SHA256=sha(frozen),AURORA_K3_SOURCE_ROOT=m['sourceClosure']['cpuSourceRoot'],AURORA_K3_PYTHON=str(PYTHON),AURORA_K3_REMOTE_STT_ENDPOINT=endpoints['Stt'],AURORA_K3_REMOTE_ASSISTANT_ENDPOINT=endpoints['Assistant'],AURORA_K3_REMOTE_TTS_ENDPOINT=endpoints['Tts'],AURORA_HOSTED_PEER_GATEWAY_API_KEY=existing_key())
    for name,key in [('CONTROLLER','controllerSha256'),('RUNNER','runnerSha256'),('ADAPTER','adapterSha256'),('COMPOSITION','k3CompositionSha256')]:env[f'AURORA_K3_{name}_SHA256']=m['implementation'][key]
    for name,b in m['canonicalModelFiles'].items():env['AURORA_K3_'+('TTS_CONFIG_PATH' if name=='tts_config' else name.upper()+'_MODEL_PATH')]=b['path']
    with (OP/'controller.private.log').open('xb') as log:
        child=subprocess.Popen([str(PYTHON),str(STAGE/'controller.py')],cwd=m['sourceClosure']['cpuSourceRoot'],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
    ticks=int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()[19])
    result={'at':datetime.now(timezone.utc).isoformat(),'status':'K3_REQUESTER_CONTROLLER_LAUNCHED_ORDINARY_WARMUP_ADMISSION_PENDING','controllerPid':child.pid,'controllerStartTicks':ticks,'frozenManifestSha256':sha(frozen),'providerReceiverPid':ready['providerReceiverPid'],'providerManifestSha256':ready['providerManifestSha256'],'plannedMeasured':900,'excludedWarmups':15,'requiredNativeJoins':45,'newWarmupsObserved':0,'newMeasuredObserved':0,'credentialFilesCopied':False,'reviewedApp860SourceUnchanged':True,'startupIsNotAcceptance':True}
    write(OP/'requester-launch.json',result);write(DEST/'REQUESTER-LAUNCH.json',result);print(json.dumps(result),flush=True)


if __name__=='__main__':launch()

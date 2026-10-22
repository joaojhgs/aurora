"""Prepare the next cumulative mesh provider using existing task state/assets.

Executed on Personal through the same plain Root control. No service or model
is imported/launched, no identity/grant is created, no credentials exported.
"""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
import shutil
import socket
import sys
import traceback

R = Path('/home/developer/projects/aurora')
OLD = R / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1912/provider'
PRIVATE = R / '.git/aurora-handoff-import-20261006/k3-mesh-provider-v1935'
OUTPUT = R / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1935/provider'
SOURCE = R / 'thesis/sources/k3-stt-runtime-v1907/personal'
CONTROLLER = '5e9d2212b0ee59848396888da919ef6a4695349bc880930a00e1aa1acd383dcd'
STT = 'd01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9'


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def main(controller):
    os.umask(0o077)
    os.nice(10)
    assert socket.gethostname() == 'personal.skyron-server'
    assert all(not Path('/proc', str(pid)).exists() for pid in [161159, 161160])
    assert json.loads((OLD / 'terminal.json').read_text())['receiverAbsent'] is True
    assert not PRIVATE.exists() and not OUTPUT.exists(), 'Reconcile existing preparation, no repeat'
    assert hashlib.sha256(controller).hexdigest() == CONTROLLER
    assert sha(SOURCE / 'source-inventory.json') == '25026c4031e07d2e7cdac2afe269f78611ed375e53d3b64cd751b31867a552cf'
    manifest = json.loads((OLD / 'provider-manifest.json').read_text())
    assert sha(OLD / 'provider-manifest.json') == 'ff1d2edc13fe65e646dccad691f4c0a3f83f31b224b796ef5f752402ce298e69'
    assert sha(manifest['config']) == manifest['configSha256'] == '10feff4f46638aa1e3c7c935a23fa050b4e2f57866256964990c1a4cc3eafeab'
    original = json.loads(Path(manifest['config']).read_text())
    config = json.loads(json.dumps(original))
    transcription = config['services']['stt']['transcription']
    accurate = transcription['accurate_model']
    assert accurate['device'] == 'cpu' and accurate['compute_type'] == 'int8'
    model_root = Path(accurate.get('model_size_or_path') or '')
    assert model_root.is_absolute() and model_root.is_dir(), 'Existing matched STT model directory unavailable'
    model = model_root / 'model.bin'
    assert model.is_file() and sha(model) == STT, 'Existing matched STT weight missing or mismatched'
    assert transcription['mesh_sharing']['share'] is False
    transcription['mesh_sharing']['share'] = True
    transcription['enabled'] = True
    accurate['enabled'] = True
    transcription['realtime_model']['enabled'] = False
    assert config['services']['stt']['hardware_acceleration'] is False
    assert config['services']['stt']['coordinator']['enabled'] is False
    assert config['services']['stt']['wakeword']['enabled'] is False
    assert config['services']['orchestrator'] == original['services']['orchestrator']
    assert config['services']['tts'] == original['services']['tts']
    assert config['services']['auth'] == original['services']['auth']
    assert config['services']['gateway'] == original['services']['gateway']
    assert config['ui']['assistant']['automatic_tts_readback'] is False
    memory = next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))
    assert memory > 4 * 1024**3
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 128 * 1024**2
    gpu = []
    for path in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_total'):
        gpu.append({'device': str(path.parent), 'totalBytes': int(path.read_text()),
                    'usedBytes': int(path.with_name('mem_info_vram_used').read_text())})
    assert any(g['totalBytes'] >= 8_000_000_000 and g['totalBytes'] - g['usedBytes'] > 2 * 1024**3 for g in gpu)
    files = manifest['actualFiles']
    files['sttModel'] = {'path': str(model), 'bytes': model.stat().st_size, 'sha256': STT}
    for item in files.values():
        assert Path(item['path']).stat().st_size == item['bytes'] and sha(item['path']) == item['sha256']
    PRIVATE.mkdir(mode=0o700)
    OUTPUT.mkdir(parents=True, mode=0o700)
    write(PRIVATE / 'config.json', config)
    write(PRIVATE / 'config.frozen.json', config)
    (PRIVATE / 'controller.py').write_bytes(controller)
    config_sha = sha(PRIVATE / 'config.json')
    source_inventory = {'root': str(SOURCE / 'source'), 'inventory_path': str(SOURCE / 'source-inventory.json'),
                        'inventory_sha256': sha(SOURCE / 'source-inventory.json')}
    source_sha = source_inventory['inventory_sha256']
    tts = dict(manifest['remoteMeshTtsReceiver'], receiver_id='personal-k3-mesh-piper-v1935', source_sha256=source_sha)
    assistant = dict(manifest['remoteMeshAssistantReceiver'], receiver_id='personal-k3-mesh-qwen-v1935',
                     source_sha256=source_sha, config_sha256=config_sha)
    stt = dict(assistant, receiver_id='personal-k3-mesh-whisper-v1935',
               provider_class='faster_whisper.transcribe.WhisperModel', model_sha256=STT)
    actual = {'at': now(), 'files': files, 'configSha256': config_sha, 'sourceInventory': source_inventory,
              'gpuMetadata': gpu, 'memAvailableBytes': memory, 'actualLoadedEngineProof': 'PENDING_ORDINARY_WARMUPS'}
    write(OUTPUT / 'ACTUAL-FILES-v1935.json', actual)
    manifest.update(schema='aurora.k3.mesh_provider.v1', at=now(), privateRoot=str(PRIVATE), output=str(OUTPUT),
                    sourceRoot=str(SOURCE / 'source'), sourceInventory=source_inventory,
                    config=str(PRIVATE / 'config.json'), configSha256=config_sha, controllerSha256=CONTROLLER,
                    retiredPredecessorPids=list(set(manifest['retiredPredecessorPids'] + [3938174, 3938202])),
                    remoteMeshSttReceiver=stt, remoteMeshAssistantReceiver=assistant, remoteMeshTtsReceiver=tts,
                    remoteSttEffectiveSettings=accurate,
                    actualFileReceiptSha256=sha(OUTPUT / 'ACTUAL-FILES-v1935.json'))
    consent = R / 'thesis/evidence/k3-stt-task-consent-v1934/personal/RESULT.json'
    assert json.loads(consent.read_text())['status'] == 'NORMAL_EXISTING_TEST_PAIR_TASK_CONSENT_APPLIED_VERIFIED'
    assert json.loads(consent.read_text())['afterPermissions'] == ['Gateway.GetRegistry','Gateway.GetMeshStatus','TTS.Synthesize','Orchestrator.use','Transcription.Transcribe']
    original_deadline = datetime.fromisoformat('2026-10-21T12:49:24.259537+00:00')
    remaining = int((original_deadline - datetime.now(timezone.utc)).total_seconds()) - 300
    assert remaining > 4000
    manifest['lifetimeSeconds'] = remaining
    manifest['originalProviderAbsoluteDeadlineUtc'] = original_deadline.isoformat()
    manifest['taskConsentReceipt'] = {'path': str(consent), 'sha256': sha(consent)}
    manifest['retiredPredecessorPids'] = list(set(manifest['retiredPredecessorPids'] + [161159,161160]))
    manifest['predecessorZeroAudioManifestSha256'] = sha(OLD / 'provider-manifest.json')
    write(OUTPUT / 'provider-manifest.json', manifest)
    result = {'at': now(), 'host': socket.gethostname(), 'status': 'K3_PROVIDER_PREPARED_NOT_LAUNCHED',
              'manifest': manifest, 'manifestPath': str(OUTPUT / 'provider-manifest.json'),
              'manifestSha256': sha(OUTPUT / 'provider-manifest.json'), 'controller': str(PRIVATE / 'controller.py'),
              'python': manifest['python'], 'resources': {'memAvailableBytes': memory,
              'freeBytes': shutil.disk_usage(R).free, 'gpus': gpu},
              'configDelta': ['stt.transcription.mesh_sharing.share=true', 'stt.transcription.enabled=true', 'stt.transcription.accurate_model.enabled=true',
                              'stt.transcription.realtime_model.enabled=false'],
              'modelsDecodingQuantizationUnchanged': True, 'originalSourcesAndResultsPreserved': True,
              'authAndGatewayUnchanged': True, 'newIdentityOrCredential': False, 'normalTaskScopedSttConsentReceipt': str(consent), 'sutCalls': 0,
              'actualGpuOffloadAndSttEngine': 'PENDING_NEW_PROCESS_ORDINARY_WARMUPS'}
    write(OUTPUT / 'PREPARATION-v1935.json', result)
    return result


if __name__ == '__main__':
    try:
        value = main(base64.b64decode(sys.argv[1], validate=True))
    except Exception as exc:
        value = {'status': 'K3_PROVIDER_PREPARATION_REQUIRES_RECONCILIATION', 'errorCategory': type(exc).__name__,
                 'error': str(exc), 'location': [{'function': f.name, 'line': f.lineno}
                 for f in traceback.extract_tb(exc.__traceback__)[-3:]], 'automaticRetry': False, 'sutCalls': 0}
    raw = base64.b64encode((json.dumps(value, indent=2, sort_keys=True) + '\n').encode()).decode()
    parts = [raw[i:i + 800] for i in range(0, len(raw), 800)]
    for i, part in enumerate(parts):
        print('AURORA_K3_PREPARE_V1912 ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

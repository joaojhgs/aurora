"""Prepare one fresh K2 provider config/manifest using existing approved assets.

No services, model calls, process launch, identities or grants are created here.
Root supplies the unchanged reviewed provider source as one explicit argument.
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
H = R / '.git/aurora-handoff-import-20261006'
PRIVATE = H / 'k2-mesh-provider-v1748'
OUTPUT = R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1748/provider'


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(1048576), b''):
            h.update(b)
    return h.hexdigest()


def write(path, raw):
    with path.open('xb') as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def main(controller_source):
    os.umask(0o077)
    assert socket.gethostname() == 'personal.skyron-server'
    assert not any(Path('/proc', str(p)).exists() for p in [3194385, 3194394])
    assert not PRIVATE.exists() and not OUTPUT.exists(), 'Reconcile existing stage; do not repeat'
    old = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/provider'
    assert json.loads((old / 'terminal.json').read_bytes())['receiverAbsent'] is True
    manifest = json.loads((old / 'provider-manifest.json').read_bytes())
    original = Path(manifest['config'])
    assert sha(original) == '06a199cfb688cd952359bc5fadfc26ca83fabf13059a0f9fa3d581832eb62493'
    config = json.loads(original.read_bytes())
    historic = H / 'distributed-k3-http-provider-v1680/runtime/config.json'
    assert sha(historic) == 'aa03866778b9a57e71a47bcab1a87dcd9adfadad2ec0974c127b98f80b40fba6'
    matched = json.loads(historic.read_bytes())['services']['orchestrator']
    orchestra = config['services']['orchestrator']
    orchestra['enabled'] = True
    orchestra['hardware_acceleration'] = matched['hardware_acceleration']
    orchestra['llm'] = matched['llm']
    orchestra['mesh_sharing']['share'] = True
    assert orchestra['llm']['provider'] == 'llama_cpp'
    options = orchestra['llm']['local']['llama_cpp']['options']
    assert options['n_gpu_layers'] == 100 and options['n_ctx'] == 4096
    assert options['temperature'] == 0 and options['max_tokens'] == 128
    assert config['ui']['assistant']['automatic_tts_readback'] is False
    # Every auth, gateway, principal and existing profile value remains the K1 value.
    oldconfig = json.loads(original.read_bytes())
    assert config['services']['auth'] == oldconfig['services']['auth']
    assert config['services']['gateway'] == oldconfig['services']['gateway']
    assert sha(Path(options['model_path'])) == '57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf'
    assert hashlib.sha256(controller_source).hexdigest() == '8cf12851d4a56cc84daa72f3de429cae2126c1a03123d674b5c997bffefd8bcd'
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 128 * 1024**2
    available = next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines()
                     if x.startswith('MemAvailable:'))
    assert available > 4 * 1024**3
    gpu = []
    for p in Path('/sys/class/drm').glob('card[0-9]*/device/mem_info_vram_total'):
        total = int(p.read_text()); used = int(p.with_name('mem_info_vram_used').read_text())
        gpu.append({'device': str(p.parent), 'totalBytes': total, 'usedBytes': used})
    assert any(g['totalBytes'] >= 8 * 1024**3 and g['totalBytes'] - g['usedBytes'] > 2 * 1024**3 for g in gpu)
    PRIVATE.mkdir(mode=0o700)
    OUTPUT.mkdir(parents=True, mode=0o700)
    write(PRIVATE / 'config.json', encode(config))
    write(PRIVATE / 'config.frozen.json', encode(config))
    write(PRIVATE / 'controller.py', controller_source)
    config_sha = sha(PRIVATE / 'config.json')
    receiver_keys = ['receiver_id', 'source_sha256', 'provider_class', 'model_sha256', 'config_sha256', 'peer_id_sha256']
    tts = {k: manifest['remoteMeshTtsReceiver'][k] for k in receiver_keys}
    tts['receiver_id'] = 'personal-k2-mesh-piper-v1748'
    assistant = {**tts, 'receiver_id': 'personal-k2-mesh-qwen-v1748',
                 'provider_class': 'app.services.orchestrator.chat_llama_cpp.ChatLlamaCpp',
                 'model_sha256': sha(Path(options['model_path'])), 'config_sha256': config_sha}
    files = manifest['actualFiles']
    model = Path(options['model_path'])
    files['llmModel'] = {'path': str(model), 'bytes': model.stat().st_size, 'sha256': assistant['model_sha256']}
    for item in files.values():
        assert Path(item['path']).stat().st_size == item['bytes'] and sha(item['path']) == item['sha256']
    effective = {k: v for k, v in options.items() if k != 'verbose'}
    actual_receipt = {'at': now(), 'files': files, 'configSha256': config_sha,
                      'sourceInventory': manifest['sourceInventory'], 'gpuMetadata': gpu,
                      'memAvailableBytes': available, 'newProcessAccelerationProof': 'PENDING_ORDINARY_WARMUPS'}
    write(OUTPUT / 'ACTUAL-FILES-v1786.json', encode(actual_receipt))
    manifest.update(schema='aurora.k2.mesh_provider.v1', at=now(),
        privateRoot=str(PRIVATE), output=str(OUTPUT), config=str(PRIVATE / 'config.json'),
        configSha256=config_sha, controllerSha256=hashlib.sha256(controller_source).hexdigest(),
        lifetimeSeconds=59040, noRequesterDeadlineSeconds=1800,
        retiredPredecessorPids=manifest['retiredPredecessorPids'] + [3194385, 3194394],
        remoteMeshTtsReceiver=tts, remoteMeshAssistantReceiver=assistant,
        remoteAssistantEffectiveSettings=effective, automaticTtsReadback=False,
        actualFileReceiptSha256=sha(OUTPUT / 'ACTUAL-FILES-v1786.json'))
    write(OUTPUT / 'provider-manifest.json', encode(manifest))
    result = {'at': now(), 'host': socket.gethostname(), 'status': 'K2_PROVIDER_PREPARED_NOT_LAUNCHED',
              'manifestPath': str(OUTPUT / 'provider-manifest.json'),
              'manifestSha256': sha(OUTPUT / 'provider-manifest.json'), 'manifest': manifest,
              'controller': str(PRIVATE / 'controller.py'), 'python': manifest['python'],
              'resources': {'memAvailableBytes': available, 'freeBytes': shutil.disk_usage(R).free, 'gpus': gpu},
              'configChanges': ['orchestrator.enabled', 'orchestrator.hardware_acceleration',
                                'orchestrator.llm matched completed HTTP', 'orchestrator.mesh_sharing.share'],
              'authAndGatewayUnchanged': True, 'newIdentityOrGrant': False, 'sutCalls': 0,
              'retiredK1Provider': True, 'actualGpuOffload': 'PENDING_NEW_PROCESS_WARMUPS'}
    write(OUTPUT / 'PREPARATION-v1786.json', encode(result))
    return result


if __name__ == '__main__':
    try:
        value = main(base64.b64decode(sys.argv[1]))
    except Exception as exc:
        value = {'status': 'K2_PREPARATION_REQUIRES_RECONCILIATION', 'errorCategory': type(exc).__name__,
                 'error': str(exc), 'location': [{'function': x.name, 'line': x.lineno}
                 for x in traceback.extract_tb(exc.__traceback__)[-3:]], 'automaticRetry': False}
    raw = base64.b64encode(encode(value)).decode()
    parts = [raw[i:i+800] for i in range(0, len(raw), 800)]
    for i, s in enumerate(parts):
        print('AURORA_K2_PREPARE_V1786 ' + json.dumps({'seq': i, 'total': len(parts), 'data': s}), flush=True)

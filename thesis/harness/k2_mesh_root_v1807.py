"""Freeze/launch the already-reviewed K2 requester, once, after K1 retirement."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess

R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OP = H / 'distributed-k2-mesh-launch-v1807'
STAGE = H / 'distributed-k2-mesh-requester-v1807'
CELL = H / 'distributed-k2-mesh-cell-v1807'
D = R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1807'
CANDIDATE = R / 'thesis/harness/distributed-k2-mesh-v1807'
FIELDS = {'controllerSha256': 'controller.py', 'runnerSha256': 'runner.py',
    'adapterSha256': 'mesh_stage_adapter.py', 'k2CompositionSha256': 'k2_composition.py',
    'receiverProofSha256': 'receiver_proof.py', 'bootstrapSha256': 'bootstrap.py',
    'bindingsSha256': 'bindings.py', 'observerSha256': 'observer.py',
    'telemetrySha256': 'aurora_voice_telemetry_v430.py', 'resourceSamplerSha256': 'resource_sample.py',
    'routeObserverSha256': 'mesh_route_observer.py', 'routeSinkSha256': 'route_observation_sink.py',
    'routeRuntimePinsSha256': 'route_runtime_pins.json'}
PEER = 'aurora-276bb04e1276201922851f6a222110de'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc)


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n'); f.flush(); os.fsync(f.fileno())


def admission(path):
    assert socket.gethostname() == 'code-worker'
    p = json.loads(path.read_bytes())
    assert p['status'] == 'K2_PROVIDER_LIVE_METADATA_ADMITTED'
    assert 0 <= (now() - datetime.fromisoformat(p['at'])).total_seconds() < 300
    assert p['host'] == 'personal.skyron-server' and p['sutCalls'] == 0
    assert p['oldK1ActorsAbsent'] is True
    assert p['configSha256'] == p['manifest']['configSha256']
    assert p['receiver']['state'] not in ['Z', 'X', 'x']
    assert all(not Path('/proc', str(pid)).exists() for pid in
               [2360747, 2360768, 2361201, 2361202, 2747722, 2747791, 2748029, 2748030])
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 128 * 1024**2
    assert next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines()
                if x.startswith('MemAvailable:')) > 2_500_000_000
    assert (datetime.fromisoformat(p['providerDeadlineUtc']) - now()).total_seconds() > 3000
    original = datetime.fromisoformat('2026-10-20T14:46:52.056334+00:00')
    assert (now() - original).total_seconds() + 55200 < 57600, 'Original K2 cumulative wall budget consumed, no reset'
    return p


def draft(path):
    p = admission(path)
    assert not any(x.exists() for x in [OP, STAGE, CELL, D])
    OP.mkdir(mode=0o700); D.mkdir(parents=True)
    shutil.copytree(CANDIDATE, STAGE)
    inventory = R / 'thesis/sources/python-audio-p2p-tts-wiring-v1706/source-inventory.json'
    shutil.copyfile(inventory, STAGE / 'source-inventory.json')
    previous = H / 'distributed-k1-mesh-launch-v1779/runtime-config.frozen.json'
    shutil.copyfile(previous, OP / 'runtime-config.json')
    shutil.copyfile(previous, OP / 'runtime-config.frozen.json')
    m = json.loads((CANDIDATE / 'freeze-template.json').read_bytes())
    pins = json.loads((STAGE / 'route_runtime_pins.json').read_bytes())
    admitted_prefix = Path(pins['runtimePrefix'])
    pins['runtimePrefix'] = str(admitted_prefix.resolve())
    (STAGE / 'route_runtime_pins.json').write_text(json.dumps(pins, indent=2, sort_keys=True) + '\n')
    m['implementation']['routeRuntimePinsSha256'] = sha(STAGE / 'route_runtime_pins.json')
    actual = {key: sha(STAGE / name) for key, name in FIELDS.items()}
    assert actual == m['implementation'], 'Reviewed candidate drift; do not launch'
    old = json.loads((R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v1779/condition-frozen.json').read_bytes())
    provider = p['manifest']
    alias = Path(old['runtime']['venvExecutable'])
    canonical = alias.parent.parent.resolve() / 'bin/python'
    assert sha(canonical.resolve()) == old['runtime']['resolvedInterpreterSha256']
    assert canonical.parent.parent == Path(pins['runtimePrefix'])
    old['runtime']['venvExecutable'] = str(canonical)
    m.update(cohortId='aurora-worker-desktop-k2-actual-p2p-assistant-tts-v1807',
        freezeAt=now().isoformat(), status='FROZEN_ORDINARY_WARMUPS_PENDING',
        runtimeConfigSha256=sha(OP / 'runtime-config.json'), runtime=old['runtime'],
        canonicalModelFiles=old['canonicalModelFiles'], effectiveEnvironment=old['effectiveEnvironment'],
        immutableRuntimeConfigInput={'path': str(OP / 'runtime-config.frozen.json'),
                                    'sha256': sha(OP / 'runtime-config.frozen.json')},
        providerManifestSha256=p['manifestSha256'], providerDeadlineUtc=p['providerDeadlineUtc'],
        providerReceiver=p['receiver'], providerController=p['controller'],
        remoteReceivers={'assistant': provider['remoteMeshAssistantReceiver'], 'tts': provider['remoteMeshTtsReceiver']},
        remoteAssistantConfigBinding={'config_sha256': p['configSha256'], 'automatic_tts_readback': False,
                                     'effective_llm_settings': provider['remoteAssistantEffectiveSettings']},
        remoteAssistantResponseIdentity={'provider': 'llama_cpp', 'model': 'Qwen3.5-0.8B-Q4_0.gguf'},
        meshAssistantPeerIdSha256=hashlib.sha256(PEER.encode()).hexdigest(),
        meshTtsPeerIdSha256=hashlib.sha256(PEER.encode()).hexdigest(),
        cumulativeConditionBudget={'originalStartUtc': '2026-10-20T14:46:52.056334+00:00', 'originalCapSeconds': 57600, 'priorElapsedSeconds': (now() - datetime.fromisoformat('2026-10-20T14:46:52.056334+00:00')).total_seconds(), 'newOuterCapSeconds': 55200, 'providerAbsoluteDeadlineNotExtended': True},
        stagePlacement={'stt': 'worker accurate CPU', 'assistant': 'Personal Vulkan GPU, new-process proof pending',
                        'tts': 'Personal Piper CPU'},
        priorK1={'attempted': 709, 'correct': 697, 'failed': 12, 'unattempted': 191,
                 'status': 'OPEN_PARTIAL_SEALED_NO_RETRY', 'notK2CompletionDependency': 'original monitor plan30.65'},
        routeLabel='typed_gateway_mesh_peer_bridge', httpSubstitution=False,
        actualAdmission={'metadata': str(path), 'sha256': sha(path), 'actualGpuAnd15Warmups': 'PENDING'})
    m['models']['ttsConfig'] = old['models']['ttsConfig']
    assert m['sourceClosure']['cpuSourceInventorySha256'] == sha(inventory)
    write(OP / 'condition-frozen-v1807.json', m)
    write(D / 'condition-frozen.json', m)
    write(OP / 'provider-admission.json', p)
    return {'at': now().isoformat(), 'status': 'FROZEN_NOT_LAUNCHED',
            'manifestSha256': sha(OP / 'condition-frozen-v1807.json'), 'measured': 0,
            'plannedMeasured': 900, 'excludedWarmups': 15}


def launch(path):
    p = admission(path)
    assert not CELL.exists() and not (OP / 'LAUNCH-INTENT.json').exists()
    mpath = OP / 'condition-frozen-v1807.json'
    m = json.loads(mpath.read_bytes())
    assert m['providerManifestSha256'] == p['manifestSha256']
    assert sha(mpath) == sha(D / 'condition-frozen.json')
    assert sha(OP / 'runtime-config.json') == m['runtimeConfigSha256']
    for k, n in FIELDS.items():
        assert sha(STAGE / n) == m['implementation'][k]
        if k != 'routeRuntimePinsSha256':
            assert sha(STAGE / n) == sha(CANDIDATE / n)
        else:
            pins = json.loads((STAGE / n).read_bytes())
            assert pins['runtimePrefix'] == str(Path(m['runtime']['venvExecutable']).parent.parent.resolve())
    env = os.environ.copy(); env.update(m['effectiveEnvironment'])
    python = m['runtime']['venvExecutable']
    env.update(VIRTUAL_ENV=str(Path(python).parent.parent), PATH=str(Path(python).parent) + os.pathsep + env.get('PATH', ''),
        AURORA_OUTPUT_DIR=str(CELL / 'campaign'), AURORA_CONFIG_FILE=str(OP / 'runtime-config.json'),
        AURORA_FROZEN_MANIFEST=str(mpath), AURORA_FROZEN_MANIFEST_SHA256=sha(mpath),
        AURORA_K2_SOURCE_ROOT=m['sourceClosure']['cpuSourceRoot'], AURORA_K2_PYTHON=python,
        AURORA_K2_MESH_ASSISTANT_PEER_ID=PEER, AURORA_K2_MESH_TTS_PEER_ID=PEER, PYTHONDONTWRITEBYTECODE='1')
    for key, field in [('STT', 'stt'), ('LLM', 'llm'), ('TTS', 'tts'), ('TTS_CONFIG', 'tts_config')]:
        env['AURORA_K2_' + key + ('_MODEL_PATH' if key != 'TTS_CONFIG' else '_PATH')] = m['canonicalModelFiles'][field]['path']
    for name, field in [('CONTROLLER', 'controllerSha256'), ('RUNNER', 'runnerSha256'), ('ADAPTER', 'adapterSha256'),
                        ('COMPOSITION', 'k2CompositionSha256'), ('RECEIVER_PROOF', 'receiverProofSha256'),
                        ('ROUTE_OBSERVER', 'routeObserverSha256'), ('ROUTE_SINK', 'routeSinkSha256'),
                        ('ROUTE_RUNTIME_PINS', 'routeRuntimePinsSha256')]:
        env['AURORA_K2_' + name + '_SHA256'] = m['implementation'][field]
    write(OP / 'LAUNCH-INTENT.json', {'at': now().isoformat(), 'maximumPopenCalls': 1,
        'manifestSha256': sha(mpath), 'providerAdmissionSha256': sha(path), 'plannedMeasured': 900,
        'conditionCapSeconds': 57600, 'outerCapSeconds': 55200, 'newWorker': False})
    with (OP / 'requester-controller.private.log').open('xb') as f:
        child = subprocess.Popen([python, str(STAGE / 'controller.py')], cwd=m['sourceClosure']['cpuSourceRoot'],
            env=env, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT, start_new_session=True)
    ticks = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
    result = {'at': now().isoformat(), 'controllerPid': child.pid, 'controllerStartTicks': ticks,
              'conditionManifestSha256': sha(mpath), 'plannedMeasured': 900, 'excludedWarmups': 15,
              'measurementAdmitted': False, 'provider': p['receiver'], 'newWorker': False}
    write(OP / 'requester-launch.json', result); write(D / 'ROOT-LAUNCH.json', result)
    return result


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['draft', 'launch'])
    parser.add_argument('admission', type=Path); args = parser.parse_args()
    print(json.dumps(draft(args.admission) if args.action == 'draft' else launch(args.admission)), flush=True)

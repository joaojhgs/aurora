"""Root-owned freeze and one-shot requester launch for the new K3 condition."""
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
OP = H / 'distributed-k3-mesh-launch-v1975'
STAGE = H / 'distributed-k3-mesh-requester-v1975'
CELL = H / 'distributed-k3-mesh-cell-v1975'
D = R / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1975'
CANDIDATE = R / 'thesis/harness/distributed-k3-mesh-v1973'
FIELDS = {'controllerSha256': 'controller.py', 'runnerSha256': 'runner.py',
          'adapterSha256': 'mesh_stage_adapter.py', 'k3CompositionSha256': 'k3_composition.py',
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
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def admission(path):
    assert socket.gethostname() == 'code-worker'
    p = json.loads(path.read_text())
    assert p['status'] == 'K3_PROVIDER_LIVE_METADATA_ADMITTED'
    assert 0 <= (now() - datetime.fromisoformat(p['at'])).total_seconds() < 300
    assert p['host'] == 'personal.skyron-server' and p['sutRequests'] == 0
    assert p['oldK2ActorsAbsent'] is True
    assert all(not Path('/proc', str(x)).exists() for x in [3061666,3061871,3061667,3061668,3107331,3107584,3107332,3107333,3116126,3116250,3116127,3116128,3121745,3121951,3121746,3121747,3134379,3134507,3134380,3134381]), 'Prior zero-audio actors must be retired'
    assert all(not Path('/proc', str(x)).exists() for x in (3057025, 3057026, 3057027, 3059926, 3059928, 3059929))
    assert p['configSha256'] == p['manifest']['configSha256']
    assert p['manifestSha256'] == '716b893424f28ef19a1820820000c8a30fb6adbf87252c9f65e1bca30e717bb9'
    assert p['receiver']['state'] not in ('Z', 'X', 'x') and p['controller']['state'] not in ('Z', 'X', 'x')
    assert all(not Path('/proc', str(pid)).exists() for pid in [2830732, 2830763, 2831081, 2831977])
    closure = json.loads((R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/CONDITION-CLOSURE-v1906.json').read_text())
    assert closure['measured'] == 900 and closure['nativeStageJoins'] == 2619
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 128 * 1024**2
    assert next(int(x.split()[1]) * 1024 for x in Path('/proc/meminfo').read_text().splitlines()
                if x.startswith('MemAvailable:')) > 2_500_000_000
    assert (datetime.fromisoformat(p['providerDeadlineUtc']) - now()).total_seconds() > 4000
    return p


def draft(path, *, reconcile_unlaunched=False):
    p = admission(path)
    if reconcile_unlaunched:
        assert OP.is_dir() and STAGE.is_dir() and D.is_dir() and not CELL.exists()
        assert not list(OP.iterdir()) and not list(D.iterdir()), 'Only the exact empty, unlaunched draft is recoverable here'
        expected = set(FIELDS.values()) | {'candidate-input.wav', 'candidate-manifest.json', 'source-inventory.json'}
        assert {p.name for p in STAGE.iterdir()} == expected
        assert all(sha(STAGE / n) == sha(CANDIDATE / n) for n in expected)
    else:
        assert not any(x.exists() for x in (OP, STAGE, CELL, D)), 'Reconcile existing K3 attempt'
        OP.mkdir(mode=0o700)
        D.mkdir(parents=True)
        STAGE.mkdir(mode=0o700)
    for name in list(FIELDS.values()) + ['candidate-input.wav', 'candidate-manifest.json', 'source-inventory.json']:
        if not reconcile_unlaunched:
            shutil.copyfile(CANDIDATE / name, STAGE / name)
    m = json.loads((CANDIDATE / 'freeze-template.json').read_text())
    assert {key: sha(STAGE / name) for key, name in FIELDS.items()} == m['implementation']
    old = json.loads((R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/condition-frozen.json').read_text())
    config = json.loads((H / 'distributed-k2-mesh-launch-v1826/runtime-config.frozen.json').read_text())
    stt = config['services']['stt']['transcription']
    stt['enabled'] = False
    stt['accurate_model']['enabled'] = False
    stt['realtime_model']['enabled'] = False
    config['services']['orchestrator']['enabled'] = False
    config['services']['tts']['enabled'] = False
    write(OP / 'runtime-config.json', config)
    write(OP / 'runtime-config.frozen.json', config)
    provider = p['manifest']
    m.update(schema='aurora.k3.mesh_cohort.v1', cohortId='aurora-worker-desktop-k3-actual-p2p-full-audio-v1975',
             freezeAt=now().isoformat(), status='FROZEN_ORDINARY_WARMUPS_PENDING',
             runtimeConfigSha256=sha(OP / 'runtime-config.json'), runtime=old['runtime'],
             canonicalModelFiles=old['canonicalModelFiles'], effectiveEnvironment=old['effectiveEnvironment'],
             immutableRuntimeConfigInput={'path': str(OP / 'runtime-config.frozen.json'), 'sha256': sha(OP / 'runtime-config.frozen.json')},
             providerManifestSha256=p['manifestSha256'], providerDeadlineUtc=p['providerDeadlineUtc'],
             providerReceiver=p['receiver'], providerController=p['controller'],
             remoteReceivers={s: provider[k] for s, k in [('stt', 'remoteMeshSttReceiver'), ('assistant', 'remoteMeshAssistantReceiver'), ('tts', 'remoteMeshTtsReceiver')]},
             remoteAssistantConfigBinding={'config_sha256': p['configSha256'], 'automatic_tts_readback': False,
                                           'effective_llm_settings': provider['remoteAssistantEffectiveSettings']},
             remoteSttConfigBinding={'config_sha256': p['configSha256'], 'effective_stt_settings': provider['remoteSttEffectiveSettings']},
             remoteAssistantResponseIdentity={'provider': 'llama_cpp', 'model': 'Qwen3.5-0.8B-Q4_0.gguf'},
             meshSttPeerIdSha256=hashlib.sha256(PEER.encode()).hexdigest(),
             meshAssistantPeerIdSha256=hashlib.sha256(PEER.encode()).hexdigest(),
             meshTtsPeerIdSha256=hashlib.sha256(PEER.encode()).hexdigest(),
             cumulativeConditionBudget={'originalStartUtc': '2026-10-20T21:04:37.423478+00:00', 'originalCapSeconds': 57600,
                                        'newOuterCapSeconds': int(min(52200, (datetime.fromisoformat(p['providerDeadlineUtc'])-now()).total_seconds()-180, 57600-(now()-datetime.fromisoformat('2026-10-20T21:04:37.423478+00:00')).total_seconds())), 'newConditionNotClosedCohortReplay': True,
                                        'providerAbsoluteDeadlineNotExtended': True},
             priorK2='thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826/CONDITION-CLOSURE-v1906.json',
             priorK1={'attempted': 709, 'correct': 697, 'failed': 12, 'unattempted': 191, 'status': 'OPEN_PARTIAL_SEALED'},
             routeLabel='typed_gateway_mesh_peer_bridge', httpSubstitution=False,
             guardDiagnosticSourceSha256=provider['guardDiagnosticSha256'],
             guardDiagnosticControllerSha256=provider['controllerSha256'],
             guardDiagnosticPolicy=provider['diagnosticGuardPolicy'],
             priorZeroAudioPreflight='thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1967/binding-diagnostic-v1972/CUSTODY.json',
             stageBoundary='Worker requester to Personal actual STT+LLM+TTS, all three stages remote; no requester-local model calls',
             controllerHistoricalSurfaceLabel='Legacy descriptive field mentions LocalBus STT; effective all-three exact-peer wiring and native joins govern this new K3 cohort',
             actualAdmission={'metadata': str(path), 'sha256': sha(path), 'actualGpuAnd15Warmups': 'PENDING'})
    m['models']['ttsConfig'] = old['models']['ttsConfig']
    assert set(m['models']) == {'stt', 'llm', 'tts', 'ttsConfig'}
    assert all(sha(Path(item['path'])) == m['models']['ttsConfig' if key == 'tts_config' else key] == item['sha256'] for key, item in m['canonicalModelFiles'].items())
    assert m['sourceClosure']['cpuSourceInventorySha256'] == sha(STAGE / 'source-inventory.json')
    assert sha(Path(m['runtime']['venvExecutable']).resolve()) == m['runtime']['resolvedInterpreterSha256']
    assert json.loads((STAGE / 'route_runtime_pins.json').read_text())['runtimePrefix'] == str(Path(m['runtime']['venvExecutable']).parent.parent.resolve())
    write(OP / 'condition-frozen-v1975.json', m)
    write(D / 'condition-frozen.json', m)
    write(OP / 'provider-admission.json', p)
    return {'status': 'K3_FROZEN_NOT_LAUNCHED', 'at': now().isoformat(), 'manifestSha256': sha(D / 'condition-frozen.json'),
            'plannedMeasured': 900, 'targetCorrectExcludedWarmups': 15, 'maximumDistinctExcludedWarmupAttempts': 30}


def launch(path):
    p = admission(path)
    mpath = OP / 'condition-frozen-v1975.json'
    m = json.loads(mpath.read_text())
    assert not CELL.exists() and not (OP / 'LAUNCH-INTENT.json').exists()
    assert sha(mpath) == sha(D / 'condition-frozen.json')
    assert m['providerManifestSha256'] == p['manifestSha256']
    assert sha(OP / 'runtime-config.json') == m['runtimeConfigSha256']
    assert {k: sha(STAGE / n) for k, n in FIELDS.items()} == m['implementation']
    env = os.environ.copy()
    env.update(m['effectiveEnvironment'])
    python = m['runtime']['venvExecutable']
    env.update(VIRTUAL_ENV=str(Path(python).parent.parent), PATH=str(Path(python).parent) + os.pathsep + env.get('PATH', ''),
               AURORA_OUTPUT_DIR=str(CELL / 'campaign'), AURORA_CONFIG_FILE=str(OP / 'runtime-config.json'),
               AURORA_FROZEN_MANIFEST=str(mpath), AURORA_FROZEN_MANIFEST_SHA256=sha(mpath),
               AURORA_K3_SOURCE_ROOT=m['sourceClosure']['cpuSourceRoot'], AURORA_K3_PYTHON=python,
               AURORA_K3_MESH_STT_PEER_ID=PEER, AURORA_K3_MESH_ASSISTANT_PEER_ID=PEER,
               AURORA_K3_MESH_TTS_PEER_ID=PEER, PYTHONDONTWRITEBYTECODE='1')
    for key, field in [('STT', 'stt'), ('LLM', 'llm'), ('TTS', 'tts'), ('TTS_CONFIG', 'tts_config')]:
        env['AURORA_K3_' + key + ('_MODEL_PATH' if key != 'TTS_CONFIG' else '_PATH')] = m['canonicalModelFiles'][field]['path']
    for name, field in [('CONTROLLER', 'controllerSha256'), ('RUNNER', 'runnerSha256'), ('ADAPTER', 'adapterSha256'),
                        ('COMPOSITION', 'k3CompositionSha256'), ('RECEIVER_PROOF', 'receiverProofSha256'),
                        ('ROUTE_OBSERVER', 'routeObserverSha256'), ('ROUTE_SINK', 'routeSinkSha256'), ('ROUTE_RUNTIME_PINS', 'routeRuntimePinsSha256')]:
        env['AURORA_K3_' + name + '_SHA256'] = m['implementation'][field]
    write(OP / 'LAUNCH-INTENT.json', {'at': now().isoformat(), 'maximumPopenCalls': 1,
                                    'manifestSha256': sha(mpath), 'plannedMeasured': 900, 'newWorker': False})
    with (OP / 'requester-controller.private.log').open('xb') as log:
        child = subprocess.Popen([python, str(STAGE / 'controller.py')], cwd=m['sourceClosure']['cpuSourceRoot'],
                                 env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    ticks = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
    value = {'at': now().isoformat(), 'controllerPid': child.pid, 'controllerStartTicks': ticks,
             'conditionManifestSha256': sha(mpath), 'plannedMeasured': 900, 'targetCorrectExcludedWarmups': 15, 'maximumDistinctExcludedWarmupAttempts': 30,
             'measurementAdmitted': False, 'provider': p['receiver'], 'newWorker': False}
    write(OP / 'requester-launch.json', value)
    write(D / 'ROOT-LAUNCH.json', value)
    return value


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['draft', 'launch'])
    parser.add_argument('admission', type=Path)
    parser.add_argument('--reconcile-unlaunched', action='store_true')
    args = parser.parse_args()
    assert not args.reconcile_unlaunched or args.action == 'draft'
    print(json.dumps(draft(args.admission, reconcile_unlaunched=args.reconcile_unlaunched)
                     if args.action == 'draft' else launch(args.admission)), flush=True)

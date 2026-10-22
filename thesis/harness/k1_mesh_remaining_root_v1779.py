"""Continue only unattempted K1 indices710–900 under the original deadline."""
from datetime import datetime, timezone
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess

R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OLD = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining880-v1719'
FIRST = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1711'
D = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v1779'
OP = H / 'distributed-k1-mesh-launch-v1779'
CELL = H / 'distributed-k1-mesh-cell-v1779'
STAGE = H / 'distributed-k1-mesh-requester-v1779'
CANDIDATE = R / 'thesis/harness/distributed-k1-mesh-remaining191-v1779/requester'
FIELDS = {'controllerSha256': 'controller.py', 'runnerSha256': 'runner.py',
          'adapterSha256': 'tts_mesh_adapter.py', 'receiverProofSha256': 'receiver_proof.py',
          'bootstrapSha256': 'bootstrap.py', 'bindingsSha256': 'bindings.py',
          'observerSha256': 'observer.py', 'telemetrySha256': 'aurora_voice_telemetry_v430.py',
          'resourceSamplerSha256': 'resource_sample.py', 'routeObserverSha256': 'mesh_route_observer.py',
          'routeSinkSha256': 'route_observation_sink.py', 'routeRuntimePinsSha256': 'route_runtime_pins.json'}
ACTORS = [2360747, 2360768, 2361201, 2361202]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc)


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def admit(path):
    value = json.loads(path.read_bytes())
    assert socket.gethostname() == 'code-worker'
    assert 0 <= (now() - datetime.fromisoformat(value['at'])).total_seconds() < 300
    assert value['host'] == 'personal.skyron-server' and value['sutCalls'] == 0
    assert value['manifestSha256'] == '245d1739111a7162287fcece91dc005958722e062a1e028613c3f85e21e3d339'
    assert value['configSha256'] == '06a199cfb688cd952359bc5fadfc26ca83fabf13059a0f9fa3d581832eb62493'
    assert value['sourceThreeFilesUnchanged'] is True
    assert value['receiver']['pid'] == 3194394 and value['receiver']['startTicks'] == 22320527
    assert value['controller']['pid'] == 3194385 and value['controller']['startTicks'] == 22320508
    assert all(value[key]['state'] not in ['Z', 'X', 'x'] for key in ['receiver', 'controller'])
    assert value['memAvailableBytes'] > 2_500_000_000 and value['freeBytes'] > 2 * 1024**3
    assert all(not Path('/proc', str(pid)).exists() for pid in ACTORS)
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 20 * 1024**2
    assert next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines()
                if line.startswith('MemAvailable:')) > 2_500_000_000
    original = json.loads((FIRST / 'ROOT-LAUNCH.json').read_bytes())
    elapsed = (now() - datetime.fromisoformat(original['at'])).total_seconds()
    assert elapsed + 15240 < 72000, 'All recovery time consumes the original wall clock'
    parent = json.loads((OLD / 'condition-frozen.json').read_bytes())
    assert (datetime.fromisoformat(parent['providerDeadlineUtc']) - now()).total_seconds() > 15300
    return value, elapsed


def draft(admission_path):
    admission, elapsed = admit(admission_path)
    assert not any(path.exists() for path in [OP, STAGE, CELL, D])
    seal = OLD / 'terminal-v1777/seal/REQUESTER-SEAL.json'
    assert sha(seal) == 'a85ca3225c99ef6f467568b1c69dff9378769ee5ef495af4a172c1352f153e43'
    sealed = json.loads(seal.read_bytes())
    assert sealed['measurement'] == {'epochPlanned': 880, 'attempted': 689, 'correct': 678,
                                     'failed': 11, 'timeoutFlagged': 1, 'unattempted': 191}
    first = json.loads((FIRST / 'terminal-v1716/seal/REQUESTER-SEAL.json').read_bytes())
    assert first['measurement']['attempted'] == 20 and first['measurement']['correct'] == 19
    assert sha(OLD / 'condition-frozen.json') == '120dd99a4de0a242c30ebe4bb46d854ca77313c482a0c74f024edb624829a6e8'
    for path in CANDIDATE.glob('*.py'):
        ast.parse(path.read_bytes())
    OP.mkdir(mode=0o700)
    D.mkdir(parents=True)
    shutil.copytree(CANDIDATE, STAGE)
    original_config = H / 'distributed-k1-mesh-launch-v1719/runtime-config.frozen.json'
    shutil.copyfile(original_config, OP / 'runtime-config.json')
    shutil.copyfile(original_config, OP / 'runtime-config.frozen.json')
    manifest = json.loads((OLD / 'condition-frozen.json').read_bytes())
    manifest['implementation'] = {key: sha(STAGE / name) for key, name in FIELDS.items()}
    manifest['measurementPlan'].update(conditionOverallCapSeconds=15000, epochMeasuredRequests=191,
                                       globalConditionTarget=900, excludedWarmupsPerEpoch=15)
    manifest.update(cohortId='aurora-worker-desktop-k1-actual-p2p-tts-remaining191-v1779',
        freezeAt=now().isoformat(), status='FROZEN_REMAINING191_NOT_LAUNCHED',
        runtimeConfigSha256=sha(OP / 'runtime-config.json'),
        immutableRuntimeConfigInput={'path': str(OP / 'runtime-config.frozen.json'),
                                    'sha256': sha(OP / 'runtime-config.frozen.json')},
        epochContinuation={'priorMeasuredAttempted': 709, 'priorCorrect': 697, 'priorFailed': 12,
            'plannedEpochMeasured': 191, 'globalFirst': 710, 'globalLast': 900,
            'targetAttemptsIndependentOfOutcome': 900, 'priorManifestSha256': sha(OLD / 'condition-frozen.json'),
            'priorSealPath': str(seal.relative_to(R)), 'priorSealSha256': sha(seal),
            'originalFirst20Seal': str((FIRST / 'terminal-v1716/seal/REQUESTER-SEAL.json').relative_to(R)),
            'timeout709RetainedNotReplayed': True, 'replayOrRetry': False},
        cumulativeConditionBudget={'conditionCapSeconds': 72000, 'priorUsedSeconds': elapsed,
            'epochOuterCapSeconds': 15240, 'epochConditionCapSeconds': 15000,
            'priorAndNewOuterSeconds': elapsed + 15240, 'providerDeadlineExtended': False},
        providerWarmupPrefixStart=admission['prefixStart'],
        providerRuntimeConfigPostStartupSha256=admission['configSha256'],
        comparisonLimits='Same application source/models/audio/settings and measured failure policy. Separate interrupted epochs; preserve raw outcomes and assess comparability before any combined percentiles.')
    write(OP / 'condition-frozen-v1779.json', manifest)
    write(D / 'condition-frozen.json', manifest)
    write(OP / 'expected-receiver.json', manifest['remoteMeshTtsReceiver'])
    result = {'at': now().isoformat(), 'status': 'FROZEN_NOT_LAUNCHED', 'manifestSha256': sha(OP / 'condition-frozen-v1779.json'),
              'plannedMeasured': 191, 'globalIndices': [710, 900], 'priorElapsedIncludingRecoverySeconds': elapsed,
              'providerDeadlineUtc': manifest['providerDeadlineUtc'], 'modelCalls': 0, 'newOrcaWorker': False}
    write(D / 'DRAFT-RECEIPT.json', result)
    return result


def launch(admission_path, review_path):
    admission, elapsed = admit(admission_path)
    assert not CELL.exists() and not (OP / 'LAUNCH-INTENT.json').exists(), 'Reconcile uncertain launch; never retry'
    manifest_path = OP / 'condition-frozen-v1779.json'
    manifest = json.loads(manifest_path.read_bytes())
    assert sha(manifest_path) == sha(D / 'condition-frozen.json')
    review = json.loads(review_path.read_bytes())
    assert review['verdict'] == 'PASS' and review['diffSha256'] == sha(CANDIDATE.parent / 'REMAINING191.diff')
    assert admission['prefixStart'] == manifest['providerWarmupPrefixStart']
    assert sha(OP / 'runtime-config.json') == manifest['runtimeConfigSha256']
    for key, name in FIELDS.items():
        assert sha(STAGE / name) == manifest['implementation'][key] == sha(CANDIDATE / name)
    source = Path(manifest['sourceClosure']['cpuSourceRoot'])
    inventory = R / 'thesis/sources/python-audio-p2p-tts-wiring-v1706/source-inventory.json'
    assert sha(inventory) == manifest['sourceClosure']['cpuSourceInventorySha256']
    python = manifest['runtime']['venvExecutable']
    env = os.environ.copy()
    env.update(manifest['effectiveEnvironment'])
    env.update(VIRTUAL_ENV=str(Path(python).parent.parent), PATH=str(Path(python).parent) + os.pathsep + env.get('PATH', ''),
        AURORA_OUTPUT_DIR=str(CELL / 'campaign'), AURORA_CONFIG_FILE=str(OP / 'runtime-config.json'),
        AURORA_FROZEN_MANIFEST=str(manifest_path), AURORA_FROZEN_MANIFEST_SHA256=sha(manifest_path),
        AURORA_K1_SOURCE_ROOT=str(source), AURORA_K1_SOURCE_INVENTORY=str(inventory), AURORA_K1_PYTHON=python,
        AURORA_K1_MESH_TTS_PEER_ID='aurora-276bb04e1276201922851f6a222110de', PYTHONDONTWRITEBYTECODE='1')
    for key, name in [('STT', 'stt'), ('LLM', 'llm'), ('TTS', 'tts'), ('TTS_CONFIG', 'tts_config')]:
        env['AURORA_K1_' + key + ('_MODEL_PATH' if key != 'TTS_CONFIG' else '_PATH')] = manifest['canonicalModelFiles'][name]['path']
    for key, field in [('CONTROLLER', 'controllerSha256'), ('RUNNER', 'runnerSha256'), ('ADAPTER', 'adapterSha256'),
                       ('RECEIVER_PROOF', 'receiverProofSha256'), ('ROUTE_OBSERVER', 'routeObserverSha256'),
                       ('ROUTE_SINK', 'routeSinkSha256'), ('ROUTE_RUNTIME_PINS', 'routeRuntimePinsSha256')]:
        env['AURORA_K1_' + key + '_SHA256'] = manifest['implementation'][field]
    write(OP / 'LAUNCH-INTENT.json', {'at': now().isoformat(), 'maximumPopenCalls': 1,
        'manifestSha256': sha(manifest_path), 'admissionSha256': sha(admission_path), 'reviewSha256': sha(review_path),
        'priorElapsedIncludingRecoverySeconds': elapsed, 'epochOuterPlusPriorRecoverySeconds': elapsed + 15240,
        'conditionCapSeconds': 72000})
    with (OP / 'requester-controller.private.log').open('xb') as log:
        child = subprocess.Popen([python, str(STAGE / 'controller.py')], cwd=source, env=env,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    fields = Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()
    result = {'at': now().isoformat(), 'controllerPid': child.pid, 'controllerStartTicks': int(fields[19]),
        'conditionManifestSha256': sha(manifest_path), 'plannedMeasured': 191, 'globalIndices': [710, 900],
        'excludedWarmups': 15, 'cell': str(CELL), 'providerReceiver': manifest['providerReceiver'],
        'measurementAdmitted': False, 'startupIsNotCompletion': True, 'newOrcaWorker': False,
        'priorElapsedIncludingRecoverySeconds': elapsed, 'epochOuterPlusPriorRecoverySeconds': elapsed + 15240,
        'conditionCapSeconds': 72000}
    write(OP / 'requester-launch.json', result)
    write(D / 'ROOT-LAUNCH.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--draft', action='store_true')
    parser.add_argument('--launch', action='store_true')
    parser.add_argument('--admission', type=Path, required=True)
    parser.add_argument('--review', type=Path)
    args = parser.parse_args()
    assert args.draft != args.launch
    print(json.dumps(draft(args.admission) if args.draft else launch(args.admission, args.review)))

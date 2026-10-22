"""Prepare or launch only global K1 P2P indices21–900; never replay old cases."""
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
OLD = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1711'
D = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining880-v1719'
OP = H / 'distributed-k1-mesh-launch-v1719'
CELL = H / 'distributed-k1-mesh-cell-v1719'
STAGE = H / 'distributed-k1-mesh-requester-v1719'
CANDIDATE = R / 'thesis/harness/distributed-k1-mesh-remaining880-v1719/requester'
FIELDS = {'controllerSha256': 'controller.py', 'runnerSha256': 'runner.py', 'adapterSha256': 'tts_mesh_adapter.py',
          'receiverProofSha256': 'receiver_proof.py', 'bootstrapSha256': 'bootstrap.py', 'bindingsSha256': 'bindings.py',
          'observerSha256': 'observer.py', 'telemetrySha256': 'aurora_voice_telemetry_v430.py',
          'resourceSamplerSha256': 'resource_sample.py', 'routeObserverSha256': 'mesh_route_observer.py',
          'routeSinkSha256': 'route_observation_sink.py', 'routeRuntimePinsSha256': 'route_runtime_pins.json'}


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


def draft():
    assert socket.gethostname() == 'code-worker'
    assert not OP.exists() and not STAGE.exists() and not CELL.exists() and not D.exists()
    seal = OLD / 'terminal-v1716/seal/REQUESTER-SEAL.json'
    sealed = json.loads(seal.read_bytes())
    assert sealed['measurement'] == {'planned': 900, 'attempted': 20, 'correct': 19, 'failed': 1, 'timeoutFlagged': 0, 'unattempted': 880}
    for pid in [2326088, 2326096, 2326666, 2326667, 2332610]:
        assert not Path('/proc', str(pid)).exists()
    summary = json.loads((OLD / 'terminal-v1716/seal/summary.json').read_bytes())
    prior_charge = sum(summary[k] / 1000 for k in ('setup_duration_ms', 'condition_elapsed_ms_excluding_setup_and_shutdown', 'shutdown_duration_ms'))
    assert prior_charge + 68240 <= 72000
    for path in CANDIDATE.glob('*.py'):
        ast.parse(path.read_bytes())
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 20 * 1024**2
    OP.mkdir(mode=0o700)
    D.mkdir(parents=True)
    shutil.copytree(CANDIDATE, STAGE)
    prior_op = H / 'distributed-k1-mesh-launch-v1711'
    # Preserve the old frozen input; the new private operational file keeps the
    # same existing task bindings. No credential values enter scientific files.
    shutil.copyfile(prior_op / 'runtime-config.frozen.json', OP / 'runtime-config.json')
    shutil.copyfile(OP / 'runtime-config.json', OP / 'runtime-config.frozen.json')
    m = json.loads((OLD / 'frozen/condition.json').read_bytes())
    assert sha(OLD / 'frozen/condition.json') == '04872dbd3948c13a4b269a1eb116f8b92fb3c369a8b0026cbbf339a2257009c1'
    m['implementation'] = {k: sha(STAGE / v) for k, v in FIELDS.items()}
    m['measurementPlan'].update(conditionOverallCapSeconds=68000, epochMeasuredRequests=880, globalConditionTarget=900, excludedWarmupsPerEpoch=15)
    m.update(cohortId='aurora-worker-desktop-k1-actual-p2p-tts-remaining880-v1719', freezeAt=now().isoformat(),
             status='FROZEN_REMAINING880_NOT_LAUNCHED', runtimeConfigSha256=sha(OP / 'runtime-config.json'),
             immutableRuntimeConfigInput={'path': str(OP / 'runtime-config.frozen.json'), 'sha256': sha(OP / 'runtime-config.frozen.json')},
             epochContinuation={'priorMeasuredAttempted': 20, 'priorCorrect': 19, 'priorFailed': 1, 'plannedEpochMeasured': 880,
                                'globalFirst': 21, 'globalLast': 900, 'targetAttemptsIndependentOfOutcome': 900,
                                'priorManifestSha256': sha(OLD / 'frozen/condition.json'), 'priorSealPath': str(seal.relative_to(R)),
                                'priorSealSha256': sha(seal), 'replayOrRetry': False},
             cumulativeConditionBudget={'conditionCapSeconds': 72000, 'priorUsedSeconds': prior_charge, 'epochOuterCapSeconds': 68240,
                                        'epochConditionCapSeconds': 68000, 'priorAndNewOuterSeconds': prior_charge + 68240,
                                        'providerDeadlineExtended': False},
             prospectiveFailurePolicy={'exactStructuredPreacceptCapabilityChanged': 'retain_failed_count_next_distinct_index',
                                       'consecutiveMeasuredRejectionHardStop': 3, 'warmupFailure': 'hard_stop',
                                       'otherSystemOrAmbiguousFailures': 'hard_stop', 'retry': False, 'fallback': False},
             comparisonLimits='Same application source/model/audio/settings. Different harness failure policy and runtime epoch; preserve separate raw and explicit comparability assessment before combined percentiles.')
    write(OP / 'condition-frozen-v1719.json', m)
    write(D / 'condition-frozen.json', m)
    write(OP / 'expected-receiver.json', m['remoteMeshTtsReceiver'])
    result = {'at': now().isoformat(), 'status': 'DRAFT_FROZEN_NOT_LAUNCHED', 'manifestSha256': sha(OP / 'condition-frozen-v1719.json'),
              'plannedMeasured': 880, 'globalIndices': [21, 900], 'priorUsedSeconds': prior_charge, 'epochOuterCapSeconds': 68240,
              'originalConditionCapSeconds': 72000, 'sameProvider': m['providerReceiver'], 'providerDeadlineUtc': m['providerDeadlineUtc'],
              'sutCalls': 0, 'modelCalls': 0, 'newOrcaWorker': False}
    write(D / 'DRAFT-RECEIPT.json', result)
    return result


def launch(admission_path, review_path):
    assert not CELL.exists() and not (OP / 'LAUNCH-INTENT.json').exists(), 'Reconcile uncertain launch; never retry'
    mpath = OP / 'condition-frozen-v1719.json'
    m = json.loads(mpath.read_bytes())
    assert sha(mpath) == sha(D / 'condition-frozen.json')
    review = json.loads(review_path.read_bytes())
    assert review['verdict'] == 'PASS' and review['diffSha256'] == sha(CANDIDATE.parent / 'REMAINING880.diff')
    admission = json.loads(admission_path.read_bytes())
    assert (now() - datetime.fromisoformat(admission['at'])).total_seconds() < 300
    assert admission['host'] == 'personal.skyron-server' and admission['sutCalls'] == 0
    assert admission['manifestSha256'] == m['providerManifestSha256']
    assert admission['receiver']['pid'] == m['providerReceiver']['pid'] and admission['receiver']['startTicks'] == m['providerReceiver']['startTicks']
    assert admission['receiver']['state'] not in ['Z', 'X', 'x'] and admission['controller']['state'] not in ['Z', 'X', 'x']
    assert admission['sourceThreeFilesUnchanged'] is True
    startup = admission.get('startupMigrationWitness', {})
    assert (admission.get('sourceConfigUnchanged') is True or (
        startup.get('pureStartupMigrationExactlyMatchesActualTree') is True
        and startup.get('existingTaskEnvCarriesSameOriginalSecretValues') is True
        and startup.get('configOrEnvWrittenByRead') is False
        and admission['reconstructedLaunchInputSha256'] == admission['expectedConfigSha256']
        and datetime.fromisoformat(startup['privateConfigMtimeUtc']) < datetime.fromisoformat(m['providerLaunchAt']).replace(minute=45)
    )), 'Config differences must be proven original startup migration, never silently accepted'
    assert admission['memAvailableBytes'] > 2_500_000_000 and admission['freeBytes'] > 2 * 1024**3
    assert (datetime.fromisoformat(m['providerDeadlineUtc']) - now()).total_seconds() > 60000
    original_launch = json.loads((OLD / 'ROOT-LAUNCH.json').read_bytes())
    elapsed_with_recovery = (now() - datetime.fromisoformat(original_launch['at'])).total_seconds()
    assert elapsed_with_recovery + 68240 < 72000, 'Recovery time also consumes the original condition allocation'
    for pid in [2326088, 2326096, 2326666]:
        assert not Path('/proc', str(pid)).exists()
    assert shutil.disk_usage(R).free > 2 * 1024**3
    assert next(int(l.split()[1]) * 1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')) > 2_500_000_000
    for key, name in FIELDS.items():
        assert sha(STAGE / name) == m['implementation'][key] == sha(CANDIDATE / name)
    env = os.environ.copy()
    env.update(m['effectiveEnvironment'])
    python = m['runtime']['venvExecutable']
    inventory = R / 'thesis/sources/python-audio-p2p-tts-wiring-v1706/source-inventory.json'
    source = Path(m['sourceClosure']['cpuSourceRoot'])
    assert sha(inventory) == m['sourceClosure']['cpuSourceInventorySha256']
    env.update(VIRTUAL_ENV=str(Path(python).parent.parent), PATH=str(Path(python).parent) + os.pathsep + env.get('PATH', ''),
               AURORA_OUTPUT_DIR=str(CELL / 'campaign'), AURORA_CONFIG_FILE=str(OP / 'runtime-config.json'),
               AURORA_FROZEN_MANIFEST=str(mpath), AURORA_FROZEN_MANIFEST_SHA256=sha(mpath),
               AURORA_K1_SOURCE_ROOT=str(source), AURORA_K1_SOURCE_INVENTORY=str(inventory), AURORA_K1_PYTHON=python,
               AURORA_K1_MESH_TTS_PEER_ID='aurora-276bb04e1276201922851f6a222110de', PYTHONDONTWRITEBYTECODE='1')
    for envkey, name in [('STT', 'stt'), ('LLM', 'llm'), ('TTS', 'tts'), ('TTS_CONFIG', 'tts_config')]:
        key = 'AURORA_K1_' + envkey + '_MODEL_PATH' if envkey != 'TTS_CONFIG' else 'AURORA_K1_TTS_CONFIG_PATH'
        env[key] = m['canonicalModelFiles'][name]['path']
    for envkey, field in [('CONTROLLER', 'controllerSha256'), ('RUNNER', 'runnerSha256'), ('ADAPTER', 'adapterSha256'),
                          ('RECEIVER_PROOF', 'receiverProofSha256'), ('ROUTE_OBSERVER', 'routeObserverSha256'),
                          ('ROUTE_SINK', 'routeSinkSha256'), ('ROUTE_RUNTIME_PINS', 'routeRuntimePinsSha256')]:
        env['AURORA_K1_' + envkey + '_SHA256'] = m['implementation'][field]
    write(OP / 'LAUNCH-INTENT.json', {'at': now().isoformat(), 'maximumPopenCalls': 1, 'manifestSha256': sha(mpath), 'admissionSha256': sha(admission_path), 'reviewSha256': sha(review_path),
                                     'priorElapsedIncludingRecoverySeconds': elapsed_with_recovery, 'originalConditionAbsoluteDeadlineUtc': datetime.fromtimestamp(datetime.fromisoformat(original_launch['at']).timestamp() + 72000, timezone.utc).isoformat(),
                                     'epochOuterPlusPriorRecoverySeconds': elapsed_with_recovery + 68240, 'conditionCapSeconds': 72000})
    with (OP / 'requester-controller.private.log').open('xb') as log:
        child = subprocess.Popen([python, str(STAGE / 'controller.py')], cwd=source, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    ticks = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
    result = {'at': now().isoformat(), 'controllerPid': child.pid, 'controllerStartTicks': ticks, 'conditionManifestSha256': sha(mpath),
              'plannedMeasured': 880, 'globalIndices': [21, 900], 'excludedWarmups': 15, 'cell': str(CELL), 'providerReceiver': m['providerReceiver'],
              'measurementAdmitted': False, 'startupIsNotCompletion': True, 'newOrcaWorker': False,
              'priorElapsedIncludingRecoverySeconds': elapsed_with_recovery, 'epochOuterPlusPriorRecoverySeconds': elapsed_with_recovery + 68240, 'conditionCapSeconds': 72000}
    write(OP / 'requester-launch.json', result)
    write(D / 'ROOT-LAUNCH.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--draft', action='store_true')
    parser.add_argument('--launch', action='store_true')
    parser.add_argument('--admission', type=Path)
    parser.add_argument('--review', type=Path)
    args = parser.parse_args()
    assert args.draft != args.launch
    print(json.dumps(draft() if args.draft else launch(args.admission, args.review)))

"""Root's single linked K3 remaining387 launch, using the existing provider/key.

--draft has no traffic. --launch requires fresh saved same-provider admission,
does one authenticated health read and never retries an uncertain launch.
"""

import argparse
import ast
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request


R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
DEST = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1513'
OP = H / 'distributed-k3-orca-relayed-launch-v1513'
CELL = H / 'distributed-k3-orca-relayed-http-cell-v1513'
STAGE = H / 'distributed-k3-requester-prep-v1513'
PARENT = R / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481'
PYTHON = H / 'cpu-audio-campaign-v491/env/bin/python'
PARENT_SHA = '54d51acdf8219b4e69f21cabb9d9fb1b402acf9826196dbdcea4fcfd15bddb25'
IMPL = {'runnerSha256': 'runner.py', 'controllerSha256': 'controller.py',
        'adapterSha256': 'stage_adapter.py', 'k3CompositionSha256': 'k3_composition.py',
        'bootstrapSha256': 'bootstrap.py', 'bindingsSha256': 'bindings.py',
        'observerSha256': 'observer.py', 'telemetrySha256': 'aurora_voice_telemetry_v430.py',
        'resourceSamplerSha256': 'resource_sample.py'}


def now():
    return datetime.now(timezone.utc)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def existing_key():
    source = H / 'audio-campaign-v485/controller.py'
    assert sha(source) == 'f3257b00d1d35674168431fe12f231c753c3d49b6c2d70171380c340236711e1'
    values = {n.value for n in ast.walk(ast.parse(source.read_bytes()))
              if isinstance(n, ast.Constant) and isinstance(n.value, str)
              and hashlib.sha256(n.value.encode()).hexdigest() == '31a57e5c47a06a2327840b9a624fe8274f0d536749cebf14a9aa9f0aca87e962'}
    assert len(values) == 1
    return values.pop()


def parent_effective_config():
    path = PARENT / 'terminal-v1506/final-artifacts/summary.json'
    assert sha(path) == 'e0fd80e370938dda4ff38a4d6004ac3d74d3598b930f1da381c80f987cdc455e'
    summary = json.loads(path.read_bytes())
    assert summary['config_raw_sha256_before_startup'] == '2b8cc043fc75c8978e2528379badb9fff7cd2ad2bc82729e61c560d35bbd1cc1'
    assert summary['config_startup_semantics_verified'] is True
    assert summary['config_startup_changed_key_paths'] == ['services.gateway.api.token_secret']
    assert summary['config_sha256'] == summary['config_raw_sha256_after_startup']
    return summary['config_sha256']


def bind_existing_effective_config(manifest):
    # Parent startup populated its previously empty local token secret. Reuse
    # that existing file exactly as measured; do not restore/reset/copy secrets.
    path = Path(manifest['immutableRuntimeConfigInput']['path'])
    assert sha(path) == parent_effective_config()
    manifest['runtimeConfigSha256'] = sha(path)
    manifest['immutableRuntimeConfigInput'] = {
        'path': str(path), 'bytes': path.stat().st_size, 'sha256': sha(path),
        'referenceOnlyNoCredentialCopy': True,
    }
    manifest['parentEffectiveConfigBinding'] = {
        'summary': str((PARENT / 'terminal-v1506/final-artifacts/summary.json').relative_to(R)),
        'summarySha256': 'e0fd80e370938dda4ff38a4d6004ac3d74d3598b930f1da381c80f987cdc455e',
        'exactConfigSha256DuringParentMeasurements': parent_effective_config(),
        'existingCredentialReusedWithoutResetOrCopy': True,
    }


def draft():
    assert sha(PARENT / 'condition-frozen.json') == PARENT_SHA
    m = json.loads((PARENT / 'condition-frozen.json').read_bytes())
    epoch = json.loads((DEST / 'EPOCH-LINEAGE.json').read_bytes())
    for field, checksum in [('parentValidationPath', 'parentValidationSha256'),
                            ('parentMeasuredRowsPath', 'parentMeasuredRowsSha256')]:
        assert sha(R / epoch[field]) == epoch[checksum]
    prep = json.loads((DEST / 'PREPARATION.json').read_bytes())
    for record in prep['sourceFiles']:
        for path in [STAGE / record['name'], R / 'thesis/harness/distributed-k3-http-remaining-v1513' / record['name']]:
            assert not path.is_symlink() and path.stat().st_size == record['bytes'] and sha(path) == record['sha256']
    m.update(cohortId='aurora-worker-desktop-k3-orca-relayed-http-stt-llm-tts-remaining-v1513',
             draftPreparedAt=now().isoformat(), status='DRAFT_NOT_LAUNCHED_SAME_PROVIDER_ADMISSION_REQUIRED',
             epochLineage=epoch, implementation={k: sha(STAGE / name) for k, name in IMPL.items()},
             receiverProofSourceSha256=sha(STAGE / 'receiver_proof.py'))
    m.pop('freezeAt', None)
    m['measurementPlan'] = {**m['measurementPlan'], 'plannedEpochMeasured': 387,
                            'priorAttemptedMeasured': 513, 'firstConditionMeasuredIndex': 514,
                            'lastConditionMeasuredIndex': 900}
    m['remainingActualAdmission'] = ['Fresh same-provider PID/manifest/config/resource read',
                                    'Existing route authenticated health',
                                    '15 new excluded strict-correct full flows',
                                    '45 exact new native model joins/actual constructor bindings',
                                    'Postwarmup provider lifetime for387 plus20percent margin and300seconds']
    bind_existing_effective_config(m)
    m['parentScientificParametersSha256'] = hashlib.sha256(json.dumps(
        scientific_parameters(m), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert scientific_parameters(m) == scientific_parameters(json.loads((PARENT / 'condition-frozen.json').read_bytes()))
    write(DEST / 'condition-draft-v1513.json', m)
    print(json.dumps({'status': m['status'], 'draft': str((DEST / 'condition-draft-v1513.json').relative_to(R)),
                      'scientificParametersSha256': m['parentScientificParametersSha256'], 'plannedEpochMeasured': 387,
                      'conditionTargetMeasured': 900, 'newRequests': 0}))


def scientific_parameters(manifest):
    values = {k: manifest[k] for k in [
        'comparisonFamilyId', 'audio', 'candidateManifestSha256', 'models', 'effectiveSetup',
        'effectiveEnvironment', 'runtimeConfigSha256', 'sourceClosure', 'runtime', 'runtimeVersions',
        'remoteReceivers', 'remoteAssistantConfigBinding', 'remoteAssistantResponseIdentity',
        'remoteConfiguredLlm', 'remoteSttEndpointSha256', 'remoteAssistantEndpointSha256',
        'remoteTtsEndpointSha256', 'remoteAuthBinding', 'stagePlacement', 'workerHardware',
        'providerManifestSha256', 'providerReceiver', 'transportClassification', 'routeClassification',
    ]}
    if manifest['cohortId'] == json.loads((PARENT / 'condition-frozen.json').read_bytes())['cohortId']:
        values['runtimeConfigSha256'] = parent_effective_config()
    return values


def launch():
    os.umask(0o077)
    assert os.uname().nodename == 'code-worker'
    assert not OP.exists() and not CELL.exists(), 'Reconcile original intent/process/result; no retry'
    assert all(not Path('/proc', str(pid)).exists() for pid in [968671, 968825, 968673])
    # Retain the same open-file-description lease through Popen. The controller
    # adopts this descriptor; closing our copy does not unlock its copy.
    lock = Path('/tmp/aurora-global-build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 100 * 1024**2
    readmit_path = DEST / 'provider-readmission/RESULT.json'
    ready = json.loads(readmit_path.read_bytes())
    assert ready['status'] == 'SAME_PROVIDER_PID_MANIFEST_CONFIG_RESOURCE_CHECK_PASSED'
    assert 0 <= (now() - datetime.fromisoformat(ready['at'])).total_seconds() < 1800
    assert ready['manifestSha256'] == 'b4b95d579c29695832c05d96692f2f15fd51cf3258333b9175091ab357280887'
    assert ready['configSha256'] == 'aa03866778b9a57e71a47bcab1a87dcd9adfadad2ec0974c127b98f80b40fba6'
    assert [(p['pid'], p['startTicks']) for p in ready['processes']] == [(1227847, 6621440), (1227894, 6621473), (1229873, 6630651)]
    m = json.loads((DEST / 'condition-draft-v1513.json').read_bytes())
    parent = json.loads((PARENT / 'condition-frozen.json').read_bytes())
    assert sha(PARENT / 'condition-frozen.json') == PARENT_SHA
    assert scientific_parameters(m) == scientific_parameters(parent)
    for key, name in IMPL.items():
        assert sha(STAGE / name) == m['implementation'][key]
    epoch = json.loads((DEST / 'EPOCH-LINEAGE.json').read_bytes())
    assert m['epochLineage'] == epoch
    for field, checksum in [('parentValidationPath', 'parentValidationSha256'), ('parentMeasuredRowsPath', 'parentMeasuredRowsSha256')]:
        assert sha(R / epoch[field]) == epoch[checksum]
    # A conservative first bound from the already retained parent full flows;
    # the fresh ordinary warmup finalizer must independently recompute it.
    budget = 31.878257710 * 387 * 1.2 + 1200
    remaining = (datetime.fromisoformat(m['providerDeadlineUtc']) - now()).total_seconds()
    assert remaining > budget, 'Same provider remaining lifetime insufficient; no launch'
    oldconfig = Path(m['immutableRuntimeConfigInput']['path'])
    assert sha(oldconfig) == m['runtimeConfigSha256']
    cfg = json.loads(oldconfig.read_bytes())
    key = existing_key()
    request = urllib.request.Request('http://127.0.0.1:18000/api/health', headers={'X-API-Key': key})
    with urllib.request.urlopen(request, timeout=20) as response:
        status = response.status
        response.read(65537)
    assert status == 200
    write(DEST / 'AUTHENTICATED-HEALTH.json', {'at': now().isoformat(), 'status': status, 'modelCalls': 0,
                                            'credentialsCopiedOrLogged': False, 'providerReadmissionSha256': sha(readmit_path)})
    OP.mkdir(mode=0o700)
    write(OP / 'LAUNCH-INTENT.json', {'at': now().isoformat(), 'newAttemptOnly': True, 'automaticRetry': False,
                                    'epochMeasured': 387, 'existingParentAttempts': 513, 'remainingProviderSeconds': remaining})
    m.update(freezeAt=now().isoformat(), status='FROZEN_FOR_NEW15_WARMUPS_45_NATIVE_JOINS_PENDING',
             sameProviderReadmissionSha256=sha(readmit_path), sameProviderReadmissionAt=ready['at'],
             actualSourceModelRuntimeOrResourceAdmissionPerformed=False)
    frozen = OP / 'condition-frozen-v1513.json'
    write(frozen, m)
    write(DEST / 'condition-frozen.json', m)
    write(OP / 'expected-receivers.json', m['remoteReceivers'])
    write(OP / 'config-reference.json', m['immutableRuntimeConfigInput'])
    endpoints = {'Stt': 'http://127.0.0.1:18000/api/Transcription/Transcribe',
                 'Assistant': 'http://127.0.0.1:18000/api/Orchestrator/ExternalUserInput',
                 'Tts': 'http://127.0.0.1:18000/api/TTS/Synthesize'}
    env = os.environ.copy()
    env.update(m['effectiveEnvironment'])
    env.update(VIRTUAL_ENV=str(PYTHON.parent.parent), PATH=str(PYTHON.parent) + os.pathsep + env.get('PATH', ''),
               HF_HOME=str(CELL / 'hf-cache'), UV_CACHE_DIR=str(CELL / 'uv-cache'),
               AURORA_TOKEN_SECRET=cfg['services']['gateway']['api']['token_secret'],
               AURORA_CONFIG_FILE=str(oldconfig), AURORA_OUTPUT_DIR=str(CELL / 'campaign'),
               AURORA_FROZEN_MANIFEST=str(frozen), AURORA_FROZEN_MANIFEST_SHA256=sha(frozen),
               AURORA_K3_SOURCE_ROOT=m['sourceClosure']['cpuSourceRoot'], AURORA_K3_PYTHON=str(PYTHON),
               AURORA_K3_BUILD_LOCK_FD=str(lock.fileno()),
               AURORA_K3_REMOTE_STT_ENDPOINT=endpoints['Stt'], AURORA_K3_REMOTE_ASSISTANT_ENDPOINT=endpoints['Assistant'],
               AURORA_K3_REMOTE_TTS_ENDPOINT=endpoints['Tts'], AURORA_HOSTED_PEER_GATEWAY_API_KEY=key)
    for name, field in [('CONTROLLER', 'controllerSha256'), ('RUNNER', 'runnerSha256'), ('ADAPTER', 'adapterSha256'), ('COMPOSITION', 'k3CompositionSha256')]:
        env['AURORA_K3_' + name + '_SHA256'] = m['implementation'][field]
    for name, binding in m['canonicalModelFiles'].items():
        env['AURORA_K3_' + ('TTS_CONFIG_PATH' if name == 'tts_config' else name.upper() + '_MODEL_PATH')] = binding['path']
    try:
        with (OP / 'controller.private.log').open('xb') as stream:
            child = subprocess.Popen([str(PYTHON), str(STAGE / 'controller.py')], cwd=m['sourceClosure']['cpuSourceRoot'],
                                     env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                     pass_fds=(lock.fileno(),), start_new_session=True)
    finally:
        lock.close()
    fields = Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()
    result = {'at': now().isoformat(), 'status': 'REMAINING387_CONTROLLER_LAUNCHED_NEW_WARMUP_GATE_PENDING',
              'controllerPid': child.pid, 'controllerStartTicks': int(fields[19]),
              'frozenManifestSha256': sha(frozen), 'providerManifestSha256': m['providerManifestSha256'],
              'providerReceiverPid': m['providerReceiver']['pid'], 'plannedMeasured': 387,
              'conditionTargetMeasured': 900, 'priorAttemptedMeasured': 513, 'priorCorrect': 512, 'priorFailed': 1,
              'excludedWarmups': 15, 'requiredNativeJoins': 45, 'newMeasuredObserved': 0,
              'providerRestarted': False, 'credentialsCopied': False, 'startupIsNotAcceptance': True,
              'globalBuildLock': 'Same locked descriptor handed to controller; parent closed its copy without unlocking'}
    write(OP / 'requester-launch.json', result)
    write(DEST / 'REQUESTER-LAUNCH.json', result)
    operators = {}
    for name, script, extra in [
        ('requesterCopier', 'custody_k3_requester_v1513.py', ['--follow', '--condition-sha256', sha(frozen)]),
        ('warmupFinalizer', 'k3_warmup_finalize_v1513.py', []),
    ]:
        source = R / 'thesis/harness' / script
        with (OP / (name + '.private.log')).open('xb') as stream:
            operator = subprocess.Popen([str(PYTHON), str(source), *extra], cwd=R,
                                        stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                        start_new_session=True)
        ticks = int(Path('/proc', str(operator.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
        record = {'at': now().isoformat(), 'pid': operator.pid, 'startTicks': ticks,
                  'sourceSha256': sha(source), 'role': 'Original Root collection utility; not an agent',
                  'modelCalls': 0}
        operators[name] = record
        write(OP / (name + '-launch.json'), record)
    write(OP / 'operator-launch.json', operators)
    write(DEST / 'OPERATOR-LAUNCH.json', operators)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--draft', action='store_true')
    mode.add_argument('--launch', action='store_true')
    args = parser.parse_args()
    if args.draft:
        draft()
    else:
        launch()

"""Root-only K2 launch/finalization using the unchanged, already-owned provider.

No provider lifecycle, credentials, settings, experiment source or retry changes.
The reviewed controller owns all SUT calls; finalization only reads saved data.
"""
import argparse
import ast
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import zlib

REPO = Path(__file__).resolve().parents[2]
HANDOFF = REPO / '.git/aurora-handoff-import-20261006'
OP = HANDOFF / 'distributed-k2-orca-relayed-launch-v1264'
STAGE = HANDOFF / 'distributed-k2-requester-prep-v1282'
CELL = HANDOFF / 'distributed-k2-orca-relayed-http-cell-v1264'
DEST = REPO / 'thesis/campaigns/worker-desktop-k2-orca-relayed-http-v1264'
PYTHON = HANDOFF / 'cpu-audio-campaign-v491/env/bin/python'
PRIOR = HANDOFF / 'distributed-k1-orca-relayed-launch-v1197'
PROVIDER_SHA = '450ee5af677a229e93f75c093e4e5ee3135c25b223f0d73f713f0c31f56c4cae'
DEADLINE = dt.datetime.fromisoformat('2026-10-18T09:58:36.115743+00:00')


def now():
    return dt.datetime.now(dt.timezone.utc)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_once(path, value):
    data = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def present(pid, ticks):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return int(fields[19]) == ticks and fields[0] != 'Z'
    except FileNotFoundError:
        return False


def approved_key():
    source = HANDOFF / 'audio-campaign-v485/controller.py'
    assert sha(source) == 'f3257b00d1d35674168431fe12f231c753c3d49b6c2d70171380c340236711e1'
    expected = '31a57e5c47a06a2327840b9a624fe8274f0d536749cebf14a9aa9f0aca87e962'
    values = {n.value for n in ast.walk(ast.parse(source.read_bytes()))
              if isinstance(n, ast.Constant) and isinstance(n.value, str)
              and hashlib.sha256(n.value.encode()).hexdigest() == expected}
    assert len(values) == 1
    return values.pop()


def launch():
    assert os.uname().nodename == 'code-worker'
    assert not OP.exists() and not CELL.exists(), 'Reconcile existing launch; never retry'
    seal = json.loads((REPO / 'thesis/evidence/orca-relayed-http-v1197/terminal-v1377/SEAL.json').read_text())
    assert seal['state'] == 'TERMINAL_PARTIAL_SEALED_NOT900_COMPLETE'
    assert all(not Path(f'/proc/{pid}').exists() for pid in [430655, 430656, 442775])
    assert present(421717, 104535394)
    with Path('/tmp/aurora-global-build.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    gpu = json.loads((HANDOFF / 'v1382-k2-existing-gpu-config-RESULT.json').read_text())
    live = json.loads((HANDOFF / 'v1381-existing-k2-runtime-metadata-RESULT.json').read_text())
    assert gpu['providerManifestSha256'] == live['providerManifestSha256'] == PROVIDER_SHA
    assert all(x['same'] for x in live['providerAfter'].values())
    assert (now() - dt.datetime.fromisoformat(gpu['at'])).total_seconds() < 1800
    assert gpu['isolatedNativeLibraryCapability']['supportsGpuOffload'] is True
    assert gpu['config']['automaticTtsReadback'] is False
    assert gpu['config']['llamaCppOptions']['n_gpu_layers'] == 100
    assert (DEADLINE - now()).total_seconds() > 8 * 3600
    assert shutil.disk_usage(REPO).free > 2 * 1024**3
    staged = json.loads((DEST / 'SOURCE-STAGING-v1282.json').read_text())
    for record in staged['sourceFiles']:
        path = REPO / record['staged']
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == record['bytes'] and sha(path) == record['sha256']
    manifest = json.loads((REPO / 'thesis/evidence/orca-relayed-http-v1197/frozen/condition.json').read_text())
    for field in ['remoteTtsReceiver', 'proposedRemoteTtsEndpoint', 'remoteTtsAuthBinding',
                  'parentFrozenCohortSHA256', 'precedingPrestartFailure', 'replacementFor']:
        manifest.pop(field, None)
    OP.mkdir(mode=0o700)
    (OP / 'input').mkdir(mode=0o700)
    original = PRIOR / 'input/runtime-config.frozen.json'
    assert sha(original) == '2b8cc043fc75c8978e2528379badb9fff7cd2ad2bc82729e61c560d35bbd1cc1'
    immutable = OP / 'input/runtime-config.frozen.json'
    mutable = OP / 'runtime-config.json'
    for path in [immutable, mutable]:
        with path.open('xb') as stream:
            stream.write(original.read_bytes())
        path.chmod(0o600)
    config = json.loads(mutable.read_text())
    assert config['ui']['assistant']['automatic_tts_readback'] is False
    tts_full = json.loads((REPO / 'thesis/evidence/orca-relayed-http-v1197/frozen/condition.json').read_text())['remoteTtsReceiver']
    keys = ['receiver_id', 'source_sha256', 'provider_class', 'model_sha256', 'config_sha256']
    assistant = {'receiver_id': 'personal-desktop-qwen-vulkan-existing1126',
                 'source_sha256': tts_full['source_sha256'],
                 'provider_class': 'app.services.orchestrator.chat_llama_cpp.ChatLlamaCpp',
                 'model_sha256': manifest['models']['llm'],
                 'config_sha256': gpu['config']['sha256']}
    receivers = {'assistant': assistant, 'tts': {k: tts_full[k] for k in keys}}
    manifest['effectiveSetup'] = {
        'stt': manifest['effectiveSetup']['stt'],
        'llm': {'hardware': 'Personal desktop RX7600', 'backend': 'Vulkan capability verified; loaded proof pending ordinary warmups',
                'configuredConstructor': gpu['config']['llamaCppOptions'], 'actualOffloadedLayers': None,
                'modelSha256': manifest['models']['llm']},
        'tts': {'hardware': 'Personal desktop CPU', 'provider': receivers['tts'],
                'useCuda': False, 'sampleRate': 22050, 'actualK2WarmupCall': 'pending'},
    }
    implementations = {'runnerSha256': 'runner.py', 'controllerSha256': 'controller.py',
                       'adapterSha256': 'stage_adapter.py', 'k2CompositionSha256': 'k2_composition.py',
                       'bootstrapSha256': 'bootstrap.py', 'bindingsSha256': 'bindings.py',
                       'observerSha256': 'observer.py', 'telemetrySha256': 'aurora_voice_telemetry_v430.py',
                       'resourceSamplerSha256': 'resource_sample.py'}
    manifest.update(schema='aurora.distributed_k2_http_condition.v1',
                    cohortId='aurora-worker-desktop-k2-orca-relayed-http-llm-tts-v1264',
                    freezeAt=now().isoformat(),
                    status='FROZEN_FOR_ORDINARY_WARMUPS_MEASURED_ADMISSION_PENDING',
                    implementation={k: sha(STAGE / v) for k, v in implementations.items()},
                    runtimeConfigSha256=sha(mutable),
                    immutableRuntimeConfigInput={'path': str(immutable), 'bytes': immutable.stat().st_size, 'sha256': sha(immutable)},
                    remoteReceivers=receivers,
                    remoteAssistantConfigBinding={'config_sha256': assistant['config_sha256'], 'automatic_tts_readback': False},
                    remoteAssistantResponseIdentity={'provider': 'llama_cpp', 'model': Path(gpu['configuredModel']['path']).name},
                    remoteAuthBinding='existing_gateway_api_key',
                    stagePlacement={'stt': 'coding-worker CPU', 'llm': 'Personal desktop Vulkan; actual warmup offload gate pending', 'tts': 'Personal desktop Piper CPU'},
                    existingProviderReuse={'manifestSha256': PROVIDER_SHA, 'receiverPid': 261790, 'startTicks': 1519744, 'restart': False},
                    remoteConfiguredLlm=gpu['config']['llamaCppOptions'],
                    remoteLoadedGpuProof='PENDING: actual constructor and native offload log from ordinary warmups; no CPU substitution',
                    providerDeadlinePolicy='Unchanged original provider deadline; require warmup p95 * 900 * 1.2 plus300s before deadline, otherwise no measured admission. No extension or automatic replay.',
                    remainingActualAdmission=['15 correct ordinary warmups', '30 correlated native remote-stage joins', 'actual loaded Vulkan offload and effective constructor', 'warmup-derived provider lifetime budget'],
                    priorK1PartialSeal='thesis/evidence/orca-relayed-http-v1197/terminal-v1377/SEAL.json')
    endpoints = {'Assistant': 'http://127.0.0.1:18000/api/Orchestrator/ExternalUserInput',
                 'Tts': 'http://127.0.0.1:18000/api/TTS/Synthesize'}
    for name, endpoint in endpoints.items():
        manifest[f'remote{name}EndpointSha256'] = hashlib.sha256(endpoint.encode()).hexdigest()
    frozen = OP / 'condition-frozen-v1264.json'
    write_once(frozen, manifest)
    write_once(DEST / 'condition-frozen.json', manifest)
    write_once(OP / 'expected-receivers.json', receivers)
    source = Path(manifest['sourceClosure']['cpuSourceRoot'])
    paths = {k: v['path'] for k, v in manifest['canonicalModelFiles'].items()}
    env = os.environ.copy()
    env.update(manifest['effectiveEnvironment'])
    env.update(VIRTUAL_ENV=str(PYTHON.parent.parent), PATH=str(PYTHON.parent) + os.pathsep + env.get('PATH', ''),
               HF_HOME=str(CELL / 'hf-cache'), UV_CACHE_DIR=str(CELL / 'uv-cache'),
               AURORA_TOKEN_SECRET=config['services']['gateway']['api']['token_secret'],
               AURORA_CONFIG_FILE=str(mutable), AURORA_OUTPUT_DIR=str(CELL / 'campaign'),
               AURORA_FROZEN_MANIFEST=str(frozen), AURORA_FROZEN_MANIFEST_SHA256=sha(frozen),
               AURORA_K2_SOURCE_ROOT=str(source), AURORA_K2_PYTHON=str(PYTHON),
               AURORA_K2_REMOTE_ASSISTANT_ENDPOINT=endpoints['Assistant'],
               AURORA_K2_REMOTE_TTS_ENDPOINT=endpoints['Tts'], AURORA_HOSTED_PEER_GATEWAY_API_KEY=approved_key())
    for name in ['CONTROLLER', 'RUNNER', 'ADAPTER', 'COMPOSITION']:
        key = {'COMPOSITION': 'k2Composition', 'CONTROLLER': 'controller', 'RUNNER': 'runner', 'ADAPTER': 'adapter'}[name] + 'Sha256'
        env[f'AURORA_K2_{name}_SHA256'] = manifest['implementation'][key]
    for name, path in paths.items():
        env['AURORA_K2_' + ('TTS_CONFIG_PATH' if name == 'tts_config' else name.upper() + '_MODEL_PATH')] = path
    with (OP / 'controller.private.log').open('xb') as stream:
        child = subprocess.Popen([str(PYTHON), str(STAGE / 'controller.py')], cwd=source, env=env,
                                 stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
    ticks = int(Path(f'/proc/{child.pid}/stat').read_text().rsplit(')', 1)[1].split()[19])
    result = {'at': now().isoformat(), 'controllerPid': child.pid, 'controllerStartTicks': ticks,
              'frozenManifestSha256': sha(frozen), 'sourceControllerSha256': manifest['implementation']['controllerSha256'],
              'plannedMeasured': 900, 'excludedWarmups': 15, 'startupIsNotWarmupOrMeasurement': True,
              'existingProviderUnchanged': True, 'credentialValueLogged': False}
    write_once(OP / 'requester-launch.json', result)
    print(json.dumps(result), flush=True)


def finalize():
    launch = json.loads((OP / 'requester-launch.json').read_text())
    end = time.monotonic() + 3600
    while time.monotonic() < end:
        rows = []
        for n in range(1, 16):
            path = CELL / f'campaign/attempts/attempt-{n:04d}-warmup.jsonl'
            try:
                row = json.loads(path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                break
            assert row['status'] == 'completed_correct', 'Retain failed warmup; no retry'
            rows.append(row)
        assert present(launch['controllerPid'], launch['controllerStartTicks']), 'Controller retired; reconcile, no rerun'
        if len(rows) == 15:
            durations = sorted(float(r['flow_duration_ms']) for r in rows)
            h = 14 * .95
            p95 = durations[int(h)] + (durations[int(h) + 1] - durations[int(h)]) * (h - int(h))
            seconds = p95 / 1000 * 900 * 1.2 + 300
            assert (DEADLINE - now()).total_seconds() > seconds, 'Original provider lifetime insufficient; no extension'
            payload = {'attempts': rows, 'receivers': json.loads((OP / 'expected-receivers.json').read_text()),
                       'manifest': json.loads((OP / 'condition-frozen-v1264.json').read_text()),
                       'cohortSha256': sha(OP / 'condition-frozen-v1264.json'),
                       'proofSource': (STAGE / 'receiver_proof.py').read_text()}
            encoded = base64.b64encode(zlib.compress(json.dumps(payload).encode())).decode()
            remote = (REPO / 'thesis/harness/k2_existing_provider_remote_proof_v1384.py').read_text()
            command = "python3 -c \"import base64;exec(base64.b64decode('" + base64.b64encode(remote.encode()).decode() + "'))\" " + encoded + '\n'
            command_path = OP / 'collect-ordinary-warmup-proof.command.txt'
            command_path.write_text(command)
            capture = subprocess.run([sys.executable, str(REPO / 'thesis/harness/orca_control_read_v1106.py'),
                                      'v1384-k2-ordinary-warmup-proof', str(command_path), 'AURORA_K2_PROOF_V1384'],
                                     capture_output=True, text=True, timeout=130)
            (OP / 'proof-collection.private.log').write_text(capture.stdout + '\nSTDERR\n' + capture.stderr)
            assert capture.returncode == 0, 'Reconcile the same accepted operation, never resend'
            result_path = HANDOFF / 'v1384-k2-ordinary-warmup-proof-RESULT.json'
            packet = json.loads(result_path.read_text())
            write_once(DEST / 'ORDINARY-WARMUP-RECEIVER-PACKET-v1384.json', packet)
            assert packet['status'] == 'proof_ready' and packet['actualOffloadedLayers'] == 25
            proof = packet['proof']
            assert proof['cohort_manifest_sha256'] == payload['cohortSha256'] and len(proof['calls']) == 30
            proof_path = CELL / 'campaign/remote-warmup-proof.json'
            write_once(proof_path, proof)
            result = {'at': now().isoformat(), 'status': 'receiver_proof_written', 'calls': 30,
                      'proofSha256': sha(proof_path), 'actualOffloadedLayers': packet['actualOffloadedLayers'],
                      'ordinaryWarmupP95MsType7': p95, 'forecastWith20PercentMarginPlus300Seconds': seconds,
                      'providerDeadline': DEADLINE.isoformat(), 'modelCallsByFinalizer': 0,
                      'measurementAdmission': 'Reviewed runner independently verifies published proof'}
            write_once(OP / 'warmup-finalizer-result.json', result)
            write_once(DEST / 'ORDINARY-WARMUP-ADMISSION-v1384.json', result)
            print(json.dumps(result), flush=True)
            return
        time.sleep(2)
    raise TimeoutError('Finite ordinary-warmup observation expired; preserve same attempt')


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['launch', 'finalize'])
    args = parser.parse_args()
    try:
        (launch if args.action == 'launch' else finalize)()
    except Exception as error:
        failure = {'at': now().isoformat(), 'action': args.action,
                   'errorType': type(error).__name__, 'error': str(error), 'automaticRetry': False}
        if OP.is_dir() and not (OP / (args.action + '-failure.json')).exists():
            write_once(OP / (args.action + '-failure.json'), failure)
        print(json.dumps(failure), flush=True)
        raise

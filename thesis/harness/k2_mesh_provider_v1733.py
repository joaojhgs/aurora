"""Root's bounded normal-service P2P Assistant and TTS receiver, reusing approved task state.

No pairing approval, credential output, HTTP listener or inference is performed
by the controller. Real TTS requests arrive through the normal mesh authority.
Scientific outputs are written directly to durable repo thesis custody.
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.metadata
import json
import logging
import os
from pathlib import Path
import runpy
import shutil
import signal
import socket
import subprocess
import sys
import time
import traceback


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda: stream.read(1048576), b''):
            h.update(data)
    return h.hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def write(path, value, exclusive=False):
    path = Path(path)
    if exclusive and path.exists():
        raise RuntimeError('existing_output_requires_reconciliation')
    tmp = path.with_name(path.name + '.new')
    with tmp.open('w') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def unwrap(value):
    if getattr(value, 'ok', True) is False:
        raise RuntimeError('typed_bus_request_failed')
    return getattr(value, 'data', value)


async def serve(manifest_path):
    manifest = json.loads(manifest_path.read_bytes())
    output = Path(manifest['output'])
    source = Path(manifest['sourceRoot'])
    sys.path[:0] = [str(Path(manifest['hookRoot'])), str(source)]
    os.chdir(Path(manifest['privateRoot']))
    # Filter all application logs before importing its entrypoint; Auth's
    # bootstrap information and signaling details must never reach custody.
    from app.helpers.aurora_logger import logger as aurora_logger
    aurora_logger.logger.addFilter(lambda record: False)
    import bindings
    bindings.install()
    from aurora_voice_telemetry_v430 import install
    install()
    import main  # Standard configuration and dotenv import path, no greeting.
    from app.services.supervisor import Supervisor
    from app.shared.contracts.models.gateway import (
        CapabilityCatalogRequest, CapabilityCatalogResponse, GatewayMethods,
        GetMeshStatusResponse, GetRegistryResponse,
    )
    from app.shared.contracts.models.common import EmptyInput
    from app.shared.contracts.models.tts import TTSMethods
    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.mesh import MeshPeerListRequest, MeshPeerListResponse
    supervisor = Supervisor()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stop.set)
    state = {'at': now(), 'pid': os.getpid(), 'host': socket.gethostname(),
             'phase': 'starting', 'newOrcaWorker': False, 'httpListener': True,
             'manifestSha256': sha(manifest_path), 'ownRuntimeRetired': False}
    write(output / 'STATUS.json', state)
    try:
        await supervisor.initialize()
        await supervisor._subscribe_registered_contracts()
        await supervisor.start_services()
        await supervisor._subscribe_to_config_changes()
        gateway = next(s for s in supervisor.services if type(s).__name__ == 'GatewayService')
        ready_at = time.monotonic()
        method_constraints = None
        end = time.monotonic() + manifest['lifetimeSeconds']
        while not stop.is_set() and time.monotonic() < end:
            if time.monotonic() - ready_at > manifest['noRequesterDeadlineSeconds']:
                bindings_path = output / 'actual-provider-bindings.jsonl'
                calls = bindings_path.read_bytes() if bindings_path.exists() else b''
                if b'piper_cli_call_start' not in calls:
                    state['phase'] = 'no_requester_admission_deadline'
                    return
            mesh = GetMeshStatusResponse.model_validate(unwrap(await supervisor.bus.request(
                GatewayMethods.GET_MESH_STATUS, EmptyInput(), timeout=10))).model_dump(mode='json')
            catalogue = CapabilityCatalogResponse.model_validate(unwrap(await supervisor.bus.request(
                GatewayMethods.GET_CAPABILITY_CATALOG,
                CapabilityCatalogRequest(modules=['Orchestrator', 'TTS'], include_schemas=False), timeout=10))).model_dump(mode='json')
            peers = MeshPeerListResponse.model_validate(unwrap(await supervisor.bus.request(
                AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10)))
            local_id = catalogue.get('local_peer_id')
            if local_id is not None and local_id != manifest['expectedStablePeerId']:
                raise RuntimeError('existing_task_identity_changed')
            route = None
            if gateway._rtc_client is not None:
                sample = runpy.run_path(manifest['routeObserver'])['sample_peer_route']
                route = sample(gateway._rtc_client, manifest['expectedRequesterPeerId'])
            if method_constraints is None:
                registry = GetRegistryResponse.model_validate(unwrap(await supervisor.bus.request(
                    GatewayMethods.GET_REGISTRY, EmptyInput(), timeout=10)))
                method_constraints = next((method.speech_constraints
                    for module in registry.modules if module.module == 'TTS'
                    for method in module.methods if method.bus_topic == TTSMethods.SYNTHESIZE), None)
            state.update(at=now(),
                         phase='normal_services_live' if method_constraints is not None else 'waiting_actual_speech_projection',
                         ttsMethodConstraints=method_constraints.model_dump(mode='json') if method_constraints is not None else None,
                         mesh=mesh, catalogue=catalogue,
                         observedRoute=route, trust=[{
                             'peerId': p.peer_id, 'outboundStatus': p.outbound_status,
                             'inboundStatus': p.inbound_status,
                             'outboundPermissions': p.outbound_permissions,
                             'inboundPermissions': p.inbound_permissions,
                         } for p in peers.peers])
            write(output / 'STATUS.json', state)
            await asyncio.wait_for(stop.wait(), timeout=5) if stop.is_set() else await asyncio.sleep(30)
        state['phase'] = 'requested_graceful_stop' if stop.is_set() else 'finite_provider_deadline'
    except Exception as exc:
        state.update(phase='provider_failed', errorCategory=type(exc).__name__,
                     errorLocation=[{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                                    for f in traceback.extract_tb(exc.__traceback__)[-6:]])
        raise
    finally:
        await supervisor.shutdown()
        state.update(at=now(), ownRuntimeRetired=True)
        write(output / 'STATUS.json', state)


def control(path):
    m = json.loads(path.read_bytes())
    assert socket.gethostname() == 'personal.skyron-server'
    output = Path(m['output'])
    assert not (output / 'controller-launch.json').exists()
    assert sha(Path(__file__)) == m['controllerSha256']
    assert sha(m['config']) == m['configSha256']
    locks = []
    for p in m['lockPaths']:
        handle = Path(p).open('a')
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        locks.append(handle)
    for pid in m['retiredPredecessorPids']:
        assert not Path('/proc', str(pid)).exists(), 'predecessor_process_not_retired'
    assert shutil.disk_usage(output).free > 2 * 1024**3
    assert next(int(l.split()[1]) * 1024 for l in Path('/proc/meminfo').read_text().splitlines()
                if l.startswith('MemAvailable:')) > 2_000_000_000
    for field in ('model', 'voiceConfig', 'piperExecutable', 'llmModel'):
        value = m['actualFiles'][field]
        assert sha(value['path']) == value['sha256'], 'actual_provider_file_drift'
    assistant = m['remoteMeshAssistantReceiver']
    assert assistant['model_sha256'] == m['actualFiles']['llmModel']['sha256']
    assert assistant['config_sha256'] == m['configSha256']
    assert m['remoteAssistantEffectiveSettings']['n_gpu_layers'] == 100
    assert m['remoteAssistantEffectiveSettings']['model_path'] == m['actualFiles']['llmModel']['path']
    assert m['automaticTtsReadback'] is False
    assert len(m['actualFileReceiptSha256']) == 64
    env = os.environ.copy()
    env.update(m['environment'])
    env.update(AURORA_CONFIG_FILE=m['config'], AURORA_ENV_FILE=m['existingEnvFile'],
               AURORA_DATA_DIR=m['existingDataDir'], AURORA_BACKUP_DIR=m['privateRoot'] + '/backups',
               AURORA_ARCHITECTURE_MODE='threads', AURORA_VOICE_STAGE_OUTPUT=str(output/'voice-stages.jsonl'),
               AURORA_V409_OBSERVER_PATH=str(Path(m['hookRoot'])/'observer.py'),
               AURORA_VOICE_STAGE_HOST_ID='personal-k2-mesh-assistant-tts-v1733', AURORA_VOICE_TELEMETRY_V430='1',
               PYTHONDONTWRITEBYTECODE='1', HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1')
    packages = {n: importlib.metadata.version(n) for n in m['runtimeVersions']}
    assert packages == m['runtimeVersions'], 'runtime_versions_changed'
    write(output/'runtime-versions.json', {'pid': os.getpid(), 'packages': packages}, exclusive=True)
    sample = runpy.run_path(m['resourceSampler'])['sample_resources']
    start = time.monotonic()
    child = None
    record = {'at': now(), 'host': socket.gethostname(), 'controllerPid': os.getpid(),
              'manifestSha256': sha(path), 'measurementStartedByController': False}
    try:
        with (Path(m['privateRoot'])/'backend.private.log').open('xb') as log, (output/'resources.jsonl').open('xb') as resources:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve', str(path)],
                                     cwd=m['privateRoot'], env=env, stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            ticks = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
            record.update(receiverPid=child.pid, receiverStartTicks=ticks)
            write(output/'controller-launch.json', record, exclusive=True)
            write(output/'receiver-identity.json', {
                'schema': 'aurora.distributed_k2_receiver_identity.v1', 'receiver_pid': child.pid,
                'provider': m['remoteMeshTtsReceiver'], 'manifest_sha256': sha(path),
                'actual_provider_files': {'source_receipt_sha256': m['actualFileReceiptSha256'],
                    'model': {'canonical_path': m['actualFiles']['model']['path'], 'sha256': m['actualFiles']['model']['sha256']},
                    'config': {'canonical_path': m['actualFiles']['voiceConfig']['path'], 'sha256': m['actualFiles']['voiceConfig']['sha256']}},
                'credential_value_logged': False,
            }, exclusive=True)
            # Independent Assistant file identity; the later strict warmup proof
            # rehashes these actual files and joins the real constructor/native
            # spans. This declaration alone makes no loaded-GPU claim.
            write(output/'assistant-identity.json', {
                'schema': 'aurora.distributed_k2_receiver_identity.v1', 'receiver_pid': child.pid,
                'provider': assistant, 'manifest_sha256': sha(path),
                'actual_provider_files': {'source_receipt_sha256': m['actualFileReceiptSha256'],
                    'model': {'canonical_path': m['actualFiles']['llmModel']['path'], 'sha256': m['actualFiles']['llmModel']['sha256']},
                    'config': {'canonical_path': m['config'], 'sha256': m['configSha256']}},
                'actual_loaded_acceleration': 'PENDING_NEW_PROCESS_ORDINARY_WARMUP_PROOF',
                'credential_value_logged': False,
            }, exclusive=True)
            while child.poll() is None and time.monotonic()-start < m['lifetimeSeconds']+180:
                row = {'at': now(), 'monotonic_ns': time.monotonic_ns(), 'pid': child.pid,
                       'resource_context': sample(child.pid)}
                resources.write((json.dumps(row, sort_keys=True)+'\n').encode());resources.flush()
                if shutil.disk_usage(output).free < 2*1024**3:
                    record['stopReason'] = 'free_disk_floor';break
                if sum(p.stat().st_size for p in output.glob('*') if p.is_file()) > 512*1024**2:
                    record['stopReason'] = 'raw_byte_cap';break
                time.sleep(1)
    finally:
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGINT)
            child.wait(timeout=45)
        record.update(finishedAt=now(), exitCode=None if child is None else child.returncode,
                      elapsedSeconds=time.monotonic()-start,
                      receiverAbsent=child is None or not Path('/proc',str(child.pid)).exists())
        write(output/'terminal.json', record)


if __name__ == '__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--serve', type=Path);parser.add_argument('--control', type=Path)
    args=parser.parse_args()
    try:
        asyncio.run(serve(args.serve)) if args.serve else control(args.control)
    except Exception as exc:
        print(json.dumps({'errorCategory': type(exc).__name__, 'location': [
            {'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
            for f in traceback.extract_tb(exc.__traceback__)[-6:]]}), flush=True)
        raise SystemExit(1) from None

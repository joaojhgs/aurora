"""Normal task-scoped Auth API update on the existing quiescent test profile.

Owner30.56.1 authorizes this exact product consent. No credential/API key is
created, no permission SQL is used, and no model or network listener starts.
"""
from pathlib import Path
from datetime import datetime, timezone
import asyncio
import base64
import fcntl
import hashlib
import json
import os
import signal
import socket
import sys
import time
import traceback

R = Path('/home/developer/projects/aurora')
B = R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1748/provider'
OUT = B.parent / 'task-consent-v1805'
PRIVATE = R / '.git/aurora-handoff-import-20261006/k2-task-consent-v1805'


def now():
    return datetime.now(timezone.utc).isoformat()


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n'); f.flush(); os.fsync(f.fileno())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def actor(pid, ticks):
    p = Path('/proc', str(pid), 'stat')
    if not p.exists():
        return False
    f = p.read_text().rsplit(')', 1)[1].split()
    assert int(f[19]) == ticks, 'PID_reused_no_signal'
    return f[0] not in ['Z', 'X', 'x']


async def consent(m):
    from app.helpers.aurora_logger import logger as aurora_logger
    aurora_logger.logger.addFilter(lambda record: False)
    from app.messaging.local_bus import LocalBus
    from app.messaging.bus_runtime import set_bus as set_runtime_bus
    from app.shared.messaging.bus_init import set_bus
    from app.services.config.service import ConfigService
    from app.services.db.service import DBService
    from app.services.auth.service import AuthService
    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.mesh import (
        MeshIdentityLoadRequest, MeshPeerListRequest, MeshPeerListResponse, MeshPeerUpdatePermissionsRequest,
    )
    from app.shared.contracts.models.orchestrator import OrchestratorMethods

    def unwrap(result):
        assert result.ok, 'normal_typed_API_failed_no_direct_DB_fallback'
        return result.data

    bus = LocalBus(); set_bus(bus); set_runtime_bus(bus); await bus.start()
    try:
        config = ConfigService(); await config._subscribe_registered_contracts()
        db = DBService(str(Path(m['existingDataDir']) / 'aurora.db'))
        await db._subscribe_registered_contracts()
        await db.db_manager.initialize(); await db.scheduler_db.initialize()
        auth = AuthService(); await auth._subscribe_registered_contracts()
        await auth.on_start(); await config.on_start()
        identity = unwrap(await bus.request(AuthMethods.LOAD_MESH_IDENTITY, MeshIdentityLoadRequest(), timeout=10))
        if hasattr(identity, 'model_dump'):
            identity = identity.model_dump(mode='json')
        assert identity['peer_id'] == m['expectedStablePeerId'], 'existing_identity_changed'
        before = MeshPeerListResponse.model_validate(unwrap(await bus.request(
            AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10)))
        target = next(p for p in before.peers if p.peer_id == m['expectedRequesterPeerId'])
        old = list(target.outbound_permissions)
        assert target.outbound_status == 'approved'
        assert set(old) == {'Gateway.GetRegistry', 'Gateway.GetMeshStatus', 'TTS.Synthesize'}
        requested = old + [OrchestratorMethods.EXTERNAL_USER_INPUT]
        write(OUT / 'AUTH-MUTATION-INTENT.json', {'at': now(), 'method': AuthMethods.MESH_UPDATE_PEER_PERMISSIONS,
            'peerId': target.peer_id, 'oldPermissions': old, 'newPermissions': requested,
            'maximumMutationCalls': 1, 'authority': 'owner30.56.1/RootACKmsg_142e2c492f54/monitorb067fb2256da'})
        response = unwrap(await bus.request(AuthMethods.MESH_UPDATE_PEER_PERMISSIONS,
            MeshPeerUpdatePermissionsRequest(peer_id=target.peer_id, permissions=requested),
            origin='internal', principal_id='system', timeout=20))
        if hasattr(response, 'model_dump'):
            response = response.model_dump(mode='json')
        assert response['success'] is True, 'normal_consent_update_not_successful_reconcile_never_repeat'
        after = MeshPeerListResponse.model_validate(unwrap(await bus.request(
            AuthMethods.MESH_LIST_PEERS, MeshPeerListRequest(), timeout=10)))
        peer = next(p for p in after.peers if p.peer_id == target.peer_id)
        assert set(peer.outbound_permissions) == set(requested)
        assert peer.inbound_permissions == target.inbound_permissions
        assert peer.outbound_status == peer.inbound_status == 'approved'
        return {'status': 'NORMAL_EXISTING_TEST_PAIR_TASK_CONSENT_APPLIED_VERIFIED',
                'peerId': peer.peer_id, 'localStablePeerId': identity['peer_id'],
                'beforePermissions': old, 'afterPermissions': list(peer.outbound_permissions),
                'reversePermissionsUnchanged': list(peer.inbound_permissions),
                'scope': 'Only Orchestrator.ExternalUserInput added to same approved test pair',
                'mutationMethod': AuthMethods.MESH_UPDATE_PEER_PERMISSIONS, 'mutationCalls': 1,
                'newIdentity': False, 'newCredential': False, 'modelServicesStarted': [],
                'modelCalls': 0, 'networkListenerStarted': False, 'directPermissionDBEdits': False}
    finally:
        await bus.stop()


def main():
    os.umask(0o077)
    assert socket.gethostname() == 'personal.skyron-server'
    assert not OUT.exists() and not PRIVATE.exists(), 'Existing operation must be reconciled, never replayed'
    m = json.loads((B / 'provider-manifest.json').read_bytes())
    assert sha(B / 'provider-manifest.json') == 'f4b28b1eff80041aca0ad8b2031cd7a80de25fa6f10e96ca9cca45ffbbbb2fa0'
    assert actor(3904749, 26303084) and actor(3904779, 26303135)
    OUT.mkdir(); PRIVATE.mkdir(mode=0o700)
    write(OUT / 'CONTROL-INTENT.json', {'at': now(), 'ownProviderRetirement': [3904749, 3904779],
        'reason': 'Zero-request setup stopped; existing provider has no authenticated HTTP management key. Use supported local typed Auth API in quiescent profile control window.',
        'newWorkers': 0, 'maximumReceiverSIGINT': 1, 'noForceOrAutomaticRetry': True})
    os.kill(3904779, signal.SIGINT)
    end = time.monotonic() + 65
    while time.monotonic() < end:
        if not actor(3904749, 26303084) and not actor(3904779, 26303135):
            break
        time.sleep(.5)
    else:
        raise RuntimeError('owned_provider_graceful_retirement_pending_no_control_started')
    terminal = json.loads((B / 'terminal.json').read_bytes())
    assert terminal['receiverAbsent'] is True and terminal['exitCode'] == 0
    files = []
    for p in sorted(B.glob('*')):
        if p.is_file() and not p.is_symlink() and p.suffix in ['.json', '.jsonl']:
            a = p.stat(); digest = sha(p); b = p.stat()
            assert (a.st_ino, a.st_size, a.st_mtime_ns) == (b.st_ino, b.st_size, b.st_mtime_ns)
            files.append({'source': str(p), 'bytes': b.st_size, 'sha256': digest, 'terminalEOF': True})
    write(OUT / 'PROVIDER-EOF-SEAL.json', {'at': now(), 'terminal': terminal, 'files': files,
        'rawPhysicallyUnderRepoThesis': True, 'allPriorFilesPreserved': True,
        'requesterWarmups': 0, 'requesterMeasured': 0, 'providerReusedSamples': 0})
    lock = Path('/tmp/aurora-global-build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    config = json.loads(Path(m['config']).read_bytes())
    config['services']['gateway']['enabled'] = False
    config['services']['gateway']['webrtc']['enabled'] = False
    config['services']['gateway']['mesh_network']['enabled'] = False
    write(PRIVATE / 'config.json', config)
    assert (Path(m['existingDataDir']) / 'aurora.db').is_file(), 'No new identity DB authorized here'
    os.environ.update(AURORA_CONFIG_FILE=str(PRIVATE / 'config.json'), AURORA_ENV_FILE=m['existingEnvFile'],
        AURORA_DATA_DIR=m['existingDataDir'], AURORA_BACKUP_DIR=str(PRIVATE / 'backups'),
        AURORA_ARCHITECTURE_MODE='threads', PYTHONDONTWRITEBYTECODE='1')
    from dotenv import load_dotenv
    load_dotenv(m['existingEnvFile'], override=False)
    sys.path.insert(0, m['sourceRoot']); os.chdir(PRIVATE)
    value = asyncio.run(asyncio.wait_for(consent(m), timeout=90))
    value.update(at=now(), host=socket.gethostname(), previousProviderTerminal=terminal,
                 providerConfigUnchanged=sha(m['config']) == m['configSha256'])
    write(OUT / 'RESULT.json', value)
    return value


if __name__ == '__main__':
    try:
        value = main()
    except Exception as exc:
        value = {'at': now(), 'status': 'CONTROL_OPERATION_REQUIRES_SAME_STATE_RECONCILIATION',
            'errorCategory': type(exc).__name__, 'error': str(exc),
            'location': [{'function': x.name, 'line': x.lineno} for x in traceback.extract_tb(exc.__traceback__)[-4:]],
            'automaticRetry': False}
    encoded = base64.b64encode(json.dumps(value).encode()).decode()
    parts = [encoded[i:i+800] for i in range(0, len(encoded), 800)]
    for i, s in enumerate(parts):
        print('AURORA_K2_TASK_CONSENT_V1805 ' + json.dumps({'seq': i, 'total': len(parts), 'data': s}), flush=True)

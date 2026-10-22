"""Read the existing, reserved Personal K2 provider after requester completion."""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import shutil
import socket

ROOT = Path('/home/developer/projects/aurora')
SOURCE = ROOT / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1813/provider'
MARKER = 'AURORA_K2_PROVIDER_EOF_READ_V1900'


def actor(pid, expected):
    path = Path('/proc', str(pid), 'stat')
    if not path.exists():
        return {'pid': pid, 'expectedStartTicks': expected, 'absent': True}
    fields = path.read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'expectedStartTicks': expected, 'startTicks': int(fields[19]),
            'identityMatches': int(fields[19]) == expected, 'state': fields[0], 'absent': False}


def main():
    assert socket.gethostname() == 'personal.skyron-server'
    manifest_raw = (SOURCE / 'provider-manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    config_raw = Path(manifest['config']).read_bytes()
    files = [{'name': p.name, 'bytes': p.stat().st_size, 'mtimeNs': p.stat().st_mtime_ns,
              'inode': p.stat().st_ino, 'symlink': p.is_symlink()}
             for p in SOURCE.iterdir() if p.is_file()]
    status = json.loads((SOURCE / 'STATUS.json').read_text())
    voice = SOURCE / 'voice-stages.jsonl'
    with voice.open('rb') as stream:
        stream.seek(max(0, voice.stat().st_size - 65536))
        tail = stream.read().decode(errors='replace').splitlines()
    recent = []
    for line in tail[-6:]:
        item = json.loads(line)
        recent.append({k: v for k, v in item.items() if k in (
            'event', 'event_type', 'kind', 'stage', 'phase', 'handler', 'handler_name',
            'name', 'pid', 'monotonic_ns', 'monotonicNs', 'correlation_id', 'span_id', 'duration_ms')})
    launch = json.loads((SOURCE / 'controller-launch.json').read_text())
    manifest_hash = hashlib.sha256(manifest_raw).hexdigest()
    config_hash = hashlib.sha256(config_raw).hexdigest()
    return {'at': datetime.now(timezone.utc).isoformat(), 'host': socket.gethostname(),
            'mode': 'metadata_read_only_after_requester_terminal', 'sutCalls': 0,
            'providerManifestSha256': manifest_hash,
            'expectedManifestMatches': manifest_hash == 'd133ecead33bca857e64a5bee381b030f297155ab4e0e723eeb64fc16f4ce667',
            'actualConfigSha256': config_hash,
            'expectedConfigMatches': config_hash == 'efed0546bf49f4e99cc977c643fa80e2f611fa99ab7fbcd5d9c9fb31d078beef',
            'actors': [actor(3938174, 26503295), actor(3938202, 26503353)],
            'controllerLaunch': {k: v for k, v in launch.items() if k in (
                'at', 'host', 'controllerPid', 'receiverPid', 'receiverStartTicks', 'manifestSha256')},
            'status': {k: v for k, v in status.items() if k in (
                'at', 'phase', 'pid', 'ownRuntimeRetired', 'errorCategory', 'receiver_pid')},
            'files': files, 'directories': [p.name for p in SOURCE.iterdir() if p.is_dir()],
            'recentNativeStageFields': recent, 'disk': shutil.disk_usage(ROOT)._asdict(),
            'source': str(SOURCE), 'privateRootReferenceOnly': manifest['privateRoot'],
            'terminalPresent': (SOURCE / 'terminal.json').exists(),
            'reservationPreserved': True, 'sourceOrSettingsChanged': False,
            'credentialsCopied': False}


if __name__ == '__main__':
    try:
        result = main()
    except Exception as exc:
        result = {'at': datetime.now(timezone.utc).isoformat(), 'host': socket.gethostname(),
                  'status': 'read_requires_reconciliation', 'errorCategory': type(exc).__name__,
                  'error': str(exc), 'sutCalls': 0, 'automaticRetry': False}
    raw = base64.b64encode((json.dumps(result, indent=2) + '\n').encode()).decode()
    parts = [raw[i:i + 800] for i in range(0, len(raw), 800)]
    for i, part in enumerate(parts):
        print(MARKER + ' ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

"""Read only existing Aurora config and public trust metadata; never create state."""
import base64
import datetime
import hashlib
import json
from pathlib import Path
import socket
import sqlite3

ROOT = Path('/home/developer/projects/aurora')


def hashed(value):
    return hashlib.sha256(str(value).encode()).hexdigest() if value else None


def main():
    config = ROOT / 'config.json'
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(),
              'scope': 'Existing source-checkout config and data/aurora.db only; no service startup',
              'modelCalls': 0, 'mutations': 0, 'secretValuesOutput': False}
    if config.is_file():
        raw = config.read_bytes()
        j = json.loads(raw)
        services = j.get('services', {})
        gateway = services.get('gateway', {})
        rtc = gateway.get('webrtc', {})
        signaling = gateway.get('signaling_mqtt', {})
        piper = services.get('tts', {}).get('piper', {})
        result['config'] = {'path': str(config), 'sha256': hashlib.sha256(raw).hexdigest(),
                            'meshEnabled': gateway.get('mesh_network', {}).get('enabled'),
                            'webrtcEnabled': rtc.get('enabled'),
                            'ttsMeshSharing': services.get('tts', {}).get('mesh_sharing', {}).get('share'),
                            'llmProvider': services.get('orchestrator', {}).get('llm', {}).get('provider'),
                            'ttsProvider': services.get('tts', {}).get('provider'),
                            'ttsPiperFieldNames': list(piper),
                            'signalingScopeHashes': {k: hashed(rtc.get(k)) for k in ['app_id', 'room']},
                            'signalingMqttScopeHashes': {k: hashed(signaling.get(k)) for k in ['app_id', 'room']},
                            'turnServerCount': len(rtc.get('turn_servers', [])),
                            'stunServerCount': len(rtc.get('stun_servers', []))}
    database = ROOT / 'data/aurora.db'
    result['database'] = {'path': str(database), 'exists': database.is_file()}
    if database.is_file():
        wal = database.with_name(database.name + '-wal')
        result['database'].update(bytes=database.stat().st_size,
                                  walBytes=wal.stat().st_size if wal.exists() else 0,
                                  snapshotPolicy='immutable read; any nonempty WAL makes latest trust unknown')
        connection = sqlite3.connect(database.as_uri() + '?mode=ro&immutable=1', uri=True, timeout=2)
        connection.row_factory = sqlite3.Row
        tables = [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%mesh%' LIMIT 50")]
        result['database']['meshTableNames'] = tables
        if 'mesh_identity' in tables:
            rows = connection.execute("SELECT peer_id, node_name FROM mesh_identity WHERE key='self' LIMIT 1").fetchall()
            result['database']['identity'] = [{'peerIdSha256': hashed(r['peer_id']), 'nodeName': r['node_name']} for r in rows]
        if 'mesh_peers' in tables:
            columns = {r['name'] for r in connection.execute('PRAGMA table_info(mesh_peers)')}
            allowed = ['peer_id', 'outbound_status', 'inbound_status', 'outbound_permissions', 'inbound_permissions', 'connection_status']
            selected = [name for name in allowed if name in columns]
            records = []
            for row in connection.execute('SELECT ' + ','.join(selected) + ' FROM mesh_peers LIMIT 50'):
                item = dict(row)
                if 'peer_id' in item:
                    item['peerIdSha256'] = hashed(item.pop('peer_id'))
                records.append(item)
            result['database']['publicPeerTrustMetadata'] = records
        connection.close()
    raw = json.dumps(result, separators=(',', ':')).encode()
    encoded = base64.b64encode(raw).decode()
    parts = [encoded[i:i + 1800] for i in range(0, len(encoded), 1800)]
    for index, part in enumerate(parts):
        print('AURORA_EXISTING_TRUST_V1387 ' + json.dumps({'seq': index, 'total': len(parts), 'data': part}), flush=True)


if __name__ == '__main__':
    main()

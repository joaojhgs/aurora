"""Copy only the reviewed STT delta onto a new immutable Personal source tree.

Run through the existing Root-owned plain Orca control. No runtime imports,
model scans, inference, provider launch, configuration or credential changes.
"""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import io
import json
import os
import shutil
import socket
import sys
import tarfile
import traceback

R = Path('/home/developer/projects/aurora')
OLD = R / 'thesis/sources/personal-p2p-tts-wiring-v1706'
DEST = R / 'thesis/sources/k3-stt-runtime-v1907/personal'
INVENTORY = '6fe434a7d3f07350ba7e8c9fce00414bb5cff8a1ee69b33eafbace73c5473b82'
ARCHIVE = 'b9e270b99545ed630cddcbea337acecca2c29dc5bd5410ddd0faad1e510da79c'
DELTA = {
    'app/services/stt_transcription/service.py': (
        '4723b798b2643cee262e3d1d0ad28114305c3e83c8ef5bae5becd790aac5f888',
        'becf4222d99b02dbc4cac03ad098f275ccb288ceb35f44e945a521701ecaaf49'),
    'app/shared/contracts/models/speech_runtime.py': (
        '1f7ea66c9a4619439130a6a200647b49a1df5b5b8cd17490c5aab0a371e88d94',
        '60113749d6cb874a478cd0551b4d39c7a024b02a3e99c0f0af4a2d2e095db9c7'),
}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def main(payload):
    os.umask(0o077)
    os.nice(10)
    assert socket.gethostname() == 'personal.skyron-server'
    assert all(not Path('/proc', str(p)).exists() for p in [3938174, 3938202])
    terminal = json.loads((R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1813/provider/terminal.json').read_text())
    assert terminal['receiverAbsent'] is True
    assert not DEST.exists(), 'Reconcile existing destination; never retry blindly'
    assert shutil.disk_usage(R).free > 2 * 1024**3 + 32 * 1024**2
    before = (OLD / 'source-inventory.json').read_bytes()
    assert digest(before) == INVENTORY and digest(payload) == ARCHIVE
    inventory = json.loads(before)
    replacements = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as tar:
        members = tar.getmembers()
        assert {m.name for m in members} == set(DELTA)
        for m in members:
            assert m.isfile() and m.size < 1024 * 1024
            raw = tar.extractfile(m).read()
            assert digest(raw) == DELTA[m.name][1]
            replacements[m.name] = raw
    # Validate the whole small source inventory before making a new tree.
    for item in inventory:
        path = Path(item['path'])
        assert not path.is_absolute() and '..' not in path.parts
        raw = (OLD / 'source' / path).read_bytes()
        assert len(raw) == item['bytes'] and digest(raw) == item['sha256']
        if item['path'] in DELTA:
            assert digest(raw) == DELTA[item['path']][0]
    DEST.mkdir(parents=True)
    source = DEST / 'source'
    source.mkdir()
    rows = []
    for item in inventory:
        path = source / item['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = replacements.get(item['path'])
        if raw is None:
            raw = (OLD / 'source' / item['path']).read_bytes()
        path.write_bytes(raw)
        rows.append({'path': item['path'], 'bytes': len(raw), 'sha256': digest(raw)})
    encoded = (json.dumps(rows, indent=2) + '\n').encode()
    (DEST / 'source-inventory.json').write_bytes(encoded)
    (DEST / 'stt-source-delta.tar.gz').write_bytes(payload)
    value = {'at': datetime.now(timezone.utc).isoformat(), 'host': socket.gethostname(),
             'status': 'K3_PERSONAL_SOURCE_FROZEN_NO_RUNTIME_LAUNCH',
             'sourceRoot': str(source), 'sourceInventory': str(DEST / 'source-inventory.json'),
             'sourceInventorySha256': digest(encoded), 'files': len(rows),
             'sourceBytes': sum(r['bytes'] for r in rows), 'baseInventorySha256': INVENTORY,
             'deltaSha256': ARCHIVE, 'changedPaths': sorted(DELTA),
             'oldProviderActorsAbsent': [3938174, 3938202], 'oldSourcesUnchanged': True,
             'runtimeImports': 0, 'sutCalls': 0, 'modelsConfigCredentialsChanged': False,
             'freeBytesAfter': shutil.disk_usage(R).free}
    (DEST / 'SOURCE-RECEIPT.json').write_text(json.dumps(value, indent=2) + '\n')
    return value


if __name__ == '__main__':
    try:
        result = main(base64.b64decode(sys.argv[1], validate=True))
    except Exception as exc:
        result = {'status': 'K3_SOURCE_PREPARATION_REQUIRES_RECONCILIATION',
                  'errorCategory': type(exc).__name__, 'error': str(exc),
                  'location': [{'function': t.name, 'line': t.lineno}
                               for t in traceback.extract_tb(exc.__traceback__)[-3:]],
                  'automaticRetry': False, 'sutCalls': 0}
    encoded = base64.b64encode((json.dumps(result, indent=2) + '\n').encode()).decode()
    parts = [encoded[n:n + 800] for n in range(0, len(encoded), 800)]
    for index, part in enumerate(parts):
        print('AURORA_K3_SOURCE_V1908 ' + json.dumps({'seq': index, 'total': len(parts), 'data': part}), flush=True)

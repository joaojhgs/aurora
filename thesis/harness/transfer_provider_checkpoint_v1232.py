"""Retrieve the already-exported provider checkpoint through existing Orca."""

import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / '.git/aurora-handoff-import-20261006'
DEST = ROOT / 'thesis/evidence/orca-relayed-http-v1197/provider-transfer-v1232'
PAGE = 98304
CAP = 600


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.partial-state')
    with tmp.open('wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)


def encode(value):
    return (json.dumps(value, indent=2) + '\n').encode()


if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    lock = (DEST / 'transfer.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    statepath = DEST / 'STATE.json'
    assert not statepath.exists(), 'Reconcile existing accepted operation; never duplicate this transfer'
    meta = json.loads((BASE / 'v1231-provider-export-RESULT.json').read_text())
    required = meta['bytes'] + meta['rawPayloadBytes'] + 4 * 1024**2
    assert shutil.disk_usage(ROOT).free - required > 2 * 1024**3
    started = time.monotonic()
    state = {'startedAt': now(), 'status': 'transferring_existing_checkpoint',
             'export': meta, 'copiedBytes': 0, 'operation': None, 'pages': [],
             'diskBefore': shutil.disk_usage(ROOT)._asdict(), 'outerSeconds': CAP,
             'sutCalls': 0, 'newAgents': 0,
             'possibleConfound': 'Existing Orca control traffic/disk IO; retain all concurrent measured cases.'}

    def save():
        state['updatedAt'] = now()
        atomic(statepath, encode(state))

    save()
    archive = DEST / Path(meta['archive']).name
    partial = archive.with_name(archive.name + '.partial')
    assert not archive.exists() and not partial.exists()
    try:
        with partial.open('xb') as output:
            for index, offset in enumerate(range(0, meta['bytes'], PAGE)):
                assert time.monotonic() - started < CAP, 'Finite transfer cap; preserve partial'
                name, marker = f'v1232-provider-page-{index:04d}', f'V1232_PAGE_{index:04d}'
                length = min(PAGE, meta['bytes'] - offset)
                code = f'''from pathlib import Path
import json,hashlib,base64
p=Path({meta['archive']!r});assert p.stat().st_size=={meta['bytes']}
with p.open('rb') as stream:stream.seek({offset});data=stream.read({length})
v={{'source':str(p),'offset':{offset},'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'data':base64.b64encode(data).decode()}}
raw=base64.b64encode(json.dumps(v,separators=(',',':')).encode()).decode();parts=[raw[i:i+800] for i in range(0,len(raw),800)]
for i,s in enumerate(parts):print({marker!r}+' '+json.dumps({{'seq':i,'total':len(parts),'data':s}}),flush=True)
'''
                command = "python3 -c \"import base64;exec(base64.b64decode('" + base64.b64encode(code.encode()).decode() + "'))\""
                commandpath = DEST / 'commands' / (name + '.txt')
                atomic(commandpath, (command + '\n').encode())
                state['operation'] = {'name': name, 'marker': marker, 'offset': offset,
                                      'status': 'One read-only send; reconcile same accepted output on failure'}
                save()
                result = subprocess.run([sys.executable, str(ROOT / 'thesis/harness/orca_control_read_v1106.py'),
                                         name, str(commandpath), marker], capture_output=True, text=True, timeout=90)
                atomic(DEST / 'receipts' / (name + '.stdout'), result.stdout.encode())
                atomic(DEST / 'receipts' / (name + '.stderr'), result.stderr.encode())
                assert result.returncode == 0, 'Read helper incomplete; reconcile same accepted page, do not resend'
                transport = json.loads(result.stdout.strip().splitlines()[-1])
                response = json.loads((BASE / transport['resultFile']).read_text())
                raw = base64.b64decode(response['data'], validate=True)
                assert response['source'] == meta['archive'] and response['offset'] == offset
                assert response['bytes'] == len(raw) == length
                assert digest(raw) == response['sha256'] and output.tell() == offset
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
                state['copiedBytes'] = output.tell()
                state['pages'].append({'offset': offset, 'bytes': length, 'sha256': digest(raw),
                                       'nextCursor': transport['nextCursor'], 'receipt': transport['resultFile']})
                state['operation'] = None
                save()
                print(json.dumps({'status': 'copying', 'copiedBytes': output.tell(), 'totalBytes': meta['bytes']}), flush=True)
        assert partial.stat().st_size == meta['bytes']
        assert digest(partial.read_bytes()) == meta['sha256']
        os.replace(partial, archive)
        state['archiveVerified'] = {'path': str(archive.relative_to(ROOT)), 'bytes': meta['bytes'], 'sha256': meta['sha256']}
        state['status'] = 'archive_verified_extracting_exact_raw'
        save()
        with tarfile.open(archive, 'r:gz') as source:
            export = json.loads(source.extractfile('PROVIDER-EXPORT.json').read())
            expected = {item['member']: item for item in export['files']}
            expected.update({name: None for name in ['PROVIDER-EXPORT.json', 'PROVIDER-CURRENT.snapshot.json', 'PROVIDER-RECEIPT.snapshot.json']})
            files = []
            for member in source.getmembers():
                path = Path(member.name)
                assert member.isfile() and not path.is_absolute() and '..' not in path.parts
                assert member.name in expected
                data = source.extractfile(member).read()
                record = expected[member.name]
                if record:
                    assert len(data) == record['bytes'] and digest(data) == record['sha256']
                target = DEST / 'extracted' / path
                assert not target.exists()
                atomic(target, data)
                assert digest(target.read_bytes()) == digest(data)
                files.append({'member': member.name, 'destination': str(target.relative_to(ROOT)), 'bytes': len(data), 'sha256': digest(data)})
            assert len(files) == len(expected)
        state.update({'status': 'complete_checkpoint_copy', 'files': files, 'finishedAt': now(),
                      'rawFiles': len(export['files']), 'rawPayloadBytes': sum(x['bytes'] for x in export['files']),
                      'prefixes': export['prefixes'], 'checkpointSequence': export['checkpointSequence'],
                      'snapshotAt': export['snapshotAt'], 'incompleteCohort': True,
                      'diskAfter': shutil.disk_usage(ROOT)._asdict()})
        save()
        atomic(DEST / 'CUSTODY.json', encode(state))
        print(json.dumps({'status': state['status'], 'rawFiles': state['rawFiles'], 'rawPayloadBytes': state['rawPayloadBytes'], 'receipt': str(DEST / 'CUSTODY.json')}), flush=True)
    except BaseException as exc:
        state.update({'status': 'incomplete_preserved', 'errorClass': type(exc).__name__, 'error': str(exc)})
        save()
        raise

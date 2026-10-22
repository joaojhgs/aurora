"""Copy one Root-admitted saved-timing packet through the existing Orca control."""

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
DEST = ROOT / 'thesis/evidence/sealed-cohorts-v1215/personal-timing-packet-v1338'
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
    meta = json.loads((BASE / 'v1336-personal-timing-export-RESULT.json').read_text())
    required = meta['bytes'] + meta['decodedBytes'] + 4 * 1024**2
    assert shutil.disk_usage(ROOT).free - required > 2 * 1024**3
    started = time.monotonic()
    state = {'startedAt': now(), 'status': 'transferring_saved_timing_packet',
             'export': meta, 'copiedBytes': 0, 'operation': None, 'pages': [],
             'diskBefore': shutil.disk_usage(ROOT)._asdict(), 'outerSeconds': CAP,
             'sutCalls': 0, 'newAgents': 0, 'originalArchivesRecopiedBytes': 0,
             'scope': 'Selected saved timing/outcome projections, not full archives',
             'possibleConfound': 'Existing Orca control traffic/disk IO; retain all concurrent measured cases.'}

    def save():
        state['updatedAt'] = now()
        atomic(statepath, encode(state))

    save()
    archive = DEST / Path(meta['path']).name
    partial = archive.with_name(archive.name + '.partial')
    assert not archive.exists() and not partial.exists()
    try:
        with partial.open('xb') as output:
            for index, offset in enumerate(range(0, meta['bytes'], PAGE)):
                assert time.monotonic() - started < CAP, 'Finite transfer cap; preserve partial'
                name, marker = f'v1338-audit-page-{index:04d}', f'V1338_AUDIT_PAGE_{index:04d}'
                length = min(PAGE, meta['bytes'] - offset)
                code = f'''from pathlib import Path
import json,hashlib,base64
p=Path({meta['path']!r});assert p.stat().st_size=={meta['bytes']}
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
                assert response['source'] == meta['path'] and response['offset'] == offset
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
        import gzip
        raw = gzip.decompress(archive.read_bytes())
        assert len(raw) == meta['decodedBytes'] < 64*1024**2
        packet = json.loads(raw)
        assert packet['schema'] == 'aurora.audit.saved-timing-packet.v1'
        assert packet['noNewMeasurements'] is True
        assert [x['cohort'] for x in packet['archives']] == ['V485', 'V497']
        forbidden = {'authorization','api_key','apiKey','token_secret','access_token',
                     'refresh_token','password','client_secret','audio_base64','audioBase64',
                     'data_base64','dataBase64'}
        def check_private(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    assert key not in forbidden or item in (None, '', False, '[REDACTED]', '***'), 'Nonempty private field; withhold packet'
                    if key == 'textUtf8':
                        check_private(json.loads(item))
                    else:
                        check_private(item)
            elif isinstance(value, list):
                for item in value:
                    check_private(item)
        check_private(packet)
        cohorts=[]
        for item in packet['archives']:
            assert len(item['attempts']) == 915
            assert len({x['member'] for x in item['attempts']}) == 915
            for document in item['documents']:
                payload=document['textUtf8'].encode()
                assert len(payload)==document['bytes'] and digest(payload)==document['sha256']
            cohorts.append({'cohort':item['cohort'],'savedAttemptRows':len(item['attempts']),
                            'archivePath':item['archivePath'],'archiveBytes':item['archiveBytes'],
                            'priorCustodySHA256':item['priorCustodySHA256']})
        state.update({'status':'complete_saved_timing_packet_copy','finishedAt':now(),
                      'cohorts':cohorts,'originalSavedAttemptRows':sum(x['savedAttemptRows'] for x in cohorts),
                      'decodedBytes':len(raw),'privacyFieldCheck':'PASS including embedded JSON documents',
                      'diskAfter':shutil.disk_usage(ROOT)._asdict(),
                      'classification':'Lossless selected timing/outcome projection with source-member identities; not full raw case payloads'})
        save()
        atomic(DEST/'CUSTODY.json',encode(state))
        print(json.dumps({'status':state['status'],'rows':state['originalSavedAttemptRows'],
                          'bytes':meta['bytes'],'sha256':meta['sha256'],'receipt':str(DEST/'CUSTODY.json')}),flush=True)
    except BaseException as exc:
        state.update({'status':'incomplete_preserved','errorClass':type(exc).__name__,'error':str(exc)})
        save()
        raise

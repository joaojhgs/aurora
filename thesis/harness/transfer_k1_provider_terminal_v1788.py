"""Retrieve new provider files only; preserve the completed new provider source; no prior-cohort files recopied."""

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
DEST = ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/provider-transfer-terminal-v1788'
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
    os.umask(0o077)
    DEST.mkdir(parents=True, exist_ok=True)
    lock = (DEST / 'transfer.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    statepath = DEST / 'STATE.json'
    assert not statepath.exists(), 'Reconcile existing accepted operation; never duplicate this transfer'
    meta = json.loads((BASE / 'k1-eof-seal-v1784-RESULT.json').read_text())
    required = meta['bytes'] + meta['rawPayloadBytes'] + 4 * 1024**2
    assert shutil.disk_usage(ROOT).free - required > 2 * 1024**3
    started = time.monotonic()
    state = {'startedAt': now(), 'status': 'transferring_existing_checkpoint',
             'export': meta, 'copiedBytes': 0, 'operation': None, 'pages': [],
             'diskBefore': shutil.disk_usage(ROOT)._asdict(), 'outerSeconds': CAP, 'priorTransportAttempt': 'V1785 archive-page0 output missing214segments due bounded terminal history; original archive intact. Fresh smaller read-only pages, no inference replay.',
             'sutCalls': 0, 'newAgents': 0, 'newK1ProviderArchiveBytes': meta['bytes'],
             'baseline': None,
             'possibleConfound': 'Post-requester-terminal retrieval of existing checksummed archive; no active measurements or new SUT traffic; all original provider owners retired.'}

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
                name, marker = f'k1-eof-v1788-provider-page-{index:04d}', f'K1_EOF_V1788_PROVIDER_PAGE_{index:04d}'
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
                result = subprocess.run([sys.executable, str(ROOT / 'thesis/harness/orca_copy_control_raw_read_v1652.py'),
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
            sealraw=source.extractfile('PROVIDER-SEAL.json').read()
            assert digest(sealraw)==meta['sealSha256']
            export=json.loads(sealraw)
            expected={item['member']:item for item in export['files']}
            expected['PROVIDER-SEAL.json']=None
            files=[]
            for member in source.getmembers():
                assert member.isfile() and member.name in expected
                path=Path(member.name);assert not path.is_absolute() and '..'not in path.parts
                record=expected[member.name];h=hashlib.sha256();size=0
                stream=source.extractfile(member)
                for chunk in iter(lambda:stream.read(1048576),b''):h.update(chunk);size+=len(chunk)
                if record:assert size==record['bytes']and h.hexdigest()==record['sha256']
                files.append({'member':member.name,'bytes':size,'sha256':h.hexdigest(),'custody':'verified member of physical retained archive'})
            assert len(files)==len(expected)
            atomic(DEST/'PROVIDER-SEAL.json',sealraw)
        state.update(status='complete_verified_provider_terminal_archive',files=files,
            finishedAt=now(),rawFiles=len(export['files']),rawPayloadBytes=export['rawPayloadBytes'],
            originalRawPreserved=True,duplicateUncompressedBytes=0,sutCalls=0,
            actorsAbsent=True,K1Measured=export['K1Measured'],diskAfter=shutil.disk_usage(ROOT)._asdict())
        save();atomic(DEST/'CUSTODY.json',encode(state))
        print(json.dumps({'status':state['status'],'rawFiles':state['rawFiles'],
            'rawPayloadBytes':state['rawPayloadBytes'],'physicalArchiveBytes':meta['bytes'],
            'sha256':meta['sha256'],'receipt':str(DEST/'CUSTODY.json')}),flush=True)
    except BaseException as exc:
        state.update({'status': 'incomplete_preserved', 'errorClass': type(exc).__name__, 'error': str(exc)})
        save()
        raise

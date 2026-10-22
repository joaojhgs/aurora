"""Retire only the identified, quiescent K1 provider and seal its saved data.

Executed by Root through the existing Personal control shell. No inference,
credential changes, forced kill, original-file overwrite or agent lifecycle.
"""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
import shutil
import signal
import socket
import tarfile
import time

ROOT = Path('/home/developer/projects/aurora')
SOURCE = ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/provider'
DEST = SOURCE.parent / 'terminal-v1783'
ACTORS = [(3194385, 22320508), (3194394, 22320527)]


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, raw):
    with path.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def actor(pid, expected):
    p = Path('/proc', str(pid), 'stat')
    if not p.exists():
        return {'pid': pid, 'expectedStartTicks': expected, 'absent': True}
    fields = p.read_text().rsplit(')', 1)[1].split()
    assert int(fields[19]) == expected, 'PID reused; never signal'
    return {'pid': pid, 'expectedStartTicks': expected,
            'startTicks': int(fields[19]), 'state': fields[0], 'absent': False}


def main():
    os.umask(0o077)
    assert socket.gethostname() == 'personal.skyron-server'
    assert not DEST.exists(), 'Existing operation requires reconciliation, not replay'
    raw = (SOURCE / 'provider-manifest.json').read_bytes()
    assert sha(raw) == '245d1739111a7162287fcece91dc005958722e062a1e028613c3f85e21e3d339'
    manifest = json.loads(raw)
    config_raw = Path(manifest['config']).read_bytes()
    assert sha(config_raw) == '06a199cfb688cd952359bc5fadfc26ca83fabf13059a0f9fa3d581832eb62493'
    secrets = []

    def collect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if any(s in key.lower() for s in ['secret', 'password', 'api_key', 'access_token', 'refresh_token']):
                    if isinstance(item, str) and len(item) >= 8:
                        secrets.append(item.encode())
                else:
                    collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(json.loads(config_raw))
    before = [actor(*a) for a in ACTORS]
    assert all(not a['absent'] and a['state'] not in ['Z', 'X', 'x'] for a in before)
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 160 * 1024**2
    DEST.mkdir()
    write(DEST / 'RETIRE-INTENT.json', encoded({
        'at': now(), 'actors': before, 'signal': 'SIGINT to exact owned receiver only',
        'rootVerifiedWorkerRequesterActorsAbsent': [2360747, 2360768, 2361201, 2361202,
                                                   2747722, 2747791, 2748029, 2748030],
        'sutCalls': 0, 'maximumSignals': 1, 'newWorker': False,
        'reason': 'Requester epochs sealed; transition to independently qualified K2 condition; K1 191 remain open'}))
    actor(*ACTORS[1])
    os.kill(ACTORS[1][0], signal.SIGINT)
    deadline = time.monotonic() + 65
    while time.monotonic() < deadline:
        after = [actor(*a) for a in ACTORS]
        if all(a['absent'] for a in after):
            break
        time.sleep(.5)
    else:
        result = {'at': now(), 'status': 'graceful_retirement_pending_no_retry_or_force',
                  'actors': after, 'sutCalls': 0}
        write(DEST / 'RETIRE-PENDING.json', encoded(result))
        return result
    terminal = json.loads((SOURCE / 'terminal.json').read_bytes())
    state = json.loads((SOURCE / 'STATUS.json').read_bytes())
    assert terminal['receiverAbsent'] is True and state['ownRuntimeRetired'] is True
    names = ['provider-manifest.json', 'controller-launch.json', 'receiver-identity.json',
             'runtime-versions.json', 'terminal.json', 'STATUS.json', 'voice-stages.jsonl',
             'actual-provider-bindings.jsonl', 'resources.jsonl']
    selected = [SOURCE / n for n in names]
    assert all(p.is_file() and not p.is_symlink() for p in selected)
    assert sum(p.stat().st_size for p in selected) < 128 * 1024**2
    (DEST / 'raw').mkdir()
    records = []
    for source in selected:
        before_stat = source.stat()
        data = source.read_bytes()
        after_stat = source.stat()
        assert (before_stat.st_ino, before_stat.st_size, before_stat.st_mtime_ns) == (
            after_stat.st_ino, after_stat.st_size, after_stat.st_mtime_ns)
        assert not any(secret in data for secret in secrets), 'Private value detected; source preserved, export refused'
        if source.suffix == '.jsonl':
            assert not data or data.endswith(b'\n'), 'Incomplete terminal line preserved; requires explicit reconciliation'
        target = DEST / 'raw' / source.name
        write(target, data)
        assert sha(target.read_bytes()) == sha(data)
        records.append({'name': 'raw/' + source.name, 'source': str(source),
                        'bytes': len(data), 'sha256': sha(data), 'sourceInode': before_stat.st_ino,
                        'terminalEOF': True})
    report = {'at': now(), 'host': socket.gethostname(), 'status': 'original_provider_retired_raw_eof_sealed',
              'actors': after, 'files': records, 'rawPayloadBytes': sum(x['bytes'] for x in records),
              'providerManifestSha256': sha(raw), 'postStartupConfigSha256': sha(config_raw),
              'sutCalls': 0, 'originalFilesPreserved': True, 'K1MeasuredAttempted': 709,
              'K1Correct': 697, 'K1Failed': 12, 'K1Unattempted': 191,
              'failedWarmupEpochV1779Measured': 0, 'exactRejectionPredicate': 'UNKNOWN',
              'comparisonStatus': 'Incomplete K1 condition; no new or pooled full-condition percentiles'}
    write(DEST / 'PROVIDER-SEAL.json', encoded(report))
    archive = DEST / 'provider-eof-v1783.tar.gz'
    with archive.open('xb') as output:
        with tarfile.open(fileobj=output, mode='w:gz') as bundle:
            for item in records:
                bundle.add(DEST / item['name'], arcname=item['name'], recursive=False)
            bundle.add(DEST / 'PROVIDER-SEAL.json', arcname='PROVIDER-SEAL.json', recursive=False)
        output.flush()
        os.fsync(output.fileno())
    result = {k: v for k, v in report.items() if k != 'files'}
    result.update(archive=str(archive), bytes=archive.stat().st_size,
                  sha256=sha(archive.read_bytes()), files=len(records),
                  sealSha256=sha((DEST / 'PROVIDER-SEAL.json').read_bytes()))
    write(DEST / 'EXPORT-RECEIPT.json', encoded(result))
    return result


if __name__ == '__main__':
    try:
        result = main()
    except Exception as exc:
        result = {'at': now(), 'status': 'retirement_or_seal_requires_reconciliation',
                  'errorCategory': type(exc).__name__, 'error': str(exc), 'automaticRetry': False}
    raw = base64.b64encode(encoded(result)).decode()
    parts = [raw[i:i + 800] for i in range(0, len(raw), 800)]
    for i, piece in enumerate(parts):
        print('AURORA_K1_PROVIDER_RETIRE_V1783 ' + json.dumps(
            {'seq': i, 'total': len(parts), 'data': piece}), flush=True)

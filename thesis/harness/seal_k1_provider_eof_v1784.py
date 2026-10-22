"""Archive already-retired K1 provider files; never signal or invoke Aurora."""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
import socket
import tarfile
import time
import traceback

R = Path('/home/developer/projects/aurora')
S = R / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/provider'
D = S.parent / 'terminal-v1783'


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024**2), b''):
            h.update(block)
    return h.hexdigest()


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2, sort_keys=True)
        f.write('\n'); f.flush(); os.fsync(f.fileno())


def main():
    os.umask(0o077)
    assert socket.gethostname() == 'personal.skyron-server'
    assert not any(Path('/proc', str(p)).exists() for p in [3194385, 3194394])
    assert json.loads((S / 'terminal.json').read_bytes())['receiverAbsent'] is True
    assert json.loads((S / 'STATUS.json').read_bytes())['ownRuntimeRetired'] is True
    assert digest(S / 'provider-manifest.json') == '245d1739111a7162287fcece91dc005958722e062a1e028613c3f85e21e3d339'
    intent = {'at': now(), 'operation': 'saved_data_archive_only', 'sutCalls': 0,
              'signals': 0, 'maximumArchives': 1, 'originalRawFilesPreserved': True}
    write(D / 'SEAL-INTENT-v1784.json', intent)
    names = ['terminal.json', 'runtime-versions.json', 'STATUS.json', 'receiver-identity.json',
             'provider-manifest.json', 'controller-launch.json', 'voice-stages.jsonl',
             'voice-stages.status.json', 'actual-provider-bindings.jsonl',
             'ROOT-LAUNCH.json', 'resources.jsonl']
    sizes = {n: (S / n).stat() for n in names}
    assert sum(s.st_size for s in sizes.values()) < 512 * 1024**2
    stat = os.statvfs(D)
    assert stat.f_bavail * stat.f_frsize > 2 * 1024**3 + 512 * 1024**2
    records = []
    start = time.monotonic()
    for n in names:
        p = S / n
        assert p.is_file() and not p.is_symlink()
        original = sizes[n]
        h = digest(p)
        after = p.stat()
        assert (original.st_ino, original.st_size, original.st_mtime_ns) == (
            after.st_ino, after.st_size, after.st_mtime_ns)
        records.append({'member': 'raw/' + n, 'source': str(p), 'bytes': after.st_size,
                        'sha256': h, 'terminalEOF': True, 'sourceInode': after.st_ino})
    report = {'at': now(), 'host': socket.gethostname(), 'status': 'provider_eof_sealed',
              'retirement': json.loads((S / 'terminal.json').read_bytes()),
              'files': records, 'rawPayloadBytes': sum(x['bytes'] for x in records),
              'sutCalls': 0, 'originalRawPreserved': True, 'duplicateUncompressedCopyBytes': 0,
              'K1Measured': {'attempted': 709, 'correct': 697, 'failed': 12, 'unattempted': 191},
              'V1779': {'excludedWarmups': 3, 'correct': 2, 'failed': 1, 'measured': 0},
              'exactRejectionPredicate': 'UNKNOWN', 'noFull900OrPooledPercentileClaim': True}
    write(D / 'PROVIDER-SEAL.json', report)
    archive = D / 'provider-eof-v1784.tar.gz'
    with archive.open('xb') as output:
        with tarfile.open(fileobj=output, mode='w:gz', compresslevel=3) as bundle:
            for item in records:
                bundle.add(item['source'], arcname=item['member'], recursive=False)
            bundle.add(D / 'PROVIDER-SEAL.json', arcname='PROVIDER-SEAL.json', recursive=False)
        output.flush(); os.fsync(output.fileno())
    for n in names:
        a, b = sizes[n], (S / n).stat()
        assert (a.st_ino, a.st_size, a.st_mtime_ns) == (b.st_ino, b.st_size, b.st_mtime_ns)
    result = {'at': now(), 'host': socket.gethostname(), 'status': 'provider_eof_archive_verified',
              'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': digest(archive),
              'files': len(records), 'rawPayloadBytes': report['rawPayloadBytes'],
              'sealSha256': digest(D / 'PROVIDER-SEAL.json'), 'elapsedSeconds': time.monotonic() - start,
              'actorsAbsent': True, 'sutCalls': 0, 'noDuplicateUncompressedCopy': True}
    write(D / 'EXPORT-RECEIPT-v1784.json', result)
    return result


if __name__ == '__main__':
    try:
        value = main()
    except Exception as exc:
        value = {'status': 'seal_requires_reconciliation', 'errorCategory': type(exc).__name__,
                 'error': str(exc), 'location': [{'function': x.name, 'line': x.lineno}
                 for x in traceback.extract_tb(exc.__traceback__)[-3:]], 'automaticRetry': False}
    raw = base64.b64encode(json.dumps(value).encode()).decode()
    parts = [raw[i:i+800] for i in range(0, len(raw), 800)]
    for i, s in enumerate(parts):
        print('AURORA_K1_EOF_SEAL_V1784 ' + json.dumps({'seq': i, 'total': len(parts), 'data': s}), flush=True)

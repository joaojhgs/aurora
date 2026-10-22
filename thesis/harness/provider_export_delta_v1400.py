"""Copy only new immutable provider custody files; never invoke Aurora."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import tarfile
import time

ROOT = Path('/home/developer/projects/aurora')
SOURCE = ROOT / 'thesis/evidence/orca-relayed-http-v1197/provider'
DEST = SOURCE.parent / 'provider-exports'
RATE = 4 * 1024**2
RESERVE = 2 * 1024**3
MAX_PAYLOAD = 128 * 1024**2


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def select_delta(state, baseline):
    """Require unchanged retained identities and select new file keys only."""
    previous = {}
    for record in baseline['files']:
        member = record['member']
        assert member.startswith('provider-raw/')
        name = member.removeprefix('provider-raw/')
        assert name not in previous
        previous[name] = record
    for name, record in state['files'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert name == relative.as_posix() and name not in ('', '.')
    for name, record in previous.items():
        current = state['files'][name]
        assert (current['bytes'], current['sha256']) == (record['bytes'], record['sha256']), name
    return [(name, record) for name, record in state['files'].items() if name not in previous]


def export(baseline_path):
    DEST.mkdir(parents=True, exist_ok=True)
    receipt_path = DEST / 'CUSTODY-delta-v1400.json'
    assert not receipt_path.exists(), 'Retrieve an existing export; never repeat it'
    started = now()
    baseline_bytes = baseline_path.read_bytes()
    baseline = json.loads(baseline_bytes)
    snapshot = (SOURCE / 'CURRENT.json').read_bytes()
    state = json.loads(snapshot)
    selected = select_delta(state, baseline)
    payload = sum(record['bytes'] for _, record in selected)
    assert selected and payload <= MAX_PAYLOAD
    before_disk = shutil.disk_usage(ROOT)._asdict()
    assert before_disk['free'] - payload - 4 * 1024**2 > RESERVE
    inventory = {
        'schema': 'aurora.provider-raw-delta-export.v1', 'host': socket.gethostname(),
        'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
        'snapshotSha256': digest(snapshot), 'incomplete': True,
        'baseline': {'path': str(baseline_path), 'bytes': len(baseline_bytes),
                     'sha256': digest(baseline_bytes), 'files': len(baseline['files']),
                     'rawPayloadBytes': sum(x['bytes'] for x in baseline['files'])},
        'files': [{'member': 'provider-raw/' + name, **record} for name, record in selected],
        'prefixes': state['prefixes'], 'sutCalls': 0,
    }
    target = DEST / f"provider-checkpoint-{state['sequence']:06d}-delta-v1400.tar.gz"
    temporary = target.with_name(target.name + '.partial')
    assert not target.exists() and not temporary.exists()
    start_copy = time.monotonic()
    copied = [0]

    class Reader:
        def __init__(self, stream):
            self.stream = stream
            self.hash = hashlib.sha256()

        def read(self, length):
            assert time.monotonic() - start_copy < 120, 'Bounded copy elapsed; preserve partial'
            block = self.stream.read(length)
            self.hash.update(block)
            copied[0] += len(block)
            time.sleep(max(0, copied[0] / RATE - (time.monotonic() - start_copy)))
            return block

    with temporary.open('xb') as output:
        with gzip.GzipFile(fileobj=output, mode='wb', compresslevel=1, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|') as archive:
                fixed = [('PROVIDER-CURRENT.snapshot.json', snapshot),
                         ('PROVIDER-RECEIPT.snapshot.json', (ROOT / state['lastReceipt']).read_bytes()),
                         ('PROVIDER-EXPORT.json', (json.dumps(inventory, indent=2) + '\n').encode())]
                for name, data in fixed:
                    info = tarfile.TarInfo(name)
                    info.size, info.mode = len(data), 0o600
                    archive.addfile(info, io.BytesIO(data))
                for name, record in selected:
                    source = SOURCE / name
                    assert source.is_file() and not source.is_symlink()
                    with source.open('rb') as stream:
                        before = os.fstat(stream.fileno())
                        assert before.st_size == record['bytes']
                        reader = Reader(stream)
                        info = tarfile.TarInfo('provider-raw/' + name)
                        info.size, info.mode = record['bytes'], 0o600
                        archive.addfile(info, reader)
                        after = os.fstat(stream.fileno())
                        assert (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
                        assert reader.hash.hexdigest() == record['sha256']
        output.flush()
        os.fsync(output.fileno())
    archive_hash = hashlib.sha256()
    with temporary.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2), b''):
            archive_hash.update(block)
    os.replace(temporary, target)
    receipt = {
        'startedAt': started, 'finishedAt': now(), 'host': socket.gethostname(),
        'archive': str(target), 'bytes': target.stat().st_size, 'sha256': archive_hash.hexdigest(),
        'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
        'rawFiles': len(selected), 'rawPayloadBytes': payload, 'prefixes': state['prefixes'],
        'baseline': inventory['baseline'], 'baselineRawRecopiedBytes': 0,
        'diskBefore': before_disk, 'diskAfter': shutil.disk_usage(ROOT)._asdict(),
        'sutCalls': 0, 'copyRateBytesPerSecond': RATE,
        'possibleConfound': 'Bounded delta export disk IO/compression concurrent with K2 V1264 on the original V1197 provider; keep every measured case.',
    }
    tmp_receipt = receipt_path.with_suffix('.partial')
    with tmp_receipt.open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp_receipt, receipt_path)
    fd = os.open(DEST, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute-delta-copy', action='store_true')
    parser.add_argument('--baseline', type=Path, required=True)
    args = parser.parse_args()
    if not args.execute_delta_copy:
        parser.error('Explicit copy-only execution flag required; no export performed')
    print(json.dumps(export(args.baseline)), flush=True)

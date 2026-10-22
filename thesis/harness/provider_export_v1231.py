"""Export one immutable provider custody checkpoint, without any SUT calls."""

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


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


if __name__ == '__main__':
    DEST.mkdir(parents=True, exist_ok=True)
    receipt_path = DEST / 'CUSTODY-v1231.json'
    assert not receipt_path.exists(), 'Existing export must be retrieved, not restarted'
    started = now()
    before_disk = shutil.disk_usage(ROOT)._asdict()
    snapshot = (SOURCE / 'CURRENT.json').read_bytes()
    state = json.loads(snapshot)
    paths = []
    for name, record in state['files'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        paths.append((SOURCE / relative, 'provider-raw/' + name, record))
    payload = sum(record['bytes'] for _, _, record in paths)
    assert shutil.disk_usage(ROOT).free - payload > RESERVE
    export = {'schema': 'aurora.provider-raw-export.v1', 'host': socket.gethostname(),
              'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
              'snapshotSha256': digest(snapshot), 'incomplete': True,
              'files': [{'member': name, **record} for _, name, record in paths],
              'prefixes': state['prefixes'], 'sutCalls': 0}
    target = DEST / f"provider-checkpoint-{state['sequence']:06d}-v1231.tar.gz"
    temporary = target.with_name(target.name + '.partial')
    assert not target.exists() and not temporary.exists()
    started_copy = time.monotonic()
    copied = [0]

    class Reader:
        def __init__(self, stream):
            self.stream = stream
            self.hash = hashlib.sha256()

        def read(self, length):
            block = self.stream.read(length)
            self.hash.update(block)
            copied[0] += len(block)
            time.sleep(max(0, copied[0] / RATE - (time.monotonic() - started_copy)))
            return block

    with temporary.open('xb') as output:
        with gzip.GzipFile(fileobj=output, mode='wb', compresslevel=1, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|') as archive:
                fixed = [('PROVIDER-CURRENT.snapshot.json', snapshot),
                         ('PROVIDER-RECEIPT.snapshot.json', (ROOT / state['lastReceipt']).read_bytes()),
                         ('PROVIDER-EXPORT.json', (json.dumps(export, indent=2) + '\n').encode())]
                for name, data in fixed:
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mode = 0o600
                    archive.addfile(info, io.BytesIO(data))
                for source, name, record in paths:
                    assert source.is_file() and not source.is_symlink()
                    with source.open('rb') as stream:
                        before = os.fstat(stream.fileno())
                        assert before.st_size == record['bytes']
                        reader = Reader(stream)
                        info = tarfile.TarInfo(name)
                        info.size = record['bytes']
                        info.mode = 0o600
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
    receipt = {'startedAt': started, 'finishedAt': now(), 'host': socket.gethostname(),
               'archive': str(target), 'bytes': target.stat().st_size, 'sha256': archive_hash.hexdigest(),
               'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
               'rawFiles': len(paths), 'rawPayloadBytes': payload, 'prefixes': state['prefixes'],
               'diskBefore': before_disk, 'diskAfter': shutil.disk_usage(ROOT)._asdict(),
               'sutCalls': 0, 'copyRateBytesPerSecond': RATE,
               'possibleConfound': 'Bounded export disk IO/compression concurrent with1197; keep every measured case.'}
    temporary_receipt = receipt_path.with_suffix('.partial')
    with temporary_receipt.open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_receipt, receipt_path)
    fd = os.open(DEST, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
    print(json.dumps(receipt), flush=True)

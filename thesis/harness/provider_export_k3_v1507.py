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
SOURCE = ROOT / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1413/provider'
DEST = SOURCE.parent / 'provider-exports'
RATE = 4 * 1024**2
RESERVE = 2 * 1024**3


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def provider_state():
    result = {}
    for pid, ticks in [(1227847, 6621440), (1227894, 6621473), (1229873, 6630651)]:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        assert int(fields[19]) == ticks and fields[0] not in ['Z', 'X', 'x']
        result[str(pid)] = {'startTicks': int(fields[19]), 'state': fields[0]}
    return result


def frozen_identity():
    path = ROOT / '.git/aurora-handoff-import-20261006/distributed-k3-http-provider-v1476/input/provider-manifest.json'
    raw = path.read_bytes()
    assert digest(raw) == 'b4b95d579c29695832c05d96692f2f15fd51cf3258333b9175091ab357280887'
    manifest = json.loads(raw)
    config_hash = digest(Path(manifest['launch_config']['path']).read_bytes())
    assert config_hash == 'aa03866778b9a57e71a47bcab1a87dcd9adfadad2ec0974c127b98f80b40fba6'
    return {'providerManifestSha256': digest(raw), 'configSha256': config_hash}


if __name__ == '__main__':
    assert socket.gethostname() == 'personal.skyron-server'
    provider_before = provider_state()
    frozen_before = frozen_identity()
    DEST.mkdir(parents=True, exist_ok=True)
    receipt_path = DEST / 'CUSTODY-v1507.json'
    assert not receipt_path.exists(), 'Existing export must be retrieved, not restarted'
    started = now()
    before_disk = shutil.disk_usage(ROOT)._asdict()
    snapshot = (SOURCE / 'CURRENT.json').read_bytes()
    state = json.loads(snapshot)
    paths = []
    for name, record in state['files'].items():
        relative = Path(name)
        assert relative.name not in ['.env', 'config.json'] and not relative.name.endswith('.env')
        assert not relative.is_absolute() and '..' not in relative.parts
        paths.append((SOURCE / relative, 'provider-raw/' + name, record))
    payload = sum(record['bytes'] for _, _, record in paths)
    assert shutil.disk_usage(ROOT).free - payload > RESERVE
    export = {'schema': 'aurora.provider-raw-export.v1', 'host': socket.gethostname(),
              'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
              'snapshotSha256': digest(snapshot), 'incomplete': True,
              'files': [{'member': name, **record} for _, name, record in paths],
              'prefixes': state['prefixes'], 'sutCalls': 0}
    target = DEST / f"provider-checkpoint-{state['sequence']:06d}-v1507.tar.gz"
    temporary = target.with_name(target.name + '.partial')
    assert not target.exists() and not temporary.exists()
    started_copy = time.monotonic()
    copied = [0]

    class Reader:
        def __init__(self, stream):
            self.stream = stream
            self.hash = hashlib.sha256()

        def read(self, length):
            assert time.monotonic() - started_copy < 180, 'Finite export cap; preserve partial, do not restart blindly'
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
               'possibleConfound': 'Post-requester-terminal immutable checkpoint export; no measured V1481 traffic remains. Original provider and resource sampler continue; incomplete flags preserved.'}
    receipt.update({'providerBefore': provider_before, 'providerAfter': provider_state(), 'frozenBefore': frozen_before, 'frozenAfter': frozen_identity(), 'exporterSourceSha256': digest(Path(__file__).read_bytes()), 'outerSeconds': 180, 'requestedCohort': 'V1481', 'sourceIncludesPriorUnadmittedV1413': True, 'newAgents': 0, 'modelsOrSettingsChanged': False})
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

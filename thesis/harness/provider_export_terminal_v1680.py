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
SOURCE = ROOT / 'thesis/campaigns/worker-desktop-k3-remaining160-v1680/provider'
DEST = SOURCE.parent / 'provider-exports'
RATE = 4 * 1024**2
RESERVE = 2 * 1024**3
MAX_PAYLOAD = 128 * 1024**2


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def provider_state():
    result = {}
    for pid, ticks in [(2991328, 21245666), (2991345, 21245707), (2991329, 21245666)]:
        path = Path('/proc', str(pid), 'stat')
        row = {'pid': pid, 'expectedStartTicks': ticks, 'present': path.exists()}
        if path.exists():
            fields = path.read_text().rsplit(')', 1)[1].split()
            row.update(startTicks=int(fields[19]), state=fields[0])
            assert int(fields[19]) != ticks or fields[0] in ['Z', 'X', 'x'], 'Original provider owner still live; no terminal seal'
        result[str(pid)] = row
    return result


def frozen_identity():
    path = ROOT / '.git/aurora-handoff-import-20261006/distributed-k3-http-provider-v1680/input/provider-manifest.json'
    raw = path.read_bytes()
    assert digest(raw) == '61fe867af6495a6e130c1148b73b97ac3ca14755dbcba9a034a155d04fa2d62e'
    manifest = json.loads(raw)
    config_hash = digest(Path(manifest['launch_config']['path']).read_bytes())
    assert config_hash == 'aa03866778b9a57e71a47bcab1a87dcd9adfadad2ec0974c127b98f80b40fba6'
    return {'providerManifestSha256': digest(raw), 'configSha256': config_hash}




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


def terminal_snapshot(original):
    import re
    state = json.loads(original)
    assert state['sequence'] == 103 and len(state['files']) == 386 and sum(item['bytes'] for item in state['files'].values()) == 29891877
    provider = ROOT / '.git/aurora-handoff-import-20261006/distributed-k3-http-provider-v1680'
    private = []
    def gather(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if re.search(r'secret|password|api.?keys?|access_token|refresh_token|authorization', key, re.I):
                    def collect(v):
                        if isinstance(v, str) and len(v) >= 8:
                            private.append(v.encode())
                        elif isinstance(v, (dict, list)):
                            for x in (v.values() if isinstance(v, dict) else v): collect(x)
                    collect(item)
                else: gather(item)
        elif isinstance(value, list):
            for item in value: gather(item)
    launch = json.loads((provider/'input/provider-manifest.json').read_bytes())
    for cfg in [Path(launch['launch_config']['path']), ROOT / '.git/aurora-handoff-import-20261006/distributed-k1-http-provider-v1126/input/launch-config.json', ROOT / '.git/aurora-handoff-import-20261006/distributed-k1-http-provider-v1126/runtime/config.json']:
        if cfg.exists(): gather(json.loads(cfg.read_bytes()))
    additions = []
    def retain(path, relative, data, **extra):
        assert not any(secret in data for secret in private), 'Private value detected; do not export'
        target = SOURCE / relative
        assert relative not in state['files'] and not target.exists()
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + '.partial-post900-v1680')
        with tmp.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        assert digest(tmp.read_bytes()) == digest(data)
        os.replace(tmp, target)
        record = {'source': str(path), 'destination': str(target.relative_to(ROOT)), 'bytes': len(data), 'sha256': digest(data), 'at': now(), **extra}
        state['files'][relative] = record
        additions.append({'name': relative, **record})
    for name, prefix in state['prefixes'].items():
        path = provider / 'runtime' / name
        meta = path.stat()
        assert meta.st_ino == prefix['inode'] and meta.st_size >= prefix['endByte']
        assert meta.st_size - prefix['endByte'] <= 4 * 1024**2
        start = prefix['endByte']
        if meta.st_size > start:
            with path.open('rb') as stream:
                stream.seek(start); data = stream.read(4 * 1024**2)
            assert data.endswith(b'\n') and len(data) == meta.st_size - start
            relative = f'prefixes/{name}/{start:012d}-{meta.st_size:012d}.chunk'
            retain(path, relative, data, startByte=start, endByte=meta.st_size, incomplete=False, sourceInode=meta.st_ino, sourceObservedBytes=meta.st_size)
            prefix['chunks'].append(relative)
        after = path.stat()
        assert (meta.st_ino, meta.st_size, meta.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
        prefix.update(endByte=meta.st_size, sourceObservedBytes=meta.st_size, observedAt=now(), incomplete=False)
    for path, label in [(provider/'runtime/backend.private.log', 'backend'), (provider/'controller.private.log', 'controller'), (provider/'copier.private.log', 'copier')]:
        if not path.exists(): continue
        meta = path.stat(); assert meta.st_size <= 2 * 1024**2
        raw = path.read_bytes(); after = path.stat()
        assert (meta.st_ino,meta.st_size,meta.st_mtime_ns)==(after.st_ino,after.st_size,after.st_mtime_ns)
        data = raw; removed = 0
        for secret in private:
            removed += data.count(secret); data = data.replace(secret,b'[REDACTED_CREDENTIAL]')
        data = re.sub(rb'(?i)(Bearer\s+)[A-Za-z0-9._~+/-]+=*', rb'\1[REDACTED_CREDENTIAL]', data)
        retain(path, f'terminal-post900-v1680/{label}.redacted.log', data, originalBytes=len(raw), originalSha256=digest(raw), exactPrivateValueRedactions=removed, credentialPatternRedactionApplied=True)
    state['terminalDerivation'] = {'at': now(), 'sourceSequence': 103, 'originalCurrentSha256': digest(original), 'sourceCURRENTUnchanged': True, 'allOriginalOwnersAbsent': True, 'newFiles': additions, 'newSutCalls': 0}
    return (json.dumps(state, indent=2, sort_keys=True)+'\n').encode(), state


def export(baseline_path):
    DEST.mkdir(parents=True, exist_ok=True)
    receipt_path = DEST / 'CUSTODY-delta-post900-v1680.json'
    assert not receipt_path.exists(), 'Retrieve an existing export; never repeat it'
    provider_before = provider_state()
    frozen_before = frozen_identity()
    started = now()
    baseline_bytes = baseline_path.read_bytes()
    baseline = json.loads(baseline_bytes)
    original_snapshot = (SOURCE / 'CURRENT.json').read_bytes()
    assert shutil.disk_usage(ROOT).free > RESERVE + 150 * 1024**2
    snapshot, state = terminal_snapshot(original_snapshot)
    selected = select_delta(state, baseline)
    payload = sum(record['bytes'] for _, record in selected)
    assert selected and payload <= MAX_PAYLOAD
    before_disk = shutil.disk_usage(ROOT)._asdict()
    assert before_disk['free'] - payload - 4 * 1024**2 > RESERVE
    inventory = {
        'schema': 'aurora.provider-raw-delta-export.v1', 'host': socket.gethostname(),
        'checkpointSequence': state['sequence'], 'snapshotAt': state['updatedAt'],
        'snapshotSha256': digest(snapshot), 'incomplete': False,
        'terminalDerivation': state['terminalDerivation'], 'originalCurrentSha256': digest(original_snapshot),
        'baseline': {'path': str(baseline_path), 'bytes': len(baseline_bytes),
                     'sha256': digest(baseline_bytes), 'files': len(baseline['files']),
                     'rawPayloadBytes': sum(x['bytes'] for x in baseline['files'])},
        'files': [{'member': 'provider-raw/' + name, **record} for name, record in selected],
        'prefixes': state['prefixes'], 'sutCalls': 0,
    }
    target = DEST / f"provider-checkpoint-{state['sequence']:06d}-delta-post900-v1680.tar.gz"
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
                         ('PROVIDER-EXPORT.json', (json.dumps(inventory, indent=2) + '\n').encode()),
                         ('PROVIDER-CURRENT.original-preterminal.json', original_snapshot)]
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
        'providerBefore': provider_before, 'providerAfter': provider_state(),
        'frozenBefore': frozen_before, 'frozenAfter': frozen_identity(),
        'requestedCohort': 'V1682 final160 measured plus15excluded warmups; original740 retained separately', 'exporterSourceSha256': digest(Path(__file__).read_bytes()),
        'diskBefore': before_disk, 'diskAfter': shutil.disk_usage(ROOT)._asdict(),
        'sutCalls': 0, 'copyRateBytesPerSecond': RATE,
        'possibleConfound': 'Post-requester-terminal export of saved data from the original K3 provider; zero SUT calls, no active measurements. All original provider owners are retired; original CURRENT103 is preserved and the EOF derivative is explicit.',
    }
    assert (SOURCE / 'CURRENT.json').read_bytes() == original_snapshot
    receipt['terminalDerivation'] = state['terminalDerivation']
    receipt['originalCURRENTUnchanged'] = True
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

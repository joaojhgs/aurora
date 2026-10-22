"""Bounded custody of an admitted future K3 Personal provider; zero SUT calls."""

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time

ROOT = Path('/home/developer/projects/aurora')
SOURCE = ROOT / '.git/aurora-handoff-import-20261006/distributed-k3-http-provider-v1674'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-remaining160-v1674/provider'
RATE = 4 * 1024**2
RESERVE = 2 * 1024**3


def sha(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(ROOT).free - len(data) < RESERVE:
        raise RuntimeError('2GiB free-space floor')
    tmp = path.with_name(path.name + '.partial-' + str(os.getpid()))
    with tmp.open('xb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    if sha(tmp.read_bytes()) != sha(data):
        raise RuntimeError('copy checksum differs')
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def checkpoint(expected_provider_manifest_sha256):
    manifest = SOURCE / 'input/provider-manifest.json'
    if not re.fullmatch(r'[0-9a-f]{64}', expected_provider_manifest_sha256):
        raise ValueError('Root must provide the actual newly frozen provider manifest SHA256')
    if sha(manifest.read_bytes()) != expected_provider_manifest_sha256:
        raise RuntimeError('K3 provider manifest differs; no data copied')
    before = shutil.disk_usage(ROOT)._asdict()
    started = now()
    statefile = DEST / 'CURRENT.json'
    state = json.loads(statefile.read_text()) if statefile.exists() else {
        'sequence': 0, 'files': {}, 'prefixes': {}}
    added, errors, private = [], [], []
    from dotenv import dotenv_values
    private.extend(value.encode() for key,value in dotenv_values(ROOT / '.git/aurora-handoff-import-20261006/distributed-k1-http-provider-v1126/input/existing-private.env').items() if isinstance(value,str) and len(value)>=8 and re.search(r'SECRET|PASSWORD|TOKEN|KEY',key,re.I))

    def redact(value, path=''):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if re.search(r'secret|password|api.?keys?|access_token|refresh_token|authorization', key, re.I):
                    def gather(v):
                        if isinstance(v, str) and len(v) >= 8:
                            private.append(v.encode())
                        elif isinstance(v, (dict, list)):
                            for x in (v.values() if isinstance(v, dict) else v):
                                gather(x)
                    gather(item)
                    result[key] = '<REDACTED>'
                else:
                    result[key] = redact(item, path + '.' + key)
            return result
        if isinstance(value, list):
            return [redact(item, path) for item in value]
        return value

    original = (ROOT / '.git/aurora-handoff-import-20261006/distributed-k1-http-provider-v1126/runtime/config.json').read_bytes()
    safe = encode({'originalSha256': sha(original), 'derivative': 'secret-free settings; not executable config',
                   'settings': redact(json.loads(original))})

    def retain(source, relative, data, **extra):
        if relative in state['files']:
            return
        if any(secret in data for secret in private):
            raise RuntimeError('private value detected; withheld')
        target = DEST / relative
        if target.exists():
            if target.is_symlink() or sha(target.read_bytes()) != sha(data):
                raise RuntimeError('existing destination differs')
        else:
            atomic(target, data)
        record = {'source': str(source), 'destination': str(target.relative_to(ROOT)),
                  'bytes': len(data), 'sha256': sha(data), 'at': now(), **extra}
        state['files'][relative] = record
        added.append(record)

    retain(ROOT / '.git/aurora-handoff-import-20261006/distributed-k1-http-provider-v1126/runtime/config.json', 'settings.redacted.json', safe)
    for name in ['input/provider-manifest.json', 'input/admission-v1674.json', 'input/source-inventory.json',
                 'input/actual-provider-files-v1476.json', 'input/runtime-full-package-inventory-v1264.json',
                 'runtime/receiver-identity.json', 'runtime/runtime-versions.json',
                 'controller.py', 'bootstrap.py', 'resource_sample.py', 'copier-v1674.py', 'hook/bindings.py', 'hook/observer.py', 'hook/aurora_voice_telemetry_v430.py', 'runtime/terminal.json', 'preflight-terminal.json']:
        path = SOURCE / name
        try:
            if name not in state['files'] and path.exists():
                old = path.stat()
                data = path.read_bytes()
                if (old.st_size, old.st_mtime_ns) != (path.stat().st_size, path.stat().st_mtime_ns):
                    raise RuntimeError('immutable source changed')
                retain(path, name, data)
        except Exception as exc:
            errors.append({'source': str(path), 'error': str(exc)})

    # At most64MiB per log/checkpoint; 4MiB/s aggregate payload budget.
    started_copy, copied = time.monotonic(), 0
    for name in ['voice-stages.jsonl', 'actual-provider-bindings.jsonl', 'resources.jsonl', 'backend.private.log']:
        path = SOURCE / 'runtime' / name
        try:
            prefix = state['prefixes'].setdefault(name, {'endByte': 0, 'chunks': []})
            with path.open('rb') as stream:
                meta = os.fstat(stream.fileno())
                if prefix.get('inode', meta.st_ino) != meta.st_ino or meta.st_size < prefix['endByte']:
                    raise RuntimeError('append source changed identity or truncated')
                for _ in range(16):
                    start = prefix['endByte']
                    stream.seek(start)
                    data = stream.read(min(RATE, meta.st_size - start))
                    data = data[:data.rfind(b'\n') + 1]
                    if not data:
                        break
                    end = start + len(data)
                    relative = f'prefixes/{name}/{start:012d}-{end:012d}.chunk'
                    raw_sha=sha(data)
                    if name.endswith('.log'):
                        for secret in private:data=data.replace(secret,b'[REDACTED_CREDENTIAL]')
                    retain(path, relative, data, startByte=start, endByte=end, incomplete=True, sourceRawSha256=raw_sha, credentialsRedacted=name.endswith('.log'),
                           sourceInode=meta.st_ino, sourceObservedBytes=meta.st_size)
                    prefix['chunks'].append(relative)
                    prefix['endByte'] = end
                    copied += len(data)
                    time.sleep(max(0, copied / RATE - (time.monotonic() - started_copy)))
                prefix.update({'inode': meta.st_ino, 'sourceObservedBytes': meta.st_size,
                               'observedAt': now(), 'incomplete': True})
        except Exception as exc:
            errors.append({'source': str(path), 'error': str(exc)})
    state['sequence'] += 1
    receipt = {'startedAt': started, 'finishedAt': now(), 'sequence': state['sequence'],
               'diskBefore': before, 'diskAfter': shutil.disk_usage(ROOT)._asdict(),
               'newFiles': added, 'errors': errors, 'prefixes': state['prefixes'],
               'physicalPayloadBytes': sum(x['bytes'] for x in state['files'].values()),
               'sutCalls': 0, 'expectedProviderManifestSha256': expected_provider_manifest_sha256, 'possibleConfound': 'Concurrent custody IO; retain all measured cases.'}
    receiptpath = DEST / f"receipts/{state['sequence']:06d}.json"
    atomic(receiptpath, encode(receipt))
    state.update({'lastReceipt': str(receiptpath.relative_to(ROOT)), 'updatedAt': now()})
    atomic(statefile, encode(state))
    print(json.dumps({k: receipt[k] for k in ['sequence', 'finishedAt', 'errors', 'physicalPayloadBytes']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--follow', action='store_true')
    parser.add_argument('--provider-manifest-sha256', required=True)
    args = parser.parse_args()
    manifest = SOURCE / 'input/provider-manifest.json'
    if not re.fullmatch(r'[0-9a-f]{64}', args.provider_manifest_sha256) or sha(manifest.read_bytes()) != args.provider_manifest_sha256:
        raise RuntimeError('Future K3 provider manifest admission required before creating custody output')
    DEST.mkdir(parents=True, exist_ok=True)
    lock = (DEST / 'copier.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    end = time.monotonic() + 11400
    while True:
        checkpoint(args.provider_manifest_sha256)
        if not args.follow or time.monotonic() >= end or (SOURCE / 'runtime/terminal.json').exists() or (SOURCE / 'preflight-terminal.json').exists():
            if args.follow and ((SOURCE / 'runtime/terminal.json').exists() or (SOURCE / 'preflight-terminal.json').exists()):checkpoint(args.provider_manifest_sha256)
            break
        time.sleep(60)

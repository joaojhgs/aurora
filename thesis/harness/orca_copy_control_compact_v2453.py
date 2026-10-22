"""One supported plain-shell Enter; retain lossless control bytes once, gzipped.

Decoded scientific results remain exact JSON; all CLI bytes are recoverable
from raw.gz with hashes and cursor metadata. No retry of accepted commands.
"""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.umask(0o077)
name, command_file, marker = sys.argv[1:]
out = Path('/home/developer/projects/aurora/.git/aurora-handoff-import-20261006')
cli = '/home/developer/.orca-relay/bin/orca'
terminal = 'term_d5651d8d-58e2-4b38-85e2-51c668cc933c'
incarnation = '034ff933-61a3-4c74-b5ad-98a75e8ac21c'
deadline = time.monotonic() + 90


def call(suffix, args):
    completed = subprocess.run([cli, *args], capture_output=True, timeout=min(30, max(1, deadline-time.monotonic())))
    raw = completed.stdout + b'\nSTDERR\n' + completed.stderr
    target = out / f'{name}-{suffix}.raw.gz'
    with target.open('xb') as stream:
        stream.write(gzip.compress(raw, mtime=0))
    result = json.loads(completed.stdout[completed.stdout.index(b'{'):])
    terminal_result = result.get('result', {}).get('terminal', {})
    metadata = {
        'ok': result.get('ok'), 'exitCode': completed.returncode,
        'rawLosslessGzip': str(target), 'uncompressedBytes': len(raw),
        'uncompressedSha256': hashlib.sha256(raw).hexdigest(),
        'stdoutBytes': len(completed.stdout), 'stderrBytes': len(completed.stderr),
        'id': result.get('id'), 'error': result.get('error'),
        'nextCursor': terminal_result.get('nextCursor'),
        'source': terminal_result.get('source'),
        'returnedLineCount': terminal_result.get('returnedLineCount'),
    }
    with (out / f'{name}-{suffix}.json').open('x') as stream:
        json.dump(metadata, stream, indent=2)
        stream.write('\n')
    assert completed.returncode == 0 and result.get('ok'), {'receipt':suffix, 'error':result.get('error')}
    return result


fence = call('SHOW-FENCE', ['terminal','show','--terminal',terminal,'--json'])['result']['terminal']
assert fence['incarnationId'] == incarnation and fence['connected'] and fence['writable']
assert fence['executionHostId'] == 'ssh:ssh-1786238480967-semdev' and not fence.get('agentIdentity')
before = call('READ-BEFORE', ['terminal','read','--terminal',terminal,'--limit','1','--json'])
cursor = before['result']['terminal']['nextCursor']
command = Path(command_file).read_text()
assert command.endswith('\n')
with (out / f'{name}-SEND-INTENT.json').open('x') as stream:
    json.dump({'plainShell':True,'enterFlag':True,'maximumSends':1,'compressedExactCliCustody':True},stream)
call('SEND',['terminal','send','--terminal',terminal,'--text',command.rstrip('\n'),'--enter','--json'])
parts = {}
total = None
for index in range(24):
    if time.monotonic() >= deadline:
        break
    result = call(f'READ-{index}',['terminal','read','--terminal',terminal,'--cursor',cursor,'--limit','2000','--json'])
    output = result['result']['terminal']
    cursor = output['nextCursor']
    if any(line.startswith('Traceback (most recent call last):') for line in output.get('tail', [])):
        with (out/f'{name}-REMOTE-ERROR-OBSERVED.json').open('x') as stream:
            json.dump({'readReceipt':f'{name}-READ-{index}.raw.gz','resend':False,'nextCursor':cursor},stream)
        raise SystemExit('Known remote error; reconcile preserved lossless receipt, never resend')
    for line in output.get('tail', []):
        if line.startswith(marker+' '):
            item=json.loads(line[len(marker)+1:])
            parts[item['seq']]=item['data']
            total=item['total']
    if total is not None and len(parts)==total:
        raw=base64.b64decode(''.join(parts[j] for j in range(total)),validate=True)
        value=json.loads(raw)
        with (out/f'{name}-RESULT.json').open('xb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        print(json.dumps({'resultFile':f'{name}-RESULT.json','bytes':len(raw),'nextCursor':cursor,'host':value.get('host')}),flush=True)
        break
    time.sleep(0.5)
else:
    raise SystemExit(f'Bounded24-read observation ended; preserve accepted command and cursor{cursor}; never resend')
if not (out/f'{name}-RESULT.json').exists():
    raise SystemExit(f'Observation deadline; preserve same command/cursor{cursor}; never resend')

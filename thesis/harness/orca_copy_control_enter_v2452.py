import base64
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
    result = subprocess.run([cli, *args], capture_output=True, text=True, timeout=min(35, max(1, deadline - time.monotonic())))
    (out / f'{name}-{suffix}.raw').write_text(result.stdout + '\nSTDERR\n' + result.stderr)
    data = json.loads(result.stdout[result.stdout.index('{'):])
    (out / f'{name}-{suffix}.json').write_text(json.dumps(data, indent=2) + '\n')
    assert result.returncode == 0 and data.get('ok'), {'receipt': f'{name}-{suffix}', 'error': data.get('error')}
    return data

fence = call('SHOW-FENCE', ['terminal', 'show', '--terminal', terminal, '--json'])['result']['terminal']
assert fence['incarnationId'] == incarnation and fence['connected'] and fence['writable']
assert fence['executionHostId'] == 'ssh:ssh-1786238480967-semdev'
assert not fence.get('agentIdentity'), 'Raw helper only supports the existing plain shell'
before = call('READ-BEFORE', ['terminal', 'read', '--terminal', terminal, '--limit', '100', '--json'])
cursor = before['result']['terminal']['nextCursor']
command = Path(command_file).read_text()
assert command.endswith('\n'), 'Explicit raw shell newline required'
with (out / f'{name}-SEND-INTENT.json').open('x') as intent:
    json.dump({'plainShell': True, 'enterFlag': True, 'maximumSends': 1, 'previousOperationNotResent': True}, intent)
call('SEND', ['terminal', 'send', '--terminal', terminal, '--text', command.rstrip('\n'), '--enter', '--json'])
parts = {}
total = None
for index in range(24):
    if time.monotonic() >= deadline:
        raise SystemExit("Observation deadline; preserve accepted command and reconcile same output, never resend")
    data = call(f'READ-{index}', ['terminal', 'read', '--terminal', terminal, '--cursor', cursor, '--limit', '2000', '--json'])
    output = data['result']['terminal']
    cursor = output['nextCursor']
    if any(line.startswith('Traceback (most recent call last):') for line in output.get('tail', [])):
        (out / f'{name}-REMOTE-ERROR-OBSERVED.json').write_text(json.dumps({'readReceipt': f'{name}-READ-{index}.json', 'remoteTracebackObserved': True, 'resend': False, 'nextCursor': cursor}) + '\n')
        raise SystemExit('Known remote error; end observation immediately, preserve command and reconcile')
    for line in output.get('tail', []):
        if line.startswith(marker + ' '):
            item = json.loads(line[len(marker) + 1:])
            parts[item['seq']] = item['data']
            total = item['total']
    if total is not None and len(parts) == total:
        raw = base64.b64decode(''.join(parts[part] for part in range(total)))
        value = json.loads(raw)
        (out / f'{name}-RESULT.json').write_bytes(raw)
        print(json.dumps({'resultFile': f'{name}-RESULT.json', 'bytes': len(raw), 'nextCursor': cursor, 'host': value.get('host')}), flush=True)
        break
    time.sleep(0.5)
else:
    raise SystemExit(f'Incomplete read receipt; same handle/cursor {cursor}; never resend command')

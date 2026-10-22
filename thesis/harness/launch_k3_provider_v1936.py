"""Start the prepared K3 SUT once and observe its same-process readiness."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import base64
import hashlib
import json
import os
import socket
import subprocess
import time
import traceback

R = Path('/home/developer/projects/aurora')
D = R / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1935/provider'
PRIVATE = R / '.git/aurora-handoff-import-20261006/k3-mesh-provider-v1935'
MANIFEST = D / 'provider-manifest.json'
MANIFEST_SHA = '016d461363c4f1d3baa2fbb67bf7a85c0aa79df1a0ebb419fc7d3f166a4de629'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def actor(pid):
    f = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'state': f[0], 'startTicks': int(f[19])}


def write(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())


def main():
    os.umask(0o077)
    assert socket.gethostname() == 'personal.skyron-server'
    assert sha(MANIFEST) == MANIFEST_SHA
    m = json.loads(MANIFEST.read_text())
    controller = PRIVATE / 'controller.py'
    assert sha(controller) == m['controllerSha256'] == '5e9d2212b0ee59848396888da919ef6a4695349bc880930a00e1aa1acd383dcd'
    assert sha(Path(m['config'])) == m['configSha256']
    assert not (D / 'controller-launch.json').exists() and not (D / 'ROOT-LAUNCH-INTENT-v1936.json').exists()
    assert all(not Path('/proc', str(p)).exists() for p in [161159, 161160])
    start = datetime.now(timezone.utc)
    assert start + timedelta(seconds=m['lifetimeSeconds']) <= datetime.fromisoformat(m['originalProviderAbsoluteDeadlineUtc']), 'Original provider absolute deadline must not extend'
    write(D / 'ROOT-LAUNCH-INTENT-v1936.json', {'at': start.isoformat(), 'manifestSha256': MANIFEST_SHA,
                                             'maximumPopenCalls': 1, 'newWorker': False})
    with (PRIVATE / 'controller.private.log').open('xb') as log:
        p = subprocess.Popen([m['python'], str(controller), '--control', str(MANIFEST)],
                             cwd=PRIVATE, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             start_new_session=True)
    expected = actor(p.pid)
    launch = {'at': start.isoformat(), 'controller': expected, 'manifestSha256': MANIFEST_SHA,
              'newWorker': False, 'measurementStarted': False}
    write(D / 'ROOT-LAUNCH-v1936.json', launch)
    deadline = time.monotonic() + 100
    status = {}
    while time.monotonic() < deadline:
        assert actor(p.pid)['startTicks'] == expected['startTicks'], 'Original controller identity changed'
        if (D / 'STATUS.json').exists():
            status = json.loads((D / 'STATUS.json').read_text())
            if status.get('phase') in ('normal_services_live', 'provider_failed'):
                break
        time.sleep(2)
    value = {'at': datetime.now(timezone.utc).isoformat(), 'host': socket.gethostname(),
             'status': 'K3_PROVIDER_STARTED_READINESS_PENDING', 'phase': status.get('phase'),
             'manifestPath': str(MANIFEST), 'manifestSha256': MANIFEST_SHA, 'manifest': m,
             'controller': actor(p.pid), 'providerDeadlineUtc': (start + timedelta(seconds=m['lifetimeSeconds'])).isoformat(),
             'configSha256': sha(Path(m['config'])), 'oldK2ActorsAbsent': True, 'newWorker': False,
             'sutRequests': 0, 'actualGpuAndOrdinaryWarmups': 'PENDING'}
    if (D / 'controller-launch.json').exists():
        child = json.loads((D / 'controller-launch.json').read_text())
        receiver = actor(child['receiverPid'])
        assert receiver['startTicks'] == child['receiverStartTicks']
        value['receiver'] = receiver
    if status.get('phase') == 'normal_services_live':
        assert status['sttMethodConstraints'] and status['ttsMethodConstraints']
        assert value['receiver']['state'] not in ('Z', 'X', 'x')
        value['status'] = 'K3_PROVIDER_LIVE_METADATA_ADMITTED'
    write(D / 'ROOT-ADMISSION-v1936.json', value)
    return value


if __name__ == '__main__':
    try:
        result = main()
    except Exception as exc:
        result = {'status': 'K3_PROVIDER_LAUNCH_REQUIRES_SAME_ATTEMPT_RECONCILIATION',
                  'errorCategory': type(exc).__name__, 'error': str(exc),
                  'location': [{'function': f.name, 'line': f.lineno} for f in traceback.extract_tb(exc.__traceback__)[-3:]],
                  'automaticRetry': False}
    raw = base64.b64encode((json.dumps(result, indent=2) + '\n').encode()).decode()
    parts = [raw[i:i + 800] for i in range(0, len(raw), 800)]
    for i, part in enumerate(parts):
        print('AURORA_K3_PROVIDER_V1936 ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

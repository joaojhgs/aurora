"""One Root-owned requester start followed by its existing bounded custody gates."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import argparse
import json
import os
import subprocess
import sys

R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OP = H / 'distributed-k3-mesh-launch-v1920'
D = R / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1920'
ADMISSION = H / 'k3-provider-existing-read-v1919-RESULT.json'


def actor(pid):
    row = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
    assert row[0] not in ('Z', 'X', 'x')
    return {'pid': pid, 'startTicks': int(row[19]), 'state': row[0]}


def main(from_frozen=False):
    os.umask(0o077)
    if from_frozen:
        assert OP.is_dir() and D.is_dir() and not (OP / 'LAUNCH-INTENT.json').exists()
        assert not (H / 'distributed-k3-mesh-cell-v1920').exists()
        assert (OP / 'condition-frozen-v1920.json').read_bytes() == (D / 'condition-frozen.json').read_bytes()
    else:
        assert not OP.exists() and not D.exists(), 'Reconcile the same accepted attempt; never duplicate'
    admission = json.loads(ADMISSION.read_text())
    assert admission['status'] == 'K3_PROVIDER_LIVE_METADATA_ADMITTED'
    root = R / 'thesis/harness/k3_mesh_root_v1920.py'
    results = []
    for action in (('launch',) if from_frozen else ('draft', 'launch')):
        p = subprocess.run([sys.executable, str(root), action, str(ADMISSION)], cwd=R,
                           capture_output=True, text=True, timeout=90)
        if p.returncode:
            print(json.dumps({'status': 'K3_SAME_REQUESTER_ATTEMPT_REQUIRES_RECONCILIATION', 'action': action,
                              'exitCode': p.returncode, 'output': p.stdout, 'error': p.stderr}), flush=True)
            raise SystemExit(1)
        value = json.loads(p.stdout)
        results.append(value)
        print(json.dumps(value), flush=True)
    requester = json.loads((OP / 'requester-launch.json').read_text())
    assert actor(requester['controllerPid'])['startTicks'] == requester['controllerStartTicks']
    condition_sha = hashlib.sha256((D / 'condition-frozen.json').read_bytes()).hexdigest()
    launched = {}
    for name, script, extra in [
        ('copier', 'custody_k3_mesh_requester_v1920.py', ['--follow', '--condition-sha256', condition_sha]),
        ('warmup-finalizer', 'k3_mesh_warmup_finalize_v1921.py', []),
    ]:
        path = R / 'thesis/harness' / script
        with (OP / (name + '.private.log')).open('xb') as log:
            child = subprocess.Popen([sys.executable, str(path), *extra], cwd=R,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        launched[name] = dict(actor(child.pid), sourceSha256=hashlib.sha256(path.read_bytes()).hexdigest())
    value = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'K3_REQUESTER_AND_BOUNDED_AUXILIARIES_STARTED',
             'requester': requester, 'auxiliaries': launched, 'conditionManifestSha256': condition_sha,
             'measurementAdmitted': False, 'plannedMeasured': 900, 'excludedWarmups': 15,
             'newOrcaWorker': False, 'provider': admission['receiver']}
    for path in (OP / 'AUXILIARY-LAUNCH-v1917.json', D / 'AUXILIARY-LAUNCH-v1917.json'):
        with path.open('x') as f:
            json.dump(value, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
    print(json.dumps(value), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--from-frozen', action='store_true')
    main(parser.parse_args().from_frozen)

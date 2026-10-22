"""Bounded Root observation of existing K3 handles; zero SUT requests or mutations."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time

ROOT = Path(__file__).resolve().parents[2]
CELL = ROOT / '.git/aurora-handoff-import-20261006/distributed-k3-orca-relayed-http-cell-v1481'
OUT = ROOT / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481/observations'
EXPECTED = {968671: 109024884, 968825: 109025741, 968673: 109024895, 421717: 104535394}


def observe(seconds, name):
    assert 1 <= seconds <= 600
    assert name.replace('-', '').replace('_', '').isalnum()
    OUT.mkdir(exist_ok=True)
    target = OUT / (name + '.jsonl')
    end = time.monotonic() + seconds
    previous, last_advance = None, time.monotonic()
    with target.open('x') as log:
        while True:
            handles = {}
            for pid, ticks in EXPECTED.items():
                try:
                    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
                    handles[str(pid)] = {'same': int(fields[19]) == ticks, 'state': fields[0], 'startTicks': int(fields[19])}
                except FileNotFoundError:
                    handles[str(pid)] = {'same': False, 'state': 'absent'}
            try:
                progress = json.loads((CELL / 'campaign/progress.json').read_text())
                error = None
            except (FileNotFoundError, json.JSONDecodeError) as exc:
                progress, error = None, type(exc).__name__
            if progress is not None and progress.get('measured_attempted') != previous:
                previous, last_advance = progress.get('measured_attempted'), time.monotonic()
            alive = all(v['same'] and v['state'] != 'Z' for v in handles.values())
            row = {'at': datetime.now(timezone.utc).isoformat(), 'observerPid': os.getpid(), 'progress': progress,
                   'progressReadError': error, 'actualProcesses': handles, 'readOnly': True, 'sutCalls': 0,
                   'sourceSettingsLifecycleChanges': 0}
            log.write(json.dumps(row) + '\n')
            log.flush()
            print(json.dumps({'at': row['at'], 'measured': previous, 'status': (progress or {}).get('status'),
                              'lastStatus': (progress or {}).get('last_attempt_status'),
                              'sameLiveHandles': alive, 'progressReadError': error, 'noNewSutCalls': True}), flush=True)
            if not alive or progress is not None and progress.get('status') != 'running':
                print('OBSERVE_ACTUAL_TERMINAL_OR_MISSING_HANDLE_NO_RESTART', flush=True)
                break
            if time.monotonic() - last_advance > 420:
                print('NO_ADVANCE_INSPECT_SAME_HANDLES_NO_RESTART', flush=True)
                break
            if time.monotonic() >= end:
                break
            time.sleep(min(45, max(0, end - time.monotonic())))
    print('BOUNDED_READ_ONLY_WINDOW_COMPLETE', str(target), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, required=True)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    observe(args.seconds, args.name)

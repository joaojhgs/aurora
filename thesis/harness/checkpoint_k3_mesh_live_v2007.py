"""Root's read-only K3 observation; always collect current primary state.

Writes one new reporting receipt. Never selects an earlier receipt as input,
imports the SUT, sends traffic, or signals a process.
"""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import argparse
import hashlib
import json
import os
import shutil

ROOT = Path(__file__).resolve().parents[2]
HANDOFF = ROOT / '.git/aurora-handoff-import-20261006'
CELL = HANDOFF / 'distributed-k3-mesh-cell-v1988'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1988'
ACTORS = [(3154212, 131502232), (3154248, 131502574), (3154213, 131502236)]


def observe(previous_count):
    started = datetime.now(timezone.utc)
    files = sorted((CELL / 'campaign/attempts').glob('*measured.jsonl'))
    rows = [json.loads(path.read_bytes()) for path in files]
    custody = json.loads((DEST / 'CURRENT.json').read_bytes())
    progress = json.loads((CELL / 'campaign/progress.json').read_bytes())
    actors = {}
    for pid, expected in ACTORS:
        path = Path('/proc', str(pid), 'stat')
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            actors[str(pid)] = {'state': fields[0], 'startTicks': int(fields[19]),
                                'sameStart': int(fields[19]) == expected}
        except FileNotFoundError:
            actors[str(pid)] = 'absent'
    ended = datetime.now(timezone.utc)
    value = {
        'at': ended.isoformat(), 'observationStartedAt': started.isoformat(),
        'observationEndedAt': ended.isoformat(), 'source': 'fresh primary case files, custody CURRENT and /proc; no previous receipt reused',
        'primaryCasesDirectory': str(CELL / 'campaign/attempts'),
        'primaryProgressPath': str(CELL / 'campaign/progress.json'),
        'custodyCurrentPath': str(DEST / 'CURRENT.json'),
        'status': progress['status'], 'actors': actors,
        'measured': {
            'attempted': len(rows), 'correct': sum(x['status'] == 'completed_correct' for x in rows),
            'incorrect': sum(x['status'] == 'completed_incorrect' for x in rows),
            'failed': sum(x['status'] not in ['completed_correct', 'completed_incorrect'] for x in rows),
            'timeouts': sum(x.get('timeout') is True for x in rows), 'remaining': 900-len(rows)},
        'custody': {'sequence': custody['sequence'], 'cases': len(custody['completedCases']),
                    'audio': sum(x.get('audio') is not None for x in custody['completedCases'].values()),
                    'files': len(custody['files'])},
        'freeBytes': shutil.disk_usage(ROOT).free,
        'measuredNonCorrect': [{k: x.get(k) for k in ['phase_index', 'status', 'failure', 'timeout', 'partial_quality_incorrect']}
                               for x in rows if x['status'] != 'completed_correct'],
        'priorCheckpointMeasuredCount': previous_count, 'newMeasuredAttempts': len(rows)-previous_count,
        'classification': 'verified_wait' if progress['status'] == 'running' and all(
            isinstance(x, dict) and x['sameStart'] and x['state'] not in ['Z', 'X', 'x'] for x in actors.values())
            else 'requires_same_actor_reconciliation',
        'nextRoutineCheckUtc': (ended+timedelta(minutes=5)).isoformat(),
        'nativeGoalThreadId': '01a112a5-d6bb-74e2-bf7c-ace73cb513b5',
        'phoneTaskSeparate': True, 'sutCalls': 0,
    }
    summary = CELL / 'campaign/summary.json'
    if summary.exists():
        raw = json.loads(summary.read_bytes())
        value['terminalSummary'] = {k: raw.get(k) for k in ['status', 'stop_reason', 'shutdown_completed']}
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt-name', required=True)
    parser.add_argument('--previous-count', type=int, required=True)
    args = parser.parse_args()
    name = Path(args.receipt_name)
    assert len(name.parts) == 1 and name.suffix == '.json'
    value = observe(args.previous_count)
    if name.name == 'ROOT-LIVE-CHECKPOINT-v2007.json':
        old = DEST / 'ROOT-LIVE-CHECKPOINT-v2004.json'
        history = DEST / 'ROOT-LIVE-20261020T230436Z.json'
        prior = json.loads(old.read_bytes()); actual = json.loads(history.read_bytes())
        assert prior['measured']['attempted'] == 30 and actual['measured']['attempted'] == 54
        value['reportingCorrection'] = {
            'supersedesReportingReceipt': str(old.relative_to(ROOT)),
            'preservedOriginalSha256': hashlib.sha256(old.read_bytes()).hexdigest(),
            'defect': 'A broad ROOT-LIVE glob selected an older CHECKPOINT receipt; primary experiment data was unaffected.',
            'historical54PrimarySnapshot': str(history.relative_to(ROOT)),
            'historical54ObservedAt': actual['at'],
            'historical54SnapshotSha256': hashlib.sha256(history.read_bytes()).hexdigest(),
            'fix': 'This entrypoint reads current primary data directly and never selects an earlier receipt.',
            'experimentRerun': False, 'oldRawOrFrozenSourceChanged': False,
        }
    raw = (json.dumps(value, indent=2)+'\n').encode()
    assert shutil.disk_usage(ROOT).free-len(raw) > 2*1024**3
    with (DEST / name).open('xb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps(value))

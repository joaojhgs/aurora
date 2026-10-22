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
CELL = HANDOFF / 'distributed-k3-mesh-cell-v2043'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043'
ACTORS = [(3207537, 131930077), (3207665, 131930844), (3207538, 131930081)]


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
            'timeouts': sum(x.get('timeout') is True for x in rows), 'remaining': 624-len(rows), 'planned': 624},
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
    seal_path = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1988/PARTIAL-CONDITION-SEAL-v2042.json'
    seal_raw = seal_path.read_bytes()
    assert hashlib.sha256(seal_raw).hexdigest() == '957240ab4ccc2eaca702fdec03a376fd96f7cab2568986df7607725b329a6d49'
    parent = json.loads(seal_raw)
    assert parent['measuredAttempted'] == 276 and parent['measuredCorrect'] == 256 and parent['measuredFailed'] == 20
    assert [row['global_measured_index'] for row in rows] == list(range(277,277+len(rows)))
    value['epochMeasured'] = value.pop('measured')
    epoch = value['epochMeasured']
    value['measured'] = {'attempted':276+epoch['attempted'],'correct':256+epoch['correct'],
        'incorrect':epoch['incorrect'],'failed':20+epoch['failed'],'timeouts':1+epoch['timeouts'],
        'remaining':624-epoch['attempted'],'planned':900}
    warmups = [json.loads(path.read_bytes()) for path in (CELL/'campaign/attempts').glob('*warmup.jsonl')]
    value['warmupsThisEpoch'] = {'attempted':len(warmups),'correct':sum(x['status']=='completed_correct' for x in warmups),
        'failed':sum(x['status']!='completed_correct' for x in warmups)}
    value['priorMeasured'] = {'attempted':276,'correct':256,'failed':20,'timeouts':1,'sealedReceipt':str(seal_path.relative_to(ROOT))}
    value['custody']['audioReferences'] = value['custody']['audio']
    value['custody']['audio'] = len(list((DEST/'audio').glob('*.wav')))
    value['newMeasuredAttempts'] = epoch['attempted'] - previous_count
    value['source'] += '; combined condition counts add immutable sealed parent276, no raw-row rewrite'
    admission = HANDOFF/'distributed-k3-mesh-launch-v2043/warmup-finalizer-result.json'
    if admission.exists():
        a = json.loads(admission.read_bytes())
        value['admission'] = {k:a.get(k) for k in ['at','status','proofSha256','excludedWarmups','remoteModelJoins','warmupP95MsType7','measured624ForecastSecondsWith20PercentPlus300']}
        value['admission']['actualGpuLayers'] = a['actualGpu']['actualOffloadedLayers']
        value['admission']['actualTotalGpuLayers'] = a['actualGpu']['actualTotalLayers']
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--receipt-name', required=True)
    parser.add_argument('--previous-count', type=int, required=True)
    args = parser.parse_args()
    name = Path(args.receipt_name)
    assert len(name.parts) == 1 and name.suffix == '.json'
    value = observe(args.previous_count)
    raw = (json.dumps(value, indent=2)+'\n').encode()
    assert shutil.disk_usage(ROOT).free-len(raw) > 2*1024**3
    with (DEST / name).open('xb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps(value))

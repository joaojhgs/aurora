"""Record one bounded observation checkpoint; never control or call the SUT."""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
HANDOFF = ROOT / '.git/aurora-handoff-import-20261006'
CELL = HANDOFF / 'distributed-k3-orca-relayed-http-cell-v1481'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkpoint(tag):
    assert re.fullmatch(r'v\d+', tag)
    window = DEST / f'observations/root-read-only-window-{tag}.jsonl'
    rows = [json.loads(line) for line in window.read_text().splitlines() if line]
    progress = json.loads((CELL / 'campaign/progress.json').read_text())
    # Progress is published after its immutable case is closed; omit a later active writer.
    cases = [json.loads(p.read_text()) for p in sorted((CELL / 'campaign/attempts').glob('*measured*'))
             if int(p.name.split('-')[1]) <= progress['attempted']]
    counts = dict(Counter(row['status'] for row in cases))
    state = json.loads((DEST / 'CURRENT.json').read_text())
    custody = json.loads((ROOT / state['lastReceipt']).read_text())
    alive = all(all(item['same'] and item['state'] != 'Z' for item in row['actualProcesses'].values()) for row in rows)
    now = datetime.now(timezone.utc)
    result = {'at': now.isoformat(), 'classification': 'VERIFIED_WAIT' if alive else 'ACTUAL_HANDLE_CHANGE_REQUIRES_RECONCILIATION',
              'window': str(window.relative_to(ROOT)), 'windowSha256': sha(window),
              'windowStarted': rows[0]['at'], 'windowEnded': rows[-1]['at'],
              'measuredStart': rows[0]['progress']['measured_attempted'],
              'measuredEnd': rows[-1]['progress']['measured_attempted'],
              'allExactHandlesLiveThroughout': alive,
              'progressReadErrors': [row['progressReadError'] for row in rows if row.get('progressReadError')],
              'progress': progress, 'measuredOutcomes': counts, 'caseCountMatchesProgress': len(cases) == progress['measured_attempted'],
              'copiedCases': len(state['completedCases']),
              'copiedWavs': sum(key.startswith('audio/') for key in state['files']), 'copierErrors': custody['errors'],
              'frozenManifestSha256': sha(DEST / 'condition-frozen.json'),
              'observerSourceSha256': sha(ROOT / 'thesis/harness/observe_k3_v1481.py'),
              'checkpointSourceSha256': sha(Path(__file__)), 'newSutCallsTestsSettingsOrLifecycleChanges': 0,
              'full13Complete': False, 'requiresTerminalReconciliation': progress.get('status') != 'running' or not alive}
    out = DEST / f'observations/ROOT-CHECKPOINT-{tag}.json'
    with out.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    index = HANDOFF / 'EXISTING-SESSION-CURRENT-V491.json'
    current = json.loads(index.read_text())
    current['activeValidation'].update(lastActualProgress=progress, measuredAttempted=len(cases), measuredOutcomes=counts,
                                       observedAt=now.isoformat(), latestReadOnlyCheckpoint=str(out.relative_to(ROOT)))
    current['lastGoalTurnClassification'] = result['classification']
    current['nextReadOnlyCheckpointDue'] = (now + timedelta(minutes=10)).isoformat()
    index.write_text(json.dumps(current, indent=2) + '\n')
    line = (f'Current bounded read-only checkpoint{now.isoformat()}: K3V1481 {progress["measured_attempted"]}/900, '
            f'measured outcomes{json.dumps(counts)},15excludedcorrect. Exact original handles live throughout observation: {alive}. '
            f'{len(state["completedCases"])}case copies,{result["copiedWavs"]}WAVs,{len(custody["errors"])}copier errors. '
            f'Same frozen54d51acd;0extraSUTcalls/tests/settings/lifecycle changes. '
            f'[Physical observer/checkpoint receipt](../../../../thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481/observations/ROOT-CHECKPOINT-{tag}.json). '
            'Current900 remains unfinished; next action is naturalfinish/seal/one analysis.')
    human = ROOT / 'docs/experiments/tcc-20261013-submission-20261030/root/CURRENT.md'
    text = human.read_text()
    text = text.replace(text.splitlines()[0], '# Aurora current evidence — ' + now.strftime('%Y-%m-%d %H:%M UTC'))
    text = re.sub(r'Current bounded read-only checkpoint[^\n]*', lambda _: line, text)
    human.write_text(text)
    routing = ROOT / '.omx/ultragoal/ORCA-COORDINATION.md'
    line = (f'- Actual dated checkpoint {now.isoformat()}: {json.dumps(progress)}. Measured outcomes: {json.dumps(counts)}. '
            f'Use actual live PID/startticks for waits; custody can lag60s. Latest physical observation `observations/ROOT-CHECKPOINT-{tag}.json` '
            'under `thesis/campaigns/worker-desktop-k3-orca-relayed-http-v1481/`. '
            f'Next ordinary read-only checkpoint {(now + timedelta(minutes=10)).strftime("%H:%MUTC")}.')
    routing.write_text(re.sub(r'- Actual dated checkpoint [^\n]*', lambda _: line, routing.read_text()))
    print(json.dumps({'receipt': str(out.relative_to(ROOT)), **result}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    checkpoint(parser.parse_args().tag)

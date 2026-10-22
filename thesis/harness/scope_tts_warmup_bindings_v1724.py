"""Reproduce an epoch's Piper binding slice from its saved native clock spans.

Keep the full provider history. This derives a NEW input for the unchanged
strict15-call gate when the same provider served an earlier epoch. No traffic.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path


def derive(attempts, stages, bindings, output):
    cases = [json.loads((attempts / f'attempt-{i:04d}-warmup.jsonl').read_bytes()) for i in range(1, 16)]
    assert all(v['phase'] == 'warmup' and v['status'] == 'completed_correct' for v in cases)
    correlations = {v['correlation']['correlation_id'] for v in cases}
    assert len(correlations) == 15
    voice = [json.loads(line) for line in stages.read_bytes().splitlines()]
    spans = [v for v in voice if v.get('correlation_id') in correlations
             and v.get('record_kind') == 'invocation_span_boundary'
             and v.get('handler') == 'tts.model_invoke']
    assert Counter((v['correlation_id'], v['event']) for v in spans) == Counter(
        (c, e) for c in correlations for e in ['span_start', 'span_end'])
    assert all(v.get('outcome') == 'completed' for v in spans if v['event'] == 'span_end')
    low = min(int(v['monotonic_ns']) for v in spans)
    high = max(int(v['monotonic_ns']) for v in spans)
    lines = bindings.read_bytes().splitlines(keepends=True)
    selected = [line for line in lines if low <= int(json.loads(line).get('monotonicNs', -1)) <= high]
    assert Counter(json.loads(line)['event'] for line in selected) == {
        'piper_cli_call_start': 15, 'piper_cli_call_return': 15}
    data = b''.join(selected)
    with output.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    digest = hashlib.sha256(data).hexdigest()
    assert hashlib.sha256(output.read_bytes()).hexdigest() == digest
    return {'fullSourceRows': len(lines), 'selectedRows': len(selected), 'sha256': digest,
            'nativeClockRange': [low, high], 'sourceModified': False, 'sutCalls': 0}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['attempts', 'stages', 'bindings', 'output']:
        parser.add_argument('--' + flag, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(derive(args.attempts, args.stages, args.bindings, args.output)))

"""Derive separate handler metrics from saved paired spans; launches no workloads."""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path


def type7(values, probability):
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--cohort', required=True)
    parser.add_argument('--expected-measured', type=int, required=True)
    parser.add_argument('--excluded-warmups', type=int, required=True)
    parser.add_argument('--receiver-pid', type=int, required=True)
    args = parser.parse_args()
    if args.expected_measured < 1 or args.excluded_warmups < 0:
        parser.error('Sample counts must be positive, with nonnegative warmups')
    source = args.history.read_bytes()
    cases = json.loads(source)
    ordinals = {int(case.rsplit('-', 1)[1]) for case in cases}
    expected = set(range(args.excluded_warmups + 1, args.excluded_warmups + args.expected_measured + 1))
    if len(cases) != args.expected_measured or ordinals != expected:
        raise ValueError('Saved measured case IDs do not match the declared population')
    groups = sorted({(stage, row['handler']) for stages in cases.values() for stage, rows in stages.items() for row in rows})
    metrics = []
    records = []
    for stage, handler in groups:
        durations = []
        counts = {'missingCases': 0, 'multipleRowCases': 0, 'invalidBoundaryCases': 0, 'missingNativeOperationId': 0, 'missingNativeAttemptId': 0}
        for case_id, stages in sorted(cases.items()):
            matches = [row for row in stages.get(stage, []) if row['handler'] == handler]
            if not matches:
                counts['missingCases'] += 1
                continue
            if len(matches) != 1:
                counts['multipleRowCases'] += 1
                continue
            row = matches[0]
            duration = row.get('durationMs')
            valid = (isinstance(duration, (int, float)) and math.isfinite(duration) and duration >= 0 and row.get('clockDomain') == 'python_process_monotonic' and row.get('receiverPid') == args.receiver_pid and bool(row.get('correlationId')) and bool(row.get('spanId')))
            if not valid:
                counts['invalidBoundaryCases'] += 1
                continue
            durations.append(duration)
            counts['missingNativeOperationId'] += not bool(row.get('nativeOperationId'))
            counts['missingNativeAttemptId'] += not bool(row.get('nativeAttemptId'))
            records.append({'cohort': args.cohort, 'case_id': case_id, 'stage': stage, 'handler': handler, 'clock_domain': row['clockDomain'], 'receiver_pid': row['receiverPid'], 'correlation_id': row['correlationId'], 'span_id': row['spanId'], 'native_operation_id': row.get('nativeOperationId'), 'native_attempt_id': row.get('nativeAttemptId'), 'duration_ms': duration})
        metrics.append({'stage': stage, 'handler': handler, 'plannedMeasured': args.expected_measured, 'denominator': len(durations), **counts, 'p50_ms': type7(durations, .5), 'p90_ms': type7(durations, .9), 'p95_ms': type7(durations, .95)})
    result = {'schema': 'aurora.saved-native-span-metrics.v1', 'cohort': args.cohort, 'source': {'path': str(args.history), 'bytes': len(source), 'sha256': hashlib.sha256(source).hexdigest()}, 'analysisSourceSHA256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'population': 'All declared completed measured cases, including incorrect answers; no correctness-only inference', 'measuredCases': len(cases), 'excludedWarmups': args.excluded_warmups, 'method': 'Hyndman-Fan Type 7: h=(n-1)*p, linear interpolation', 'boundary': 'Saved same-process paired-span duration, grouped by exact stage and handler; wrapper and invocation metrics remain separate and are never summed', 'rawAuditReplayed': False, 'newMeasurements': 0, 'unknowns': {'queue': None, 'TTFT': None, 'streamedFirstAudio': None, 'playback': None}, 'metrics': metrics}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    json_path = args.output_dir / 'NATIVE-SPAN-METRICS-v733.json'
    csv_path = args.output_dir / 'native-span-durations-v733.csv'
    if json_path.exists() or csv_path.exists():
        raise FileExistsError('Preserve existing analysis; use a distinct version for a changed analysis')
    with csv_path.open('x', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(records[0]) if records else ['cohort', 'case_id', 'stage', 'handler', 'duration_ms'])
        writer.writeheader()
        writer.writerows(records)
    json_path.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(json_path), 'newMeasurements': 0, 'metrics': metrics}, indent=2))


if __name__ == '__main__':
    main()

"""Analyse saved K1 requester/provider checkpoints; never execute a workload."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path

from native_span_metrics_v2 import type7


REPO = Path(__file__).resolve().parents[2]
EXPECTED_MANIFEST = '6bc65cf5cc3c4eddb90b80b0764a01e6a9fc4afbed66f33c731e3ab58528e101'
HANDLERS = {
    'requester': [('stt', 'Transcription.Transcribe'), ('stt', 'stt.model_invoke'),
                  ('llm', 'resolved_chat_model.astream'),
                  ('history', 'OrchestratorService._persist_chat_message')],
    'provider': [('tts', 'TTS.Synthesize'), ('tts', 'tts.model_invoke')],
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def distribution(values):
    clean = [float(value) for value in values if finite(value)]
    return {'denominator': len(clean), 'p50_ms': type7(clean, .5),
            'p90_ms': type7(clean, .9), 'p95_ms': type7(clean, .95)}


def read_bound(path, records):
    data = path.read_bytes()
    records.append({'path': str(path), 'bytes': len(data), 'sha256': sha(data)})
    return data


def provider_locations(chain_path, state, source_records):
    """Resolve one saved snapshot across verified immutable copy locations."""
    chain = json.loads(read_bound(chain_path, source_records))
    assert chain['checkpointSequence'] == state['sequence']
    assert chain['snapshotAt'] == state['updatedAt']
    locations = chain['resolvedFiles']
    assert set(locations) == set(state['files'])
    result = {}
    for name, record in state['files'].items():
        location = locations[name]
        assert (location['bytes'], location['sha256']) == (record['bytes'], record['sha256'])
        relative = Path(location['path'])
        assert not relative.is_absolute() and '..' not in relative.parts
        path = REPO / relative
        assert path.resolve(strict=True) == path
        assert path.is_relative_to(REPO / 'thesis') and path.is_file()
        result[name] = path
    return result


def prefix_rows(state, base, provider, source_records, locations=None):
    prefix = state['prefixes']['voice-stages.jsonl']
    rows, position = [], 0
    for name in prefix['chunks']:
        if provider:
            record = state['files'][name]
            path = locations[name] if locations is not None else base / 'provider-raw' / name
        else:
            key = str(Path(name).relative_to(base.relative_to(REPO)))
            record = state['files'][key]
            path = REPO / name
        data = read_bound(path, source_records)
        assert len(data) == record['bytes'] and sha(data) == record['sha256']
        assert record['startByte'] == position
        position = record['endByte']
        assert len(data) == position - record['startByte']
        rows.extend(json.loads(line) for line in data.splitlines() if line.strip())
    assert position == prefix['endByte']
    return rows


def paired_spans(rows, receiver_pid, host):
    starts, completed = {}, defaultdict(list)
    counters = Counter()
    seen_ends = set()
    for item in rows:
        if item.get('record_kind') != 'invocation_span_boundary':
            continue
        if item.get('receiver_pid') != receiver_pid:
            counters['otherReceiverBoundaries'] += 1
            continue
        if not item.get('correlation_id'):
            counters['unattributedBoundaries'] += 1
            continue
        key = tuple(item.get(name) for name in ['receiver_pid', 'recorder_process_id', 'clock_domain',
                                               'stage', 'handler', 'span_id', 'correlation_id'])
        if item.get('event') == 'span_start':
            if key in starts:
                counters['duplicateStarts'] += 1
            else:
                starts[key] = item
            continue
        if item.get('event') != 'span_end':
            continue
        if key in seen_ends:
            counters['duplicateEnds'] += 1
            continue
        seen_ends.add(key)
        begin = starts.pop(key, None)
        if begin is None:
            counters['endWithoutStart'] += 1
            continue
        try:
            values = [begin['monotonic_ns'], item['monotonic_ns']]
            assert all(isinstance(value, (str, int)) and not isinstance(value, bool) for value in values)
            start, end = map(int, values)
            assert item.get('clock_domain') == 'python_process_monotonic'
            assert end >= start >= 0 and item.get('span_id') and item.get('recorder_process_id')
            for field in ['request_id', 'session_id', 'operation_id', 'attempt_id']:
                assert begin.get(field) == item.get(field)
        except (AssertionError, KeyError, ValueError, TypeError):
            counters['invalidBoundaryPairs'] += 1
            continue
        if item.get('outcome') != 'completed':
            counters['noncompletedPairs'] += 1
            continue
        completed[item['correlation_id']].append({
            'host': host, 'stage': item['stage'], 'handler': item['handler'],
            'receiverPid': receiver_pid, 'recorderProcessId': item['recorder_process_id'],
            'clockDomain': item['clock_domain'], 'startMonotonicNs': str(start),
            'endMonotonicNs': str(end), 'durationMs': (end - start) / 1_000_000,
            'correlationId': item['correlation_id'], 'spanId': item['span_id'],
            'requestId': item.get('request_id'), 'sessionId': item.get('session_id'),
            'nativeOperationId': item.get('operation_id'), 'nativeAttemptId': item.get('attempt_id'),
        })
    counters['unmatchedStartsInSavedPrefix'] = len(starts)
    return completed, dict(counters)


def phase_counts(rows):
    outcomes = Counter(row['status'] for row in rows)
    return {'attempted': len(rows), 'outcomes': dict(outcomes),
            'correct': outcomes['completed_correct'], 'incorrect': outcomes['completed_incorrect'],
            'failedOrInterrupted': sum(count for status, count in outcomes.items()
                                      if status not in ['completed_correct', 'completed_incorrect']),
            'timeouts': sum(row.get('timeout') is True for row in rows)}


def write_once(path, value):
    data = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    return write_bytes_once(path, data)


def write_bytes_once(path, data):
    assert not path.exists(), 'Preserve earlier outputs'
    temporary = path.with_name(path.name + '.partial')
    with temporary.open('xb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    assert sha(temporary.read_bytes()) == sha(data)
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
    return {'path': str(path), 'bytes': len(data), 'sha256': sha(data)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--requester-custody', type=Path, required=True)
    parser.add_argument('--provider-extracted', type=Path, required=True)
    parser.add_argument('--provider-coverage-chain', type=Path,
                        help='Resolve the selected provider snapshot across retained baseline/delta copies')
    parser.add_argument('--requester-snapshot', type=Path,
                        help='Replay a prior immutable snapshot instead of reading live CURRENT.json')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    args.requester_custody = args.requester_custody.resolve()
    args.provider_extracted = args.provider_extracted.resolve()
    args.output_dir = args.output_dir.resolve()
    assert args.output_dir.is_relative_to(REPO / 'thesis'), 'Keep scientific outputs inside thesis/'
    assert not args.output_dir.exists(), 'Use a new versioned analysis directory'
    sources = []
    snapshot_path = args.requester_snapshot.resolve() if args.requester_snapshot else args.requester_custody / 'CURRENT.json'
    snapshot = read_bound(snapshot_path, sources)
    state = json.loads(snapshot)
    provider_snapshot = read_bound(args.provider_extracted / 'PROVIDER-CURRENT.snapshot.json', sources)
    provider_state = json.loads(provider_snapshot)
    export = json.loads(read_bound(args.provider_extracted / 'PROVIDER-EXPORT.json', sources))
    assert export['snapshotSha256'] == sha(provider_snapshot)
    locations = (provider_locations(args.provider_coverage_chain.resolve(), provider_state, sources)
                 if args.provider_coverage_chain else None)
    frozen = read_bound(args.requester_custody / 'frozen/condition.json', sources)
    assert sha(frozen) == EXPECTED_MANIFEST
    manifest = json.loads(frozen)
    rows = []
    for name in sorted(state['completedCases']):
        record = state['completedCases'][name]
        raw = read_bound(REPO / record['case'], sources)
        assert sha(raw) == record['caseSha256']
        parsed = [json.loads(line) for line in raw.splitlines() if line.strip()]
        assert len(parsed) == 1
        rows.append(parsed[0])
    assert len({row['harness_case_id'] for row in rows}) == len(rows)
    assert all(row['phase'] in ['warmup', 'measured'] for row in rows)
    assert all(row['candidate_manifest_sha256'] == manifest['candidateManifestSha256'] for row in rows)
    local_ids = [row['correlation']['correlation_id'] for row in rows]
    assert all(isinstance(value, str) and value for value in local_ids)
    assert len(set(local_ids)) == len(local_ids)
    remote_ids = [row.get('stages', {}).get('tts', {}).get('server_correlation_id') for row in rows]
    remote_ids = [value for value in remote_ids if value]
    assert len(set(remote_ids)) == len(remote_ids)
    local, local_counts = paired_spans(prefix_rows(state, args.requester_custody, False, sources), 430656, 'requester')
    remote, remote_counts = paired_spans(prefix_rows(provider_state, args.provider_extracted, True, sources, locations), 261790, 'provider')
    history, aggregate_rows = {}, []
    for row in rows:
        local_id = row['correlation']['correlation_id']
        remote_id = row.get('stages', {}).get('tts', {}).get('server_correlation_id')
        spans = []
        for span in local.get(local_id, []) + remote.get(remote_id, []):
            if span['host'] == 'requester':
                if span.get('requestId') is not None:
                    assert span['requestId'] == row['correlation']['request_id']
                if span.get('sessionId') is not None:
                    assert span['sessionId'] == row['correlation']['session_id']
                if span['stage'] == 'llm':
                    assert span.get('requestId') and span.get('sessionId')
            spans.append(span)
        case = {'phase': row['phase'], 'ordinal': row['ordinal'], 'status': row['status'],
                'timeout': row.get('timeout', False), 'localCorrelationId': local_id,
                'serverCorrelationId': remote_id, 'flowDurationMs': row.get('flow_duration_ms'),
                'artifactStoreDurationMs': row.get('artifact_store_duration_ms'),
                'flowStartedMonotonicNs': row.get('flow_started_monotonic_ns'),
                'flowEndedMonotonicNs': row.get('flow_ended_monotonic_ns'),
                'requesterFlowClockDomain': 'python_process_monotonic',
                'requesterReceiverPid': 430656,
                'outputAudio': row.get('output_audio'), 'harnessStages': row.get('stages', {}),
                'nativeSpans': spans}
        history[row['harness_case_id']] = case
        if row['phase'] == 'measured':
            aggregate_rows.append((row, case))
    measured = [row for row in rows if row['phase'] == 'measured']
    warmups = [row for row in rows if row['phase'] == 'warmup']
    metrics = []
    for host, handlers in HANDLERS.items():
        for stage, handler in handlers:
            all_invocations, single_case, counts = [], [], Counter()
            for row, case in aggregate_rows:
                matches = [span for span in case['nativeSpans']
                           if (span['host'], span['stage'], span['handler']) == (host, stage, handler)]
                if not matches:
                    counts['missingCasesInSavedPrefixes'] += 1
                else:
                    counts['casesWithAnyCompletedSpan'] += 1
                if len(matches) == 1:
                    single_case.append(matches[0]['durationMs'])
                elif len(matches) > 1:
                    counts['multipleCompletedSpanCases'] += 1
                all_invocations.extend(span['durationMs'] for span in matches)
                counts['missingNativeOperationId'] += sum(not span['nativeOperationId'] for span in matches)
                counts['missingNativeAttemptId'] += sum(not span['nativeAttemptId'] for span in matches)
            metrics.append({'host': host, 'stage': stage, 'handler': handler,
                            'retainedMeasuredCaseDenominator': len(measured), **dict(counts),
                            'exactlyOneCompletedSpanPerCase': distribution(single_case),
                            'allCompletedInvocations': distribution(all_invocations),
                            'populationNote': 'Native completed spans can belong to failed or incorrect overall requests; they never convert those outcomes to successes.'})
    flow_metrics = {
        'successfulCorrect': distribution([row.get('flow_duration_ms') for row in measured if row['status'] == 'completed_correct']),
        'completedIncludingIncorrect': distribution([row.get('flow_duration_ms') for row in measured if row['status'] in ['completed_correct', 'completed_incorrect']]),
        'observedAttemptsIncludingFailures': distribution([row.get('flow_duration_ms') for row in measured]),
    }
    harness = {}
    for stage in ['stt', 'assistant', 'tts']:
        harness[stage] = distribution([row.get('stages', {}).get(stage, {}).get('duration_ms') for row in measured])
    progress = state['progressObservation']
    summary = {'schema': 'aurora.k1.saved-case-analysis.v1', 'at': datetime.now(timezone.utc).isoformat(),
               'cohort': manifest['cohortId'], 'route': manifest['routeLabel'],
               'analysisSourceSha256': sha(Path(__file__).read_bytes()),
               'type7SourceSha256': sha(Path(__file__).with_name('native_span_metrics_v2.py').read_bytes()),
               'status': 'INCOMPLETE_CHECKPOINT_ANALYSIS_NOT_A_900_CASE_SEAL',
               'plannedMeasured': 900, 'plannedExcludedWarmups': 15,
               'retainedPhases': {'measured': phase_counts(measured), 'excludedWarmup': phase_counts(warmups)},
               'sourceProgressObservation': progress,
               'measuredObservedButNotInCustodySnapshot': progress['measured_attempted'] - len(measured),
               'unattemptedAtSourceProgress': progress['unattempted_measured'],
               'requesterSnapshotAt': state['updatedAt'], 'providerSnapshotAt': provider_state['updatedAt'],
               'providerCheckpoint': provider_state['sequence'],
               'providerCoverageChain': (str(args.provider_coverage_chain.resolve())
                                         if args.provider_coverage_chain else None),
               'prefixWatermarks': {'requester': state['prefixes']['voice-stages.jsonl']['endByte'],
                                    'provider': provider_state['prefixes']['voice-stages.jsonl']['endByte']},
               'resourceCustody': {
                   'requester': state['prefixes']['resources.jsonl'],
                   'provider': provider_state['prefixes']['resources.jsonl'],
                   'scope': 'Raw resource chunks retained, with per-case own-clock flow/span boundaries for later association. No per-request CPU/network attribution or resource-derived metric is claimed here.',
               },
               'flowMetricsMs': flow_metrics, 'harnessStageMetricsMs': harness,
               'nativePairingCounts': {'requester': local_counts, 'provider': remote_counts},
               'nativeMetrics': metrics, 'quantileMethod': 'Hyndman-Fan Type7, h=(n-1)*p, linear interpolation',
               'clockPolicy': 'Pair identical host/process/recorder/clock/stage/handler/span/correlation boundaries; never subtract different host clocks or sum independent quantiles.',
               'missingSpanPolicy': 'Missing in copied prefixes is a custody/coverage observation, not a model/runtime failure.',
               'audioPolicy': 'Retain existing audio references and custody; no repeated WAV decoding or model/transcript correctness audit.',
               'unknownMetrics': {'queue': None, 'firstToken': None, 'firstAudio': None, 'playback': None,
                                  'relayOnlyLatency': None, 'externalPiperSubprocessPerRequestCpu': None},
               'sutCalls': 0, 'newMeasurements': 0}
    assert summary['measuredObservedButNotInCustodySnapshot'] >= 0
    args.output_dir.mkdir(parents=True)
    outputs = [write_once(args.output_dir / 'SUMMARY.json', summary),
               write_once(args.output_dir / 'CASE-HISTORY.json', history),
               write_once(args.output_dir / 'SOURCE-IDENTITIES.json', sources)]
    outputs.append(write_bytes_once(args.output_dir / 'REQUESTER-CURRENT.snapshot.json', snapshot))
    write_once(args.output_dir / 'CUSTODY.json', {'outputs': outputs, 'newMeasurements': 0})
    print(json.dumps({'summary': str(args.output_dir / 'SUMMARY.json'),
                      'retainedMeasured': len(measured), 'warmupsExcluded': len(warmups),
                      'nativeCoverage': [{k: metric.get(k, 0) for k in ['host', 'stage', 'handler', 'casesWithAnyCompletedSpan', 'missingCasesInSavedPrefixes']} for metric in metrics],
                      'newMeasurements': 0}), flush=True)


if __name__ == '__main__':
    main()

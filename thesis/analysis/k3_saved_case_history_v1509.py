"""Analyse saved K3 terminal-partial checkpoints; no workload execution or SUT imports."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

from k1_saved_case_history import (
    distribution,
    paired_spans,
    phase_counts,
    prefix_rows,
    provider_locations,
    read_bound,
    sha,
    write_bytes_once,
    write_once,
)

REPO = Path(__file__).resolve().parents[2]
EXPECTED_MANIFEST = '54d51acdf8219b4e69f21cabb9d9fb1b402acf9826196dbdcea4fcfd15bddb25'
REQUESTER_PID = 968825
PROVIDER_PID = 1227894
HANDLERS = {
    'requester': [],
    'provider': [('stt', 'Transcription.Transcribe'), ('stt', 'stt.model_invoke'),
                 ('llm', 'resolved_chat_model.astream'),
                 ('history', 'OrchestratorService._persist_chat_message'),
                 ('tts', 'TTS.Synthesize'), ('tts', 'tts.model_invoke')],
}


def counts(rows):
    return {**phase_counts(rows),
            'partialQualityIncorrect': sum(row.get('partial_quality_incorrect') is True for row in rows),
            'timeoutFlagAbsent': sum('timeout' not in row for row in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--requester-custody', type=Path, required=True)
    parser.add_argument('--requester-snapshot', type=Path, required=True)
    parser.add_argument('--provider-extracted', type=Path, required=True)
    parser.add_argument('--provider-coverage-chain', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    output = args.output_dir.resolve()
    assert output.is_relative_to(REPO / 'thesis') and not output.exists()
    source_records = []
    snapshot = read_bound(args.requester_snapshot.resolve(), source_records)
    state = json.loads(snapshot)
    provider_snapshot = read_bound(args.provider_extracted / 'PROVIDER-CURRENT.snapshot.json', source_records)
    provider_state = json.loads(provider_snapshot)
    export = json.loads(read_bound(args.provider_extracted / 'PROVIDER-EXPORT.json', source_records))
    assert export['snapshotSha256'] == sha(provider_snapshot)
    locations = provider_locations(args.provider_coverage_chain.resolve(), provider_state, source_records)
    frozen = read_bound(args.requester_custody / 'terminal-v1506/final-artifacts/condition-frozen-v1481.json', source_records)
    assert sha(frozen) == EXPECTED_MANIFEST
    manifest = json.loads(frozen)
    rows = []
    for key in sorted(state['completedCases']):
        record = state['completedCases'][key]
        raw = read_bound(REPO / record['case'], source_records)
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
    remote_ids = [row.get('stages', {}).get(stage, {}).get('server_correlation_id')
                  for row in rows for stage in ['stt', 'assistant', 'tts']]
    remote_ids = [value for value in remote_ids if value]
    assert len(set(remote_ids)) == len(remote_ids)
    local, local_counts = paired_spans(
        prefix_rows(state, args.requester_custody.resolve(), False, source_records), REQUESTER_PID, 'requester')
    remote, remote_counts = paired_spans(
        prefix_rows(provider_state, args.provider_extracted, True, source_records, locations), PROVIDER_PID, 'provider')
    history, measured_cases = {}, []
    for row in rows:
        local_id = row['correlation']['correlation_id']
        stages = row.get('stages', {})
        server_ids = {stage: stages.get(stage, {}).get('server_correlation_id') for stage in ['stt', 'assistant', 'tts']}
        spans = []
        for span in local.get(local_id, []):
            for native, supplied in [('requestId', 'request_id'), ('sessionId', 'session_id')]:
                if span.get(native) is not None:
                    assert span[native] == row['correlation'][supplied]
            spans.append(span)
        for stage, correlation in server_ids.items():
            for span in remote.get(correlation, []):
                spans.append({**span, 'gatewayStage': stage})
        case = {'phase': row['phase'], 'ordinal': row['ordinal'], 'status': row['status'],
                'timeout': row.get('timeout'), 'partialQualityIncorrect': row.get('partial_quality_incorrect'),
                'correctness': row.get('correctness'), 'failure': row.get('failure'),
                'partialFailureClass': row.get('partial_failure_class'),
                'localCorrelationId': local_id, 'serverCorrelationIds': server_ids,
                'flowDurationMs': row.get('flow_duration_ms'),
                'artifactStoreDurationMs': row.get('artifact_store_duration_ms'),
                'flowStartedMonotonicNs': row.get('flow_started_monotonic_ns'),
                'flowEndedMonotonicNs': row.get('flow_ended_monotonic_ns'),
                'requesterFlowClockDomain': 'python_process_monotonic',
                'requesterReceiverPid': REQUESTER_PID,
                'outputAudio': row.get('output_audio'), 'harnessStages': stages, 'nativeSpans': spans}
        history[row['harness_case_id']] = case
        if row['phase'] == 'measured':
            measured_cases.append((row, case))
    measured = [row for row in rows if row['phase'] == 'measured']
    warmups = [row for row in rows if row['phase'] == 'warmup']
    metrics = []
    for host, handlers in HANDLERS.items():
        for stage, handler in handlers:
            invocations, single, coverage = [], [], Counter()
            for row, case in measured_cases:
                matches = [span for span in case['nativeSpans']
                           if (span['host'], span['stage'], span['handler']) == (host, stage, handler)]
                coverage['casesWithAnyCompletedSpan' if matches else 'missingCasesInSavedPrefixes'] += 1
                if len(matches) == 1:
                    single.append(matches[0]['durationMs'])
                elif len(matches) > 1:
                    coverage['multipleCompletedSpanCases'] += 1
                invocations.extend(span['durationMs'] for span in matches)
                for field, label in [('nativeOperationId', 'missingNativeOperationId'),
                                     ('nativeAttemptId', 'missingNativeAttemptId'),
                                     ('requestId', 'missingNativeRequestId'), ('sessionId', 'missingNativeSessionId')]:
                    coverage[label] += sum(not span.get(field) for span in matches)
            metrics.append({'host': host, 'stage': stage, 'handler': handler,
                            'retainedMeasuredCaseDenominator': len(measured), **dict(coverage),
                            'exactlyOneCompletedSpanPerCase': distribution(single),
                            'allCompletedInvocations': distribution(invocations),
                            'populationNote': 'Native completed spans never turn a failed or incorrect full request into success.'})
    progress = state['progressObservation']
    missing_cases = progress['measured_attempted'] - len(measured)
    assert missing_cases >= 0
    summary = {'schema': 'aurora.k3.saved-case-analysis.v1', 'at': datetime.now(timezone.utc).isoformat(),
               'cohort': manifest['cohortId'], 'route': manifest['routeLabel'],
               'status': 'INCOMPLETE_CHECKPOINT_ANALYSIS_NOT_A_900_CASE_SEAL',
               'analysisSourceSha256': sha(Path(__file__).read_bytes()),
               'sharedAnalysisSourceSha256': sha(Path(__file__).with_name('k1_saved_case_history.py').read_bytes()),
               'type7SourceSha256': sha(Path(__file__).with_name('native_span_metrics_v2.py').read_bytes()),
               'plannedMeasured': 900, 'plannedExcludedWarmups': 15,
               'retainedPhases': {'measured': counts(measured), 'excludedWarmup': counts(warmups)},
               'sourceProgressObservation': progress, 'measuredObservedButNotInCustodySnapshot': missing_cases,
               'unattemptedAtSourceProgress': progress['unattempted_measured'],
               'requesterSnapshotAt': state['updatedAt'], 'providerSnapshotAt': provider_state['updatedAt'],
               'providerCheckpoint': provider_state['sequence'], 'providerCoverageChain': str(args.provider_coverage_chain.resolve()),
               'flowMetricsMs': {
                   'successfulCorrect': distribution([r.get('flow_duration_ms') for r in measured if r['status'] == 'completed_correct']),
                   'completedIncludingIncorrect': distribution([r.get('flow_duration_ms') for r in measured if r['status'] in ['completed_correct', 'completed_incorrect']]),
                   'observedAttemptsIncludingFailures': distribution([r.get('flow_duration_ms') for r in measured])},
               'harnessStageMetricsMs': {stage: distribution([r.get('stages', {}).get(stage, {}).get('duration_ms') for r in measured])
                                         for stage in ['stt', 'assistant', 'tts']},
               'nativePairingCounts': {'requester': local_counts, 'provider': remote_counts}, 'nativeMetrics': metrics,
               'nativePairingCountsScope': 'Whole retained prefixes of the reused provider session; only this cohort case correlations enter nativeMetrics.',
               'resourceCustody': {'requester': state['prefixes']['resources.jsonl'], 'provider': provider_state['prefixes']['resources.jsonl'],
                                   'scope': 'Raw resources retained; no per-request CPU/network attribution is inferred.'},
               'quantileMethod': 'Hyndman-Fan Type7, h=(n-1)*p, linear interpolation',
               'clockPolicy': 'Pair host/process/recorder/clock/stage/handler/span/correlation; no cross-host subtraction or sum of independent quantiles.',
               'missingSpanPolicy': 'Missing saved-prefix spans describe coverage, not a model failure. The final failed TTS request has no client response server-correlation ID; do not force-join an adjacent provider completion by time or order.',
               'timeoutDefinition': 'Counts use the requester harness timeout flag; unavailable transport exception detail is not inferred.',
               'failedTtsTailEvidence': 'provider-observations/failure-tail-v1506/RESULT.json retains a candidate final provider TTS completion separately; no strict failed-client response-ID join is claimed.',
               'audioPolicy': 'Retain actual audio/custody references; no repeated WAV decoding or correctness audit.',
               'unknownMetrics': {'queue': None, 'firstToken': None, 'firstAudio': None, 'playback': None, 'relayOnlyLatency': None},
               'newMeasurements': 0, 'sutCalls': 0}
    output.mkdir(parents=True)
    outputs = [write_once(output / 'SUMMARY.json', summary), write_once(output / 'CASE-HISTORY.json', history),
               write_once(output / 'SOURCE-IDENTITIES.json', source_records),
               write_bytes_once(output / 'REQUESTER-CURRENT.snapshot.json', snapshot)]
    write_once(output / 'CUSTODY.json', {'outputs': outputs, 'newMeasurements': 0})
    print(json.dumps({'summary': str(output / 'SUMMARY.json'), 'measured': len(measured), 'excludedWarmups': len(warmups),
                      'nativeCoverage': [{k: item.get(k, 0) for k in ['host', 'handler', 'casesWithAnyCompletedSpan', 'missingCasesInSavedPrefixes']}
                                         for item in metrics], 'newMeasurements': 0}), flush=True)


if __name__ == '__main__':
    main()

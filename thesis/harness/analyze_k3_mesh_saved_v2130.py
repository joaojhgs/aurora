"""Reproduce K3 outcomes and correlated traces from saved evidence only.

No SUT imports, traffic, inference, source mutation or historical-row rewrite.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import collections
import hashlib
import json
import os
import runpy
import shutil
import tarfile
import time
import wave

ROOT = Path(__file__).resolve().parents[2]
PARENT = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v1988'
CURRENT = ROOT / 'thesis/campaigns/worker-desktop-k3-p2p-full-audio-v2043'
ARCHIVE = CURRENT / 'provider-prefix-transfer-v2129/provider-prefix-v2128.tar.gz'
HELPERS = ROOT / 'thesis/harness/analyze_k2_mesh_saved_v1904.py'
H = runpy.run_path(str(HELPERS))
HANDLERS = {'stt': 'stt.model_invoke', 'assistant': 'resolved_chat_model.astream', 'tts': 'tts.model_invoke'}
TOPICS = {'stt': 'Transcription.Transcribe', 'assistant': 'Orchestrator.ExternalUserInput', 'tts': 'TTS.Synthesize'}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, value):
    with path.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def prefix(state, name):
    for relative in state['prefixes'].get(name, {}).get('chunks', []):
        with (ROOT / relative).open('rb') as stream:
            for line in stream:
                yield json.loads(line)


def main(out):
    os.umask(0o077)
    os.nice(10)
    assert not out.exists(), 'Use a new output directory; preserve every prior result'
    assert all(not Path('/proc', str(pid)).exists() for pid in [3207537, 3207665, 3207538])
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3 + 16 * 1024**2
    started = time.monotonic()
    assert H['sha'](ARCHIVE) == '462847fd5b22695873aee2fae763025012f9abf08ad888fb2bb67e6cc09c4559'
    cases, epochs, custody = [], {}, []
    for label, folder, manifest_sha, pid, ticks in [
        ('parent', PARENT, '46003ef84b71fade94e1d9e3cbac0dcee8bb524680ca613a9f02df5878e4cd6b', 3154248, 131502574),
        ('remaining624', CURRENT, 'ac92f9ba1455c3778e378c6548f0e518fcf0115c6ea9ebf7624f8c30df14d2c5', 3207665, 131930844),
    ]:
        assert H['sha'](folder / 'condition-frozen.json') == manifest_sha
        state = json.loads((folder / 'CURRENT.json').read_bytes())
        verified_bytes = 0
        for item in state['files'].values():
            raw = (ROOT / item['destination']).read_bytes()
            assert len(raw) == item['bytes'] and sha(raw) == item['sha256']
            verified_bytes += len(raw)
        rows = [json.loads(p.read_bytes()) for p in sorted((folder / 'attempts').glob('*.jsonl'))]
        resources, resource_info = H['resource_samples'](prefix(state, 'resources.jsonl'), pid, ticks)
        calls, routes = collections.defaultdict(dict), {}
        for row in prefix(state, 'requester-mesh-calls.jsonl'):
            key = (row['topic'], row['correlation_id'])
            assert row['event'] not in calls[key]
            calls[key][row['event']] = row
        for row in prefix(state, 'mesh-route-observations.jsonl'):
            key = (row['topic'], row['correlation_id'])
            assert key not in routes
            routes[key] = row
        epochs[label] = {'folder': folder, 'state': state, 'resources': resources,
                         'times': [r['ns'] for r in resources], 'calls': calls, 'routes': routes,
                         'pid': pid, 'ticks': ticks, 'resourceInfo': resource_info}
        for row in rows:
            index = row.get('global_measured_index', row['phase_index']) if row['phase'] == 'measured' else None
            audio = row.get('output_audio')
            if audio:
                audio_path = folder / audio['file']
                assert H['sha'](audio_path) == audio['sha256']
                with wave.open(str(audio_path), 'rb') as stream:
                    assert stream.getnframes() > 0
            cases.append({'epoch': label, 'globalIndex': index, 'row': row})
        custody.append({'epoch': label, 'files': len(state['files']), 'verifiedBytes': verified_bytes,
                        'cases': len(rows), 'audioFiles': len(list((folder / 'audio').glob('*.wav'))),
                        'stateSha256': H['sha'](folder / 'CURRENT.json')})
    assert len(cases) == 935
    assert len({c['row']['correlation']['correlation_id'] for c in cases}) == 935
    measured = [c for c in cases if c['globalIndex'] is not None]
    assert sorted(c['globalIndex'] for c in measured) == list(range(1, 901))
    native, archive_members = collections.defaultdict(dict), []
    with tarfile.open(ARCHIVE, 'r:gz') as archive:
        seal_raw = archive.extractfile('PROVIDER-PREFIX-SEAL.json').read()
        assert sha(seal_raw) == 'f81c45d2d1cb299f42ddb86280fe5a0f8f252383de9b9fc7b3dd95cb3f972158'
        seal = json.loads(seal_raw)
        for record in seal['files']:
            stream = archive.extractfile(record['name'])
            digest, size = hashlib.sha256(), 0
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
                size += len(block)
            assert size == record['bytes'] and digest.hexdigest() == record['sha256']
            archive_members.append({'name': record['name'], 'bytes': size, 'sha256': digest.hexdigest()})
        for line in archive.extractfile('raw/voice-stages.jsonl'):
            row = json.loads(line)
            if row.get('record_kind') != 'invocation_span_boundary':
                continue
            key = (row['handler'], row['correlation_id'], row['span_id'])
            assert row['event'] not in native[key]
            native[key][row['event']] = row
        dr, dr_info = H['resource_samples']((json.loads(x) for x in archive.extractfile('raw/resources.jsonl')), 251473, 29038457)
    dtimes = [r['ns'] for r in dr]
    native_by_case = collections.defaultdict(list)
    current_correlations = {c['row']['correlation']['correlation_id'] for c in cases}
    for (handler, corr, span), pair in native.items():
        if corr not in current_correlations or handler not in HANDLERS.values():
            continue
        assert set(pair) == {'span_start', 'span_end'}
        a, b = pair['span_start'], pair['span_end']
        assert a['receiver_pid'] == b['receiver_pid'] == 251473
        assert a['clock_domain'] == b['clock_domain'] == 'python_process_monotonic'
        begin, end = int(a['monotonic_ns']), int(b['monotonic_ns'])
        assert begin < end
        native_by_case[(handler, corr)].append({'spanId': span, 'startNs': begin, 'endNs': end,
            'outcome': b['outcome'], 'durationMs': (end-begin)/1e6,
            'resources': H['resource_window'](dr, dtimes, begin, end)})
    result_rows, gaps = [], []
    for case in cases:
        row = case['row']; epoch = epochs[case['epoch']]; corr = row['correlation']['correlation_id']
        result = {'epoch': case['epoch'], 'phase': row['phase'], 'globalIndex': case['globalIndex'],
                  'caseId': row['harness_case_id'], 'correlation': row['correlation'], 'status': row['status'],
                  'failure': row.get('failure'), 'partialQualityIncorrect': row.get('partial_quality_incorrect'),
                  'timeout': row.get('timeout'), 'flowMs': row['flow_duration_ms'],
                  'correctness': row.get('correctness'), 'requesterStages': row['stages'],
                  'nativeStages': {}, 'routes': {}, 'workerResources': None}
        try:
            result['workerResources'] = H['resource_window'](epoch['resources'], epoch['times'], row['flow_started_monotonic_ns'], row['flow_ended_monotonic_ns'])
        except AssertionError as error:
            gaps.append({'caseId': result['caseId'], 'field': 'workerResources', 'reason': str(error)})
        for stage, handler in HANDLERS.items():
            spans = native_by_case.get((handler, corr), [])
            result['nativeStages'][stage] = spans
            route = epoch['routes'].get((TOPICS[stage], corr))
            calls = epoch['calls'].get((TOPICS[stage], corr), {})
            if route:
                result['routes'][stage] = {'observation': route, 'calls': calls}
            if row['status'] == 'completed_correct' and (not spans or not route or set(calls) != {'mesh_peer_call_start', 'mesh_peer_call_end'}):
                gaps.append({'caseId': result['caseId'], 'field': stage, 'reason': 'missing native/route/call join for full-audio success'})
        result_rows.append(result)
    measured_rows = [r for r in result_rows if r['globalIndex'] is not None]
    correct = [r for r in measured_rows if r['status'] == 'completed_correct']
    failed = [r for r in measured_rows if r['status'] != 'completed_correct']
    assert len(correct) == 773 and len(failed) == 127
    codes = collections.Counter(r['failure']['code'] for r in failed)
    assert codes == {'preaccept_capability_changed': 71, 'assistant_reply_predicate_failed': 55, 'mesh_request_timeout_ambiguous': 1}
    q = H['quantiles']
    report = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'saved_requester_and_native_analysis_complete',
        'conditionTarget': 900, 'measuredAttempted': 900, 'correctFullAudio': 773, 'failed': 127,
        'partialAssistantQualityFailuresIncludedInFailed': 55, 'failureCodes': dict(codes),
        'timeoutsIncludedInFailed': 1, 'remaining': 0, 'warmupsExcluded': 35,
        'warmupCorrect': sum(r['status'] == 'completed_correct' for r in result_rows if r['phase'] != 'measured'),
        'latency': {'correctFullAudioOnly': q([r['flowMs'] for r in correct]),
                    'allAttemptsTimeToOutcomeNotAllFullAudio': q([r['flowMs'] for r in measured_rows]),
                    'failedTimeToOutcome': q([r['flowMs'] for r in failed])},
        'requesterStageLatencyOnCorrectFullAudio': {s: q([r['requesterStages'][s]['duration_ms'] for r in correct]) for s in HANDLERS},
        'nativeStageLatencyOnCorrectFullAudio': {s: q([span['durationMs'] for r in correct for span in r['nativeStages'][s]]) for s in HANDLERS},
        'custody': custody, 'providerArchive': {'path': str(ARCHIVE.relative_to(ROOT)), 'sha256': H['sha'](ARCHIVE), 'members': archive_members},
        'nativePairsInSnapshotAllScopes': len(native),
        'joinedNativePairsCurrent935Cases': sum(len(v) for r in result_rows for v in r['nativeStages'].values()),
        'providerResources': dr_info, 'requesterResources': {k: v['resourceInfo'] for k,v in epochs.items()},
        'gaps': gaps, 'qualityFailureCause': 'UNKNOWN; predicate failures are retained outcomes, response hashes alone are not a causal diagnosis',
        'clockPolicy': 'Requester durations use W monotonic; native durations and resources use D monotonic; no cross-host subtraction',
        'routeLimit': 'Before/after selected-pair observations only; no pair ID or continuous route/direct-or-TURN purity claim',
        'epochPolicy': 'Same effective setup, parent1–276 plus continuation277–900; raw histories and each manifest preserved; no failed-index retry or success top-up',
        'helper': {'path': str(HELPERS.relative_to(ROOT)), 'sha256': H['sha'](HELPERS)},
        'sutCalls': 0, 'elapsedSeconds': time.monotonic()-started}
    out.mkdir()
    with (out / 'case-analysis.jsonl').open('x') as stream:
        for row in result_rows:
            stream.write(json.dumps(row, separators=(',', ':'))+'\n')
    write(out / 'RESULT.json', report)
    print(json.dumps({k: report[k] for k in ['status','measuredAttempted','correctFullAudio','failed','failureCodes','latency','joinedNativePairsCurrent935Cases','gaps','elapsedSeconds']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=CURRENT / 'analysis-v2130')
    main(parser.parse_args().out)

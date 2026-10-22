"""Reproduce K1 counts and stage/resource joins from saved files, with no SUT calls."""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import collections
import hashlib
import itertools
import json
import os
import runpy
import shutil
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
CURRENT = ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining191-v2153'
HELPER = ROOT / 'thesis/harness/analyze_k2_mesh_saved_v1904.py'
H = runpy.run_path(str(HELPER))
HANDLERS = {'stt': 'stt.model_invoke', 'assistant': 'resolved_chat_model.astream', 'tts': 'tts.model_invoke'}
PEER = '77421aa81ce7ae2e865455348e9aa5ae17013d8f5e1f72d38d71d09f110ef868'
EPOCHS = [
    ('first20', 'worker-desktop-k1-p2p-tts-v1711', '04872dbd3948c13a4b269a1eb116f8b92fb3c369a8b0026cbbf339a2257009c1', 2326096, 124639833, 'oldProvider'),
    ('next689', 'worker-desktop-k1-p2p-tts-remaining880-v1719', '120dd99a4de0a242c30ebe4bb46d854ca77313c482a0c74f024edb624829a6e8', 2360768, 124937952, 'oldProvider'),
    ('remaining191', 'worker-desktop-k1-p2p-tts-remaining191-v2153', 'd753203e4a53f12ed983a98d776a811d241d0d6bc6061b28e3c1480a077a17d3', 3332919, 132996503, 'currentProvider'),
]


def prefix(state, name):
    for relative in state['prefixes'][name]['chunks']:
        with (ROOT / relative).open('rb') as stream:
            for line in stream:
                yield json.loads(line)


def pairs(rows, correlations, pid, stages):
    result = collections.defaultdict(dict)
    for row in rows:
        if (row.get('record_kind') != 'invocation_span_boundary'
                or row.get('handler') not in stages
                or row.get('correlation_id') not in correlations):
            continue
        assert row['receiver_pid'] == pid
        assert row['clock_domain'] == 'python_process_monotonic'
        key = (row['handler'], row['correlation_id'], row['span_id'])
        assert row['event'] not in result[key]
        result[key][row['event']] = row
    return result


def resources(rows, pid, ticks=None):
    if ticks is None:
        before = []
        for row in rows:
            context = row.get('resource_context', {})
            observed = context.get('child_proc_stat', {}).get('startTicks')
            if context.get('pid') == pid and observed is not None:
                ticks = observed
                before.append(row)
                break
            before.append(row)
            assert len(before) < 4096, 'Bounded receiver identity discovery'
        assert ticks is not None
        rows = itertools.chain(before, rows)
    samples, info = H['resource_samples'](rows, pid, ticks)
    info.update(receiverPid=pid, startTicks=ticks,
                scope='Receiver process plus sampled host/GPU/interface counters; parent process CPU is not all subprocess CPU')
    return {'samples': samples, 'times': [v['ns'] for v in samples], 'info': info}


def window(data, begin, end):
    value = H['resource_window'](data['samples'], data['times'], begin, end)
    if not any(isinstance(v['status'].get('VmRSS'), (int, float))
               for v in data['samples'] if begin <= v['ns'] <= end):
        value['sampledMaxRssKiB'] = None
    return value


def load_provider(custody_path, pid, correlations):
    custody = json.loads(custody_path.read_bytes())
    archive = ROOT / custody['archiveVerified']['path']
    assert H['sha'](archive) == custody['archiveVerified']['sha256']
    native, counters, members = None, None, []
    with tarfile.open(archive, 'r|gz') as source:
        for member in source:
            members.append(member.name)
            if member.name == 'raw/voice-stages.jsonl':
                native = pairs((json.loads(line) for line in source.extractfile(member)),
                               correlations, pid, {HANDLERS['tts']})
            elif member.name == 'raw/resources.jsonl':
                counters = resources((json.loads(line) for line in source.extractfile(member)), pid)
    assert native is not None and counters is not None
    return {'pairs': native, 'resources': counters,
            'archive': {'path': str(archive.relative_to(ROOT)),
                        'sha256': custody['archiveVerified']['sha256'],
                        'members': members, 'rawPayloadBytes': custody['rawPayloadBytes']}}


def native_by_case(raw, data, gaps, host):
    result = collections.defaultdict(list)
    for (handler, corr, span), pair in raw.items():
        if set(pair) != {'span_start', 'span_end'}:
            gaps.append({'correlationId': corr, 'host': host, 'field': handler, 'reason': 'unpaired saved span'})
            continue
        start, end = pair['span_start'], pair['span_end']
        a, b = int(start['monotonic_ns']), int(end['monotonic_ns'])
        assert a < b
        value = {'spanId': span, 'receiverPid': start['receiver_pid'], 'host': host,
                 'startNs': a, 'endNs': b, 'durationMs': (b-a)/1e6,
                 'outcome': end['outcome'], 'resources': None}
        try:
            value['resources'] = window(data, a, b)
        except AssertionError as error:
            gaps.append({'correlationId': corr, 'host': host, 'field': handler + '.resources', 'reason': str(error)})
        result[(handler, corr)].append(value)
    return result


def route_summary(route, calls, pid, corr):
    a, b = calls['mesh_peer_call_start'], calls['mesh_peer_call_end']
    assert route['requester_pid'] == a['pid'] == b['pid'] == pid
    assert route['correlation_id'] == a['correlation_id'] == b['correlation_id'] == corr
    assert route['topic'] == a['topic'] == b['topic'] == 'TTS.Synthesize'
    assert a['peer_id_sha256'] == b['peer_id_sha256'] == PEER
    assert route['request_monotonic_start_ns'] <= a['monotonic_start_ns']
    assert a['monotonic_start_ns'] == b['monotonic_start_ns'] < b['monotonic_end_ns'] <= route['request_monotonic_end_ns']
    snapshots = [route['before'], route['after']]
    for item in snapshots:
        assert item['status'] == 'selected_nominated_pair_observed'
        assert item['pid'] == pid and item['peer_id_sha256'] == PEER
        assert item['selected_pairs'] and all(v['nominated'] and v['pair_state'] == 'succeeded' for v in item['selected_pairs'])
    assert snapshots[0]['peer_connection_instance_sha256'] == snapshots[1]['peer_connection_instance_sha256']
    return {'requestOutcome': route['request_outcome'], 'callOutcome': b['outcome'],
            'beforeClasses': sorted({v['path_class'] for v in snapshots[0]['selected_pairs']}),
            'afterClasses': sorted({v['path_class'] for v in snapshots[1]['selected_pairs']}),
            'callMs': (b['monotonic_end_ns']-a['monotonic_start_ns'])/1e6,
            'scope': 'before/after observations only; no pair ID or continuous direct/relay purity claim'}


def main(out):
    os.umask(0o077)
    os.nice(10)
    assert not out.exists(), 'Use a new output path; preserve prior results'
    assert all(not Path('/proc', str(pid)).exists() for pid in [3332811, 3332919, 3333678])
    assert shutil.disk_usage(ROOT).free > 2*1024**3 + 16*1024**2
    started = time.monotonic()
    cases, epochs, gaps = [], {}, []
    audio_count = 0
    for label, folder, manifest, pid, ticks, provider in EPOCHS:
        path = ROOT / 'thesis/campaigns' / folder
        assert H['sha'](path / 'condition-frozen.json') == manifest
        state = json.loads((path / 'CURRENT.json').read_bytes())
        for record in state['completedCases'].values():
            raw = (ROOT / record['case']).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == record['caseSha256']
            row = json.loads(raw)
            if record['audio']:
                assert (ROOT / record['audio']).is_file()
                audio_count += 1
            index = row.get('global_measured_index', row.get('condition_measured_index', row['phase_index'])) if row['phase'] == 'measured' else None
            cases.append({'epoch': label, 'index': index, 'row': row})
        correlations = {v['row']['correlation']['correlation_id'] for v in cases if v['epoch'] == label}
        counters = resources(prefix(state, 'resources.jsonl'), pid, ticks)
        calls, routes = collections.defaultdict(dict), {}
        for row in prefix(state, 'requester-mesh-calls.jsonl'):
            key = row['correlation_id']
            assert row['event'] not in calls[key]
            calls[key][row['event']] = row
        for row in prefix(state, 'requester-mesh-route-observations.jsonl'):
            assert row['correlation_id'] not in routes
            routes[row['correlation_id']] = row
        local = pairs(prefix(state, 'voice-stages.jsonl'), correlations, pid,
                      {HANDLERS['stt'], HANDLERS['assistant']})
        epochs[label] = {'provider': provider, 'pid': pid, 'resources': counters,
                         'native': native_by_case(local, counters, gaps, 'coding-worker'),
                         'routes': routes, 'calls': calls, 'manifest': manifest}
    assert len(cases) == 945
    assert len({v['row']['correlation']['correlation_id'] for v in cases}) == 945
    assert sorted(v['index'] for v in cases if v['index'] is not None) == list(range(1, 901))
    correlations = {v['row']['correlation']['correlation_id'] for v in cases}
    providers = {
        'oldProvider': load_provider(ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-v1710/provider-transfer-terminal-v1788/CUSTODY.json', 3194394, correlations),
        'currentProvider': load_provider(CURRENT / 'provider-prefix-transfer-v2198/CUSTODY.json', 251473, correlations),
    }
    for name, provider in providers.items():
        provider['native'] = native_by_case(provider['pairs'], provider['resources'], gaps, 'personal-desktop/' + name)
    results = []
    for case in cases:
        row = case['row']; epoch = epochs[case['epoch']]; corr = row['correlation']['correlation_id']
        value = {'epoch': case['epoch'], 'globalIndex': case['index'], 'phase': row['phase'],
                 'caseId': row['harness_case_id'], 'correlation': row['correlation'],
                 'status': row['status'], 'failure': row.get('failure'), 'timeout': row.get('timeout'),
                 'flowMs': row['flow_duration_ms'], 'requesterStages': row['stages'],
                 'nativeStages': {}, 'workerResources': None, 'route': None}
        try:
            value['workerResources'] = window(epoch['resources'], row['flow_started_monotonic_ns'], row['flow_ended_monotonic_ns'])
        except AssertionError as error:
            gaps.append({'caseId': value['caseId'], 'field': 'workerResources', 'reason': str(error)})
        for stage, handler in HANDLERS.items():
            source = providers[epoch['provider']]['native'] if stage == 'tts' else epoch['native']
            spans = source.get((handler, corr), [])
            value['nativeStages'][stage] = spans
            if row['status'] == 'completed_correct' and not spans:
                gaps.append({'caseId': value['caseId'], 'field': stage, 'reason': 'missing saved native inference span'})
        route, calls = epoch['routes'].get(corr), epoch['calls'].get(corr, {})
        if route and set(calls) == {'mesh_peer_call_start', 'mesh_peer_call_end'}:
            try:
                value['route'] = route_summary(route, calls, epoch['pid'], corr)
            except AssertionError:
                gaps.append({'caseId': value['caseId'], 'field': 'route', 'reason': 'saved route/call binding did not match'})
        elif row['status'] == 'completed_correct':
            gaps.append({'caseId': value['caseId'], 'field': 'route', 'reason': 'missing saved route/call join'})
        results.append(value)
    measured = [v for v in results if v['globalIndex'] is not None]
    assert collections.Counter(v['status'] for v in measured) == {'completed_correct': 885, 'failed': 15}
    q = H['quantiles']; tables = {}
    for label, epoch in epochs.items():
        rows = [v for v in measured if v['epoch'] == label]
        good = [v for v in rows if v['status'] == 'completed_correct']
        tables[label] = {'measured': len(rows), 'correct': len(good), 'failed': len(rows)-len(good),
            'timeoutsIncludedInFailed': sum(v['timeout'] is True for v in rows),
            'correctFullAudioOnly': q([v['flowMs'] for v in good]),
            'allAttemptsTimeToOutcomeNotAllFullAudio': q([v['flowMs'] for v in rows]),
            'failedTimeToOutcome': q([v['flowMs'] for v in rows if v['status'] != 'completed_correct']),
            'nativeStageCorrectOnly': {s: q([p['durationMs'] for v in good for p in v['nativeStages'][s]]) for s in HANDLERS},
            'requesterStageCorrectOnly': {s: q([v['requesterStages'][s]['duration_ms'] for v in good]) for s in HANDLERS},
            'requesterResources': epoch['resources']['info'], 'providerContext': epoch['provider'],
            'conditionManifestSha256': epoch['manifest']}
    report = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'saved_k1_analysis_complete',
        'measuredAttempted': 900, 'correctFullAudio': 885, 'failed': 15, 'remaining': 0,
        'timeoutsIncludedInFailed': sum(v['timeout'] is True for v in measured),
        'failureCodes': dict(collections.Counter(v['failure']['code'] for v in measured if v['status'] != 'completed_correct')),
        'excludedWarmupsInMeasuredEpochs': sum(v['phase'] == 'warmup' for v in results), 'extraFailedStartup': 'V1779 retains3additional excludedwarmups=2correct1failed/0measured; V2143 zero requests; separate preserved history',
        'perEpoch': tables, 'providerResources': {k: v['resources']['info'] for k,v in providers.items()},
        'providerArchives': {k: v['archive'] for k,v in providers.items()},
        'caseCount': len(results), 'audioFilesPreviouslySealedAndStillPresent': audio_count,
        'joinedNativePairs': sum(len(p) for v in results for p in v['nativeStages'].values()),
        'gaps': gaps, 'whole900PooledLatency': None,
        'latencyPolicy': 'Per-epoch distributions only: explicit language-list contract compatibility source delta and full-three-model desktop residency in final191; no silent context pooling or pure protocol-overhead interpretation',
        'clockPolicy': 'W flow/local-native/resource windows use W monotonic; D native/resource windows use the appropriate D receiver process monotonic; no cross-host subtraction',
        'routePolicy': 'Before/after nominated-pair observations; no pair ID or continuous route purity claim',
        'failureCausePolicy': 'Outcome codes retained; capability-change cause and ambiguous timeout execution cause remain UNKNOWN, no model-quality inference',
        'helper': {'path': str(HELPER.relative_to(ROOT)), 'sha256': H['sha'](HELPER)},
        'sutCalls': 0, 'elapsedSeconds': time.monotonic()-started}
    out.mkdir()
    with (out / 'case-analysis.jsonl').open('x') as stream:
        for row in results:
            stream.write(json.dumps(row,separators=(',',':'))+'\n')
    with (out / 'RESULT.json').open('x') as stream:
        json.dump(report,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    text = '# K1 actual P2P: retained results\n\n900 distinct measured attempts:885 correct,15 failed(including1timeout);45 excluded warmups in the three measured epochs. V1779 startup history remains separate. No failed index was retried or topped up.\n\n'
    text += '| Epoch | Attempted | Correct | Failed | Correct-flow p90(s) | p95(s) |\n|---|---:|---:|---:|---:|---:|\n'
    for label,v in tables.items():
        text += f'| {label} | {v["measured"]} | {v["correct"]} | {v["failed"]} | {v["correctFullAudioOnly"]["p90"]/1000:.6f} | {v["correctFullAudioOnly"]["p95"]/1000:.6f} |\n'
    text += '\nQuantiles use Hyndman–Fan Type7; source values are milliseconds. Each correct-flow denominator is the epoch correct count. All-attempt and failed time-to-outcome populations, native/requester stage distributions, correlated resource windows and exact IDs are in RESULT.json/case-analysis.jsonl. Failures are not full-audio completions.\n\n'
    text += report['latencyPolicy']+'. '+report['clockPolicy']+'. '+report['routePolicy']+'.\n\n'
    text += f'945 saved case records;930 audio files previously sealed and still present;{report["joinedNativePairs"]} joined native inference pairs;{len(gaps)} recorded trace/resource gaps. Receiver-process CPU excludes untracked subprocess CPU; host counters retain their own sampling brackets. Missing counters are not evidence of zero use. Provider archives contain actual raw copies; live-provider prefixes are not provider EOF. No inference, network testing, model scan or source mutation was performed.\n'
    with (out / 'results.md').open('x') as stream:
        stream.write(text)
    print(json.dumps({k:report[k] for k in ['status','measuredAttempted','correctFullAudio','failed','failureCodes','joinedNativePairs','gaps','elapsedSeconds']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=CURRENT/'analysis-v2200')
    main(parser.parse_args().out)

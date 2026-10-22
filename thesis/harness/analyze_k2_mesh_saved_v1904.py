"""Reproduce the V1826 terminal K2 analysis from retained files; no SUT calls."""
from __future__ import annotations

import argparse
import bisect
import collections
import hashlib
import json
import math
import os
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826'
CONDITION = 'a653d60065616e34844d956d1ed47038aa94f3ff876c36bf3a98e904ca838641'
ARCHIVE = DATA / 'provider-transfer-terminal-v1902/provider-eof-v1901.tar.gz'
EXPECTED = {'stt': (2830763, 'stt.model_invoke'),
            'assistant': (3938202, 'resolved_chat_model.astream'),
            'tts': (3938202, 'tts.model_invoke')}
TOPICS = {'assistant': 'Orchestrator.ExternalUserInput', 'tts': 'TTS.Synthesize'}


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def quantiles(values):
    v = sorted(values)
    result = {'n': len(v), 'units': 'ms', 'estimator': 'Hyndman-Fan type 7'}
    if v:
        for label, p in [('p50', .5), ('p90', .9), ('p95', .95), ('p99', .99)]:
            index = (len(v) - 1) * p
            lo, hi = math.floor(index), math.ceil(index)
            result[label] = v[lo] + (v[hi] - v[lo]) * (index - lo)
    return result


def prefix_rows(state, name):
    for relative in state['prefixes'][name]['chunks']:
        with (ROOT / relative).open('rb') as f:
            for line in f:
                yield json.loads(line)


def stage_pairs(rows):
    groups = collections.defaultdict(dict)
    for row in rows:
        stage = next((s for s, (_, handler) in EXPECTED.items()
                      if row.get('handler') == handler), None)
        if stage is None or row.get('record_kind') != 'invocation_span_boundary':
            continue
        key = (stage, row['correlation_id'])
        event = row['event']
        assert event in ('span_start', 'span_end') and event not in groups[key]
        groups[key][event] = row
    return groups


def resource_samples(rows, expected_pid, expected_ticks):
    result = []
    excluded = 0
    error_fields = collections.Counter()
    for row in rows:
        c = row.get('resource_context', {})
        if c.get('pid') != expected_pid or c.get('child_proc_stat', {}).get('startTicks') != expected_ticks:
            excluded += 1
            continue
        ns = int(c['monotonic_ns'])
        for e in c.get('counter_errors', []):
            error_fields[e.get('field', 'unknown')] += 1
        proc = c['child_proc_stat']
        result.append({'ns': ns, 'cpu_ticks': proc['userCpuTicks'] + proc['systemCpuTicks'],
                       'hz': c['ticks_per_second'], 'status': c.get('child_status', {}),
                       'host_cpu': c.get('host_cpu_ticks'), 'gpu': c.get('amd_drm_devices', []),
                       'network': c.get('host_network', {}).get('interfaces', {})})
    assert result and all(a['ns'] < b['ns'] for a, b in zip(result, result[1:]))
    return result, {'identityMatchedSamples': len(result), 'excludedIdentityOrPrestartup': excluded,
                    'counterErrorFields': dict(error_fields)}


def resource_window(samples, times, start, end):
    left, right = bisect.bisect_right(times, start) - 1, bisect.bisect_left(times, end)
    assert left >= 0 and right < len(samples), 'Missing same-host resource bracket'
    a, b = samples[left], samples[right]
    window = samples[left:right + 1]
    gpu = {}
    for sample in window:
        for device in sample['gpu']:
            key = str(device['device'])
            item = gpu.setdefault(key, {'vendor': device.get('vendor'), 'busy': [], 'vram': []})
            for raw, dest in [('gpu_busy_percent', 'busy'), ('mem_info_vram_used', 'vram')]:
                if isinstance(device.get(raw), (int, float)):
                    item[dest].append(device[raw])
    gpu_result = {key: {'vendor': v['vendor'],
                         'sampledMaxBusyPercent': max(v['busy']) if v['busy'] else None,
                         'sampledMaxVramBytes': max(v['vram']) if v['vram'] else None,
                         'busySamples': len(v['busy']), 'vramSamples': len(v['vram'])}
                  for key, v in gpu.items()}
    network = {}
    for interface in a['network'].keys() & b['network'].keys():
        network[interface] = {k: b['network'][interface][k] - a['network'][interface][k]
                              for k in ('rx_bytes', 'tx_bytes')}
    cpu = None
    if a['host_cpu'] and b['host_cpu']:
        delta = [y - x for x, y in zip(a['host_cpu'][:8], b['host_cpu'][:8])]
        if sum(delta) > 0:
            cpu = 100 * (sum(delta) - delta[3] - delta[4]) / sum(delta)
    return {'startBracketNs': a['ns'], 'endBracketNs': b['ns'], 'sampleCount': len(window),
            'beforeSlackMs': (start - a['ns']) / 1e6, 'afterSlackMs': (b['ns'] - end) / 1e6,
            'processCpuMsWithinBracket': (b['cpu_ticks'] - a['cpu_ticks']) * 1000 / a['hz'],
            'sampledMaxRssKiB': max(s['status'].get('VmRSS', 0) for s in window),
            'hostCpuBusyPercentWithinBracket': cpu, 'deviceGpu': gpu_result,
            'hostInterfaceByteDeltasWithinBracket': network}


def valid_route(route, call_start, call_end, peer, corr, topic):
    assert route['requester_pid'] == call_start['pid'] == call_end['pid'] == 2830763
    assert route['topic'] == call_start['topic'] == call_end['topic'] == topic
    assert route['correlation_id'] == call_start['correlation_id'] == call_end['correlation_id'] == corr
    assert call_start['peer_id_sha256'] == call_end['peer_id_sha256'] == peer
    assert route['request_monotonic_start_ns'] <= call_start['monotonic_start_ns']
    assert call_end['monotonic_start_ns'] == call_start['monotonic_start_ns']
    assert call_start['monotonic_start_ns'] < call_end['monotonic_end_ns'] <= route['request_monotonic_end_ns']
    before, after = route['before'], route['after']
    for snapshot in (before, after):
        assert snapshot['status'] == 'selected_nominated_pair_observed'
        assert snapshot['pid'] == 2830763 and snapshot['peer_id_sha256'] == peer
        assert snapshot['selected_pairs'] and all(p['nominated'] is True and p['pair_state'] == 'succeeded'
                                                 for p in snapshot['selected_pairs'])
    assert before['session_peer_id_sha256'] == after['session_peer_id_sha256']
    assert before['peer_connection_instance_sha256'] == after['peer_connection_instance_sha256']
    return {'requestOutcome': route['request_outcome'], 'callOutcome': call_end['outcome'],
            'beforePathClasses': sorted({p['path_class'] for p in before['selected_pairs']}),
            'afterPathClasses': sorted({p['path_class'] for p in after['selected_pairs']}),
            'peerIdSha256': peer, 'sessionPeerIdSha256': before['session_peer_id_sha256'],
            'peerConnectionInstanceSha256': before['peer_connection_instance_sha256'],
            'callMs': (call_end['monotonic_end_ns'] - call_start['monotonic_start_ns']) / 1e6}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=DATA / 'analysis-v1904')
    args = parser.parse_args()
    os.umask(0o077)
    os.nice(10)
    assert not args.out.exists(), 'Use a new output directory; preserve prior analysis'
    state = json.loads((DATA / 'CURRENT.json').read_text())
    condition = json.loads((DATA / 'condition-frozen.json').read_text())
    requester_seal = json.loads((DATA / 'terminal-v1899/REQUESTER-SEAL.json').read_text())
    custody = json.loads((DATA / 'provider-transfer-terminal-v1902/CUSTODY.json').read_text())
    assert sha(DATA / 'condition-frozen.json') == CONDITION
    assert sha(ARCHIVE) == custody['archiveVerified']['sha256']
    cases = [json.loads(p.read_text()) for p in sorted((DATA / 'attempts').glob('*.jsonl'))]
    assert len(cases) == 915 and len({r['correlation']['correlation_id'] for r in cases}) == 915
    assert {r['phase_index'] for r in cases if r['phase'] == 'measured'} == set(range(1, 901))
    local = stage_pairs(prefix_rows(state, 'voice-stages.jsonl'))
    wr, wr_info = resource_samples(prefix_rows(state, 'resources.jsonl'), 2830763, 129050436)
    with tarfile.open(ARCHIVE, 'r:gz') as archive:
        remote = stage_pairs(json.loads(line) for line in archive.extractfile('raw/voice-stages.jsonl'))
        bindings = [json.loads(line) for line in archive.extractfile('raw/actual-provider-bindings.jsonl')]
        dr, dr_info = resource_samples((json.loads(line) for line in archive.extractfile('raw/resources.jsonl')),
                                       3938202, 26503353)
    current_corr = {r['correlation']['correlation_id'] for r in cases}
    excluded_remote = sum(k[1] not in current_corr for k in remote)
    local.update({k: v for k, v in remote.items() if k[1] in current_corr})
    assert len(local) == 915 + 915 + 789
    starts = [b for b in bindings if b.get('event') == 'piper_cli_call_start']
    returns = [b for b in bindings if b.get('event') == 'piper_cli_call_return']
    constructors = [b for b in bindings if b.get('event') == 'llm_constructor_return']
    assert len(constructors) == 1 and constructors[0]['pid'] == 3938202
    expected_settings = condition['remoteAssistantConfigBinding']['effective_llm_settings']
    assert {k: constructors[0]['actualArguments'][k] for k in expected_settings} == expected_settings
    assert expected_settings['n_gpu_layers'] == 100
    calls = collections.defaultdict(dict)
    for row in prefix_rows(state, 'requester-mesh-calls.jsonl'):
        key = (row['topic'], row['correlation_id'])
        assert row['event'] not in calls[key]
        calls[key][row['event']] = row
    routes = {}
    for row in prefix_rows(state, 'mesh-route-observations.jsonl'):
        key = (row['topic'], row['correlation_id'])
        assert key not in routes
        routes[key] = row
    assert len(calls) == len(routes) == 1715
    times = {'worker': [r['ns'] for r in wr], 'desktop': [r['ns'] for r in dr]}
    resource = {'worker': wr, 'desktop': dr}
    native_rows, case_rows = [], []
    for case in cases:
        corr = case['correlation']['correlation_id']
        row = {'caseId': case['harness_case_id'], 'phase': case['phase'], 'phaseIndex': case['phase_index'],
               'correlation': case['correlation'], 'status': case['status'], 'failure': case.get('failure'),
               'flowMs': case['flow_duration_ms'], 'audio': case.get('output_audio'),
               'requesterStages': case['stages'], 'nativeStages': {}, 'routes': {}}
        for stage, (pid, handler) in EXPECTED.items():
            key = (stage, corr)
            expected = stage != 'tts' or case['status'] == 'completed_correct'
            if not expected:
                assert key not in local
                row['nativeStages'][stage] = {'status': 'not_invoked_after_recorded_failure'}
                continue
            pair = local[key]
            assert set(pair) == {'span_start', 'span_end'}
            begin, finish = pair['span_start'], pair['span_end']
            assert begin['receiver_pid'] == finish['receiver_pid'] == pid
            assert begin['handler'] == finish['handler'] == handler
            assert begin['correlation_id'] == finish['correlation_id'] == corr
            assert begin['span_id'] == finish['span_id']
            assert begin['clock_domain'] == finish['clock_domain'] == 'python_process_monotonic'
            assert begin['outcome'] == 'started' and finish['outcome'] == 'completed'
            start, end = int(begin['monotonic_ns']), int(finish['monotonic_ns'])
            assert 0 < start < end
            if stage == 'assistant':
                assert all(begin[k] == finish[k] == case['correlation'][k] for k in ('request_id', 'session_id'))
            else:
                assert begin['operation_id'] == finish['operation_id'] and begin['attempt_id'] == finish['attempt_id']
                assert begin['operation_id'] and begin['attempt_id']
            host = 'worker' if stage == 'stt' else 'desktop'
            if stage == 'stt':
                assert case['stages']['stt']['start_monotonic_ns'] <= start < end <= case['stages']['stt']['end_monotonic_ns']
            record = {'caseId': row['caseId'], 'phase': row['phase'], 'phaseIndex': row['phaseIndex'],
                      'caseStatus': row['status'], 'correlationId': corr, 'stage': stage,
                      'host': host, 'pid': pid, 'handler': handler, 'spanId': finish['span_id'],
                      'operationId': finish.get('operation_id'), 'attemptId': finish.get('attempt_id'),
                      'startNs': start, 'endNs': end, 'durationMs': (end - start) / 1e6,
                      'resources': resource_window(resource[host], times[host], start, end)}
            if stage == 'tts':
                ps = [b for b in starts if b['pid'] == pid and start <= b['monotonicNs'] <= end]
                pe = [b for b in returns if b['pid'] == pid and start <= b['monotonicNs'] <= end]
                assert len(ps) == len(pe) == 1 and ps[0]['monotonicNs'] < pe[0]['monotonicNs']
                assert ps[0]['actualArguments']['useCuda'] is False
                record['piperInvocationMs'] = (pe[0]['monotonicNs'] - ps[0]['monotonicNs']) / 1e6
            row['nativeStages'][stage] = {k: v for k, v in record.items() if k not in ('resources',)}
            native_rows.append(record)
        for stage, topic in TOPICS.items():
            key = (topic, corr)
            if key not in calls:
                assert stage == 'tts' and (case.get('failure') or {}).get('code') == 'assistant_reply_predicate_failed'
                continue
            pair = calls[key]
            assert set(pair) == {'mesh_peer_call_start', 'mesh_peer_call_end'}
            peer = condition['remoteReceivers'][stage]['peer_id_sha256']
            row['routes'][stage] = valid_route(routes[key], pair['mesh_peer_call_start'], pair['mesh_peer_call_end'], peer, corr, topic)
        case_rows.append(row)
    measured = [r for r in case_rows if r['phase'] == 'measured']
    measured_native = [r for r in native_rows if r['phase'] == 'measured']
    counts = collections.Counter(r['stage'] for r in measured_native)
    assert counts == {'stt': 900, 'assistant': 900, 'tts': 774}
    assert len(native_rows) == 2619
    metrics = {'successfulCorrectE2E': quantiles([r['flowMs'] for r in measured if r['status'] == 'completed_correct']),
               'allMeasuredObservedAttempts': quantiles([r['flowMs'] for r in measured]),
               'nativeAllInvokedMeasured': {s: quantiles([r['durationMs'] for r in measured_native if r['stage'] == s]) for s in EXPECTED},
               'nativeCorrectFullAudioOnly': {s: quantiles([r['durationMs'] for r in measured_native if r['stage'] == s and r['caseStatus'] == 'completed_correct']) for s in EXPECTED}}
    assert metrics['successfulCorrectE2E'] == requester_seal['metrics']['successful_correct_e2e']
    summary = {'schema': 'aurora.k2_saved_terminal_analysis.v1', 'scope': 'Current bounded check; fixed-file audio only',
               'conditionManifestSha256': CONDITION, 'providerArchiveSha256': sha(ARCHIVE),
               'sourceProcedureSha256': sha(Path(__file__)), 'measured': len(measured), 'excludedWarmups': 15,
               'outcomes': dict(collections.Counter(r['status'] for r in measured)),
               'failureKinds': dict(collections.Counter(r['failure']['code'] for r in measured if r['failure'])),
               'timeouts': requester_seal['timeouts'], 'unattempted': 0,
               'nativeMeasuredStageCounts': dict(counts), 'nativeWarmupStageJoins': 45,
               'excludedEarlierProviderCorrelationStagePairs': excluded_remote,
               'routeCallJoinsIncludingWarmups': len(calls), 'metrics': metrics,
               'resourceInputs': {'worker': wr_info, 'desktop': dr_info},
               'resourceSemantics': 'Same-host native span bracket samples. CPU deltas include bracket slack; process CPU excludes Piper child process CPU. RSS is sampled KiB. GPU and interface counters are host/device-level context, not exclusive request attribution; overlapping brackets must not be summed.',
               'maxResourceBracketSlackMs': max(max(r['resources']['beforeSlackMs'], r['resources']['afterSlackMs']) for r in native_rows),
               'clockSemantics': 'Native durations use start/end within their own host monotonic domain. No cross-host monotonic subtraction; no network-only latency inferred.',
               'routeSemantics': 'Before/after selected nominated ICE transport snapshots; no continuous path-stability claim.',
               'models': condition['models'], 'audio': condition['audio'],
               'actualStt': list(prefix_rows(state, 'actual-provider-bindings.jsonl')),
               'actualLlmConstructor': constructors[0], 'gpuReadinessProof': 'ordinary-warmup-proof-v1826/actual-new-process-gpu.json',
               'knownReplyFormatOutcome': '115 failed strict city-only predicate; known 31-byte sentence was factually correct. Frozen predicate unchanged; skipped TTS has no expected output WAV.',
               'receiverPreacceptCause': 'UNKNOWN; observed structured capability_changed rejection, no causal inference',
               'newSutCalls': 0, 'physicalMicrophonePlaybackAudibilityTested': False, 'allSourceDataPreserved': True}
    inputs = []
    paths = [DATA / 'condition-frozen.json', DATA / 'CURRENT.json', DATA / 'terminal-v1899/REQUESTER-SEAL.json', ARCHIVE,
             DATA / 'provider-transfer-terminal-v1902/CUSTODY.json', Path(__file__)]
    paths += sorted((DATA / 'attempts').glob('*.jsonl'))
    for name in ('voice-stages.jsonl', 'resources.jsonl', 'actual-provider-bindings.jsonl', 'requester-mesh-calls.jsonl', 'mesh-route-observations.jsonl'):
        paths += [ROOT / p for p in state['prefixes'][name]['chunks']]
    for path in paths:
        inputs.append({'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size, 'sha256': sha(path)})
    args.out.mkdir(parents=True)
    def write(name, data):
        (args.out / name).write_text(data)
    write('INPUTS.json', json.dumps(inputs, indent=2) + '\n')
    write('SUMMARY.json', json.dumps(summary, indent=2) + '\n')
    write('cases.jsonl', ''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in case_rows))
    write('native-stages-and-resources.jsonl', ''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in native_rows))
    lines = ['# K2 worker to Personal desktop: completed 900-attempt condition', '', '**Status: Current bounded check.**', '',
             'All 900 declared measured attempts completed naturally: 774 correct full-audio results, 115 strict city-only reply-format failures and 11 preaccept rejections. Zero timeouts or unattempted cases. Fifteen additional correct warmups are excluded.', '',
             'The unchanged pipeline was actual fixed WAV → worker CPU faster-whisper base → Personal Vulkan Qwen3.5-0.8B Q4_0 → Personal CPU Piper → valid WAV. Requester/receiver correlated native records and before/after ICE snapshots establish the production PeerBridge route. The readiness GPU record confirms configured100 and actual25/25 layers on RX7600; CPU/GPU cohorts are separate.', '',
             '| Measured boundary | n | p50 ms | p90 ms | p95 ms |', '| --- | ---: | ---: | ---: | ---: |']
    for name, m in [('Correct full-audio end to end', metrics['successfulCorrectE2E']), ('All observed attempts, including failures/skipped TTS', metrics['allMeasuredObservedAttempts'])] + [(f'Native {s}: all measured invocations', m) for s, m in metrics['nativeAllInvokedMeasured'].items()]:
        lines.append(f"| {name} | {m['n']} | {m['p50']:.3f} | {m['p90']:.3f} | {m['p95']:.3f} |")
    lines += ['', 'Percentiles are recomputed from retained rows with Hyndman–Fan type7 interpolation. The all-attempt distribution is not a 900-success full-pipeline distribution. Native STT/LLM include failed-output cases; native TTS has774 measured invocations. Correct-full-audio native subsets are separately available in SUMMARY.json.', '',
              f'All2619 current native stage pairs join uniquely: 45 excluded-warmup stages plus2574 measured stages. {excluded_remote} earlier provider correlation/stage pairs are excluded. All1715 requester remote calls, including warmups and rejections, join to route snapshots. Resource brackets attach within each host clock only; sampled process CPU/RSS and host/device GPU/network context are not exclusive per-request costs. See SUMMARY.json for missing-counter observations and bracket slack.', '',
              'The115 format failures retained a factually correct31-byte sentence instead of the required city-only response; no TTS call/audio is expected after that predicate fails. The cause of this output change and the11 receiver capability rejections remains UNKNOWN. Neither samples nor failure predicates were changed. Failed observations remain in cases.jsonl.', '',
              'Requester cases/audio and all raw stream EOFs are sealed under ../terminal-v1899/. Provider raw12 files (87266093 bytes) are retained physically in ../provider-transfer-terminal-v1902/provider-eof-v1901.tar.gz, with archive and every member checksummed. Original Desktop sources remain preserved. INPUTS.json pins every analysis input; no inference, builds, downloads or reruns are performed by this analysis.', '',
              'Reproduce into a fresh output directory:', '', '```sh', 'python3 thesis/harness/analyze_k2_mesh_saved_v1904.py --out /tmp/aurora-k2-v1904-reproduction', '```', '',
              'This condition covers fixed-file audio submission to returned valid audio. It does not prove physical microphone capture, playback/audibility, Android/iOS acceptance, all concurrency conditions or the full matrix. K1 remaining191 and subsequent matrix conditions remain open.', '']
    write('REPORT.md', '\n'.join(lines))
    outputs = [{'path': str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p), 'bytes': p.stat().st_size, 'sha256': sha(p)} for p in sorted(args.out.iterdir())]
    write('OUTPUTS.json', json.dumps(outputs, indent=2) + '\n')
    print(json.dumps({'status': 'saved_data_join_complete', 'out': str(args.out), 'measured': 900,
                      'nativeStageJoins': len(native_rows), 'routeCallJoins': len(calls),
                      'excludedEarlierProviderStagePairs': excluded_remote, 'metrics': metrics,
                      'maxResourceBracketSlackMs': summary['maxResourceBracketSlackMs']}))


if __name__ == '__main__':
    main()

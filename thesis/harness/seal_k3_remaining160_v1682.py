"""Seal and analyze the completed requester using saved files only."""
from collections import Counter
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'analysis'))
from k1_saved_case_history import distribution, phase_counts

ROOT = Path(__file__).resolve().parents[2]
IMPORT = ROOT / '.git/aurora-handoff-import-20261006'
DEST = ROOT / 'thesis/campaigns/worker-desktop-k3-orca-relayed-http-remaining-v1682'
CELL = IMPORT / 'distributed-k3-orca-relayed-http-cell-v1682'
OP = IMPORT / 'distributed-k3-orca-relayed-launch-v1682'
OUT = DEST / 'terminal-20261020T0213'
EXPECTED = '32c5ac87c8cd765f0117a0312b6941c8f69c7731dfe66987826311e74e34b506'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(data), 'sha256': sha(data)}

def json_write(path, value):
    return write(path, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())

def main():
    assert not OUT.exists(), 'Reconcile the existing seal; never overwrite evidence'
    for pid in [2202799, 2202983, 2202800, 2202801]:
        assert not Path('/proc', str(pid)).exists(), 'Original requester actor not retired'
    frozen = (DEST / 'condition-frozen.json').read_bytes()
    assert sha(frozen) == EXPECTED
    manifest = json.loads(frozen)
    original = (DEST / 'CURRENT.json').read_bytes()
    state = json.loads(original)
    terminal_bytes = (CELL / 'campaign/summary.json').read_bytes()
    terminal = json.loads(terminal_bytes)
    assert terminal['status'] == 'completed_all_correct' and terminal['shutdown_completed'] is True
    assert terminal['frozen_cohort_manifest_sha256'] == EXPECTED
    receipt = json.loads((ROOT / state['lastReceipt']).read_text())
    assert receipt['errors'] == []
    index = state['files']
    for record in index.values():
        path = ROOT / record['destination']
        assert path.is_relative_to(ROOT / 'thesis') and path.resolve(strict=True) == path
        data = path.read_bytes()
        assert len(data) == record['bytes'] and sha(data) == record['sha256']
    rows = []
    audio = {}
    for record in state['completedCases'].values():
        path = ROOT / record['case']
        raw = path.read_bytes()
        assert sha(raw) == record['caseSha256']
        row = json.loads(raw)
        assert row['status'] == record['status'] == 'completed_correct'
        assert row['frozen_cohort_manifest_sha256'] == EXPECTED
        output = row['output_audio']
        wav = DEST / output['file']
        data = wav.read_bytes()
        assert sha(data) == output['sha256'] and data[:4] == b'RIFF'
        audio[str(wav.relative_to(ROOT))] = {'bytes': len(data), 'sha256': sha(data)}
        rows.append(row)
    rows.sort(key=lambda row: row['ordinal'])
    measured = [row for row in rows if row['phase'] == 'measured']
    warmups = [row for row in rows if row['phase'] == 'warmup']
    assert len(rows) == 175 and len(measured) == 160 and len(warmups) == 15
    assert [row['condition_measured_index'] for row in measured] == list(range(741, 901))
    assert len({row['harness_case_id'] for row in rows}) == 175
    assert len({row['correlation']['correlation_id'] for row in rows}) == 175
    metrics = distribution([row['flow_duration_ms'] for row in measured])
    for name in ['p50', 'p90', 'p95']:
        assert abs(metrics[name + '_ms'] - terminal['successful_correct_latency_ms_r7'][name]) < 1e-7
    assert shutil.disk_usage(ROOT).free > 2 * 1024**3
    OUT.mkdir()
    original_receipt = write(OUT / 'ORIGINAL-CURRENT.snapshot.json', original)
    terminal_receipt = write(OUT / 'summary.json', terminal_bytes)
    private = runpy.run_path(str(ROOT / 'thesis/harness/custody_k3_requester_v1682.py'))['private_values']()
    prefixes = {}
    tails = []
    for name, prefix in state['prefixes'].items():
        source = (CELL if name in ['actual-provider-bindings.jsonl', 'backend.private.log', 'resources.jsonl', 'voice-stages.jsonl'] else OP) / name
        assert source.stat().st_ino == prefix['inode']
        end = 0
        by_path = {record['destination']: record for record in index.values()}
        for member in prefix['chunks']:
            item = by_path[member]
            assert item['startByte'] == end
            end = item['endByte']
        assert end == prefix['endByte']
        size = source.stat().st_size
        assert end <= size
        if size > end:
            assert size - end <= 1024**2, 'Retain a bounded final append, no bulk log copy'
            with source.open('rb') as stream:
                stream.seek(end)
                raw = stream.read()
            data = raw
            for value in private:
                data = data.replace(value, b'<REDACTED>')
            saved = write(OUT / 'final-prefix-tails' / (name + '.chunk'), data)
            tails.append({**saved, 'source': str(source), 'startByte': end, 'endByte': size,
                          'sourceRawSha256': sha(raw), 'redacted': data != raw})
        prefixes[name] = {'retainedPriorEndByte': end, 'finalSourceBytes': size,
                          'tailCopiedBytes': size - end, 'terminalEOF': True,
                          'originalLiveIncompleteFlagRetainedUnmodified': prefix['incomplete']}
    write(OUT / 'MEASURED-REQUESTS.jsonl', ''.join(json.dumps(row) + '\n' for row in measured).encode())
    json_write(OUT / 'CASE-HISTORY.json', rows)
    json_write(OUT / 'AUDIO-CUSTODY.json', audio)
    charge = sum(terminal[key] / 1000 for key in ['setup_duration_ms', 'condition_elapsed_ms_excluding_setup_and_shutdown', 'shutdown_duration_ms'])
    budget = manifest['cumulativeConditionBudget']
    lock = Path('/tmp/aurora-global-build.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
    result = {'at': datetime.now(timezone.utc).isoformat(),
              'status': 'REQUESTER_COMPLETED_AND_SEALED_PROVIDER_POSTRUN_VALIDATION_PENDING',
              'conditionManifestSha256': EXPECTED,
              'measured': phase_counts(measured), 'excludedWarmups': phase_counts(warmups),
              'flowMetricsMsCorrectOnly': metrics,
              'stageMetricsMs': {stage: distribution([row['stages'][stage]['duration_ms'] for row in measured]) for stage in ['stt', 'assistant', 'tts']},
              'conditionCountsOnly': {'attempted': 900, 'correct': 885, 'failed': 15, 'unattempted': 0, 'prior740Preserved': True},
              'originalCustodySnapshot': original_receipt, 'terminalSummary': terminal_receipt,
              'verifiedIndexedFiles': len(index), 'verifiedIndexedBytes': sum(record['bytes'] for record in index.values()),
              'verifiedCases': len(rows), 'physicalOutputWavs': len(audio), 'audioBytes': sum(value['bytes'] for value in audio.values()),
              'requesterPrefixes': prefixes, 'boundedFinalTailCopies': tails,
              'originalRequesterActorsAbsent': [2202799, 2202983, 2202800, 2202801], 'workerBuildLeaseFree': True,
              'budget': {'priorUsedSeconds': budget['priorUsedSeconds'], 'thisEpochChargeSeconds': charge,
                         'cumulativeUsedSeconds': budget['priorUsedSeconds'] + charge, 'capSeconds': budget['conditionCapSeconds']},
              'quantileMethod': 'Hyndman-Fan Type7 h=(n-1)*p, linear interpolation; milliseconds; warmups excluded',
              'percentilePooling': 'None; prior epochs retained, combined counts only until explicit comparability analysis',
              'providerNativeMeasuredStageCoverage': 'PENDING final provider custody and exact saved correlation join; warmup proof is admission only',
              'newInferenceOrTests': 0, 'originalLiveIndexModified': False, 'freeBytesAfter': shutil.disk_usage(ROOT).free}
    json_write(OUT / 'REQUESTER-SEAL-AND-RESULT.json', result)
    print(json.dumps({'receipt': str((OUT / 'REQUESTER-SEAL-AND-RESULT.json').relative_to(ROOT)),
                      'cases': len(rows), 'wavFiles': len(audio), 'indexedFiles': len(index),
                      'newTailBytes': sum(item['endByte'] - item['startByte'] for item in tails),
                      'metrics': metrics, 'budget': result['budget']}))

if __name__ == '__main__':
    main()

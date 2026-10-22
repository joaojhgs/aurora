"""Seal the completed V1826 requester from saved data, without SUT traffic."""
from pathlib import Path
from datetime import datetime, timezone
import collections
import hashlib
import json
import math
import os

ROOT = Path('/home/developer/projects/aurora')
HANDOFF = ROOT / '.git/aurora-handoff-import-20261006'
CELL = HANDOFF / 'distributed-k2-mesh-cell-v1826'
OP = HANDOFF / 'distributed-k2-mesh-launch-v1826'
DATA = ROOT / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1826'
DEST = DATA / 'terminal-v1899'
CONDITION = 'a653d60065616e34844d956d1ed47038aa94f3ff876c36bf3a98e904ca838641'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_once(path, value):
    raw = (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()
    temp = path.with_name(path.name + '.partial')
    assert not path.exists()
    with temp.open('xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)
    return {'path': str(path.relative_to(ROOT)), 'bytes': len(raw), 'sha256': digest(raw)}


def quantiles(values):
    values = sorted(values)
    result = {'n': len(values), 'units': 'ms', 'estimator': 'Hyndman-Fan type 7'}
    if not values:
        return result
    for label, p in [('p50', .5), ('p90', .9), ('p95', .95), ('p99', .99)]:
        h = (len(values) - 1) * p
        low, high = math.floor(h), math.ceil(h)
        result[label] = values[low] + (values[high] - values[low]) * (h - low)
    return result


def main():
    os.umask(0o077)
    assert not DEST.exists(), 'Reconcile an existing seal; never overwrite or rerun it blindly'
    actors = [2830732, 2830763, 2831081, 2831977]
    assert all(not Path('/proc', str(pid)).exists() for pid in actors)
    assert file_digest(DATA / 'condition-frozen.json') == CONDITION
    state = json.loads((DATA / 'CURRENT.json').read_text())
    receipt = json.loads((ROOT / state['lastReceipt']).read_text())
    assert file_digest(ROOT / state['lastReceipt']) == state['lastReceiptSha256']
    assert not receipt['errors']
    control = json.loads((CELL / 'control-launch.json').read_text())
    summary = json.loads((CELL / 'campaign/summary.json').read_text())
    assert control['child_present_after_wait'] is False and control['finished_at']
    assert summary['shutdown_completed'] and summary['stop_reason'] is None
    assert summary['status'] == 'completed_with_failures_or_incorrect'
    assert summary['measured_requests'] == 900 and summary['unattempted_measured'] == 0
    assert control['exit_code'] == 1  # Completed collection reports its retained failed attempts.

    verified = []
    for item in state['files'].values():
        path = ROOT / item['destination']
        assert path.is_file() and not path.is_symlink()
        assert path.stat().st_size == item['bytes'] and file_digest(path) == item['sha256']
        verified.append({k: item[k] for k in ('destination', 'bytes', 'sha256')})

    rows = []
    audio_references = 0
    for path in sorted((DATA / 'attempts').glob('*.jsonl')):
        raw = path.read_bytes()
        assert raw == (CELL / 'campaign/attempts' / path.name).read_bytes()
        row = json.loads(raw)
        assert row['input_wav_sha256'] == summary['input']['sha256']
        if row['output_audio']:
            audio = DATA / row['output_audio']['file']
            assert file_digest(audio) == row['output_audio']['sha256']
            audio_references += 1
        rows.append(row)
    warmups = [r for r in rows if r['phase'] == 'warmup']
    measured = [r for r in rows if r['phase'] == 'measured']
    assert len(rows) == 915 and len(warmups) == 15 and len(measured) == 900
    assert {r['phase_index'] for r in measured} == set(range(1, 901))
    assert {r['phase_index'] for r in warmups} == set(range(1, 16))
    assert all(r['status'] == 'completed_correct' for r in warmups)
    successful = [r['flow_duration_ms'] for r in measured if r['status'] == 'completed_correct']
    all_attempts = [r['flow_duration_ms'] for r in measured]
    metrics = {'successful_correct_e2e': quantiles(successful), 'all_measured_attempts': quantiles(all_attempts)}
    for key, reported in [('successful_correct_e2e', 'successful_correct_latency_ms_r7'),
                          ('all_measured_attempts', 'observed_measured_attempt_latency_ms_r7_including_failures')]:
        for q, value in summary[reported].items():
            assert abs(metrics[key][q] - value) <= 1e-6, 'Saved raw and producer quantile mismatch'

    prefix_records = []
    for name, prefix in state['prefixes'].items():
        source = (OP / 'requester-controller.private.log' if name == 'controller.private.log'
                  else OP / name if name == 'proof-collection.private.log' else CELL / name)
        before = source.stat()
        assert before.st_ino == prefix['inode'] and before.st_size == prefix['endByte']
        offset = 0
        redactions = 0
        stored_hash = hashlib.sha256()
        with source.open('rb') as stream:
            for relative in prefix['chunks']:
                item = state['files'][str(Path(relative).relative_to(DATA.relative_to(ROOT)))]
                assert item['startByte'] == offset and item['endByte'] >= offset
                raw = stream.read(item['endByte'] - offset)
                assert digest(raw) == item['sourceRawSha256']
                stored_hash.update((ROOT / relative).read_bytes())
                redactions += item.get('credentialsRedacted', 0)
                offset = item['endByte']
            assert stream.read(1) == b''
        after = source.stat()
        assert (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns)
        assert offset == before.st_size
        prefix_records.append({'name': name, 'source': str(source), 'sourceBytes': before.st_size,
                               'sourceSha256': file_digest(source), 'storedConcatenationSha256': stored_hash.hexdigest(),
                               'credentialsRedacted': redactions, 'chunks': prefix['chunks'], 'terminalEOFVerified': True})
    for name, item in state['snapshots'].items():
        source = CELL / 'campaign' / name if name in ('summary.json', 'progress.json', 'mesh-route-admission.json', 'mesh-route-admission-timing.json') else CELL / name
        assert file_digest(source) == item['sha256'] == file_digest(ROOT / item['destination'])

    DEST.mkdir()
    files_receipt = write_once(DEST / 'FILES.json', verified)
    prefix_receipt = write_once(DEST / 'PREFIX-EOF.json', prefix_records)
    stage_metrics = {}
    for stage in ('stt', 'assistant', 'tts'):
        durations = [r['stages'][stage]['duration_ms'] for r in measured
                     if r.get('stages', {}).get(stage, {}).get('status') == 'completed']
        stage_metrics[stage] = quantiles(durations)
    seal = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'requester_terminal_raw_eof_sealed',
            'conditionManifestSha256': CONDITION, 'controllerExitCode': control['exit_code'],
            'shutdownCompleted': True, 'requesterActorsAbsent': actors, 'plannedMeasured': 900,
            'measured': len(measured), 'excludedWarmups': len(warmups),
            'outcomes': dict(collections.Counter(r['status'] for r in measured)),
            'failureKinds': dict(collections.Counter((r.get('failure') or {}).get('code', 'unclassified')
                                                   for r in measured if r['status'] != 'completed_correct')),
            'timeouts': sum(bool(r.get('timeout')) for r in measured), 'unattempted': 0,
            'retainedCases': len(rows), 'retainedAudioBlobs': len(list((DATA / 'audio').glob('*.wav'))),
            'caseAudioReferencesVerified': audio_references, 'files': files_receipt, 'prefixes': prefix_receipt,
            'verifiedPayloadBytes': sum(r['bytes'] for r in verified), 'metrics': metrics,
            'requesterObservedStageDurationMs': stage_metrics,
            'stageDurationScope': 'Requester-observed stage durations; native model spans/resources require the separate provider join.',
            'latencyBoundary': summary['flow_end_point'], 'physicalMicrophone': False,
            'physicalPlaybackOrAudibility': False, 'producerSummarySha256': file_digest(CELL / 'campaign/summary.json'),
            'priorCopierReceipt': state['lastReceipt'], 'priorCopierReceiptSha256': state['lastReceiptSha256'],
            'originalFilesPreserved': True, 'newInferenceOrTestTraffic': False,
            'pendingProviderGate': 'Preserve same provider reservation until its exact process/EOF custody is reconciled.'}
    seal_receipt = write_once(DEST / 'REQUESTER-SEAL.json', seal)
    print(json.dumps({'seal': seal_receipt, 'outcomes': seal['outcomes'], 'failureKinds': seal['failureKinds'],
                      'retainedCases': len(rows), 'audioReferences': audio_references, 'metrics': metrics,
                      'providerGate': seal['pendingProviderGate']}))


if __name__ == '__main__':
    main()

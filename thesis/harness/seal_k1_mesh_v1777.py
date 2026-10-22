"""Seal the stopped K1 continuation epoch from saved data, without touching its index."""
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil

ROOT = Path(__file__).resolve().parents[2]
H = ROOT / '.git/aurora-handoff-import-20261006'
D = ROOT / 'thesis/campaigns/worker-desktop-k1-p2p-tts-remaining880-v1719'
CELL = H / 'distributed-k1-mesh-cell-v1719'
OUT = D / 'terminal-v1777/seal'
EXPECTED = '120dd99a4de0a242c30ebe4bb46d854ca77313c482a0c74f024edb624829a6e8'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(name, raw):
    q = OUT / name
    q.parent.mkdir(parents=True, exist_ok=True)
    assert shutil.disk_usage(ROOT).free - len(raw) > 2 * 1024**3
    if q.exists():
        assert q.read_bytes() == raw, 'Existing partial seal differs; preserve it'
        return {'path': str(q.relative_to(ROOT)), 'bytes': len(raw), 'sha256': sha(raw)}
    tmp = q.with_name(q.name + '.partial')
    with tmp.open('xb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())
    assert sha(tmp.read_bytes()) == sha(raw)
    assert not q.exists()
    os.replace(tmp, q)
    return {'path': str(q.relative_to(ROOT)), 'bytes': len(raw), 'sha256': sha(raw)}


def quantiles(values):
    values = sorted(values)
    result = {'n': len(values), 'unit': 'ms', 'estimator': 'Hyndman-Fan Type7'}
    for label, p in [('p50', .5), ('p90', .9), ('p95', .95)]:
        h = (len(values) - 1) * p
        lo = int(h)
        result[label] = (values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (h - lo)) if values else None
    return result


def main():
    assert not (OUT / 'REQUESTER-SEAL.json').exists(), 'Completed seal must not be rerun'
    for pid in [2360747, 2360768, 2361201, 2361202]:
        assert not Path('/proc', str(pid)).exists(), 'Original actor not retired'
    condition = (D / 'condition-frozen.json').read_bytes()
    assert sha(condition) == EXPECTED
    original = (D / 'CURRENT.json').read_bytes()
    state = json.loads(original)
    control_raw = (CELL / 'control-launch.json').read_bytes()
    control = json.loads(control_raw)
    summary_raw = (CELL / 'campaign/summary.json').read_bytes()
    summary = json.loads(summary_raw)
    assert control['child_present_after_wait'] is False and control['exit_code'] == 1
    assert summary['shutdown_completed'] is True and summary['status'] == 'stopped_system_failure'
    assert json.loads((ROOT / state['lastReceipt']).read_bytes())['errors'] == []
    private = runpy.run_path(str(ROOT / 'thesis/harness/custody_k1_mesh_requester_v1719.py'))['private_values']()
    by_path = {v['destination']: v for v in state['files'].values()}
    for record in by_path.values():
        raw = (ROOT / record['destination']).read_bytes()
        assert len(raw) == record['bytes'] and sha(raw) == record['sha256']
    rows, audio = [], {}
    for record in state['completedCases'].values():
        raw = (ROOT / record['case']).read_bytes()
        assert sha(raw) == record['caseSha256']
        row = json.loads(raw)
        rows.append(row)
        if record['audio']:
            data = (ROOT / record['audio']).read_bytes()
            assert sha(data) == record['audioSha256'] and data[:4] == b'RIFF'
            audio[record['audio']] = {'bytes': len(data), 'sha256': sha(data)}
    rows.sort(key=lambda v: v['ordinal'])
    measured = [v for v in rows if v['phase'] == 'measured']
    warmups = [v for v in rows if v['phase'] == 'warmup']
    assert len(rows) == 704 and len(measured) == 689 and len(warmups) == 15
    assert sum(bool(record['audio']) for record in state['completedCases'].values()) == 693
    assert all(v['status'] == 'completed_correct' for v in warmups)
    assert [v['condition_measured_index'] for v in measured] == list(range(21, 710))
    assert sum(v.get('timeout') is True for v in measured) == 1
    assert Counter(v['status'] for v in measured) == {'completed_correct': 678, 'failed': 11}
    assert [v['phase_index'] for v in measured] == list(range(1, 690))
    assert len({v['correlation']['correlation_id'] for v in rows}) == len(rows)
    OUT.mkdir(parents=True, exist_ok=True)
    save('ORIGINAL-CURRENT.snapshot.json', original)
    save('summary.json', summary_raw)
    save('control-launch.json', control_raw)
    prefixes, tails = {}, []
    for name, prefix in state['prefixes'].items():
        records = [by_path[path] for path in prefix['chunks']]
        empty_sources = {'controller.private.log': H / 'distributed-k1-mesh-launch-v1719/requester-controller.private.log'}
        source = Path(records[0]['source']) if records else empty_sources[name]
        stat = source.stat()
        assert stat.st_ino == prefix['inode']
        end = 0
        for record in records:
            assert record['startByte'] == end
            end = record['endByte']
        assert end == prefix['endByte'] <= stat.st_size
        if stat.st_size > end:
            assert stat.st_size - end <= 1024**2
            with source.open('rb') as f:
                f.seek(end)
                raw = f.read()
            redacted = raw
            for value in private:
                redacted = redacted.replace(value, b'[REDACTED_CREDENTIAL]')
            tail = save('final-prefix-tails/' + name + '.chunk', redacted)
            tails.append({**tail, 'startByte': end, 'endByte': stat.st_size, 'sourceRawSha256': sha(raw), 'credentialsRedacted': redacted != raw})
        assert source.stat().st_size == stat.st_size
        prefixes[name] = {'source': str(source), 'retainedPriorEndByte': end, 'finalSourceBytes': stat.st_size, 'tailCopiedBytes': stat.st_size - end, 'terminalEOF': True, 'originalIncompleteFlagPreserved': prefix['incomplete']}
    save('CASE-HISTORY.jsonl', b''.join((json.dumps(v, sort_keys=True) + '\n').encode() for v in rows))
    save('AUDIO-CUSTODY.json', (json.dumps(audio, indent=2) + '\n').encode())
    successful = [v for v in measured if v['status'] == 'completed_correct']
    result = {'at': datetime.now(timezone.utc).isoformat(), 'status': 'REQUESTER_TERMINAL_EOF_SEALED', 'conditionManifestSha256': EXPECTED,
              'measurement': {'epochPlanned': 880, 'attempted': 689, 'correct': 678, 'failed': 11, 'timeoutFlagged': 1, 'unattempted': 191},
              'excludedWarmups': {'attempted': 15, 'correct': 15}, 'verifiedCases': len(rows), 'verifiedIndexedFiles': len(by_path),
              'verifiedIndexedBytes': sum(v['bytes'] for v in by_path.values()), 'physicalWavs': len(audio), 'audioBytes': sum(v['bytes'] for v in audio.values()),
              'correctFlowLatency': quantiles([v['flow_duration_ms'] for v in successful]), 'failureObservedFlowMs': measured[-1]['flow_duration_ms'],
              'stageCorrectOnlyMs': {s: quantiles([v['stages'][s]['duration_ms'] for v in successful]) for s in ('stt', 'assistant', 'tts')},
              'prefixes': prefixes, 'finalTailCopies': tails, 'sourceMutation': False, 'originalLiveIndexModified': False, 'sutCalls': 0,
              'providerCustody': 'Original Personal provider state pending reconciliation; no provider EOF claim',
              'scientificScope': 'Interrupted continuation689 of880; original20 retained separately. Whole condition709 of900,697correct12failed191unattempted. Preserve all failures and timeout; no whole-condition completion or pure-transport comparison claim.',
              'freeBytesAfter': shutil.disk_usage(ROOT).free}
    save('REQUESTER-SEAL.json', (json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps({k: result[k] for k in ('status', 'measurement', 'verifiedCases', 'physicalWavs', 'verifiedIndexedBytes', 'correctFlowLatency')}))


if __name__ == '__main__':
    main()

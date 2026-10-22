"""Collect actual K2 ordinary warmup proof on the existing Personal receiver.

Only saved data and existing files are read. Writes are confined to a new
private evidence directory; the live provider and its configuration stay intact.
"""
import base64
import datetime
import hashlib
import json
from pathlib import Path
import re
import sys
import zlib

ROOT = Path('/home/developer/projects/aurora')
HANDOFF = ROOT / '.git/aurora-handoff-import-20261006'
PROVIDER = HANDOFF / 'distributed-k1-http-provider-v1126'
OUT = HANDOFF / 'distributed-k2-ordinary-proof-v1384'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    payload = json.loads(zlib.decompress(base64.b64decode(sys.argv[1])))
    frozen = payload['manifest']
    assert digest((PROVIDER / 'input/provider-manifest.json').read_bytes()) == frozen['providerManifestSha256']
    stat = Path('/proc/261790/stat').read_text().rsplit(')', 1)[1].split()
    assert int(stat[19]) == 1519744
    config_path = PROVIDER / 'runtime/config.json'
    assert digest(config_path.read_bytes()) == frozen['remoteAssistantConfigBinding']['config_sha256']
    assert not OUT.exists(), 'Reconcile already accepted proof; do not rerun'
    OUT.mkdir(mode=0o700)
    attempts = OUT / 'attempts'
    attempts.mkdir(mode=0o700)
    correlations = set()
    for row in payload['attempts']:
        assert row['phase'] == 'warmup' and row['status'] == 'completed_correct'
        for stage in ['assistant', 'tts']:
            correlations.add(row['stages'][stage]['server_correlation_id'])
        (attempts / f"attempt-{row['ordinal']:04d}-warmup.jsonl").write_text(json.dumps(row) + '\n')
    assert len(correlations) == 30
    selected = []
    source_records = []
    for filename, cap in [('voice-stages.jsonl', 16 * 1024**2), ('actual-provider-bindings.jsonl', 4 * 1024**2)]:
        path = PROVIDER / 'runtime' / filename
        with path.open('rb') as stream:
            raw = stream.read(cap + 1)
        assert len(raw) <= cap
        raw = raw[:raw.rfind(b'\n') + 1]
        rows = [json.loads(line) for line in raw.splitlines() if line]
        source_records.append({'path': str(path), 'prefixBytes': len(raw), 'sha256': digest(raw)})
        if filename == 'voice-stages.jsonl':
            selected = [r for r in rows if r.get('correlation_id') in correlations]
            spans = [r for r in selected if r.get('stage') == 'tts' and r.get('handler') == 'tts.model_invoke']
            windows = {}
            for row in spans:
                windows.setdefault(row['span_id'], []).append(int(row['monotonic_ns']))
            assert len(windows) == 15 and all(len(v) == 2 for v in windows.values())
            ranges = [(min(v), max(v)) for v in windows.values()]
        else:
            selected = [r for r in rows if r.get('event') in ['llm_constructor_start', 'llm_constructor_return']
                        or r.get('event') in ['piper_cli_call_start', 'piper_cli_call_return']
                        and any(lo <= r.get('monotonicNs', 0) <= hi for lo, hi in ranges)]
            constructor = [r for r in selected if r.get('event') == 'llm_constructor_return' and r.get('pid') == 261790]
            assert constructor
            expected = frozen['remoteConfiguredLlm']
            for observed in constructor:
                for key in ['model_path', 'n_gpu_layers', 'n_ctx', 'n_batch', 'n_threads', 'temperature', 'max_tokens', 'seed', 'top_p', 'top_k']:
                    assert observed['actualArguments'][key] == expected[key], 'Effective remote constructor mismatch'
        (OUT / filename).write_text(''.join(json.dumps(r) + '\n' for r in selected))
    log = PROVIDER / 'runtime/backend.private.log'
    with log.open('rb') as stream:
        raw = stream.read(16 * 1024**2 + 1)
    assert len(raw) <= 16 * 1024**2
    lines = raw.decode(errors='replace').splitlines()
    offloads = [re.search(r'offloaded (\d+)/(\d+) layers to GPU', line) for line in lines]
    offloads = [m for m in offloads if m]
    assert offloads and all(tuple(map(int, item.groups())) == (25, 25) for item in offloads)
    gpu_lines = [line for line in lines if 'Vulkan' in line and any(x in line for x in ['RX 7600', 'model buffer', 'device'])]
    assert gpu_lines, 'Actual loaded Vulkan backend evidence missing'
    tts_original = json.loads((PROVIDER / 'runtime/receiver-identity.json').read_text())
    for stage in ['assistant', 'tts']:
        expected = payload['receivers'][stage]
        paths = {'model': frozen['remoteConfiguredLlm']['model_path'], 'config': str(config_path)} if stage == 'assistant' else {
            k: tts_original['actual_provider_files'][k]['canonical_path'] for k in ['model', 'config']}
        files = {k: {'canonical_path': v, 'sha256': expected['model_sha256' if k == 'model' else 'config_sha256']} for k, v in paths.items()}
        files['source_receipt_sha256'] = tts_original['actual_provider_files']['source_receipt_sha256']
        (OUT / (stage + '-identity.json')).write_text(json.dumps({'receiver_pid': 261790, 'provider': expected, 'actual_provider_files': files}))
    namespace = {'__name__': 'saved_receiver_proof'}
    source = payload['proofSource']
    assert digest(source.encode()) == '06c1bb4aeae3ba8f2de7441bd09ccfc39d426615defd5b8a38b807117df4d791'
    (OUT / 'receiver_proof.py').write_text(source)
    exec(compile(source, str(OUT / 'receiver_proof.py'), 'exec'), namespace)
    proof = namespace['build_proof'](attempts_dir=attempts, stage_path=OUT / 'voice-stages.jsonl',
        bindings_path=OUT / 'actual-provider-bindings.jsonl', assistant_identity_path=OUT / 'assistant-identity.json',
        tts_identity_path=OUT / 'tts-identity.json', candidate_sha=frozen['candidateManifestSha256'],
        cohort_sha=payload['cohortSha256'], expected_receivers=payload['receivers'])
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'status': 'proof_ready',
              'actualOffloadedLayers': 25, 'actualTotalLayers': 25, 'gpuEvidenceLines': gpu_lines,
              'offloadEvidenceLine': offloads[0].group(), 'sources': source_records, 'proof': proof,
              'modelCallsByCollector': 0, 'existingProviderUnchanged': True,
              'sourceScope': 'Only these30correlations and15Piper invocation windows; historical K1 rows excluded'}
    (OUT / 'RESULT.json').write_text(json.dumps(result, indent=2) + '\n')
    encoded = base64.b64encode(json.dumps(result).encode()).decode()
    parts = [encoded[i:i + 1800] for i in range(0, len(encoded), 1800)]
    for index, part in enumerate(parts):
        print('AURORA_K2_PROOF_V1384 ' + json.dumps({'seq': index, 'total': len(parts), 'data': part}), flush=True)


main()

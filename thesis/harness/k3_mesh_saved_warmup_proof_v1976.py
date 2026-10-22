"""Future K3 ordinary-warmup collector; saved data only, no model requests.

Root stages the exact requester warmup files on the existing Personal host.
The new provider remains paused for admission. This collector preserves raw
prefixes, derives their case-scoped views and runs the unchanged strict proof.
It does not publish a requester gate or decide resource/time admission.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import socket


REPO = Path('/home/developer/projects/aurora')
HANDOFF = REPO / '.git/aurora-handoff-import-20261006'
PROOF_SHA = 'e79c973003ac9be1e8579e0ebf3316c2c7a58a646f18fc98e01155807c3963a8'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read(path, limit):
    assert not path.is_symlink() and path.is_file()
    with path.open('rb') as stream:
        raw = stream.read(limit + 1)
    assert len(raw) <= limit, 'saved_input_size_cap'
    return raw


def save(path, data):
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def collect(admission_path):
    assert socket.gethostname() == 'personal.skyron-server'
    admission = json.loads(read(admission_path, 64 * 1024))
    provider_path = Path(admission['providerManifest'])
    provider_bytes = read(provider_path, 128 * 1024)
    assert sha(provider_bytes) == admission['providerManifestSha256']
    provider = json.loads(provider_bytes)
    input_dir = Path(admission['requesterInputs'])
    assert input_dir.is_dir() and not input_dir.is_symlink()
    frozen_bytes = read(input_dir / 'frozen-manifest.json', 256 * 1024)
    assert sha(frozen_bytes) == admission['cohortManifestSha256']
    frozen = json.loads(frozen_bytes)
    assert frozen['providerManifestSha256'] == sha(provider_bytes)
    assert frozen['remoteAssistantConfigBinding']['effective_llm_settings']['n_gpu_layers'] == 100
    output = Path(admission['output'])
    assert output.is_absolute() and not output.exists() and not output.is_symlink()
    assert output.parent.resolve(strict=True).is_relative_to((REPO / 'thesis').resolve(strict=True))
    output.mkdir(mode=0o700)
    raw_dir = output / 'raw-prefixes'
    raw_dir.mkdir(mode=0o700)
    receiver_output = Path(provider['output'])
    launch = json.loads(read(receiver_output / 'controller-launch.json', 64 * 1024))
    pid = launch['receiverPid']
    assert pid == admission['expectedReceiverPid']
    stat = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
    assert int(stat[19]) == launch['receiverStartTicks'] == admission['expectedReceiverStartTicks']
    assert stat[0] != 'Z'
    assert sha(read(Path(provider['config']), 256 * 1024)) == frozen['remoteAssistantConfigBinding']['config_sha256']
    expected = frozen['remoteReceivers']
    for stage, name in [('stt', 'stt-identity.json'), ('assistant', 'assistant-identity.json'), ('tts', 'receiver-identity.json')]:
        data = read(receiver_output / name, 64 * 1024)
        identity = json.loads(data)
        assert identity['receiver_pid'] == pid and identity['provider'] == expected[stage]
        save(output / (stage + '-identity.json'), data)

    proof_source = read(input_dir / 'receiver_proof.py', 128 * 1024)
    assert sha(proof_source) == PROOF_SHA == frozen['implementation']['receiverProofSha256']
    save(output / 'receiver_proof.py', proof_source)
    proof_ns = runpy.run_path(str(output / 'receiver_proof.py'))
    assert frozen['warmupReadinessPolicy'] == proof_ns['WARMUP_POLICY']
    qualification = proof_ns['qualified_warmup_records'](input_dir / 'attempts')
    correlations = set()
    durations = []
    attempts = output / 'attempts'
    attempts.mkdir(mode=0o700)
    for item in qualification['all']:
        save(attempts / item['path'].name, read(item['path'], 2 * 1024 * 1024))
    for item in qualification['selected']:
        row = item['row']
        correlation = row['correlation']['correlation_id']
        assert all(row['stages'][s]['mesh_correlation_id'] == correlation for s in ['stt', 'assistant', 'tts'])
        correlations.add(correlation)
        durations.append(row['flow_duration_ms'])
    assert len(correlations) == 15

    prefixes = []
    for filename, cap in [('voice-stages.jsonl', 16 * 1024**2), ('actual-provider-bindings.jsonl', 4 * 1024**2)]:
        raw = read(receiver_output / filename, cap)
        raw = raw[:raw.rfind(b'\n') + 1]
        save(raw_dir / filename, raw)
        prefixes.append({'source': str(receiver_output / filename), 'bytes': len(raw), 'sha256': sha(raw), 'appendPrefixNotEof': True})
        rows = [json.loads(line) for line in raw.splitlines() if line]
        if filename == 'voice-stages.jsonl':
            selected = [r for r in rows if r.get('correlation_id') in correlations]
            spans = {}
            for r in selected:
                if r.get('stage') == 'tts' and r.get('handler') == 'tts.model_invoke':
                    spans.setdefault(r['span_id'], []).append(int(r['monotonic_ns']))
            assert len(spans) == 15 and all(len(v) == 2 for v in spans.values())
            piper_windows = [(min(v), max(v)) for v in spans.values()]
        else:
            selected = [r for r in rows if r.get('pid') == pid and (
                r.get('event') in ['stt_constructor_start', 'stt_constructor_return', 'llm_constructor_start', 'llm_constructor_return'] or
                r.get('event') in ['piper_cli_call_start', 'piper_cli_call_return'] and
                any(lo <= r.get('monotonicNs', 0) <= hi for lo, hi in piper_windows))]
        save(output / filename, b''.join((json.dumps(r, sort_keys=True) + '\n').encode() for r in selected))

    backend = Path(provider['privateRoot']) / 'backend.private.log'
    raw = read(backend, 16 * 1024**2)
    log_lines = raw.decode(errors='replace').splitlines()
    offloads = [re.search(r'offloaded (\d+)/(\d+) layers to GPU', line) for line in log_lines]
    offloads = [m for m in offloads if m]
    assert offloads and all(tuple(map(int, m.groups())) == (25, 25) for m in offloads)
    gpu = [{'lineNumber': i, 'text': line} for i, line in enumerate(log_lines, 1)
           if 'Vulkan' in line and any(s in line for s in ['RX 7600', 'model buffer', 'device'])
           or 'offloaded 25/25 layers to GPU' in line]
    assert any('RX 7600' in r['text'] and 'Vulkan' in r['text'] for r in gpu)
    gpu_receipt = {'receiverPid': pid, 'receiverStartTicks': int(stat[19]), 'configuredLayers': 100,
        'actualOffloadedLayers': 25, 'actualTotalLayers': 25, 'backend': 'Vulkan',
        'nativeLogPrefix': {'source': str(backend), 'bytes': len(raw), 'sha256': sha(raw)},
        'selectedNativeLines': gpu, 'notCrossHostClockSubtraction': True}
    save(output / 'actual-new-process-gpu.json', (json.dumps(gpu_receipt, indent=2) + '\n').encode())

    for filename in ['requester-mesh-calls.jsonl', 'mesh-route-observations.jsonl', 'mesh-route-sink-status.json', 'mesh-route-runtime-pins.json']:
        save(output / filename, read(input_dir / filename, 4 * 1024**2))
    save(output / 'frozen-manifest.json', frozen_bytes)
    proof = proof_ns['build_proof'](
        attempts_dir=attempts, stage_path=output / 'voice-stages.jsonl',
        bindings_path=output / 'actual-provider-bindings.jsonl',
        assistant_identity_path=output / 'assistant-identity.json', tts_identity_path=output / 'tts-identity.json',
        stt_identity_path=output / 'stt-identity.json',
        mesh_calls_path=output / 'requester-mesh-calls.jsonl', route_observations_path=output / 'mesh-route-observations.jsonl',
        route_sink_status_path=output / 'mesh-route-sink-status.json', route_runtime_pins_path=output / 'mesh-route-runtime-pins.json',
        frozen_manifest_path=output / 'frozen-manifest.json', candidate_sha=frozen['candidateManifestSha256'],
        cohort_sha=sha(frozen_bytes), expected_receivers=expected)
    save(output / 'remote-warmup-proof.json', (json.dumps(proof, indent=2) + '\n').encode())
    result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(),
        'status': 'SAVED_DATA_PROOF_READY_NOT_REQUESTER_GATE_PUBLISHED', 'output': str(output),
        'cohortManifestSha256': sha(frozen_bytes), 'proofSha256': sha((output / 'remote-warmup-proof.json').read_bytes()),
        'proof': proof, 'nativeGpu': gpu_receipt, 'rawPrefixes': prefixes,
        'warmupDurationsMs': durations, 'excludedWarmups': qualification['attempted'],
        'warmupQualification': proof_ns['warmup_qualification_receipt'](qualification), 'remoteModelJoins': 45,
        'modelCallsByCollector': 0, 'runtimeServiceImports': 0, 'providerUnchanged': True,
        'resourceAndTimeAdmission': 'Root must check remaining provider/requester windows and forecast before publishing the original gate'}
    save(output / 'RESULT.json', (json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps({'output': str(output), 'resultSha256': sha((output / 'RESULT.json').read_bytes()), 'modelCalls': 0}))


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('admission', type=Path)
    collect(parser.parse_args().admission)

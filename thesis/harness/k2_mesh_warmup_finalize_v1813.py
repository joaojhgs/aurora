"""Collect the reviewed K2 proof from fifteen ordinary warmups, once."""
from pathlib import Path
from datetime import datetime, timezone
import base64
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
import zlib

R = Path(__file__).resolve().parents[2]
H = R / '.git/aurora-handoff-import-20261006'
OP = H / 'distributed-k2-mesh-launch-v1813'
CELL = H / 'distributed-k2-mesh-cell-v1813'
STAGE = H / 'distributed-k2-mesh-requester-v1813'
D = R / 'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1813'


def now():
    return datetime.now(timezone.utc)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def write(path, raw):
    with path.open('xb') as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())


def save(path, value):
    write(path, (json.dumps(value, indent=2, sort_keys=True) + '\n').encode())


def main():
    os.umask(0o077)
    launch = json.loads((OP / 'requester-launch.json').read_bytes())
    mpath = OP / 'condition-frozen-v1813.json'
    mraw = mpath.read_bytes(); m = json.loads(mraw)
    deadline = time.monotonic() + 5400
    while True:
        assert time.monotonic() < deadline, 'finite_ordinary_warmup_observation_deadline'
        rows = []
        for n in range(1, 16):
            p = CELL / f'campaign/attempts/attempt-{n:04d}-warmup.jsonl'
            if not p.exists():
                break
            row = json.loads(p.read_bytes())
            assert row['status'] == 'completed_correct', 'failed_ordinary_warmup_preserved_no_automatic_retry'
            rows.append(row)
        if len(rows) == 15:
            break
        f = Path('/proc', str(launch['controllerPid']), 'stat').read_text().rsplit(')', 1)[1].split()
        assert int(f[19]) == launch['controllerStartTicks'] and f[0] not in ['Z', 'X', 'x']
        time.sleep(2)
    files = {'frozen-manifest.json': mraw, 'receiver_proof.py': (STAGE / 'receiver_proof.py').read_bytes()}
    for n in range(1, 16):
        name = f'attempt-{n:04d}-warmup.jsonl'
        files['attempts/' + name] = (CELL / 'campaign/attempts' / name).read_bytes()
    for n in ['requester-mesh-calls.jsonl', 'mesh-route-observations.jsonl',
              'mesh-route-sink-status.json', 'mesh-route-runtime-pins.json']:
        files[n] = (CELL / n).read_bytes()
    packet = {n: base64.b64encode(b).decode() for n, b in files.items()}
    packed = base64.b64encode(zlib.compress(json.dumps(packet).encode())).decode()
    collector = (R / 'thesis/harness/k2_mesh_saved_warmup_proof_v1735.py').read_bytes()
    assert sha(collector) == '5a8c4fdd50edc4c66c2f0e56ef552409b1132b1147c0e3e73075d75e5d2c27dd'
    remote = '''from pathlib import Path
import base64,hashlib,json,os,runpy,socket,time,zlib
r=Path('/home/developer/projects/aurora');b=r/'thesis/campaigns/worker-desktop-k2-p2p-assistant-tts-v1813'
inp=b/'ordinary-warmup-inputs-v1787';out=b/'ordinary-warmup-proof-v1787'
assert socket.gethostname()=='personal.skyron-server' and not inp.exists() and not out.exists()
b.mkdir(parents=True,exist_ok=True);inp.mkdir();(inp/'attempts').mkdir()
for n,s in json.loads(zlib.decompress(base64.b64decode(PACKED_INPUTS))).items():
 p=Path(n);assert not p.is_absolute()and '..'not in p.parts
 with (inp/p).open('xb')as f:f.write(base64.b64decode(s));f.flush();os.fsync(f.fileno())
c=inp/'collector.py';c.write_bytes(base64.b64decode(COLLECTOR_CODE))
assert hashlib.sha256(c.read_bytes()).hexdigest()==COLLECTOR_SHA
a=ADMISSION;a['requesterInputs']=str(inp);a['output']=str(out)
ap=inp/'admission.json';ap.write_text(json.dumps(a))
runpy.run_path(str(c))['collect'](ap)
files={}
for p in out.rglob('*'):
 if p.is_file():
  raw=p.read_bytes();files[str(p.relative_to(out))]={'data':base64.b64encode(raw).decode(),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()}
v={'files':files,'memAvailableBytes':next(int(x.split()[1])*1024 for x in Path('/proc/meminfo').read_text().splitlines()if x.startswith('MemAvailable:'))}
compressed=base64.b64encode(zlib.compress(json.dumps(v).encode())).decode()
assert len(compressed)<96*1024,'bounded_return_packet_cap'
v={'host':socket.gethostname(),'status':'K2_SAVED_WARMUP_PROOF_COLLECTED','bundleZlibBase64':compressed,'sutCalls':0}
raw=base64.b64encode(json.dumps(v).encode()).decode();parts=[raw[i:i+800]for i in range(0,len(raw),800)]
for i,s in enumerate(parts):print('AURORA_K2_WARMUPS_V1787 '+json.dumps({'seq':i,'total':len(parts),'data':s}),flush=True);time.sleep(.005)
'''
    prep = json.loads((OP / 'provider-admission.json').read_bytes())
    admission = {'providerManifest': prep['manifestPath'], 'providerManifestSha256': prep['manifestSha256'],
                 'cohortManifestSha256': sha(mraw), 'expectedReceiverPid': prep['receiver']['pid'],
                 'expectedReceiverStartTicks': prep['receiver']['startTicks']}
    remote = remote.replace('PACKED_INPUTS', repr(packed)).replace('COLLECTOR_CODE', repr(base64.b64encode(collector).decode()))
    remote = remote.replace('COLLECTOR_SHA', repr(sha(collector))).replace('ADMISSION', repr(admission))
    command = OP / 'collect-provider-warmups.command.txt'
    write(command, ('python3 -c ' + shlex.quote(remote) + '\n').encode())
    save(OP / 'proof-collection-request.json', {'at': now().isoformat(), 'maximumSends': 1,
        'sutCalls': 0, 'inputs': {n: {'bytes': len(b), 'sha256': sha(b)} for n, b in files.items()}})
    cp = subprocess.run([sys.executable, str(R / 'thesis/harness/orca_copy_control_raw_read_v1652.py'),
        'k2-ordinary-warmup-proof-v1787', str(command), 'AURORA_K2_WARMUPS_V1787'],
        capture_output=True, text=True, timeout=190)
    write(OP / 'proof-collection.private.log', (cp.stdout + '\nSTDERR\n' + cp.stderr).encode())
    resultpath = H / 'k2-ordinary-warmup-proof-v1787-RESULT.json'
    assert cp.returncode == 0 and resultpath.exists(), 'reconcile_same_accepted_collection_never_resend'
    result = json.loads(resultpath.read_bytes())
    assert result['status'] == 'K2_SAVED_WARMUP_PROOF_COLLECTED' and result['sutCalls'] == 0
    result = json.loads(zlib.decompress(base64.b64decode(result['bundleZlibBase64'])))
    custody = D / 'ordinary-warmup-proof-v1787'; custody.mkdir()
    copied = {}
    for n, item in result['files'].items():
        p = Path(n); assert not p.is_absolute() and '..' not in p.parts
        raw = base64.b64decode(item['data']); assert len(raw) == item['bytes'] and sha(raw) == item['sha256']
        target = custody / p; target.parent.mkdir(exist_ok=True, parents=True); write(target, raw)
        copied[n] = {'bytes': len(raw), 'sha256': sha(raw)}
    save(custody / 'CUSTODY.json', {'at': now().isoformat(), 'files': copied, 'sutCalls': 0})
    proofraw = (custody / 'remote-warmup-proof.json').read_bytes(); proof = json.loads(proofraw)
    assert proof['cohort_manifest_sha256'] == sha(mraw) and proof['receivers'] == m['remoteReceivers']
    gpu = json.loads((custody / 'actual-new-process-gpu.json').read_bytes())
    assert gpu['actualOffloadedLayers'] == gpu['actualTotalLayers'] == 25 and gpu['configuredLayers'] == 100
    assert result['memAvailableBytes'] > 2_500_000_000
    assert shutil.disk_usage(R).free > 2 * 1024**3
    durations = sorted(float(row['flow_duration_ms']) for row in rows)
    h = 14 * .95; p95 = durations[int(h)] + (durations[int(h) + 1] - durations[int(h)]) * (h - int(h))
    forecast = 900 * p95 / 1000 * 1.2 + 300
    provider_remaining = (datetime.fromisoformat(m['providerDeadlineUtc']) - now()).total_seconds()
    requester_remaining = min(54000 - (now() - datetime.fromisoformat(launch['at'])).total_seconds(), 57600 - (now() - datetime.fromisoformat('2026-10-20T14:46:52.056334+00:00')).total_seconds())
    assert forecast < min(provider_remaining, requester_remaining), 'fixed_frozen_budget_insufficient_no_measurement'
    target = OP / 'completed-remote-warmup-proof.json'; write(target, proofraw)
    os.link(target, CELL / 'campaign/remote-warmup-proof.json')
    receipt = {'at': now().isoformat(), 'status': 'K2_15_ORDINARY_WARMUPS_REMOTE_NATIVE_GPU_ROUTE_PROOF_PUBLISHED',
        'proofSha256': sha(proofraw), 'excludedWarmups': 15, 'remoteModelJoins': 30,
        'warmupP95MsType7': p95, 'measured900ForecastSecondsWith20PercentPlus300': forecast,
        'providerRemainingSeconds': provider_remaining, 'requesterRemainingSeconds': requester_remaining,
        'actualGpu': gpu, 'sutCallsByFinalizer': 0, 'measuredAdmission': 'unchanged runner independently validates local STT and remote proof'}
    save(OP / 'warmup-finalizer-result.json', receipt); save(D / 'ORDINARY-WARMUP-ADMISSION.json', receipt)
    print(json.dumps({k: v for k, v in receipt.items() if k != 'actualGpu'}), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        receipt = {'at': now().isoformat(), 'errorCategory': type(exc).__name__, 'error': str(exc),
                   'automaticRetry': False, 'sameAcceptedCommandMustBeReconciled': True}
        save(OP / 'warmup-finalizer-failure.json', receipt)
        print(json.dumps(receipt), flush=True)
        raise SystemExit(1) from None

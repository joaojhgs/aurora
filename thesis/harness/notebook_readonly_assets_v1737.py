"""Bounded Personal-notebook asset metadata; no application/model execution."""
import base64
import datetime
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess


assert socket.gethostname() == 'skyron-notebook'
repo = Path('/home/developer/projects/aurora')
assert Path.cwd() == repo
models = [
    repo / '.artifacts/local-inference/models/Qwen3.5-0.8B-Q4_0.gguf',
    Path('/home/developer/.cache/huggingface/hub/models--Systran--faster-whisper-base/snapshots/ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66/model.bin'),
    repo / 'voice_models/en_US-ljspeech-medium.onnx',
    repo / 'voice_models/en_US-ljspeech-medium.onnx.json',
    repo / '.git/aurora-handoff-import-20261006/cpu-full-audio-v483/models/en_US-ljspeech-medium.onnx',
    repo / '.git/aurora-handoff-import-20261006/cpu-full-audio-v483/models/en_US-ljspeech-medium.onnx.json',
]
model_metadata = []
for path in models:
    try:
        stat = path.stat()
        model_metadata.append({'path': str(path), 'exists': True, 'bytes': stat.st_size,
                               'isSymlink': path.is_symlink(), 'weightsRead': False})
    except FileNotFoundError:
        model_metadata.append({'path': str(path), 'exists': False, 'weightsRead': False})

cache_roots = []
cache_rows = []
visited = 0
limit = 512
for kind in ['sdists-v9', 'sdists-v8', 'wheels-v5', 'wheels-v4']:
    for package in ['llama-cpp-python', 'llama_cpp_python']:
        root = Path('/home/developer/.cache/uv') / kind / 'pypi' / package / '0.3.19'
        cache_roots.append({'path': str(root), 'exists': root.exists()})
        if not root.is_dir() or root.is_symlink():
            continue
        queue = [(root, 0)]
        while queue and visited < limit:
            parent, depth = queue.pop(0)
            with os.scandir(parent) as items:
                for item in items:
                    if visited >= limit:
                        break
                    visited += 1
                    info = item.stat(follow_symlinks=False)
                    is_dir = item.is_dir(follow_symlinks=False)
                    cache_rows.append({'path': item.path, 'isDirectory': is_dir,
                                       'isSymlink': item.is_symlink(), 'bytes': info.st_size})
                    if is_dir and depth < 2:
                        queue.append((Path(item.path), depth + 1))

tools = {name: shutil.which(name) for name in ['uv', 'cmake', 'ninja', 'cc', 'c++', 'nvcc', 'nvidia-smi', 'piper']}
gpu = {'status': 'utility_unavailable', 'accelerationProven': False}
if tools['nvidia-smi']:
    args = [tools['nvidia-smi'], '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu,power.draw', '--format=csv,noheader']
    try:
        call = subprocess.run(args, capture_output=True, text=True, timeout=8)
        gpu = {'command': args, 'exitCode': call.returncode, 'stdout': call.stdout[:4096],
               'stderr': call.stderr[:4096], 'accelerationProven': False}
    except subprocess.TimeoutExpired:
        gpu = {'command': args, 'status': 'read_timeout_8_seconds', 'accelerationProven': False}
mem = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key = line.split(':', 1)[0]
    if key in ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']:
        mem[key + 'Bytes'] = int(line.split()[1]) * 1024
value = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(),
    'scope': 'PERSONAL_EXISTING_REPO_KNOWN_PATH_STATS_AND_EXACT_PACKAGE_CACHE_ONLY',
    'knownMatchedModelPaths': model_metadata, 'exactCacheRootsChecked': cache_roots,
    'cacheRows': cache_rows, 'cacheEntriesVisited': visited, 'cacheEntryCap': limit,
    'cacheSearchScope': 'Only listed uv pypi llama0.3.19 roots, max3directory levels; no global cache absence claim',
    'installedBuildToolPaths': tools, 'aggregateGpuRead': gpu,
    'aggregateHostResources': {'memory': mem, 'loadAverage': os.getloadavg(), 'repoFreeBytes': shutil.disk_usage(repo).free},
    'companyProcessesAccountsOrDataRead': False, 'modelWeightsRead': False,
    'buildsInstallsDownloadsTransfersOrInference': 0, 'physicalResourceReservation': 'NOT_ADMITTED'}
encoded = base64.b64encode(json.dumps(value, sort_keys=True).encode()).decode()
parts = [encoded[i:i + 1700] for i in range(0, len(encoded), 1700)]
for i, part in enumerate(parts):
    print('AURORA_NOTEBOOK_ASSETS_V1737 ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

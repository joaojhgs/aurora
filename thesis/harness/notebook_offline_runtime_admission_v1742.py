"""Bounded Personal notebook preparation admission, with no network/build/install.

Use the existing approved shell. Query the exact cached wheel plan, not another
model or benchmark. An uncached wheel is not proof that source cannot be built.
"""
import base64
import datetime
import fcntl
import json
import os
from pathlib import Path
import resource
import shutil
import signal
import socket
import subprocess


os.umask(0o077)
os.nice(10)
repo = Path('/home/developer/projects/aurora')
assert socket.gethostname() == 'skyron-notebook' and Path.cwd() == repo
output = repo / 'thesis/evidence/personal-notebook-readiness-20261020/offline-runtime-admission-v1742'
output.mkdir(parents=True, exist_ok=False)
available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
free = shutil.disk_usage(repo).free
result = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': socket.gethostname(),
    'status': 'PREPARATION_ADMISSION_PENDING', 'memoryAvailableBytes': available, 'repoFreeBytes': free,
    'scope': 'Existing Personal repo/cache and exact llama0.3.19 wheel/build prerequisites only',
    'networkCallsBuildsInstallsModelTransfersOrInference': 0, 'newWorker': False,
    'measuredLaneAdmitted': False, 'companyAccountsProcessesOrDataRead': False}
lock = Path('/tmp/aurora-global-build.lock').open('a')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    result['preparationLock'] = 'ACQUIRED_FOR_BOUNDED_PREPARATION_ONLY_RELEASED_ON_EXIT'
    assert available >= 4 * 1024**3 and free >= 2 * 1024**3, 'preparation_resource_floor'
    tools = {}
    for name in ['cmake', 'ninja', 'cc', 'c++', 'nvcc', 'nvidia-smi', 'piper', 'uv']:
        local = repo / '.venv/bin' / name
        tools[name] = str(local) if local.is_file() else shutil.which(name)
    result['toolPathsCheckedRepoVenvThenShellPath'] = tools
    cache = Path('/home/developer/.cache/uv')
    result['cacheRootExists'] = cache.is_dir()
    exact = []
    count = 0
    packages = ['llama-cpp-python', 'llama_cpp_python', 'cmake', 'ninja', 'scikit-build-core', 'scikit_build_core']
    for kind in ['wheels-v5', 'wheels-v4', 'sdists-v9', 'sdists-v8']:
        parents = [cache / kind / 'pypi']
        index = cache / kind / 'index'
        if index.is_dir() and not index.is_symlink():
            with os.scandir(index) as entries:
                for i, entry in enumerate(entries):
                    if i >= 16:
                        break
                    if entry.is_dir(follow_symlinks=False):
                        parents.append(Path(entry.path))
        for parent in parents:
            for package in packages:
                path = parent / package
                if not path.is_dir() or path.is_symlink():
                    continue
                with os.scandir(path) as entries:
                    for entry in entries:
                        if count >= 64:
                            break
                        if package.startswith('llama') and not entry.name.startswith('0.3.19'):
                            continue
                        count += 1
                        exact.append({'path': entry.path, 'isDirectory': entry.is_dir(follow_symlinks=False), 'isSymlink': entry.is_symlink()})
    result['exactCachePrerequisiteEntries'] = exact
    result['cacheReadBoundary'] = 'Only named packages, max16index roots per bucket/max64version entries; no global model/cache scan'
    assert tools['uv'], 'existing_uv_tool_unavailable'
    env = {key: value for key, value in os.environ.items() if not key.startswith(('UV_', 'PIP_'))}
    env.update(UV_CONCURRENT_BUILDS='1', UV_CONCURRENT_INSTALLS='1', UV_CONCURRENT_DOWNLOADS='1',
               OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1')
    command = [tools['uv'], '--no-config', '--offline', '--cache-dir', str(cache), 'pip', 'install',
               '--dry-run', '--no-build', '--no-deps', '--python', str(repo / '.venv/bin/python'), 'llama-cpp-python==0.3.19']
    result['command'] = command
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    ticks = int(Path('/proc', str(child.pid), 'stat').read_text().rsplit(')', 1)[1].split()[19])
    result['ownedResolverPid'] = child.pid
    result['ownedResolverStartTicks'] = ticks
    try:
        stdout, stderr = child.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        # This is only the owned resolver, never an Orca terminal or SUT.
        os.killpg(child.pid, signal.SIGTERM)
        try:
            stdout, stderr = child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            stdout, stderr = child.communicate(timeout=3)
        result['resolverObservation'] = 'OWNED_READ_RESOLVER_TIMEOUT_20_SECONDS'
    result.update(exitCode=child.returncode, stdout=stdout.decode(errors='replace')[:20000], stderr=stderr.decode(errors='replace')[:20000])
    result['status'] = 'OFFLINE_WHEEL_PLAN_AVAILABLE_NOT_INSTALLED' if child.returncode == 0 else 'OFFLINE_WHEEL_PLAN_NOT_ADMITTED'
except Exception as exc:
    result.update(status='PREPARATION_ADMISSION_NOT_MET', errorClass=type(exc).__name__, errorCode=str(exc)[:256])
finally:
    lock.close()
    result['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data = json.dumps(result, sort_keys=True).encode()
    with (output / 'RESULT.json').open('xb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    encoded = base64.b64encode(data).decode()
    parts = [encoded[i:i + 1700] for i in range(0, len(encoded), 1700)]
    for i, part in enumerate(parts):
        print('AURORA_NOTEBOOK_OFFLINE_RUNTIME_V1742 ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

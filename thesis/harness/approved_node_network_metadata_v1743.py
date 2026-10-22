"""Read only the approved shell's network/proxy metadata; no socket probes."""
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
from urllib.parse import urlsplit


host = socket.gethostname()
assert host in ['skyron-notebook', 'personal.skyron-server']
assert Path.cwd() == Path('/home/developer/projects/aurora')
proxies = {}
for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']:
    value = os.environ.get(key)
    if not value:
        proxies[key] = {'present': False}
        continue
    parsed = urlsplit(value if '://' in value else 'http://' + value)
    endpoint = (parsed.scheme, parsed.hostname, parsed.port)
    proxies[key] = {'present': True, 'endpointSha256': hashlib.sha256(json.dumps(endpoint).encode()).hexdigest(),
                    'loopbackEndpoint': parsed.hostname in ['localhost', '127.0.0.1', '::1'], 'credentialsOutput': False}
routes = []
for line in Path('/proc/net/route').read_text().splitlines()[1:]:
    fields = line.split()
    if len(fields) > 7 and fields[1] == '00000000':
        routes.append({'interface': fields[0], 'gateway': socket.inet_ntoa(struct.pack('<I', int(fields[2], 16))), 'metric': fields[6]})
value = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': host,
    'proxyMetadata': proxies, 'defaultIpv4RoutesInThisNamespace': routes,
    'kernelBootIdSha256': hashlib.sha256(Path('/proc/sys/kernel/random/boot_id').read_bytes()).hexdigest(),
    'networkNamespace': os.readlink('/proc/self/ns/net'),
    'scope': 'Approved Personal shell environment and its own namespace only; no connection/process/company inventory',
    'publicEgressOrPhysicalNetworkIndependenceProven': False, 'networkProbeTraffic': 0,
    'modelBuildInstallTransferOrServiceCalls': 0, 'credentialsOutput': False}
encoded = base64.b64encode(json.dumps(value, sort_keys=True).encode()).decode()
parts = [encoded[i:i + 1700] for i in range(0, len(encoded), 1700)]
for i, part in enumerate(parts):
    print('AURORA_APPROVED_NETWORK_METADATA_V1743 ' + json.dumps({'seq': i, 'total': len(parts), 'data': part}), flush=True)

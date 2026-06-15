# Aurora process-mode dev: Docker Compose + Redis + per-service log-level buttons + Python hot reload.
# Merges docker-compose.tilt.yml (log levels + watchmedo + app/modules mounts). See docs/TILT.md.
# Prerequisites: Docker, Docker Compose v2, Tilt (https://docs.tilt.dev/install.html)
# Copy `.env.example` → `.env` for Compose/Tilt variables and secrets.
#
#   tilt up
#
# Ngrok: enable the `ngrok-gateway` resource in the Tilt UI (requires `ngrok` on PATH
# and NGROK_AUTHTOKEN in your environment).

load('ext://uibutton', 'cmd_button', 'location')

# Sync STT_HOST_AUDIO_GID into `.env` only when it changes (avoids constant Tilt reloads).
main_dir = str(config.main_dir)

# Fix for missing docker-compose in path: ensure user scripts directory is in PATH
# This handles the case where newer setups only have `docker compose` and Tilt needs the wrapper.
os.environ['PATH'] = main_dir + '/scripts:' + os.environ.get('PATH', '')

# Synchronize host audio group dynamically without modifying .env
# This prevents permission denied on /dev/snd for local audio capture
host_gid = str(local('getent group audio 2>/dev/null | cut -d: -f3 || echo 29')).strip()
if host_gid:
    os.environ['STT_HOST_AUDIO_GID'] = host_gid

docker_host_config_path = '/run/host' + main_dir + '/config.json'
docker_host_config_kind = str(
    local(
        'if [ -f '
        + docker_host_config_path
        + ' ]; then echo file; elif [ -d '
        + docker_host_config_path
        + ' ]; then echo directory; else echo missing; fi'
    )
).strip()
if docker_host_config_kind == 'directory':
    # In containerized dev shells, Docker may see a stale host-side project
    # directory while Tilt's build context sees the live workspace. In that case
    # /app/host/config.json is a directory, so use the config baked from Tilt's
    # live build context instead of falling back at runtime.
    os.environ['AURORA_CONFIG_FILE'] = '/app/config.json'
else:
    os.environ.setdefault('AURORA_CONFIG_FILE', '/app/host/config.json')

watch_file('config.json')
watch_file('app/services/config/config_defaults.json')

# Parse config.json natively using Tilt's Starlark JSON module
config_json = read_file('config.json', default='{}')
config_data = decode_json(config_json) if config_json != '{}' else {}

if not config_data.get('services'):
    default_json = read_file('app/services/config/config_defaults.json', default='{}')
    config_data = decode_json(default_json) if default_json != '{}' else {}

services_cfg = config_data.get('services', {})

def bool_to_hardware(value):
    if value:
        return 'cuda'
    return 'cpu'

def llm_mode(provider):
    normalized = str(provider or 'openai').strip().lower().replace('_', '-')
    if normalized == 'huggingface-endpoint':
        return 'huggingface-endpoint'
    if normalized == 'huggingface-pipeline':
        return 'huggingface-local'
    if normalized == 'llama-cpp':
        return 'llama-cpp'
    return 'openai'

db_cfg = services_cfg.get('db', {})
db_embeddings_cfg = db_cfg.get('embeddings', {})
orchestrator_cfg = services_cfg.get('orchestrator', {})
orchestrator_llm_cfg = orchestrator_cfg.get('llm', {})
tts_cfg = services_cfg.get('tts', {})
stt_cfg = services_cfg.get('stt', {})

os.environ['DB_EMBEDDINGS_MODE'] = 'local' if db_embeddings_cfg.get('use_local', False) else 'openai'
os.environ['ORCHESTRATOR_LLM_MODE'] = llm_mode(orchestrator_llm_cfg.get('provider', 'openai'))
os.environ['ORCHESTRATOR_HARDWARE'] = bool_to_hardware(
    orchestrator_cfg.get('hardware_acceleration', False)
)
os.environ['TTS_HARDWARE'] = bool_to_hardware(tts_cfg.get('hardware_acceleration', False))
stt_hardware = bool_to_hardware(stt_cfg.get('hardware_acceleration', False))
os.environ['STT_TRANSCRIPTION_HARDWARE'] = stt_hardware
os.environ['STT_WAKEWORD_HARDWARE'] = stt_hardware

docker_compose(
    ['docker-compose.process.yml', 'docker-compose.tilt.yml'],
    project_name='aurora-process',
)

enabled_services = []
if services_cfg.get('auth', {}).get('enabled', False): enabled_services.append('auth')
if services_cfg.get('gateway', {}).get('enabled', False): enabled_services.append('gateway')
if services_cfg.get('tts', {}).get('enabled', False): enabled_services.append('tts')
if services_cfg.get('scheduler', {}).get('enabled', True): enabled_services.append('scheduler')

if stt_cfg.get('coordinator', {}).get('enabled', False): enabled_services.append('stt_coordinator')
if stt_cfg.get('wakeword', {}).get('enabled', False): enabled_services.append('stt_wakeword')
if stt_cfg.get('transcription', {}).get('enabled', False): enabled_services.append('stt_transcription')

SERVICE_MAP = {
    'auth': ['auth-service'],
    'gateway': ['gateway-service'],
    'tts': ['tts-service'],
    'scheduler': ['scheduler-service'],
    'stt_coordinator': ['stt-coordinator-service'],
    'stt_wakeword': ['stt-wakeword-service'],
    'stt_transcription': ['stt-transcription-service'],
}

disabled_compose_services = []
for key, svcs in SERVICE_MAP.items():
    if key not in enabled_services:
        disabled_compose_services.extend(svcs)

for svc in disabled_compose_services:
    # Avoid initializing disabled services automatically in Tilt
    dc_resource(svc, auto_init=False)

if disabled_compose_services:
    # Dev-only convenience: if config.json disables a service while Tilt is
    # running, stop its Compose container on Tiltfile reload. Runtime lifecycle
    # still belongs to ConfigService; this only keeps the local dev stack tidy.
    local(
        'docker compose -p aurora-process -f docker-compose.process.yml -f docker-compose.tilt.yml stop '
        + ' '.join(disabled_compose_services)
    )

script = main_dir + '/scripts/tilt-set-service-log-level.sh'

services = [
    'config-service',
    'db-service',
    'auth-service',
    'orchestrator-service',
    'gateway-service',
    'tts-service',
    'stt-transcription-service',
    'stt-wakeword-service',
    'scheduler-service',
    'tooling-service',
    'stt-coordinator-service',
]

for s in services:
    sid = s.replace('-', '_')
    cmd_button(
        'aurora-log-debug-' + sid,
        text='Log DEBUG: ' + s,
        argv=[script, s, 'DEBUG'],
        location=location.NAV,
    )
    cmd_button(
        'aurora-log-info-' + sid,
        text='Log INFO: ' + s,
        argv=[script, s, 'INFO'],
        location=location.NAV,
    )

# Optional tunnel to host gateway port (gateway container publishes GATEWAY_HOST_PORT, default 8000).
local_resource(
    'ngrok-gateway',
    serve_cmd='sh -c "exec ngrok http ${NGROK_GATEWAY_PORT:-8000}"',
    auto_init=False,
    labels=['ngrok'],
)

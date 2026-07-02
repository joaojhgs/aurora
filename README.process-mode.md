# Aurora Process Mode Docker Setup

This guide explains how to run Aurora in process mode using Docker Compose, where each service runs in its own container.

## Prerequisites

- Docker 20.10+
- Docker Compose 2.0+ (or `docker compose` v2)
- At least 4GB RAM available for containers
- Linux host (for audio device access) or macOS/Windows with WSL2

## Quick Start

### Option 1: Using the Helper Script (Recommended)

```bash
# Setup and start everything
make docker-process-mode

# Or use the script directly
bash scripts/docker-process-mode.sh
```

The script will:
- Check Docker installation
- Create/update `config.json` for process mode
- Create necessary directories
- Start all services

### Option 2: Manual Setup

1. **Configure Aurora for process mode**

   Edit `config.json` and set:
   ```json
   {
     "general": {
       "architecture": {
         "mode": "processes"
       }
     },
     "messaging": {
       "redis": {
         "url": "redis://redis:6379"
       }
     }
   }
   ```

2. **Build and start all services**

   ```bash
   docker-compose -f docker-compose.process.yml up -d --build
   ```

3. **View logs**

   ```bash
   # All services
   docker-compose -f docker-compose.process.yml logs -f

   # Specific service
   docker-compose -f docker-compose.process.yml logs -f orchestrator-service
   ```

4. **Stop all services**

   ```bash
   docker-compose -f docker-compose.process.yml down
   ```

### Make Commands

For convenience, use these Make commands:

```bash
make docker-process-mode   # Setup and start
make docker-process-up     # Start services
make docker-process-down   # Stop services
make docker-process-logs   # View logs
make docker-process-ps     # Show status
make docker-process-restart # Restart services
```

## Service Architecture

The process mode setup runs the following services:

- **redis**: Redis server for BullMQBus message queue
- **config-service**: Configuration management (starts first)
- **db-service**: Database and RAG operations
- **auth-service**: Authentication, pairing, JWT, mesh trust (uses DB via bus)
- **tooling-service**: Tool management and MCP integration
- **scheduler-service**: Cron job scheduling
- **tts-service**: Text-to-speech synthesis
- **stt-wakeword-service**: Wake word detection
- **stt-transcription-service**: Speech-to-text transcription
- **stt-coordinator-service**: STT workflow and audio capture (see **Microphone / Linux audio** below)
- **orchestrator-service**: LangGraph / LLM orchestration
- **gateway-service**: HTTP/WebSocket/WebRTC API (`GATEWAY_HOST_PORT` → container `8000`)

There is **no supervisor container** in process mode: Compose + Redis replace in-process `Supervisor` startup.

## Microphone / Linux audio (STT coordinator)

The coordinator container uses **PyAudio** → **PortAudio** → **ALSA**. On Linux, Compose passes through **`/dev/snd`** and adds the host **`audio` group GID** so the non-root `aurora` user can open the mic.

1. **GID is synced into `.env` when needed**: `make docker-process-up`, `./scripts/docker-process-mode.sh`, and **`tilt up`** run **`scripts/sync-stt-audio-gid-in-dotenv.sh`**, which sets **`STT_HOST_AUDIO_GID`** from `getent group audio` (fallback **29**) **only if** `.env` is missing the key or the value changed — avoiding constant file churn. If you have no `.env`, Compose still uses **`STT_HOST_AUDIO_GID:-29`** from the YAML.
2. **Docker Desktop on macOS** does not provide `/dev/snd`. Use **Linux**, **WSL2**, or a compose override that removes `devices` / `group_add` for `stt-coordinator-service` if you only run headless STT.
3. **PulseAudio / PipeWire**: if you need the container to use the host session server, set `PULSE_SERVER` (e.g. `unix:/run/user/1000/pulse/native`) and bind-mount the host’s runtime dir in a **local override** file — paths differ per distro/user.

The coordinator image installs **`libasound2`** at runtime (not only `portaudio19-dev` at build time).

## Tilt (optional)

For iterative dev with per-service `DEBUG` buttons and optional ngrok, see **[docs/TILT.md](docs/TILT.md)**.

## Service Dependencies

Services start in dependency order (see `docker-compose.process.yml` for exact `depends_on`):

1. **Redis** (foundation; healthcheck before config)
2. **Config** (needed by all Aurora services)
3. **DB** (after config)
4. **Auth** (after config, DB, Redis)
5. **Tooling** / **Scheduler** (after config, DB, auth, Redis)
6. **Orchestrator** (after config, DB, auth, tooling, Redis)
7. **Gateway** (after config, DB, auth, tooling, orchestrator, Redis) — exposes port **8000** in-container
8. **TTS**, **STT** workers (after config; coordinator also depends on wakeword + transcription)

## Gateway port

Host port defaults to **8000**. Override when port is busy:

```bash
GATEWAY_HOST_PORT=18000 docker compose -f docker-compose.process.yml up -d gateway-service
```

## Configuration

### Environment Variables

All services support these environment variables:

- `AURORA_ENV`: Environment (default: `production`)
- `AURORA_ARCHITECTURE_MODE`: Must be `processes` for this setup
- `REDIS_URL`: Redis connection URL (default: `redis://redis:6379`)
- `AURORA_LOG_LEVEL`: Logging level (default: `INFO`)
### Volumes

Paths on the left are relative to the **Compose project directory** (repo root when you run `docker compose` from there):

- `…/data` → `/app/data`: Application data and databases
- `…/config` → `/app/config`: Writable config dir
- `…/logs` → `/app/logs`: Service logs
- `…/` (repo root) → `/app/host`: Optional full checkout (read/write) for dev sync
- `…/models` → `/app/models`: LLM/voice/wakeword assets (services that need models)

**Configuration**: Only **`config-service`** bakes **`config.json`** at image build (`docker/services/Dockerfile.config` copies the repo-root **`config.json`**). That file **must exist** when you build (create one from **`app/services/config/config_defaults.json`** if you do not keep `config.json` in the tree). All other services use **ConfigAPI** over the bus to **ConfigService**—they do not ship a local `config.json`. Change settings at runtime via **ConfigService** / API; to change the image’s starting config, edit **`config.json`** and **rebuild `config-service`** only.

Build-time image variants are also derived from **`config.json`** by the supported Make/scripts workflows. `scripts/config_to_docker_env.py` maps `services.db.embeddings.use_local`, `services.orchestrator.llm.provider`, and hardware acceleration flags into Compose build args such as `DB_EMBEDDINGS_MODE`, `ORCHESTRATOR_LLM_MODE`, and `TTS_HARDWARE`. Inspect with:

```bash
python scripts/config_to_docker_env.py --format env
```

### Audio Devices (Linux only)

The **stt-coordinator-service** mounts `/dev/snd` for microphone capture. On macOS/Windows, use Linux/WSL2 or adjust audio passthrough for your environment.

## Monitoring

### Check service status

```bash
docker-compose -f docker-compose.process.yml ps
```

### View service logs

```bash
# All services
docker-compose -f docker-compose.process.yml logs -f

# Specific service
docker-compose -f docker-compose.process.yml logs -f config-service
docker-compose -f docker-compose.process.yml logs -f orchestrator-service
```

### Restart a service

```bash
docker-compose -f docker-compose.process.yml restart orchestrator-service
```

### Scale services (advanced)

You can run multiple instances of stateless services:

```bash
docker compose -f docker-compose.process.yml up -d --scale stt-transcription-service=2
```

## Troubleshooting

### Services won't start

1. Check Redis is healthy:
   ```bash
   docker-compose -f docker-compose.process.yml ps redis
   ```

2. Check service logs:
   ```bash
   docker-compose -f docker-compose.process.yml logs <service-name>
   ```

3. Verify config.json has correct Redis URL:
   ```json
   {
     "messaging": {
       "redis": {
         "url": "redis://redis:6379"
       }
     }
   }
   ```

### Services can't connect to Redis

- Ensure Redis container is running: `docker-compose -f docker-compose.process.yml ps redis`
- Check network connectivity: `docker-compose -f docker-compose.process.yml exec config-service ping redis`
- Verify `REDIS_URL` environment variable is set correctly

### Audio issues

- On Linux: Ensure `/dev/snd` devices are accessible
- On macOS/Windows: Consider using virtual audio devices or WSL2
- Check stt-coordinator-service logs for device errors

### High memory usage

- Process mode uses more memory than threads mode
- Consider reducing model sizes or disabling unused services
- Monitor with: `docker stats`

## Development

### Rebuild after code changes

```bash
docker-compose -f docker-compose.process.yml build
docker-compose -f docker-compose.process.yml up -d
```

### Run a single service for testing

```bash
docker-compose -f docker-compose.process.yml up config-service
```

### Access a service shell

```bash
docker-compose -f docker-compose.process.yml exec orchestrator-service /bin/bash
```

## Production Considerations

1. **Security**: Use Docker secrets for sensitive configuration
2. **Resource Limits**: Set memory/CPU limits per service
3. **Health Checks**: Implement proper health checks for orchestration
4. **Logging**: Configure centralized logging (e.g., ELK stack)
5. **Monitoring**: Set up Prometheus/Grafana for metrics
6. **Backup**: Regular backups of Redis and data volumes
7. **Scaling**: Use Docker Swarm or Kubernetes for production

## Comparison: Threads vs Process Mode

| Aspect | Threads Mode | Process Mode |
|--------|-------------|--------------|
| **Isolation** | Shared memory | Process isolation |
| **Fault Tolerance** | One crash affects all | Service crashes isolated |
| **Scaling** | Single process | Horizontal scaling possible |
| **Resource Usage** | Lower memory | Higher memory |
| **Communication** | LocalBus (in-memory) | BullMQBus (Redis) |
| **Use Case** | Development, small deployments | Production, microservices |

## Additional Resources

- [Aurora Documentation](docs/DOCS_INDEX.md)
- [Messaging Architecture](docs/MESSAGING_ARCHITECTURE.md)
- [Docker Compose Documentation](https://docs.docker.com/compose/)

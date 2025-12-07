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
- **tooling-service**: Tool management and MCP integration
- **scheduler-service**: Cron job scheduling
- **tts-service**: Text-to-speech synthesis
- **audio-input-service**: Audio capture from microphone
- **wakeword-service**: Wake word detection
- **transcription-service**: Speech-to-text transcription
- **stt-coordinator-service**: STT workflow coordination
- **orchestrator-service**: Main orchestration (starts last)

## Service Dependencies

Services start in dependency order:
1. Redis (foundation)
2. Config Service (needed by all)
3. DB Service (foundation)
4. Tooling Service (depends on DB)
5. Scheduler Service (depends on DB)
6. TTS Service (standalone)
7. Audio Input Service (standalone)
8. Wake Word & Transcription Services (depend on Audio Input)
9. STT Coordinator (depends on Wake Word & Transcription)
10. Orchestrator (depends on all above)

## Configuration

### Environment Variables

All services support these environment variables:

- `AURORA_ENV`: Environment (default: `production`)
- `AURORA_ARCHITECTURE_MODE`: Must be `processes` for this setup
- `REDIS_URL`: Redis connection URL (default: `redis://redis:6379`)
- `AURORA_LOG_LEVEL`: Logging level (default: `INFO`)

### Volumes

The following directories are mounted:

- `./data` → `/app/data`: Application data and databases
- `./config` → `/app/config`: Configuration files
- `./logs` → `/app/logs`: Service logs
- `./config.json` → `/app/config.json`: Main config file
- `./chat_models` → `/app/chat_models`: LLM models (if needed)
- `./voice_models` → `/app/voice_models`: Voice models (if needed)

### Audio Devices (Linux only)

The `audio-input-service` requires access to audio devices. On Linux, this is handled via device mounting (`/dev/snd`). On macOS/Windows, you may need to use different approaches.

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
docker-compose -f docker-compose.process.yml up -d --scale transcription-service=2
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
- Check audio-input-service logs for device errors

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

- [Aurora Documentation](../docs/)
- [Process Mode Architecture](../docs/MESSAGING_ARCHITECTURE.md)
- [Docker Compose Documentation](https://docs.docker.com/compose/)

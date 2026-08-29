# Testing Process Mode

This document describes how to test Aurora in process mode (microservices architecture).

## Overview

Process mode runs each service as a separate OS process, communicating via Redis/BullMQ message bus. This enables true microservices architecture with process isolation.

## Prerequisites

### Redis Server

Process mode requires a running Redis server. You can install and run Redis using:

**Linux/macOS:**
```bash
# Install Redis
sudo apt-get install redis-server  # Ubuntu/Debian
brew install redis                 # macOS

# Start Redis
redis-server
```

**Docker:**
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

**Verify Redis is running:**
```bash
redis-cli ping
# Should return: PONG
```

## Running Process Mode Tests

### Run All Process Mode Tests

```bash
pytest tests/integration/test_process_mode.py -v -m process_mode
```

### Run Specific Test

```bash
pytest tests/integration/test_process_mode.py::TestProcessModeServices::test_config_service_startup -v
```

### Run with Redis Check

The tests automatically check for Redis availability and skip if not available:

```bash
# Without Redis - tests will be skipped
pytest tests/integration/test_process_mode.py -v

# With Redis running - tests will execute
redis-server &
pytest tests/integration/test_process_mode.py -v
```

## Test Structure

### Test Fixtures

Located in `tests/fixtures/process_mode.py`:

- `redis_server`: Ensures Redis is running (session-scoped)
- `process_mode_environment`: Sets environment variables for process mode
- `service_manager`: Context manager for managing service processes

### Test Classes

#### TestProcessModeServices

Tests individual services in process mode:

- `test_config_service_startup`: Verifies ConfigService can start
- `test_db_service_startup`: Verifies DBService can start
- `test_service_communication`: Tests bus communication
- `test_config_reload_in_process_mode`: Tests config reload across processes

#### TestProcessModeEndToEnd

End-to-end tests for full process mode deployment:

- `test_full_stack_startup`: Tests all services starting together
- `test_service_isolation`: Tests that service failures don't affect others
- `test_graceful_shutdown`: Tests graceful shutdown

## What Each Test Verifies

### Service Startup Tests

- Service can start as a subprocess
- Service connects to Redis
- Service initializes its message bus
- Service remains running

### Communication Tests

- Services can send messages via bus
- Services can receive messages via bus
- Message routing works correctly
- Error handling works

### Config Reload Tests

- Config changes propagate to services
- Services reload configuration correctly
- Services handle config errors gracefully

### Isolation Tests

- Service failures don't affect other services
- Services can be restarted independently
- Process isolation is maintained

### Shutdown Tests

- Services shut down gracefully
- Resources are cleaned up
- No zombie processes remain

## Troubleshooting

### Redis Connection Errors

**Error:** `Redis not available - skipping process mode tests`

**Solution:**
1. Ensure Redis is installed and running
2. Check Redis is listening on port 6379: `redis-cli ping`
3. Verify `REDIS_URL` environment variable is set correctly

### Service Startup Failures

**Error:** Service process exits immediately

**Solution:**
1. Check service logs: `python -m app.services.config` (run directly)
2. Verify dependencies are installed
3. Check environment variables are set correctly
4. Verify Redis is accessible

### Test Timeouts

**Error:** Tests timeout waiting for services

**Solution:**
1. Increase timeout in test (default is 5 seconds)
2. Check if services are actually starting (check process list)
3. Verify Redis is responsive
4. Check system resources (CPU/memory)

### Port Conflicts

**Error:** Port already in use

**Solution:**
1. Check if another Redis instance is running: `ps aux | grep redis`
2. Stop conflicting services
3. Use a different Redis port (update `REDIS_URL`)

## CI/CD Integration

Process mode tests run automatically in CI in the `process-mode` job of `.github/workflows/python-tests.yml`.

The CI workflow:
1. Starts a Redis container
2. Sets up Python environment
3. Installs dependencies
4. Runs process mode tests

## Manual Testing

To manually test process mode:

1. **Start Redis:**
   ```bash
   redis-server
   ```

2. **Set environment variables:**
   ```bash
   export AURORA_ARCHITECTURE_MODE=processes
   export REDIS_URL=redis://localhost:6379
   ```

3. **Start a service:**
   ```bash
   python -m app.services.config
   ```

4. **In another terminal, verify it's running:**
   ```bash
   redis-cli
   > KEYS *
   ```

5. **Stop the service:**
   ```bash
   # Ctrl+C or kill the process
   ```

## Best Practices

1. **Always clean up:** Use fixtures that automatically clean up processes
2. **Use timeouts:** Don't wait indefinitely for services
3. **Check Redis first:** Verify Redis is available before starting services
4. **Isolate tests:** Each test should be independent
5. **Test failures:** Verify services handle failures gracefully

## Related Documentation

- [MESSAGING_ARCHITECTURE.md](./MESSAGING_ARCHITECTURE.md): Message bus architecture
- [README.process-mode.md](../README.process-mode.md): Process mode overview
- [ARCHITECTURE.md](./ARCHITECTURE.md): Overall architecture

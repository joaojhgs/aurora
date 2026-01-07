# Aurora Gateway API

## Overview

The Aurora Gateway is a FastAPI-based HTTP gateway that exposes all Aurora services as RESTful endpoints. It dynamically discovers services and their methods through the message bus contract registry, automatically generating routes and OpenAPI documentation.

### Key Features

- **Dynamic Service Discovery**: Automatically discovers services and methods at runtime
- **Automatic Route Generation**: Creates REST endpoints from service contracts
- **OpenAPI/Swagger Documentation**: Full API documentation with request/response schemas
- **Dual Mode Support**: Works in both threads (local) and processes (microservices) modes
- **Error Propagation**: Immediate error responses instead of timeouts
- **Schema Validation**: Automatic input/output validation using Pydantic models
- **CORS Support**: Configurable CORS for web applications
- **API Key Authentication**: Optional API key authentication

## Architecture

### Components

```
┌─────────────────┐
│   FastAPI App   │
│  (Gateway API)  │
└────────┬────────┘
         │
         ├─────────────────┐
         │                 │
┌────────▼────────┐  ┌─────▼──────────┐
│ Route Generator │  │Registry         │
│                 │  │Aggregator       │
└────────┬────────┘  └─────┬────────────┘
         │                │
         │                │
┌────────▼────────────────▼────────┐
│      Message Bus                 │
│  (LocalBus / BullMQBus)          │
└────────┬─────────────────────────┘
         │
         │
┌────────▼────────┐
│   Services      │
│  (Orchestrator, │
│   Config, etc.) │
└─────────────────┘
```

### Service Discovery Flow

1. **Service Announcement**: When a service starts, it publishes a `ServiceAnnouncement` message containing:
   - Service metadata (name, version, capabilities)
   - Method contracts with input/output schemas
   - Exposure levels (internal/external/both)

2. **Registry Aggregation**: The `RegistryAggregator` subscribes to announcements and maintains an aggregated view of all available services

3. **Route Generation**: The `RouteGenerator` creates FastAPI routes dynamically:
   - Only for methods with `exposure="external"` or `exposure="both"`
   - Routes are generated lazily when first needed
   - Routes are regenerated when services announce/depart

4. **Request Handling**: When a request arrives:
   - Gateway validates input against the method's input schema
   - Forwards request to service via message bus
   - Returns service response (or error) to client

## Configuration

The gateway is configured in `config.json`:

```json
{
  "gateway": {
    "enabled": true,
    "host": "0.0.0.0",
    "port": 8000,
    "request_timeout_s": 30.0,
    "cors": {
      "origins": ["*"],
      "allow_credentials": true
    },
    "auth": {
      "enabled": false,
      "api_keys": []
    }
  }
}
```

### Configuration Options

- **enabled**: Enable/disable the gateway (can be changed at runtime via `Config.Set`)
- **host**: Bind address (default: `0.0.0.0`)
- **port**: HTTP port (default: `8000`)
- **request_timeout_s**: Timeout for service requests in seconds (default: `30.0`)
- **cors.origins**: List of allowed CORS origins (use `["*"]` for all)
- **cors.allow_credentials**: Allow credentials in CORS requests
- **auth.enabled**: Enable API key authentication
- **auth.api_keys**: List of valid API keys

### Dynamic Configuration

The gateway can be enabled/disabled at runtime via the `Config.Set` API:

```bash
# Disable gateway
curl -X POST http://localhost:8000/api/Config/Set \
  -H "Content-Type: application/json" \
  -d '{"key_path": "gateway.enabled", "value": false}'

# Re-enable gateway
curl -X POST http://localhost:8000/api/Config/Set \
  -H "Content-Type: application/json" \
  -d '{"key_path": "gateway.enabled", "value": true}'
```

**Note**: Some settings (host, port) require a full restart to take effect.

## API Endpoints

### Built-in Endpoints

#### Health Check
```
GET /api/health
```
Returns gateway health status.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-20T12:00:00Z"
}
```

#### Service Registry
```
GET /api/registry
```
Returns the complete service registry with all methods and schemas.

#### List Services
```
GET /api/services
```
Returns a list of all available services with their status.

**Response:**
```json
{
  "services": [
    {
      "module": "Orchestrator",
      "version": "1.0.0",
      "status": "healthy",
      "methods": ["ExternalUserInput"]
    }
  ]
}
```

#### Get Service Details
```
GET /api/services/{module_name}
```
Returns detailed information about a specific service.

#### List Routes
```
GET /api/routes
```
Returns all available API routes grouped by service.

**Response:**
```json
{
  "total_routes": 16,
  "services": [
    {
      "service": "Orchestrator",
      "routes": ["/api/Orchestrator/ExternalUserInput"]
    }
  ]
}
```

### Service Endpoints

All service methods with `exposure="external"` or `exposure="both"` are automatically exposed as:

```
POST /api/{ServiceName}/{MethodName}
```

#### Example: Orchestrator.ExternalUserInput

```bash
curl -X POST http://localhost:8000/api/Orchestrator/ExternalUserInput \
  -H "Content-Type: application/json" \
  -d '{
    "text": "What is 2+2?",
    "session_id": "my-session"
  }'
```

**Response:**
```json
{
  "text": "Two plus two equals four.",
  "session_id": "my-session",
  "metadata": {
    "source": "external"
  }
}
```

## Error Handling

### Error Response Format

All errors follow a consistent format:

```json
{
  "error": "Error message",
  "status_code": 500,
  "path": "/api/Service/Method"
}
```

### Error Types

#### 422 - Validation Error
Returned when request body doesn't match the method's input schema.

```json
{
  "detail": [
    {
      "type": "missing",
      "loc": ["body", "text"],
      "msg": "Field required"
    }
  ]
}
```

#### 500 - Service Error
Returned when the service encounters an error processing the request.

```json
{
  "error": "Tool not found: 'nonexistent_tool'",
  "status_code": 500,
  "path": "/api/Tooling/ExecuteTool"
}
```

#### 503 - Service Unavailable
Returned when a service is not available (only in processes mode).

```json
{
  "error": "Service 'Orchestrator' is not available",
  "status_code": 503,
  "path": "/api/Orchestrator/ExternalUserInput"
}
```

#### 504 - Timeout
Returned when a service request times out.

```json
{
  "error": "Service 'Orchestrator' request timed out",
  "status_code": 504,
  "path": "/api/Orchestrator/ExternalUserInput"
}
```

### Error Propagation Improvements

**Before**: Service errors caused 30-second timeouts before returning an error.

**After**: Errors are immediately propagated:
- Validation errors return immediately (422)
- Service errors return immediately (500) with error message
- Response time: ~9ms instead of 30s

## Service Discovery Protocol

### Service Announcement

When a service starts, it publishes a `ServiceAnnouncement`:

```python
ServiceAnnouncement(
    module="Orchestrator",
    version="1.0.0",
    summary="Orchestrates LLM interactions",
    capabilities=["llm", "tool_execution"],
    methods=[
        MethodInfo(
            name="ExternalUserInput",
            summary="Process external user input",
            bus_topic="Orchestrator.ExternalUserInput",
            input_schema={...},  # JSON Schema
            output_schema={...},  # JSON Schema
            exposure="external"
        )
    ]
)
```

### Service Departure

When a service stops, it publishes a `ServiceDeparture`:

```python
ServiceDeparture(
    module="Orchestrator",
    reason="shutdown"
)
```

### Registry Aggregation

The `RegistryAggregator`:
- Subscribes to `Gateway.ServiceAnnouncement` and `Gateway.ServiceDeparture`
- Maintains a registry of all available services
- In threads mode: Also loads from local contract registry at startup
- In processes mode: Relies entirely on announcements (with heartbeat tracking)

## Implementation Details

### Route Generation

Routes are generated lazily:
1. Routes are created when the registry changes (service announces/departs)
2. Routes are not pre-generated at startup (faster startup)
3. Routes are regenerated when services come/go

### Schema Handling

#### Input Validation
- Gateway creates dynamic Pydantic models from JSON schemas
- FastAPI validates requests against these models
- Invalid requests return 422 immediately

#### Output Documentation
- OpenAPI schemas are generated from service output schemas
- `$defs` references are resolved inline for OpenAPI compatibility
- `additionalProperties` are stripped to avoid "additionalProp1" in Swagger UI

### Threads vs Processes Mode

#### Threads Mode
- All services run in the same process
- Services are always considered "available"
- Registry is loaded from local contract registry at startup
- No heartbeat tracking needed

#### Processes Mode
- Services run as separate OS processes
- Services announce themselves via message bus
- Heartbeat tracking determines availability
- Services can be unavailable (return 503)

## API Documentation

The gateway automatically generates OpenAPI/Swagger documentation:

- **Swagger UI**: http://localhost:8000/api/docs
- **ReDoc**: http://localhost:8000/api/redoc
- **OpenAPI JSON**: http://localhost:8000/api/openapi.json

### Schema Generation

Schemas are extracted from service method contracts:
- Input schemas: From `input_model` Pydantic models
- Output schemas: From `output_model` Pydantic models
- Schemas are converted to JSON Schema format
- `$defs` references are resolved inline for OpenAPI compatibility

## Authentication

### API Key Authentication

When enabled, all requests (except `/api/health`) require an API key:

```bash
curl -X POST http://localhost:8000/api/Orchestrator/ExternalUserInput \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key-here" \
  -d '{"text": "Hello"}'
```

### Bypass Endpoints

The following endpoints bypass authentication:
- `/api/health`
- `/api/docs`
- `/api/redoc`
- `/api/openapi.json`

## Testing

### Manual Testing

```bash
# Test health endpoint
curl http://localhost:8000/api/health

# Test service endpoint
curl -X POST http://localhost:8000/api/Orchestrator/ExternalUserInput \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello"}'

# Test error handling
curl -X POST http://localhost:8000/api/Tooling/ExecuteTool \
  -H "Content-Type: application/json" \
  -d '{"tool_name": "nonexistent", "arguments": {}}'
```

### Unit Tests

Gateway components are tested in `tests/unit/app/test_gateway.py`:
- Model validation
- Registry aggregation
- Route generation
- FastAPI app creation

## Troubleshooting

### Gateway Not Starting

1. Check `config.json` has `gateway.enabled: true`
2. Check logs for initialization errors
3. Verify port 8000 is not in use

### Routes Not Appearing

1. Check service has methods with `exposure="external"` or `exposure="both"`
2. Verify service has announced itself (check logs for "Service announced")
3. Check `/api/routes` endpoint

### Timeout Errors

1. Check service is actually running
2. Increase `gateway.request_timeout_s` in config
3. Check service logs for processing errors

### Schema Errors in Swagger

1. Verify service output models are valid Pydantic models
2. Check for circular references in models
3. Ensure `$defs` are properly resolved (should be automatic)

## Changes Made

### Core Implementation

1. **Gateway Service** (`app/services/gateway/`)
   - `fastapi_app.py`: FastAPI application factory
   - `registry_aggregator.py`: Service discovery and registry management
   - `route_generator.py`: Dynamic route generation
   - `auth.py`: API key authentication

2. **Service Announcement Protocol** (`app/shared/services/base_service.py`)
   - Services automatically announce themselves on startup
   - Services publish departure on shutdown
   - Includes method schemas in announcements

3. **Supervisor Integration** (`app/services/supervisor.py`)
   - Gateway lifecycle management
   - Dynamic enable/disable via config changes
   - Gateway starts after all services are up

4. **Error Handling** (`app/messaging/local_bus.py`, `app/shared/services/base_service.py`)
   - Error responses propagate immediately (no timeouts)
   - Validation errors return proper error responses
   - Consistent error format across all endpoints

### Bug Fixes

1. **Handler Signature Fixes**
   - Updated all service handlers to use new `@method_contract` pattern
   - Handlers now directly receive Pydantic models (not Envelopes)
   - Handlers return response models (not None)

2. **Contract Subscription Fix**
   - Fixed `_subscribe_registered_contracts` to use `method_id` as topic
   - Added explicit subscription call in `main.py` for Supervisor

3. **Schema Generation Fixes**
   - Fixed `$defs` reference resolution for OpenAPI
   - Stripped `additionalProperties` to avoid "additionalProp1" in Swagger
   - Fixed type inference for `Any` types in schemas

4. **Error Propagation Fixes**
   - Bus now detects `ErrorOutput` responses and marks them as errors
   - Validation errors send error responses instead of silently failing
   - Gateway returns errors immediately instead of waiting for timeout

## Future Enhancements

- [ ] Rate limiting per API key
- [ ] Request/response logging middleware
- [ ] Metrics/telemetry endpoint
- [ ] WebSocket support for streaming responses
- [ ] GraphQL endpoint option
- [ ] Request signing/verification
- [ ] Service health aggregation endpoint

## Related Documentation

- [Architecture Overview](../docs/ARCHITECTURE.md)
- [Messaging Architecture](../docs/MESSAGING_ARCHITECTURE.md)
- [Service Contracts](../app/shared/contracts/README.md)


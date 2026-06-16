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
- **auth.enabled**: Enable API key authentication and WebRTC auth enforcement
- **auth.api_keys**: List of valid API keys
- **permissions.webrtc_auth_timeout_seconds**: Auth timeout for WebRTC peers (default: `10.0`)
- **permissions.webrtc_pairing_timeout_seconds**: Extended timeout for peers in pairing flow (default: `300.0`, range: 30–3600)
- **webrtc.room**: Room name (auto-generated if `"default"` or empty)
- **webrtc.password**: Room password (auto-generated if empty; required when auth is enabled)
- **webrtc.encrypt_signaling**: Encrypt MQTT presence with AEAD (default: `false`)
- **webrtc.enable_app_layer_e2ee**: Encrypt WebRTC DataChannel JSON messages with AEAD in addition to WebRTC DTLS (default: `false`). When enabled, both peers must enable it and share the same room password-derived data key; plaintext DataChannel messages are dropped instead of downgraded.

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

#### Mesh Status and Route Diagnostics
```
POST /api/Gateway/GetMeshStatus
```
Returns a read-only, redacted diagnostic snapshot of mesh state. The response includes local
mesh identity, whether WebRTC/mesh components are started, connected peer lifecycle state,
negotiated peer services, capacity and active calls, recent ping/latency age, compatibility
ACK results, and per-module route decisions.

The diagnostic output is designed to answer questions such as which peer provides `Tooling`,
`DB`, or `TTS`, why a route selected local or remote delivery, and which version/capability
checks made a peer ineligible. Credential-bearing configuration is not included; the response
does not expose tokens, API keys, MQTT passwords, WebRTC room passwords, or raw secrets.

Example:
```bash
curl -X POST http://localhost:8000/api/Gateway/GetMeshStatus \
  -H "Content-Type: application/json" \
  -d '{}'
```

Key fields:
- `local`: local mesh enable/start state, stable peer id, node name, shared modules, and routed modules.
- `peers`: peer status, negotiated services, service capacity, active calls, latency, and compatibility reports.
- `routes`: configured route preference/fallback plus the current decision and provider eligibility reasons.
- `compatibility_failures`: flattened local/remote compatibility failures for quick scanning.

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

## WebRTC Authentication & Pairing

The Gateway exposes four **pairing and login RPC methods** that are accessible both via the HTTP API and over the WebRTC DataChannel. These methods allow devices to pair and authenticate without needing a separate HTTP connection.

The pairing system implements a **consolidated trust model** — the Auth service's `users/devices/tokens` tables and the mesh `mesh_peers` table are bidirectionally synced, ensuring a single source of truth for peer identity, permissions, and credentials.

### Gateway Pairing Methods

| Method ID | Summary | Input | Output | Exposure |
|-----------|---------|-------|--------|----------|
| `Gateway.PairingStart` | Start device pairing | `PairingStartRequest` | `PairingStartResponse` | **both** |
| `Gateway.PairingConnect` | Poll pairing status | `PairingConnectRequest` | `PairingConnectResponse` | **both** |
| `Gateway.PairingExchange` | Exchange code for token | `PairingExchangeRequest` | `PairingExchangeResponse` | **both** |
| `Gateway.Login` | Authenticate with credentials | `LoginRequest` | `LoginResponse` | **both** |

These methods are the **only** RPC calls that anonymous (unauthenticated) WebRTC peers are allowed to make. All other RPC calls from anonymous peers are rejected with a 401 error.

#### Notable Request/Response Fields

**`PairingStartRequest`** includes:
- `device_name` — Human-readable device name for the admin approval screen
- `remote_peer_id` — (Optional) The initiator's stable `mesh_identity.peer_id`; used by the responder to auto-trigger **bilateral pairing** (Phase 2)
- `remote_node_name` — (Optional) The initiator's node name for logging

**`PairingExchangeResponse`** includes:
- `access_token` — JWT/token for subsequent authenticated API calls
- `token_id` — The DB primary key of the issued Token record; used by the caller to link outbound foreign keys in `mesh_peers`

### WebRTC Auth Enforcement

When `api.auth_enabled` is `true`, the RTCClient enforces a strict auth gate:

1. **On DataChannel open**: Gateway sends its auth token to the peer. A heartbeat-based auth timeout loop is started.
2. **Auth gate**: Only `auth` and `reauth` messages pass through from anonymous peers. All other message types are silently dropped.
3. **RPC allowlist**: Anonymous peers may call `PairingStart`, `PairingConnect`, `PairingExchange`, and `Login`. Other RPC calls return 401.
4. **Event blocking**: Events from anonymous peers are silently dropped.
5. **Smart auth timeout (heartbeat loop)**: Instead of a single fire-and-forget timer, the auth gate runs a periodic heartbeat check (every 5 seconds) that monitors whether the peer has authenticated. When a peer starts pairing via `PairingStart`, the deadline is extended to `webrtc_pairing_timeout_seconds` (default 300s). If the peer authenticates before the deadline, the loop exits. If the deadline passes without authentication, the peer is disconnected with `"auth_timeout"`.

When `api.auth_enabled` is `false`:
- Peers receive the `OPEN_PEER` identity immediately (full permissions).
- No auth message is sent, no timeout, no auth gate.

### DataChannel Encryption Modes

WebRTC DataChannels are protected in transit by WebRTC DTLS. Aurora can also add an optional application-layer encryption step for every JSON message sent through the `aurora-rpc` DataChannel:

- `webrtc.enable_app_layer_e2ee=false` (default): auth messages, JSON-RPC calls/responses, manifests, ping/pong, capacity updates, and mesh events are sent as JSON text over the DTLS-protected DataChannel.
- `webrtc.enable_app_layer_e2ee=true`: those same JSON messages are sealed with AES-GCM using the room password-derived DataChannel key and sent as binary frames.

The mode is strict. A peer with app-layer E2EE enabled drops plaintext DataChannel messages, and a peer with it disabled cannot decode encrypted binary frames. This avoids silent downgrade behavior; paired peers must use matching `enable_app_layer_e2ee`, `webrtc.app_id`, `webrtc.room`, and `webrtc.password` values.

### Bilateral Mesh Pairing

When two Aurora instances pair, the process happens in **two phases** so that each admin independently approves the other:

#### Phase 1 (Initiator → Responder)
1. Initiator calls `PairingStart` with its `remote_peer_id` and `remote_node_name`.
2. Responder admin sees the pairing code and approves it (or auto-approves in dev mode).
3. Initiator calls `PairingExchange` to receive an access token + `token_id`.
4. Auth service publishes `Auth.PairingRequested` event with the initiator's `remote_peer_id`.

#### Phase 2 (Responder → Initiator) — Automatic Reverse Pairing
5. On authenticating the initiator (`validate_peer`), RTCClient detects the `remote_peer_id` and calls `_reverse_pairing()`.
6. `_reverse_pairing()` calls `PairingStart` on the **initiator** (via the DataChannel) with the responder's own `peer_id` and `node_name`.
7. The initiator's admin approves. The responder calls `PairingExchange` to receive the initiator's token + `token_id`.
8. Both sides now hold each other's credentials → **mutual trust established**.

#### Partial Completion

| Phase 1 | Phase 2 | Result |
|---------|---------|--------|
| ✅ | ✅ | Full mutual trust — bidirectional RPC |
| ✅ | ❌ | One-way trust — initiator can call responder but not vice-versa |
| ❌ | N/A | No trust — pairing never completed |

Both phases persist their results to the `mesh_peers` DB table with outbound FKs linking to the auth tables.

### Consolidated Trust Stores

The Auth service maintains **two sets of tables** that are kept in sync:

| Auth Tables | Mesh Table | Link Direction |
|-------------|------------|----------------|
| `users`, `devices`, `tokens` | `mesh_peers` | `mesh_peers.outbound_{user,device,token}_id` → auth PKs |

#### Sync Points

1. **`approve_mesh_peer()`** — When the admin approves a mesh peer:
   - Also approves any pending pairing codes from that peer's `remote_peer_id`
   - Copies `mesh_peers.permissions` → `User.permissions` and `Token.scopes`

2. **`update_mesh_peer_permissions()`** — When the admin changes a peer's permissions:
   - Updates `mesh_peers.permissions`
   - Syncs to `User.permissions` and `Token.scopes` via outbound FKs

3. **`exchange_pairing()`** — After token issuance:
   - Calls `_MeshSQL.link_outbound_fks()` to write `outbound_token_id`, `outbound_device_id`, `outbound_user_id` into the `mesh_peers` row

This ensures that permission changes made via the **Peer Management API** automatically propagate to the auth enforcement layer, and vice-versa.

### Peer Identification

Connected peers are identified by human-readable labels in logs:

- **Format**: `node_name (peer_id[:8])` — e.g., `"Aurora-Kitchen (a1b2c3d4)"`
- Stored in `RTCClient._peer_names` dict, keyed by DataChannel label
- Falls back to the DataChannel label if no node name is provided

### Peer Management API

The Auth service exposes additional contracts for managing mesh peers after pairing:

| Method ID | Summary | Exposure |
|-----------|---------|----------|
| `Auth.ApproveMeshPeer` | Approve a pending peer (also syncs pairing codes) | **both** |
| `Auth.DenyMeshPeer` | Deny/remove a pending or active peer | **both** |
| `Auth.UpdateMeshPeerPermissions` | Update a peer's permissions (syncs to auth tables) | **both** |
| `Auth.ListMeshPeers` | List all mesh peers with status | **both** |
| `Auth.RemoveMeshPeer` | Remove a peer and revoke all credentials | **both** |

These methods are accessible via the standard Gateway HTTP API (e.g., `POST /api/Auth/ApproveMeshPeer`) and via WebRTC RPC from authenticated peers.

### Room Auto-Generation

On startup, the Gateway auto-generates secure room credentials if not configured:
- **Room name**: If set to `"default"` or empty, replaced with `aurora-<random_hex>`.
- **Password**: If empty, replaced with a `secrets.token_urlsafe(32)` value.
- Both values are persisted to `config.json` via `ConfigManager.set()`.

### Encrypted MQTT Presence

When `webrtc.encrypt_signaling` is enabled, room presence announcements sent via MQTT are AEAD-encrypted using `aead_seal(k_sig, payload)`. Receiving peers attempt decryption first and fall back to plaintext parsing for backward compatibility.

### Room Invite CLI

The `scripts/config_updater.py` tool provides room invite management:

```bash
# Export an encrypted room invite (share with other instances)
python scripts/config_updater.py --room-export --passphrase "shared-secret"

# Import a room invite from another instance
python scripts/config_updater.py --room-import "<invite_base64>" --passphrase "shared-secret"

# Show current room configuration
python scripts/config_updater.py --room-info
```

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
- [x] Request signing/verification (implemented via AEAD-encrypted signaling and DataChannel auth gate)
- [x] Bilateral mesh pairing with consolidated trust stores
- [x] Peer Management API (approve, deny, update permissions, remove)
- [x] Smart heartbeat-based auth timeout
- [x] Typed permissions with 195 validated permission strings
- [x] Audit proxy routing via message bus
- [ ] Service health aggregation endpoint

## Related Documentation

- [Architecture Overview](../docs/ARCHITECTURE.md)
- [Messaging Architecture](../docs/MESSAGING_ARCHITECTURE.md)
- [Peer Pairing Flow](../docs/PEER_PAIRING_FLOW.md)
- [Mesh Pairing Fix Plan](../docs/MESH_PAIRING_FIX_PLAN.md)
- [Service Contracts](../app/shared/contracts/README.md)

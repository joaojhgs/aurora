# Gateway Service -- Agent Guide

> **Scope**: `app/services/gateway/` -- HTTP API, WebRTC, P2P mesh, ACL.
> **Parent**: [Services AGENTS.md](../AGENTS.md); [Root AGENTS.md](../../../AGENTS.md).
> **Related**: [Auth AGENTS.md](../auth/AGENTS.md); [Messaging AGENTS.md](../../messaging/AGENTS.md); [Contracts AGENTS.md](../../shared/contracts/AGENTS.md).

---

## Architecture Overview

The Gateway is the most complex service. It has four major subsystems:

```
gateway/
├── service.py              # Orchestrates all subsystems
├── fastapi_app.py          # FastAPI app factory
├── registry_aggregator.py  # Collects service contracts
├── route_generator.py      # Dynamic route creation
├── auth.py                 # HTTP auth middleware
├── auth_proxy.py           # Bus-backed auth for RTCClient
├── config.py               # Pydantic config models
├── dependencies.py         # FastAPI dependency injection
├── acl/                    # Access control (re-exports from shared)
│   ├── identity.py
│   ├── permissions.py
│   └── audit.py
├── mesh/                   # P2P mesh networking
│   ├── peer_registry.py    # Track connected peers
│   ├── routing_table.py    # Local vs remote routing
│   ├── peer_bridge.py      # Outbound RPC to peers
│   ├── negotiation.py      # Manifest exchange
│   ├── latency.py          # Ping/pong RTT
│   ├── version_compat.py   # Semver checking
│   ├── announcer.py        # Periodic re-announcement
│   └── models.py           # Mesh-specific models
├── webrtc/                 # WebRTC peer connections
│   ├── rtc_client.py       # Peer lifecycle, auth gate
│   ├── rpc.py              # JSON-RPC over DataChannels
│   └── signaling/
│       ├── base.py         # SignalingAdapter protocol
│       └── mqtt_client.py  # MQTT implementation
└── utils/
    └── crypto.py           # Room keys, AEAD, JWT
```

---

## CRITICAL RULES

### 1. Permission Scoping -- PascalCase

Permission strings are **case-sensitive**. Always use PascalCase matching the bus topic format:

```python
# CORRECT
scopes=["Auth.manage"]

# WRONG -- will silently fail permission checks
scopes=["auth.manage"]
```

### 2. Bypass Paths Use ANONYMOUS, Not SYSTEM

When auth is enabled but a path is bypassed (health, docs), assign `ANONYMOUS` identity (no permissions), not `SYSTEM` (full admin):

```python
# CORRECT
if auth.should_bypass(request.url.path):
    request.state.identity = ANONYMOUS

# WRONG -- gives unauthenticated requests full admin access
if auth.should_bypass(request.url.path):
    request.state.identity = SYSTEM
```

`SYSTEM` is only used when auth is entirely disabled.

### 3. Always Pass `method_type` to `identity.can()`

The RPC handler must include `method_type` from the contract metadata:

```python
# CORRECT
if perms_needed and not identity.can(*perms_needed, method_type=meta.method_type):
    raise PermissionError(...)

# WRONG -- type-based permissions (use/manage) won't work
if perms_needed and not identity.can(*perms_needed):
    raise PermissionError(...)
```

### 4. Use Typed Topic Constants in auth_proxy.py and service.py

Both `auth_proxy.py` and `service.py` make many bus calls. All MUST use `AuthMethods.*` constants:

```python
from app.shared.contracts.models.auth import AuthMethods

# CORRECT
await self._bus.request(AuthMethods.VALIDATE_TOKEN, request)
await bus.request(AuthMethods.MESH_UPSERT_PEER, upsert_request)

# WRONG
await self._bus.request("Auth.ValidateToken", request)
```

### 5. `Literal` Type Construction

When building Literal types from enum values for route generation, use `__getitem__`:

```python
# CORRECT -- creates Union of literal values
return Literal.__getitem__(tuple(enum_values))

# WRONG -- creates a literal *tuple* type
return Literal[tuple(enum_values)]
```

---

## Registry Aggregator

Collects service contracts to build the external API schema.

**Thread mode**: Reads from in-process `list_modules()` registry.
**Process mode**: Subscribes to `Gateway.ServiceAnnounce`, `SERVICE_DEPART`, `SERVICE_HEARTBEAT` bus events.

Key API: `get_services()`, `get_service(name)`, `get_external_methods()`, `get_registry_export()`.

Route regeneration: `RouteGenerator` subscribes to `on_registry_change()` callbacks and lazily rebuilds routes.

---

## Route Generator

Dynamically creates FastAPI routes from contract metadata:

1. Iterates `RegistryAggregator.get_external_methods()`
2. For each method: builds Pydantic input model from JSON schema
3. Creates an async endpoint that calls `bus.request(topic, payload)`
4. Attaches `create_scoped_auth_check(method_type=...)` as a security dependency

---

## Auth Middleware (`auth.py`)

The middleware runs before all HTTP handlers:

1. **Auth disabled**: `request.state.identity = SYSTEM` (full access)
2. **Bypass path** (`/health`, `/docs`, `/openapi.json`, `/api/auth/pairing/*`, `/api/auth/login`): `request.state.identity = ANONYMOUS`
3. **API key** (X-API-Key header): validates, assigns SYSTEM identity
4. **Bearer token**: validates via `Auth.ValidateToken` bus call, builds Identity from response
5. **No credentials**: returns 401

---

## BusAuthProxy (`auth_proxy.py`)

RTCClient can't import Auth service directly. `BusAuthProxy` provides the same interface but delegates to bus:

- `authenticate_token(token_str)` -> `Auth.ValidateToken` bus request
- `build_identity_from_token(token)` -> constructs `Identity` from cached validation data
- `get_principal(principal_id)` -> `Auth.GetPrincipal` bus request
- `upsert_mesh_peer(...)` -> `Auth.MeshUpsertPeer` bus request
- `save_inbound_credential(...)` -> `Auth.MeshSaveInboundCredential` bus request

**`_AuditDBProxy`**: Handles audit event storage. Routes via `Auth.StoreAuditEvent` bus request (NOT fire-and-forget event).

---

## WebRTC Lifecycle

### Signaling

`SignalingAdapter` protocol in `webrtc/signaling/base.py`:
- `connect()`, `join_room(app_id, room, peer_id)`, `send(channel, payload, to_peer)`
- `on_message(channel, handler)`, `leave()`, `close()`

`MQTTSignaling` (`mqtt_client.py`): MQTT topics `{root}/{app_id}/{room}/{channel}[/{to_peer}]`.

### Peer Connection Flow

1. MQTT presence announces peer
2. SDP offer/answer exchange via MQTT
3. WebRTC connection established
4. DataChannel opened for RPC

### Auth Gate

Anonymous peers can only send `auth`/`reauth` messages and call pairing/login RPC methods:

```python
_ANON_ALLOWED_RPC_PREFIXES = (
    AuthMethods.PAIRING_START,
    AuthMethods.PAIRING_CONNECT,
    AuthMethods.PAIRING_EXCHANGE,
    AuthMethods.LOGIN,
)
```

Unauthenticated peers have a heartbeat-based smart timeout (not fire-and-forget timer).

### RPC Handler (`rpc.py`)

JSON-RPC over DataChannels:
1. Parse message as JSON-RPC call
2. Look up method in RegistryAggregator
3. Check `identity.can(*perms_needed, method_type=meta.method_type)`
4. Forward to bus via `bus.request()` or `bus.publish()`
5. Return result via DataChannel

---

## Mesh Networking

### Components

| Component | Purpose |
|-----------|---------|
| `PeerRegistry` | Tracks peers, manifests, latency, stale detection; DB persistence via callbacks |
| `RoutingTable` | Resolves topics to local/remote based on config; uses PeerRegistry + VersionCompat |
| `PeerBridge` | Outbound RPC to remote peers via DataChannels; pending futures; pong routing |
| `LatencyMonitor` | Periodic ping/pong RTT measurement |
| `MeshAnnouncer` | Periodic manifest re-announcement |
| `Negotiation` | Manifest generation, parsing, ACK with compatibility report |
| `VersionCompat` | Semver comparison with exact/compatible/any policies |
| `MeshBus` | Transparent routing wrapper (in `app/messaging/mesh_bus.py`) |

### Mesh Flow

1. WebRTC connects peers -> authenticate -> `PeerRegistry.register_peer()`
2. Manifest exchange -> `PeerRegistry.update_manifest()`
3. `RoutingTable.resolve(topic)` uses `get_best_provider()` (lowest_latency, round_robin, random)
4. `MeshBus` routes commands to remote via `PeerBridge`, events with `mesh=True` forwarded

### DB Persistence

PeerRegistry callbacks (`on_peer_registered`, `on_peer_removed`, `on_peer_status_changed`) persist state via `AuthMethods.MESH_UPSERT_PEER` and `AuthMethods.MESH_UPDATE_PEER_CONNECTION` bus calls.

---

## Config Model (`config.py`)

Key settings classes:
- `APISettings` -- host, port, CORS, request_timeout, auth settings
- `WebRTCSettings` -- room, password, STUN/TURN, signaling
- `MQTTSettings` -- broker, port, topic_root, TLS, encrypt_signaling
- `PermissionSettings` -- default permissions for new devices/users
- `MeshConfig` -- enabled, node_name, services, ping interval
- `MeshServiceConfig` -- per-service: share, max_concurrent, allowed_peers, prefer, fallback, min_version

### token_secret Generation

`APISettings.token_secret` uses `Field(default_factory=_generate_token_secret)` which generates a cryptographically secure 64-char hex string.

`from_gateway_dict()` uses `gateway.get("token_secret") or _generate_token_secret()` -- the `or` ensures empty/missing values trigger generation instead of using insecure defaults.

---

## Crypto (`utils/crypto.py`)

- `derive_room_keys(room, password)` -- Scrypt (n=2^16) + HKDF -> `k_enc` (data), `k_sig` (signaling)
- `aead_seal(key, plaintext)` / `aead_open(key, ciphertext)` -- AES-GCM with random nonce
- `issue_token(payload, secret)` / `verify_token(token, secret)` -- HMAC-SHA256 JWT-style tokens

---

## Encrypted MQTT Presence

When `encrypt_signaling` is enabled in MQTT config, room presence is sealed:

```python
sealed = aead_seal(k_sig, json.dumps(presence_payload).encode())
```

Peers that don't have the room password cannot read presence messages.

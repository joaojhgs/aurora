# P2P Mesh Network — Full Implementation Plan

> **Goal**: Transform Aurora from a client→server model into a **true peer-to-peer mesh** where every Aurora instance is simultaneously a **server** (sharing its own services) and a **client** (consuming services from the network). Routing between local and remote execution is **transparent** to the caller — the message bus decides where to send messages based on configuration, peer availability, version compatibility, and latency.

---

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Architecture Overview](#architecture-overview)
3. [Design Principles](#design-principles)
4. [Data Model & Configuration](#phase-1-data-model--configuration)
5. [Peer Registry & Discovery](#phase-2-peer-registry--discovery)
6. [Negotiation Protocol](#phase-3-negotiation-protocol)
7. [Bidirectional Handshake](#phase-4-bidirectional-handshake)
8. [MeshBus (Transparent Routing Layer)](#phase-5-meshbus-transparent-routing-layer)
9. [Bus Integration & Service Transparency](#phase-6-bus-integration--service-transparency)
10. [Latency Measurement & Peer Selection](#phase-7-latency-measurement--peer-selection)
11. [Fault Tolerance & Failover](#phase-8-fault-tolerance--failover)
12. [Security & Permissions](#phase-9-security--permissions)
13. [Testing Strategy](#phase-10-testing-strategy)
14. [Migration & Backwards Compatibility](#migration--backwards-compatibility)
15. [File Inventory](#file-inventory)
16. [Implementation Checklist](#implementation-checklist)

---

## Problem Statement

### Current Limitations

1. **Unidirectional access**: Remote peers (devices) can call Aurora's services, but Aurora cannot call services on remote peers. The `RTCClient` + `RPCHandler` only handle **inbound** RPC calls.

2. **No resource sharing configuration**: There is no way for a principal to declare:
   - "I want to **share** my TTS service with the network."
   - "I want to **consume** the Orchestrator service from the network instead of running it locally."

3. **No transparent routing**: The `LocalBus` / `BullMQBus` only delivers to local subscribers. There is no mechanism to route a `bus.publish("TTS.Request", ...)` call to a remote peer instead of (or in addition to) the local TTS service.

4. **No negotiation protocol**: When peers connect, they authenticate but never exchange:
   - Which services they offer
   - What versions those services are
   - What contracts (input/output schemas) they support
   - Whether their service implementations are compatible

5. **No peer selection logic**: If multiple peers offer the same service, there is no mechanism to choose the best one (e.g., lowest latency).

### What Already Exists (Reusable)

| Component | Location | Reuse |
|---|---|---|
| **Contract Registry** | `app/shared/contracts/registry.py` | `ModuleContract` has `version`, `capabilities`, `depends_on`, `methods`. Already supports `export()` / `import_registry()` for serialization. |
| **Registry Aggregator** | `app/services/gateway/registry_aggregator.py` | Aggregates `ServiceAnnouncement` from local services. Can be extended to include remote peers. |
| **Service Announcement** | `app/shared/contracts/models/gateway.py` | `ServiceAnnouncement`, `MethodInfo`, `ServiceInfo` — already have version, capabilities, methods with schemas. |
| **WebRTC DataChannel** | `app/services/gateway/webrtc/rtc_client.py` | Already has bidirectional data channels, auth, and message routing. |
| **RPC Handler** | `app/services/gateway/webrtc/rpc.py` | Already handles `{"type": "call"}` messages, permission checks, and bus forwarding. |
| **Message Bus Protocol** | `app/messaging/bus.py` | `MessageBus` protocol with `publish()`, `request()`, `subscribe()`. The routing layer wraps this. |
| **Identity & Permissions** | `app/services/gateway/acl/` | Full RBAC with wildcard matching. Permissions already control what a peer can do. |
| **MQTT Signaling** | `app/services/gateway/webrtc/signaling/` | Peer discovery and WebRTC offer/answer exchange. |

---

## Architecture Overview

### High-Level Mesh Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Aurora Instance A                         │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ TTSService│  │STTService│  │Orchestr. │  │DBService │       │
│  │ (shared) │  │ (local)  │  │ (shared) │  │ (local)  │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       │              │              │              │             │
│       └──────────────┴──────────────┴──────────────┘             │
│                              │                                   │
│                     ┌────────┴────────┐                          │
│                     │    MeshBus      │  ← Routing decision layer│
│                     │                 │                          │
│                     │ For each topic: │                          │
│                     │  local OR       │                          │
│                     │  remote OR      │                          │
│                     │  both?          │                          │
│                     └───┬─────────┬───┘                          │
│                         │         │                              │
│              ┌──────────┘         └──────────┐                   │
│              ▼                               ▼                   │
│    ┌──────────────┐                ┌──────────────────┐          │
│    │  LocalBus /  │                │   PeerBridge     │          │
│    │  BullMQBus   │                │   (outbound RPC  │          │
│    │  (local      │                │    via WebRTC)   │          │
│    │   delivery)  │                └────────┬─────────┘          │
│    └──────────────┘                         │                    │
│                                    ┌────────┴─────────┐          │
│                                    │   RTCClient      │          │
│                                    │   (WebRTC mesh)  │          │
│                                    └────────┬─────────┘          │
└─────────────────────────────────────────────┤────────────────────┘
                                              │
                        WebRTC DataChannels    │
                        (AEAD encrypted)       │
                                              │
┌─────────────────────────────────────────────┤────────────────────┐
│                        Aurora Instance B     │                    │
│                                    ┌────────┴─────────┐          │
│                                    │   RTCClient      │          │
│                                    │   (WebRTC mesh)  │          │
│                                    └────────┬─────────┘          │
│                                    ┌────────┴─────────┐          │
│                                    │   PeerBridge     │          │
│                                    │   (inbound RPC   │          │
│                                    │    → local bus)  │          │
│                                    └────────┬─────────┘          │
│                              ┌──────────────┘                    │
│                              ▼                                   │
│                     ┌────────────────┐                           │
│                     │    MeshBus     │                           │
│                     └───┬────────┬───┘                           │
│                         │        │                               │
│  ┌──────────┐  ┌───────┘        └───────┐  ┌──────────┐        │
│  │ TTSService│  │STTService│  │Orchestr.│  │DBService │        │
│  │ (local)  │  │ (shared) │  │ (local) │  │ (local)  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Message Flow Example

**Scenario**: Instance A wants to use TTS from the network. Instance B shares its TTS.

```
Instance A                                              Instance B
┌────────────────┐                                     ┌────────────────┐
│ Orchestrator   │                                     │                │
│ "speak this"   │                                     │                │
│       │        │                                     │                │
│       ▼        │                                     │                │
│ bus.publish(   │                                     │                │
│  "TTS.Request",│                                     │                │
│   payload)     │                                     │                │
│       │        │                                     │                │
│       ▼        │                                     │                │
│ ┌──────────┐   │                                     │                │
│ │ MeshBus  │   │                                     │                │
│ │          │   │                                     │                │
│ │ Route?   │   │                                     │                │
│ │ TTS →    │   │                                     │                │
│ │  prefer: │   │                                     │                │
│ │  network │   │                                     │                │
│ │          │   │                                     │                │
│ │ Peer B   │   │     DataChannel RPC call            │ ┌──────────┐  │
│ │ has TTS  │───┼────────────────────────────────────►│ │PeerBridge│  │
│ │ v1.0.0   │   │   {"type":"call",                   │ │          │  │
│ │ ping=12ms│   │    "method":"TTS.Request",          │ │ Forward  │  │
│ └──────────┘   │    "params":{...}}                  │ │ to local │  │
│                │                                     │ │ bus      │  │
│                │                                     │ └────┬─────┘  │
│                │                                     │      │        │
│                │                                     │      ▼        │
│                │                                     │ ┌──────────┐  │
│                │                                     │ │ TTSService│  │
│                │                                     │ │ (local)  │  │
│                │                                     │ └────┬─────┘  │
│                │                                     │      │        │
│                │     DataChannel RPC response         │      │        │
│ ┌──────────┐   │◄────────────────────────────────────│──────┘        │
│ │ MeshBus  │   │   {"type":"result",                 │               │
│ │ (return) │   │    "id":"req1",                     │               │
│ └──────────┘   │    "result":{...}}                  │               │
│       │        │                                     │               │
│       ▼        │                                     │               │
│  Orchestrator  │                                     │               │
│  gets result   │                                     │               │
└────────────────┘                                     └────────────────┘
```

---

## Design Principles

1. **Symmetry**: Every Aurora instance is both server and client. There is no "primary" or "secondary" — only peers.
2. **Transparency**: Services never know if they're being called locally or remotely. The bus handles routing.
3. **Configuration-driven**: What to share and what to consume is purely a configuration concern.
4. **Permission-gated**: A peer can only use a remote service if the remote peer has granted the calling peer permission to use it.
5. **Version-aware**: The negotiation protocol ensures only compatible service versions are used.
6. **Latency-optimal**: When multiple peers offer the same service, the one with the lowest measured latency wins.
7. **Fail-safe**: If a remote service becomes unavailable, the MeshBus falls back to local (if available) or returns an error.
8. **Incremental**: The mesh layer is optional. Setting `mesh.enabled = false` preserves the existing single-instance behavior with zero overhead.

---

## Phase 1: Data Model & Configuration

### 1.1 Mesh Configuration Schema

**File**: `app/services/gateway/config.py` (extend `Settings`)

```python
class ServiceSharingConfig(BaseModel):
    """Per-service sharing configuration."""
    share: bool = False                    # Whether to share this service with the network
    max_concurrent: int = 10               # Max concurrent remote calls to this service
    allowed_peers: list[str] | None = None # Specific peer IDs allowed (None = all authenticated)


class ServiceRoutingConfig(BaseModel):
    """Per-service routing preference."""
    prefer: str = "local"       # "local" | "network" | "network_only" | "local_only"
    fallback: str = "local"     # "local" | "network" | "error" | "none"
    min_version: str | None = None  # Minimum required version (semver)
    required_capabilities: list[str] = []  # Capabilities the remote service must have


class MeshConfig(BaseModel):
    """Mesh network configuration."""
    enabled: bool = False
    node_name: str = ""                    # Human-readable name for this node
    sharing: dict[str, ServiceSharingConfig] = {}  # Module name → sharing config
    routing: dict[str, ServiceRoutingConfig] = {}  # Module name → routing config
    version_policy: str = "compatible"     # "exact" | "compatible" | "any"
    peer_selection: str = "lowest_latency" # "lowest_latency" | "round_robin" | "random"
    ping_interval_s: float = 30.0          # How often to measure peer latency
    registry_announce_interval_s: float = 60.0  # How often to re-announce registry
    stale_peer_timeout_s: float = 120.0    # Mark peer stale after this many seconds
```

**Configuration example** (`config.json`):
```json
{
    "gateway": {
        "mesh": {
            "enabled": true,
            "node_name": "Living Room Hub",
            "sharing": {
                "TTS": { "share": true, "max_concurrent": 5 },
                "STT": { "share": false },
                "Orchestrator": { "share": true, "max_concurrent": 2 },
                "DB": { "share": false }
            },
            "routing": {
                "TTS": { "prefer": "local", "fallback": "network" },
                "Orchestrator": {
                    "prefer": "network",
                    "fallback": "local",
                    "min_version": "1.0.0",
                    "required_capabilities": ["streaming"]
                }
            },
            "version_policy": "compatible",
            "peer_selection": "lowest_latency",
            "ping_interval_s": 30
        }
    }
}
```

### 1.2 Peer Capability Model

**File**: `app/services/gateway/mesh/models.py` (new)

```python
class PeerServiceInfo(BaseModel):
    """A service offered by a remote peer."""
    module: str                          # e.g., "TTS"
    version: str                         # e.g., "1.0.0"
    capabilities: list[str] = []         # e.g., ["streaming", "multilingual"]
    methods: list[MethodInfo] = []       # Available methods with schemas
    max_concurrent: int = 10             # Max concurrent calls the peer will accept
    digest: str = ""                     # SHA-256 of the serialized contract (for quick equality)


class PeerManifest(BaseModel):
    """Complete capability manifest sent during negotiation."""
    peer_id: str                         # Unique peer identifier
    node_name: str = ""                  # Human-readable name
    aurora_version: str = ""             # Aurora version for broad compatibility
    shared_services: list[PeerServiceInfo] = []  # Services this peer is sharing
    timestamp: str = ""                  # ISO timestamp of the manifest


class PeerState(BaseModel):
    """Runtime state of a connected peer in the mesh."""
    peer_id: str
    node_name: str = ""
    identity: Identity | None = None     # Resolved RBAC identity
    manifest: PeerManifest | None = None # Their shared services
    latency_ms: float = float("inf")     # Last measured RTT in ms
    last_ping: float = 0                 # Unix timestamp of last ping
    last_manifest: float = 0             # Unix timestamp of last manifest
    active_calls: int = 0                # Current in-flight calls to this peer
    status: str = "connected"            # "connected" | "authenticated" | "negotiated" | "stale"
```

### 1.3 Routing Table Model

**File**: `app/services/gateway/mesh/routing_table.py` (new)

```python
class RouteEntry:
    """A single route for a service topic."""
    peer_id: str                  # Which peer to route to
    module: str                   # Service module name
    version: str                  # Service version
    latency_ms: float             # Measured latency
    capacity: int                 # Remaining capacity (max_concurrent - active_calls)
    digest: str                   # Contract digest for compatibility check


class RoutingTable:
    """Maintains the routing table for the mesh.
    
    For each topic (e.g., "TTS.Request"), maintains a list of
    candidate routes (local + remote peers), sorted by preference.
    """
    
    def resolve(self, topic: str, config: ServiceRoutingConfig) -> RouteDecision:
        """Determine where to route a message.
        
        Returns:
            RouteDecision with target="local" or target="remote" + peer_id
        """
        ...
    
    def update_peer(self, peer_id: str, manifest: PeerManifest) -> None:
        """Update routing table when a peer announces services."""
        ...
    
    def remove_peer(self, peer_id: str) -> None:
        """Remove all routes for a departing peer."""
        ...
    
    def update_latency(self, peer_id: str, latency_ms: float) -> None:
        """Update latency measurement for a peer."""
        ...
```

---

## Phase 2: Peer Registry & Discovery

### 2.1 PeerRegistry Service

**File**: `app/services/gateway/mesh/peer_registry.py` (new)

The `PeerRegistry` is the central authority for tracking connected peers and their capabilities. It is **not** a separate Aurora service — it lives inside the Gateway as a component (like `RegistryAggregator`).

**Responsibilities**:
- Maintain the list of connected, authenticated, and negotiated peers
- Store each peer's manifest (shared services)
- Track latency measurements
- Emit events when peers join, leave, or update their manifests
- Provide query APIs for the routing table

```python
class PeerRegistry:
    def __init__(self, bus: MessageBus, mesh_config: MeshConfig):
        self._bus = bus
        self._config = mesh_config
        self._peers: dict[str, PeerState] = {}
        self._lock = asyncio.Lock()
    
    async def register_peer(self, peer_id: str, identity: Identity) -> None:
        """Called when a peer is authenticated."""
        ...
    
    async def update_manifest(self, peer_id: str, manifest: PeerManifest) -> None:
        """Called when a peer sends its capability manifest."""
        ...
    
    async def remove_peer(self, peer_id: str) -> None:
        """Called when a peer disconnects."""
        ...
    
    async def update_latency(self, peer_id: str, latency_ms: float) -> None:
        """Called after a ping/pong exchange."""
        ...
    
    def get_providers(self, module: str) -> list[PeerState]:
        """Get all peers that share a given service module.
        
        Filters by:
        - Peer has the module in their manifest
        - Peer has granted us permission to use it
        - Peer is in 'negotiated' status (not stale)
        """
        ...
    
    def get_best_provider(
        self, 
        module: str, 
        routing_config: ServiceRoutingConfig,
        version_policy: str,
    ) -> PeerState | None:
        """Get the best peer for a service based on routing policy.
        
        Selection criteria:
        1. Filter by version compatibility
        2. Filter by required capabilities
        3. Filter by available capacity
        4. Sort by latency (or round-robin, etc.)
        5. Return best match
        """
        ...
```

### 2.2 Integration with RegistryAggregator

The existing `RegistryAggregator` aggregates **local** service registries. The `PeerRegistry` handles **remote** peer services. The `RoutingTable` combines both to make routing decisions.

```
┌─────────────────────┐     ┌──────────────────────┐
│ RegistryAggregator  │     │    PeerRegistry       │
│ (local services)    │     │ (remote peer services)│
└─────────┬───────────┘     └──────────┬────────────┘
          │                            │
          └────────────┬───────────────┘
                       │
              ┌────────┴────────┐
              │  RoutingTable   │
              │  (combined)     │
              └────────┬────────┘
                       │
              ┌────────┴────────┐
              │    MeshBus      │
              │ (routes msgs)   │
              └─────────────────┘
```

---

## Phase 3: Negotiation Protocol

### 3.1 Protocol Messages (over DataChannel)

The negotiation protocol adds new message types to the existing DataChannel JSON-RPC protocol:

| Message Type | Direction | Purpose |
|---|---|---|
| `manifest` | Both → Both | Peer announces its shared service catalog |
| `manifest_request` | Either → Either | Request the other peer's manifest |
| `manifest_ack` | Receiver → Sender | Acknowledge receipt of manifest, with compatibility report |
| `ping` | Either → Either | Latency measurement (timestamp) |
| `pong` | Responder → Initiator | Latency measurement response (echo timestamp) |
| `call` | Either → Either | RPC call (already exists, now bidirectional) |
| `result` | Responder → Caller | RPC response (already exists) |
| `error` | Responder → Caller | RPC error (already exists) |
| `capacity_update` | Either → Either | Notify peer of capacity change |

### 3.2 Manifest Exchange Flow

After mutual authentication, both peers exchange manifests:

```
Peer A                                              Peer B
  │                                                    │
  │ ── auth ──►                                        │
  │                                   ◄── auth ────    │
  │                                                    │
  │ Both authenticated                                 │
  │                                                    │
  │ ── manifest ──────────────────────────────────────►│
  │   {                                                │
  │     "type": "manifest",                            │
  │     "peer_id": "A",                                │
  │     "node_name": "Living Room Hub",                │
  │     "aurora_version": "1.0.0",                     │
  │     "shared_services": [                           │
  │       {                                            │
  │         "module": "TTS",                           │
  │         "version": "1.0.0",                        │
  │         "capabilities": ["piper", "streaming"],    │
  │         "methods": [...],                          │
  │         "max_concurrent": 5,                       │
  │         "digest": "abc123..."                      │
  │       }                                            │
  │     ]                                              │
  │   }                                                │
  │                                                    │
  │◄───────────────────────────────── manifest ────    │
  │   {                                                │
  │     "type": "manifest",                            │
  │     "peer_id": "B",                                │
  │     "node_name": "Office Node",                    │
  │     "shared_services": [                           │
  │       {                                            │
  │         "module": "Orchestrator",                  │
  │         "version": "1.2.0",                        │
  │         "capabilities": ["streaming", "tools"],    │
  │         "methods": [...],                          │
  │         "digest": "def456..."                      │
  │       },                                           │
  │       {                                            │
  │         "module": "STT",                           │
  │         "version": "1.0.0",                        │
  │         "capabilities": ["whisper", "realtime"],   │
  │         "methods": [...],                          │
  │         "digest": "ghi789..."                      │
  │       }                                            │
  │     ]                                              │
  │   }                                                │
  │                                                    │
  │ ── manifest_ack ──────────────────────────────────►│
  │   {                                                │
  │     "type": "manifest_ack",                        │
  │     "compatible_services": ["Orchestrator"],       │
  │     "incompatible_services": [],                   │
  │     "unused_services": ["STT"]                     │
  │   }                                                │
  │                                                    │
  │◄───────────────────────────────── manifest_ack ──  │
  │   {                                                │
  │     "type": "manifest_ack",                        │
  │     "compatible_services": ["TTS"],                │
  │     "incompatible_services": [],                   │
  │     "unused_services": []                          │
  │   }                                                │
  │                                                    │
  │ ── ping ──────────────────────────────────────────►│
  │   { "type": "ping", "ts": 1706000000.123 }        │
  │◄──────────────────────────────────────── pong ──   │
  │   { "type": "pong", "ts": 1706000000.123 }        │
  │                                                    │
  │ Both peers update routing tables                   │
  │ Mesh is now active                                 │
```

### 3.3 Version Compatibility Algorithm

**File**: `app/services/gateway/mesh/version_compat.py` (new)

Uses semantic versioning:

```python
def is_compatible(
    local_version: str,      # The version we want to call
    remote_version: str,     # The version the peer offers
    policy: str,             # "exact", "compatible", "any"
    min_version: str | None, # Optional minimum version constraint
) -> bool:
    """Check if a remote service version is compatible.
    
    Policies:
    - "exact": versions must match exactly
    - "compatible": major version must match, remote >= local
    - "any": any version is accepted
    """
```

### 3.4 Contract Compatibility Check

Beyond version, we also verify that the method signatures (input/output schemas) are compatible:

```python
def check_contract_compatibility(
    local_digest: str,       # SHA-256 of local contract
    remote_digest: str,      # SHA-256 of remote contract
    strict: bool = False,    # If True, digests must match exactly
) -> bool:
    """Quick compatibility check via contract digest.
    
    If digests match, contracts are identical.
    If not, a deeper schema comparison may be needed.
    """
```

The `digest` field in `PeerServiceInfo` is the SHA-256 of the `MethodContract` serialization — this is already produced by `registry.export()`.

---

## Phase 4: Bidirectional Handshake

### 4.1 Extended Pairing Flow

The existing pairing flow (start → poll → approve → exchange) establishes **unidirectional** trust: the gateway trusts the device. For P2P mesh, we need **bidirectional** trust.

**New flow**: After the standard pairing exchange, the newly paired device can optionally initiate a **mesh handshake** that establishes mutual trust:

```
Step 1: Standard pairing (existing)
  Device → Gateway: POST /pairing/start
  Admin → Gateway:  POST /pairing/approve
  Device → Gateway: POST /pairing/exchange → gets token

Step 2: WebRTC connection (existing)
  Device → MQTT → Gateway: offer/answer exchange
  Device → DataChannel: {"type": "auth", "token": "<device_token>"}
  Gateway → DataChannel: {"type": "auth", "token": "<gateway_system_token>"}

Step 3: Manifest exchange (NEW)
  Both sides exchange manifests automatically after mutual auth
  Gateway → DataChannel: {"type": "manifest", ...}
  Device → DataChannel: {"type": "manifest", ...}
  
  Both sides send manifest_ack
  Both sides perform ping/pong

Step 4: Mesh is active
  Both peers can now call each other's shared services
```

### 4.2 Changes to RTCClient

**File**: `app/services/gateway/webrtc/rtc_client.py` (modify)

After successful authentication of a peer, trigger manifest exchange:

```python
# In validate_peer() after successful auth:
async def validate_peer() -> None:
    token = await self._auth_service.authenticate_token(token_str)
    if token:
        identity = await self._auth_service.build_identity_from_token(token, source="webrtc_peer")
        self._peer_acl[peer] = identity
        self._peer_tokens[peer] = token
        
        # Cancel auth timeout
        timeout_task = self._peer_timeout_tasks.pop(peer, None)
        if timeout_task:
            timeout_task.cancel()
        
        # NEW: Initiate mesh negotiation if mesh is enabled
        if self._mesh_enabled:
            await self._send_manifest(peer)
            await self._send_ping(peer)
```

### 4.3 PeerBridge (Outbound RPC)

**File**: `app/services/gateway/mesh/peer_bridge.py` (new)

The `PeerBridge` is the component that sends RPC calls **outbound** to remote peers and returns the results. It is the counterpart of `RPCHandler` (which handles **inbound** calls).

```python
class PeerBridge:
    """Sends RPC calls to remote peers over WebRTC DataChannels."""
    
    def __init__(self, rtc_client: RTCClient, peer_registry: PeerRegistry):
        self._rtc_client = rtc_client
        self._registry = peer_registry
        self._pending_calls: dict[str, asyncio.Future] = {}
    
    async def call(
        self,
        peer_id: str,
        topic: str,
        payload: BaseModel,
        timeout: float = 30.0,
    ) -> QueryResult:
        """Send an RPC call to a remote peer and wait for the response.
        
        Args:
            peer_id: Target peer
            topic: Bus topic (e.g., "TTS.Request")
            payload: Message payload
            timeout: Response timeout
            
        Returns:
            QueryResult with the response
        """
        req_id = str(uuid.uuid4())
        fut = asyncio.get_event_loop().create_future()
        self._pending_calls[req_id] = fut
        
        # Send RPC call via DataChannel
        msg = {
            "type": "call",
            "id": req_id,
            "method": topic,
            "params": payload.model_dump(mode="json"),
        }
        self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
        
        try:
            result = await asyncio.wait_for(fut, timeout)
            return result
        except TimeoutError:
            self._pending_calls.pop(req_id, None)
            return QueryResult(ok=False, error=f"Remote call to {peer_id} timed out")
    
    def on_response(self, peer_id: str, msg: dict) -> None:
        """Handle response from a remote peer."""
        req_id = msg.get("id")
        if req_id and req_id in self._pending_calls:
            fut = self._pending_calls.pop(req_id)
            if msg.get("type") == "result":
                fut.set_result(QueryResult(ok=True, data=msg.get("result")))
            elif msg.get("type") == "error":
                error = msg.get("error", {})
                fut.set_result(QueryResult(
                    ok=False, 
                    error=error.get("message", "Remote error")
                ))
```

---

## Phase 5: MeshBus (Transparent Routing Layer)

### 5.1 MeshBus Implementation

**File**: `app/messaging/mesh_bus.py` (new)

The `MeshBus` wraps the underlying `LocalBus` or `BullMQBus` and adds transparent routing to remote peers.

```python
class MeshBus:
    """Message bus with transparent mesh routing.
    
    Wraps an underlying bus (LocalBus/BullMQBus) and adds the ability
    to route messages to remote peers based on configuration.
    
    For each publish/request:
    1. Check routing config for the topic's module
    2. If prefer=local → deliver locally
    3. If prefer=network → find best remote peer, send via PeerBridge
    4. If prefer=network but no peer available → check fallback
    5. If prefer=local and local fails → check fallback
    
    Implements the same MessageBus protocol, so all existing services
    work without modification.
    """
    
    def __init__(
        self,
        inner_bus: MessageBus,          # LocalBus or BullMQBus
        routing_table: RoutingTable,
        peer_bridge: PeerBridge,
        mesh_config: MeshConfig,
    ):
        self._inner = inner_bus
        self._routing_table = routing_table
        self._peer_bridge = peer_bridge
        self._config = mesh_config
    
    async def publish(
        self,
        topic: str,
        message: BaseModel,
        *,
        event: bool = True,
        priority: int = 50,
        origin: str = "internal",
        **kwargs,
    ) -> None:
        """Publish with mesh routing.
        
        Events are ALWAYS delivered locally (broadcast).
        Commands may be routed to remote peers based on config.
        """
        # Events always go local (they're broadcasts for local state)
        if event:
            await self._inner.publish(topic, message, event=True, 
                                       priority=priority, origin=origin, **kwargs)
            return
        
        # For commands, check routing
        module = topic.split(".")[0] if "." in topic else topic
        routing_config = self._config.routing.get(module)
        
        if not routing_config or routing_config.prefer == "local":
            # Local first
            await self._inner.publish(topic, message, event=False,
                                       priority=priority, origin=origin, **kwargs)
            return
        
        if routing_config.prefer in ("network", "network_only"):
            # Try remote peer
            route = self._routing_table.resolve(topic, routing_config)
            if route and route.target == "remote":
                # Route to remote peer via PeerBridge
                result = await self._peer_bridge.call(
                    route.peer_id, topic, message
                )
                # For fire-and-forget commands, we don't need the result
                return
            
            # No remote peer available
            if routing_config.fallback == "local" and routing_config.prefer != "network_only":
                await self._inner.publish(topic, message, event=False,
                                           priority=priority, origin=origin, **kwargs)
            elif routing_config.fallback == "error":
                raise RuntimeError(f"No remote peer available for {topic}")
    
    async def request(
        self,
        topic: str,
        message: BaseModel,
        *,
        priority: int = 50,
        origin: str = "internal",
        timeout: float = 5.0,
        **kwargs,
    ) -> QueryResult:
        """Request with mesh routing.
        
        Same routing logic as publish, but returns a result.
        """
        module = topic.split(".")[0] if "." in topic else topic
        routing_config = self._config.routing.get(module)
        
        if not routing_config or routing_config.prefer == "local":
            return await self._inner.request(topic, message, priority=priority,
                                              origin=origin, timeout=timeout, **kwargs)
        
        if routing_config.prefer in ("network", "network_only"):
            route = self._routing_table.resolve(topic, routing_config)
            if route and route.target == "remote":
                return await self._peer_bridge.call(
                    route.peer_id, topic, message, timeout=timeout
                )
            
            # Fallback
            if routing_config.fallback == "local" and routing_config.prefer != "network_only":
                return await self._inner.request(topic, message, priority=priority,
                                                  origin=origin, timeout=timeout, **kwargs)
            
            return QueryResult(ok=False, error=f"No remote peer available for {topic}")
        
        # Default: local
        return await self._inner.request(topic, message, priority=priority,
                                          origin=origin, timeout=timeout, **kwargs)
    
    def subscribe(self, topic: str, handler: Handler) -> None:
        """Subscribe always goes to the inner bus (local delivery)."""
        self._inner.subscribe(topic, handler)
    
    # Delegate lifecycle methods
    async def start(self) -> None:
        await self._inner.start()
    
    async def stop(self) -> None:
        await self._inner.stop()
```

### 5.2 MeshBus Initialization

**File**: `app/services/supervisor.py` (modify)

When mesh is enabled, the Supervisor wraps the inner bus with MeshBus:

```python
async def _initialize_local_bus(self) -> None:
    inner_bus = LocalBus(...)
    await inner_bus.start()
    
    # Check if mesh is enabled
    mesh_config = self._get_mesh_config()
    if mesh_config and mesh_config.enabled:
        # MeshBus wraps the inner bus
        # PeerBridge and RoutingTable are initialized later by GatewayService
        self._inner_bus = inner_bus
        self._bus = MeshBus(
            inner_bus=inner_bus,
            routing_table=RoutingTable(),
            peer_bridge=None,  # Set later by Gateway
            mesh_config=mesh_config,
        )
    else:
        self._bus = inner_bus
```

**Alternative (preferred)**: Initialize MeshBus in `GatewayService.on_start()` and **replace** the global bus singleton. This keeps the Supervisor simple and puts all mesh logic in the Gateway where it belongs:

```python
# In GatewayService.on_start():
if mesh_config.enabled:
    mesh_bus = MeshBus(
        inner_bus=self.bus,
        routing_table=self._routing_table,
        peer_bridge=self._peer_bridge,
        mesh_config=mesh_config,
    )
    # Replace the global bus singleton
    set_bus(mesh_bus)
    self._mesh_bus = mesh_bus
```

---

## Phase 6: Bus Integration & Service Transparency

### 6.1 Inbound Call Handling (Remote → Local)

When a remote peer calls one of our shared services, the `RPCHandler` already handles this:

1. Remote peer sends `{"type": "call", "method": "TTS.Request", ...}` via DataChannel.
2. `RPCHandler._handle_call()` looks up the method in the registry.
3. Checks permissions against the peer's `Identity`.
4. Forwards to the **local** bus via `self._bus.request(topic, params)`.
5. Returns the result via DataChannel.

**Change needed**: Add a **sharing gate** to the RPCHandler that checks whether the called service is configured as `share: true` in the mesh config:

```python
# In RPCHandler._handle_call():
# NEW: Check if this service is shared
if self._mesh_config and self._mesh_config.enabled:
    module = method_name.split(".")[0]
    sharing = self._mesh_config.sharing.get(module)
    if not sharing or not sharing.share:
        self._send_error(req_id, 403, f"Service {module} is not shared")
        return
    if sharing.max_concurrent > 0:
        # Check concurrent call limit
        active = self._active_remote_calls.get(module, 0)
        if active >= sharing.max_concurrent:
            self._send_error(req_id, 429, f"Service {module} at capacity")
            return
```

### 6.2 Outbound Call Handling (Local → Remote)

This is handled by `MeshBus` (Phase 5). When a local service publishes to a topic:

1. `MeshBus.publish()` or `MeshBus.request()` intercepts the call.
2. Extracts the module name from the topic (e.g., `"TTS"` from `"TTS.Request"`).
3. Looks up the routing config for that module.
4. If `prefer: "network"`, asks `RoutingTable` for the best remote peer.
5. `PeerBridge.call()` sends the RPC via DataChannel.
6. Result flows back through the future.

### 6.3 Bidirectional DataChannel Messages

**File**: `app/services/gateway/webrtc/rtc_client.py` (modify)

The `on_message` handler in `_ensure_pc` needs to handle new message types and route responses back to `PeerBridge`:

```python
# In on_message handler:
if obj.get("type") == "auth":
    # ... existing auth handling ...
elif obj.get("type") == "reauth":
    # ... existing reauth handling ...
elif obj.get("type") == "manifest":
    asyncio.create_task(self._on_peer_manifest(peer, obj))
elif obj.get("type") == "manifest_request":
    asyncio.create_task(self._send_manifest(peer))
elif obj.get("type") == "manifest_ack":
    asyncio.create_task(self._on_manifest_ack(peer, obj))
elif obj.get("type") == "ping":
    self._send_pong(peer, obj)
elif obj.get("type") == "pong":
    self._on_pong(peer, obj)
elif obj.get("type") in ("result", "error"):
    # Response to an outbound call — route to PeerBridge
    if self._peer_bridge:
        self._peer_bridge.on_response(peer, obj)
elif obj.get("type") == "call":
    # Inbound RPC call — existing handler
    asyncio.create_task(handler.on_message(text))
```

---

## Phase 7: Latency Measurement & Peer Selection

### 7.1 Ping/Pong Protocol

**File**: `app/services/gateway/mesh/latency.py` (new)

```python
class LatencyMonitor:
    """Periodically measures RTT to all connected peers."""
    
    def __init__(self, rtc_client: RTCClient, peer_registry: PeerRegistry, interval_s: float):
        self._rtc_client = rtc_client
        self._registry = peer_registry
        self._interval = interval_s
        self._pending_pings: dict[str, tuple[str, float]] = {}  # ping_id → (peer_id, send_time)
        self._task: asyncio.Task | None = None
    
    async def start(self) -> None:
        """Start periodic ping task."""
        self._task = asyncio.create_task(self._ping_loop())
    
    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
    
    async def _ping_loop(self) -> None:
        while True:
            await asyncio.sleep(self._interval)
            for peer_id in list(self._rtc_client._pcs.keys()):
                await self._send_ping(peer_id)
    
    async def _send_ping(self, peer_id: str) -> None:
        ping_id = str(uuid.uuid4())[:8]
        ts = time.monotonic()
        self._pending_pings[ping_id] = (peer_id, ts)
        msg = {"type": "ping", "id": ping_id, "ts": ts}
        self._rtc_client.send_to_peer(peer_id, json.dumps(msg))
    
    def on_pong(self, peer_id: str, msg: dict) -> None:
        ping_id = msg.get("id")
        if ping_id and ping_id in self._pending_pings:
            stored_peer_id, send_time = self._pending_pings.pop(ping_id)
            if stored_peer_id == peer_id:
                rtt_ms = (time.monotonic() - send_time) * 1000
                asyncio.create_task(
                    self._registry.update_latency(peer_id, rtt_ms)
                )
```

### 7.2 Peer Selection Algorithm

**File**: `app/services/gateway/mesh/routing_table.py`

```python
def _select_peer(
    self,
    candidates: list[PeerState],
    policy: str,  # "lowest_latency" | "round_robin" | "random"
) -> PeerState | None:
    """Select the best peer from candidates.
    
    Candidates are pre-filtered for:
    - Version compatibility
    - Required capabilities
    - Available capacity
    - Permission grants
    """
    if not candidates:
        return None
    
    if policy == "lowest_latency":
        return min(candidates, key=lambda p: p.latency_ms)
    elif policy == "round_robin":
        # Use a counter to rotate through candidates
        self._rr_counter = (self._rr_counter + 1) % len(candidates)
        return candidates[self._rr_counter]
    elif policy == "random":
        return random.choice(candidates)
    
    return candidates[0]
```

---

## Phase 8: Fault Tolerance & Failover

### 8.1 Automatic Fallback

When a remote call fails (timeout, peer disconnect, error), the `MeshBus` automatically falls back based on the `fallback` config:

```python
async def request(self, topic, message, **kwargs):
    route = self._routing_table.resolve(topic, routing_config)
    
    if route and route.target == "remote":
        try:
            result = await self._peer_bridge.call(route.peer_id, topic, message)
            if result.ok:
                return result
        except Exception as e:
            log_warning(f"Remote call to {route.peer_id} failed: {e}")
        
        # Remote failed — check fallback
        if routing_config.fallback == "local":
            log_info(f"Falling back to local for {topic}")
            return await self._inner.request(topic, message, **kwargs)
        elif routing_config.fallback == "network":
            # Try next best peer
            next_route = self._routing_table.resolve(
                topic, routing_config, exclude=[route.peer_id]
            )
            if next_route and next_route.target == "remote":
                return await self._peer_bridge.call(next_route.peer_id, topic, message)
    
    # No route or all failed
    return await self._inner.request(topic, message, **kwargs)
```

### 8.2 Stale Peer Detection

The `LatencyMonitor` (ping loop) doubles as a health check. If a peer hasn't responded to pings within `stale_peer_timeout_s`, it is marked as `"stale"` and excluded from routing:

```python
async def _check_stale_peers(self) -> None:
    now = time.monotonic()
    for peer_id, state in list(self._peers.items()):
        if now - state.last_ping > self._config.stale_peer_timeout_s:
            state.status = "stale"
            self._routing_table.remove_peer(peer_id)
            log_warning(f"Peer {peer_id} marked stale (no ping response)")
```

### 8.3 Re-announcement on Reconnect

When a stale peer reconnects (or a disconnected peer re-establishes a WebRTC connection), the negotiation protocol is re-executed: auth → manifest exchange → ping → routing table update.

---

## Phase 9: Security & Permissions

### 9.1 Permission Model for Mesh

The existing RBAC system naturally extends to mesh:

- **Sharing a service**: The admin configures which services to share via `mesh.sharing`. No new permissions needed — this is a node-level config, not a per-user setting.
- **Using a remote service**: The remote peer must have permissions that match the `required_perms` on the method contract. The **remote** `RPCHandler` checks the caller's identity.
- **Token scopes**: The token issued during pairing controls what the remote peer can do on this node. If Peer A has `scopes: ["TTS.*"]`, they can only call TTS methods on Peer B.

### 9.2 Additional Permission Grants

For the mesh, we add a new permission namespace:

```
mesh.use.<Module>     — Permission to use a remote service
mesh.share.<Module>   — Permission to share a local service (admin-only config)
```

Example:
- Peer A's token has `scopes: ["TTS.*", "mesh.use.TTS"]` → can use remote TTS
- Peer B's mesh config has `sharing.TTS.share: true` → shares its TTS
- When A calls B's TTS, B's RPCHandler checks A's identity has `TTS.*` permission

### 9.3 Sharing Allowlist

Each `ServiceSharingConfig` has an optional `allowed_peers` list:

```json
{
    "sharing": {
        "Orchestrator": {
            "share": true,
            "allowed_peers": ["peer-id-1", "peer-id-2"]
        }
    }
}
```

If `allowed_peers` is `null`, all authenticated peers can use the service. Otherwise, only listed peers can.

---

## Phase 10: Testing Strategy

### 10.1 Unit Tests

| Test File | Tests |
|---|---|
| `tests/unit/gateway/test_mesh_models.py` | PeerManifest, PeerState, PeerServiceInfo serialization |
| `tests/unit/gateway/test_routing_table.py` | Route resolution with various configs, fallback logic |
| `tests/unit/gateway/test_version_compat.py` | Version compatibility checks (exact, compatible, any) |
| `tests/unit/gateway/test_peer_registry.py` | Peer registration, manifest updates, stale detection |
| `tests/unit/gateway/test_mesh_bus.py` | MeshBus routing decisions, fallback behavior |
| `tests/unit/gateway/test_peer_bridge.py` | Outbound RPC call/response handling |
| `tests/unit/gateway/test_latency_monitor.py` | Ping/pong timing, latency updates |
| `tests/unit/gateway/test_negotiation.py` | Manifest exchange, ack generation, compatibility reports |

### 10.2 Integration Tests

| Test File | Tests |
|---|---|
| `tests/integration/test_mesh_routing.py` | End-to-end: local service call routed to "remote" (mocked peer) |
| `tests/integration/test_mesh_failover.py` | Remote fails → fallback to local |
| `tests/integration/test_manifest_exchange.py` | Two RTCClients exchange manifests and build routing tables |
| `tests/integration/test_mesh_permissions.py` | Permission-gated remote calls |
| `tests/integration/test_mesh_config_reload.py` | Hot-reload of mesh config updates routing |

### 10.3 Performance Tests

| Test File | Tests |
|---|---|
| `tests/performance/test_mesh_latency.py` | Overhead of MeshBus routing decision |
| `tests/performance/test_mesh_throughput.py` | Messages/second through MeshBus vs raw LocalBus |

---

## Migration & Backwards Compatibility

### Zero-Overhead Default

When `mesh.enabled = false` (default):
- `MeshBus` is not instantiated.
- The raw `LocalBus` / `BullMQBus` is used directly.
- No negotiation protocol messages are sent.
- No latency monitoring.
- **Zero overhead** compared to current behavior.

### Gradual Opt-In

1. **Step 1**: Deploy Aurora with mesh disabled (default). Everything works as before.
2. **Step 2**: Enable mesh on one node. It advertises shared services but no peers to connect to yet.
3. **Step 3**: Enable mesh on a second node. After pairing and connecting via WebRTC, they exchange manifests and begin mesh routing.
4. **Step 4**: Configure routing preferences to start offloading specific services to the network.

### Config Migration

Add `mesh` section to `config.json` with sensible defaults (all disabled). Existing configs without `mesh` continue to work because `MeshConfig.enabled = False` by default.

---

## File Inventory

### New Files

| File | Purpose |
|---|---|
| `app/services/gateway/mesh/__init__.py` | Package init |
| `app/services/gateway/mesh/models.py` | Pydantic models: PeerManifest, PeerState, PeerServiceInfo, RouteDecision |
| `app/services/gateway/mesh/peer_registry.py` | PeerRegistry: tracks connected peers and their capabilities |
| `app/services/gateway/mesh/routing_table.py` | RoutingTable: resolves topic → local or remote peer |
| `app/services/gateway/mesh/peer_bridge.py` | PeerBridge: sends outbound RPC calls via DataChannel |
| `app/services/gateway/mesh/version_compat.py` | Version compatibility checking (semver) |
| `app/services/gateway/mesh/latency.py` | LatencyMonitor: periodic ping/pong measurement |
| `app/services/gateway/mesh/negotiation.py` | Manifest generation, exchange logic, ack generation |
| `app/messaging/mesh_bus.py` | MeshBus: wraps inner bus with mesh routing |
| `tests/unit/gateway/test_mesh_models.py` | Unit tests for mesh models |
| `tests/unit/gateway/test_routing_table.py` | Unit tests for routing table |
| `tests/unit/gateway/test_version_compat.py` | Unit tests for version compatibility |
| `tests/unit/gateway/test_peer_registry.py` | Unit tests for peer registry |
| `tests/unit/gateway/test_mesh_bus.py` | Unit tests for MeshBus |
| `tests/unit/gateway/test_peer_bridge.py` | Unit tests for PeerBridge |
| `tests/unit/gateway/test_latency_monitor.py` | Unit tests for latency monitor |
| `tests/unit/gateway/test_negotiation.py` | Unit tests for negotiation protocol |
| `tests/integration/test_mesh_routing.py` | Integration tests for mesh routing |
| `tests/integration/test_mesh_failover.py` | Integration tests for failover |
| `tests/integration/test_mesh_permissions.py` | Integration tests for mesh permissions |

### Modified Files

| File | Changes |
|---|---|
| `app/services/gateway/config.py` | Add `MeshConfig`, `ServiceSharingConfig`, `ServiceRoutingConfig` to `Settings` |
| `app/services/gateway/service.py` | Initialize mesh components, replace bus singleton when mesh enabled |
| `app/services/gateway/webrtc/rtc_client.py` | Handle new message types (manifest, ping/pong, responses), `send_to_peer()` helper, manifest exchange after auth |
| `app/services/gateway/webrtc/rpc.py` | Add sharing gate (check `share: true` and capacity before processing inbound calls) |
| `app/messaging/bus.py` | No changes needed — MeshBus implements the same Protocol |
| `app/messaging/bus_runtime.py` | No changes — `set_bus()` / `get_bus()` work with MeshBus transparently |
| `app/services/supervisor.py` | No changes if MeshBus is initialized by GatewayService |
| `docs/PEER_PAIRING_FLOW.md` | Update with bidirectional handshake and mesh sections |

---

## Implementation Checklist

### Phase 1: Data Model & Configuration
- [ ] 1.1: Create `app/services/gateway/mesh/__init__.py`
- [ ] 1.2: Create `app/services/gateway/mesh/models.py` with `PeerServiceInfo`, `PeerManifest`, `PeerState`, `RouteDecision`
- [ ] 1.3: Add `MeshConfig`, `ServiceSharingConfig`, `ServiceRoutingConfig` to `app/services/gateway/config.py`
- [ ] 1.4: Add `mesh: MeshConfig` field to `Settings` in `config.py`

### Phase 2: Peer Registry & Discovery
- [ ] 2.1: Create `app/services/gateway/mesh/peer_registry.py` with `PeerRegistry`
- [ ] 2.2: Implement `register_peer()`, `update_manifest()`, `remove_peer()`, `update_latency()`
- [ ] 2.3: Implement `get_providers()` and `get_best_provider()`
- [ ] 2.4: Implement stale peer detection loop

### Phase 3: Negotiation Protocol
- [ ] 3.1: Create `app/services/gateway/mesh/negotiation.py` — manifest generation from local registry + sharing config
- [ ] 3.2: Implement `generate_manifest()` using `registry.export()` filtered by sharing config
- [ ] 3.3: Implement `generate_manifest_ack()` comparing remote manifest against local routing config
- [ ] 3.4: Create `app/services/gateway/mesh/version_compat.py` with `is_compatible()` and `check_contract_compatibility()`

### Phase 4: Bidirectional Handshake
- [ ] 4.1: Add `send_to_peer(peer_id, text)` helper method to `RTCClient`
- [ ] 4.2: Add `_send_manifest(peer_id)` to `RTCClient` — sends local manifest after auth
- [ ] 4.3: Add `_on_peer_manifest(peer_id, msg)` to `RTCClient` — processes incoming manifest
- [ ] 4.4: Add `_on_manifest_ack(peer_id, msg)` to `RTCClient`
- [ ] 4.5: Trigger manifest exchange in `validate_peer()` after successful auth
- [ ] 4.6: Handle new message types in DataChannel `on_message` handler

### Phase 5: MeshBus (Transparent Routing Layer)
- [ ] 5.1: Create `app/services/gateway/mesh/routing_table.py` with `RoutingTable`
- [ ] 5.2: Implement `resolve()` — topic → RouteDecision based on config + peer availability
- [ ] 5.3: Implement `update_peer()`, `remove_peer()`, `update_latency()`
- [ ] 5.4: Create `app/messaging/mesh_bus.py` with `MeshBus`
- [ ] 5.5: Implement `MeshBus.publish()` with routing logic and fallback
- [ ] 5.6: Implement `MeshBus.request()` with routing logic and fallback
- [ ] 5.7: Implement `MeshBus.subscribe()` (delegates to inner bus)

### Phase 6: PeerBridge & Bus Integration
- [ ] 6.1: Create `app/services/gateway/mesh/peer_bridge.py` with `PeerBridge`
- [ ] 6.2: Implement `PeerBridge.call()` — outbound RPC via DataChannel
- [ ] 6.3: Implement `PeerBridge.on_response()` — handle result/error from remote
- [ ] 6.4: Add sharing gate to `RPCHandler._handle_call()` (check share config + capacity)
- [ ] 6.5: Route `result`/`error` messages in RTCClient `on_message` to PeerBridge

### Phase 7: Latency Measurement
- [ ] 7.1: Create `app/services/gateway/mesh/latency.py` with `LatencyMonitor`
- [ ] 7.2: Implement `_ping_loop()` and `_send_ping()`
- [ ] 7.3: Handle `ping` → `pong` response in RTCClient
- [ ] 7.4: Handle `pong` → update PeerRegistry latency
- [ ] 7.5: Implement peer selection algorithm in RoutingTable

### Phase 8: GatewayService Integration
- [ ] 8.1: Add mesh component initialization to `GatewayService.on_start()`
- [ ] 8.2: Create PeerRegistry, RoutingTable, PeerBridge, LatencyMonitor instances
- [ ] 8.3: Replace global bus singleton with MeshBus when mesh is enabled
- [ ] 8.4: Pass mesh config to RTCClient and RPCHandler
- [ ] 8.5: Handle `Config.Changed` events for mesh config (hot-reload)
- [ ] 8.6: Add mesh cleanup to `GatewayService.on_stop()`

### Phase 9: Fault Tolerance
- [ ] 9.1: Implement automatic fallback in `MeshBus` when remote call fails
- [ ] 9.2: Implement stale peer timeout and routing table cleanup
- [ ] 9.3: Implement re-negotiation on reconnect
- [ ] 9.4: Add capacity tracking (increment on call, decrement on response)

### Phase 10: Testing
- [ ] 10.1: Unit tests for mesh models
- [ ] 10.2: Unit tests for routing table
- [ ] 10.3: Unit tests for version compatibility
- [ ] 10.4: Unit tests for peer registry
- [ ] 10.5: Unit tests for MeshBus routing decisions
- [ ] 10.6: Unit tests for PeerBridge
- [ ] 10.7: Unit tests for latency monitor
- [ ] 10.8: Unit tests for negotiation protocol
- [ ] 10.9: Integration tests for mesh routing (local → remote)
- [ ] 10.10: Integration tests for mesh failover
- [ ] 10.11: Integration tests for mesh permissions
- [ ] 10.12: Run `make format`, `make lint`, `make unit`

### Phase 11: Documentation
- [ ] 11.1: Update `docs/PEER_PAIRING_FLOW.md` with mesh sections
- [ ] 11.2: Update `.sisyphus/plans/` with completion status

---

## Summary

This plan transforms Aurora from a **client → server** architecture into a **true P2P mesh** where every instance is both a provider and consumer of services. The key components are:

| Component | Purpose |
|---|---|
| **MeshConfig** | Configuration for what to share and what to consume |
| **PeerRegistry** | Tracks connected peers and their capabilities |
| **RoutingTable** | Resolves bus topics to local or remote targets |
| **MeshBus** | Transparent routing layer wrapping the inner bus |
| **PeerBridge** | Sends outbound RPC calls to remote peers |
| **LatencyMonitor** | Measures RTT to all peers for optimal routing |
| **Negotiation Protocol** | Manifest exchange, version checking, compatibility verification |

The design reuses the existing:
- **Contract Registry** (version, capabilities, methods, schemas, digest)
- **WebRTC DataChannel** (bidirectional, encrypted communication)
- **RPC Handler** (inbound call processing with permission checks)
- **Identity & RBAC** (permission-gated access to services)
- **Service Announcements** (service metadata model)
- **MQTT Signaling** (peer discovery and connection setup)

All changes are **backwards compatible** — mesh is disabled by default, and enabling it requires explicit configuration. Zero overhead when disabled.

---

**Last Updated**: February 2026
**Author**: Aurora Team
**Status**: Implementation Plan — Ready for Review

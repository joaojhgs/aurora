# Aurora Architecture

This document provides an overview of Aurora's architecture, service structure, and design patterns.

## Overview

Aurora is a modular voice assistant built with a microservices architecture that can run in two modes:
- **Threads Mode**: All services run in the same process (default, for development)
- **Processes Mode**: Each service runs as a separate OS process (for production)

## Service Structure

### Core Services

Aurora consists of the following services:

1. **ConfigService** (`app/services/config/`)
   - Manages application configuration
   - Provides config API for other services
   - Handles config reload events

2. **DBService** (`app/services/db/`)
   - Database persistence and retrieval
   - Message history management
   - RAG (Retrieval-Augmented Generation) storage
   - Cron job storage

3. **OrchestratorService** (`app/services/orchestrator/`)
   - LangGraph agent coordination
   - LLM integration (OpenAI, HuggingFace, llama.cpp)
   - Conversation management

4. **TTSService** (`app/services/tts/`)
   - Text-to-speech synthesis
   - Audio output management

5. **STT Services** (`app/services/stt_*/`)
   - **STTCoordinatorService**: Coordinates STT operations
   - **STTTranscriptionService**: Handles transcription
   - **STTWakewordService**: Detects wake words

6. **SchedulerService** (`app/services/scheduler/`)
   - Scheduled task management
   - Cron job execution

7. **ToolingService** (`app/services/tooling/`)
   - Tool management (core, plugin, MCP)
   - Tool execution
   - MCP (Model Context Protocol) integration

8. **GatewayService** (`app/services/gateway/`)
   - HTTP REST API gateway for all services
   - Dynamic service discovery via message bus
   - Automatic route generation from service contracts
   - OpenAPI/Swagger documentation
   - WebRTC peer authentication with DataChannel auth gate
   - Pairing and login RPC methods (accessible by anonymous peers)
   - Room auto-generation and encrypted MQTT presence
   - P2P mesh networking for cross-instance service sharing
   - See [Gateway Documentation](./GATEWAY.md) for details

9. **Supervisor** (`app/services/supervisor.py`)
   - Service lifecycle management
   - Architecture mode selection
   - Service startup/shutdown coordination
   - Gateway lifecycle management

### Service Directory Structure

```
app/
├── shared/              # Shared code used by all services
│   ├── config/          # Configuration interface
│   ├── contracts/       # API contracts and models
│   ├── messaging/       # Message bus initialization
│   └── services/        # Base service abstraction
├── services/            # Individual service implementations
│   ├── config/
│   ├── db/
│   ├── orchestrator/
│   ├── scheduler/
│   ├── tts/
│   ├── tooling/
│   └── stt_*/
└── helpers/             # Utility functions
```

## Message Bus Architecture

Aurora uses a message bus abstraction for inter-service communication:

### Bus Implementations

1. **LocalBus** (Threads Mode)
   - In-process message passing
   - Low latency
   - Shared memory

2. **BullMQBus** (Processes Mode)
   - Redis-backed message queue
   - Distributed communication
   - Horizontal scalability

### Message Types

- **Commands**: Point-to-point messages with guaranteed delivery
- **Events**: Broadcast messages for pub/sub patterns
- **Queries**: Request/response pattern with timeouts

### Message Priority

- **Interactive** (10): User interactions, highest priority
- **System** (50): Background tasks, medium priority
- **External** (80): External API requests, lowest priority

### Service Communication Flow

```mermaid
graph TB
    subgraph "Service A"
        A[Service A Handler]
    end
    
    subgraph "Message Bus"
        MB[LocalBus / BullMQBus]
        Q[Command Queue]
        E[Event Queue]
    end
    
    subgraph "Service B"
        B[Service B Handler]
    end
    
    A -->|Publish Command| MB
    MB -->|Route| Q
    Q -->|Deliver| B
    B -->|Response| MB
    MB -->|Reply| A
    
    A -.->|Publish Event| E
    E -.->|Broadcast| B
    E -.->|Broadcast| C[Service C]
    
    style MB fill:#e1f5ff
    style Q fill:#fff4e1
    style E fill:#ffe1f5
```

### Inter-Service Communication Patterns

```mermaid
sequenceDiagram
    participant A as Service A
    participant Bus as Message Bus
    participant B as Service B
    
    Note over A,B: Command Pattern (Request/Response)
    A->>Bus: Publish Command (with reply_to)
    Bus->>B: Deliver Command
    B->>Bus: Publish Response (to reply_to)
    Bus->>A: Deliver Response
    
    Note over A,B: Event Pattern (Pub/Sub)
    A->>Bus: Publish Event
    Bus->>B: Broadcast Event
    Bus->>C: Broadcast Event (Service C)
    
    Note over A,B: Query Pattern (with Timeout)
    A->>Bus: Request Query
    Bus->>B: Deliver Query
    B->>Bus: Response (within timeout)
    Bus->>A: Return Result
    alt Timeout
        Bus->>A: Return Timeout Error
    end
```

## Contract Registry System

Aurora uses a contract registry to define and expose service APIs:

### Contract Definition

Services define contracts using the `@method_contract` decorator:

```python
@method_contract(
    method_id="TTS.Request",
    summary="Request TTS synthesis",
    input_model=TTSRequest,
    output_model=TTSResponse,
    exposure="both"
)
async def synthesize(self, request: TTSRequest) -> TTSResponse:
    # Implementation
    pass
```

### Contract Registration

Contracts are automatically registered when services inherit from `BaseService`:

1. Service inherits from `BaseService`
2. `BaseService.__init__` scans for `@method_contract` decorators
3. Contracts are registered in the global registry
4. Methods are auto-subscribed to message bus topics

## Process vs Threads Mode

### Threads Mode (Default)

- **Architecture**: All services in one process
- **Communication**: LocalBus (in-memory)
- **Use Case**: Development, testing, single-machine deployments
- **Benefits**: Low latency, simple setup, shared memory
- **Limitations**: No horizontal scaling, single point of failure

### Processes Mode

- **Architecture**: Each service in separate OS process
- **Communication**: BullMQBus (Redis)
- **Use Case**: Production, distributed deployments
- **Benefits**: Horizontal scaling, process isolation, fault tolerance
- **Requirements**: Redis server

### Mode Selection

Set via environment variable or config:

```bash
export AURORA_ARCHITECTURE_MODE=processes
export REDIS_URL=redis://localhost:6379
```

Or in `config.json`:

```json
{
  "general": {
    "architecture": {
      "mode": "processes"
    }
  },
  "messaging": {
    "redis": {
      "url": "redis://localhost:6379"
    }
  }
}
```

## Configuration Management

### Config Service

The ConfigService provides a centralized configuration API:

```python
from app.shared.config.interface import ConfigAPI

config_api = ConfigAPI()
config = config_api.get_config()
```

### Config Reload

Services subscribe to config change events and reload automatically:

1. ConfigService publishes `Config.Changed` event
2. Services receive event via message bus
3. Services call `reload()` method with affected section
4. Services update internal state

### Config Structure

Configuration is stored in `config.json`:

```json
{
  "app": {
    "name": "Aurora",
    "version": "1.0.0"
  },
  "llm": {
    "provider": "openai",
    "model": "gpt-4"
  },
  "tts": {
    "voice_model": "path/to/model"
  }
}
```

## Base Service Abstraction

All services inherit from `BaseService`:

### Features

- **Bus Access**: Automatic bus initialization via singleton
- **Lifecycle Management**: `start()`, `stop()`, `on_start()`, `on_stop()`
- **Config Reload**: `reload()` method for config changes
- **Contract Registration**: Automatic contract registration
- **Auto-Subscription**: Methods auto-subscribe to message bus

### Service Implementation Pattern

```python
from app.shared.services.base_service import BaseService

class MyService(BaseService):
    def __init__(self):
        super().__init__(
            module="MyService",
            summary="My service description",
            capabilities=["capability1", "capability2"]
        )
    
    async def on_start(self):
        # Service-specific startup
        pass
    
    async def on_stop(self):
        # Service-specific shutdown
        pass
    
    async def reload(self, config_section: str | None = None):
        # Handle config reload
        pass
```

## Process Launcher

The ProcessLauncher manages service processes in processes mode:

### Features

- Start/stop services as subprocesses
- Process monitoring
- Log collection
- Statistics collection

### Usage

```python
from app.shared.services.process_launcher import ProcessLauncher

launcher = ProcessLauncher()
launcher.start_service("ConfigService", "app.services.config")
# ... later
launcher.stop_all()
```

## Health Checks

Services implement health check endpoints:

### Health Check Response

```python
{
    "status": "healthy" | "degraded" | "unhealthy",
    "checks": {
        "bus": "ok" | "error",
        "config": "ok" | "error",
        ...
    },
    "timestamp": "2025-01-XX...",
    "service": "ServiceName"
}
```

### Health Check Utility

```python
from app.shared.services.health import check_service_health

health = await check_service_health("ConfigService")
```

## Docker Architecture

Aurora services can be containerized:

### Service Images

Each service has its own Dockerfile:
- `docker/services/Dockerfile.config`
- `docker/services/Dockerfile.db`
- `docker/services/Dockerfile.orchestrator`
- etc.

### Docker Compose

Process mode can be run via Docker Compose:

```bash
docker-compose -f docker-compose.process.yml up
```

## Gateway Architecture

The Gateway provides HTTP REST API access to all Aurora services. It dynamically discovers services and generates routes from service contracts.

### Gateway Components

```mermaid
graph TB
    subgraph "External Clients"
        Client[HTTP Client]
    end
    
    subgraph "Gateway Service"
        FastAPI[FastAPI App]
        Router[Route Generator]
        Registry[Registry Aggregator]
        Auth[Auth Middleware]
    end
    
    subgraph "Message Bus"
        Bus[LocalBus / BullMQBus]
    end
    
    subgraph "Aurora Services"
        Config[ConfigService]
        Orchestrator[OrchestratorService]
        TTS[TTSService]
        Other[Other Services...]
    end
    
    Client -->|HTTP Request| FastAPI
    FastAPI -->|Validate| Auth
    Auth -->|Route| Router
    Router -->|Check Registry| Registry
    Registry -->|Query| Bus
    Router -->|Forward Request| Bus
    Bus -->|Deliver| Config
    Bus -->|Deliver| Orchestrator
    Bus -->|Deliver| TTS
    Bus -->|Deliver| Other
    Config -->|Response| Bus
    Orchestrator -->|Response| Bus
    TTS -->|Response| Bus
    Other -->|Response| Bus
    Bus -->|Return| Router
    Router -->|Format| FastAPI
    FastAPI -->|HTTP Response| Client
    
    Config -.->|Announce| Bus
    Orchestrator -.->|Announce| Bus
    TTS -.->|Announce| Bus
    Other -.->|Announce| Bus
    Bus -.->|Service Discovery| Registry
    
    style FastAPI fill:#4a90e2
    style Router fill:#50c878
    style Registry fill:#ff6b6b
    style Bus fill:#e1f5ff
```

### Gateway Request Flow

```mermaid
sequenceDiagram
    participant Client
    participant Gateway as Gateway API
    participant Router as Route Generator
    participant Registry as Registry Aggregator
    participant Bus as Message Bus
    participant Service as Target Service
    
    Client->>Gateway: POST /api/Service/Method
    Gateway->>Router: Route Request
    Router->>Registry: Check Service Available
    Registry-->>Router: Service Status
    
    alt Service Available
        Router->>Router: Validate Input Schema
        Router->>Bus: Request(topic, payload)
        Bus->>Service: Deliver Message
        Service->>Service: Process Request
        Service->>Bus: Publish Response
        Bus->>Router: Return Result
        
        alt Success
            Router->>Gateway: Return Data
            Gateway->>Client: 200 OK + Response
        else Error
            Router->>Gateway: Return Error
            Gateway->>Client: 500 Error + Message
        end
    else Service Unavailable
        Router->>Gateway: Service Unavailable
        Gateway->>Client: 503 Service Unavailable
    end
```

### Supervisor and Gateway Lifecycle

```mermaid
graph TB
    subgraph "Supervisor"
        Sup[Supervisor]
        Init[Initialize Bus]
        Start[Start Services]
        Gateway[Start Gateway]
        Monitor[Monitor Services]
    end
    
    subgraph "Service Startup"
        S1[ConfigService]
        S2[DBService]
        S3[Other Services...]
    end
    
    subgraph "Gateway Startup"
        Reg[Registry Aggregator]
        Gen[Route Generator]
        API[FastAPI Server]
    end
    
    subgraph "Message Bus"
        Bus[LocalBus / BullMQBus]
    end
    
    Sup -->|1. Initialize| Init
    Init -->|2. Create| Bus
    Sup -->|3. Start| Start
    Start -->|4. Launch| S1
    Start -->|4. Launch| S2
    Start -->|4. Launch| S3
    
    S1 -->|5. Announce| Bus
    S2 -->|5. Announce| Bus
    S3 -->|5. Announce| Bus
    
    Sup -->|6. Start| Gateway
    Gateway -->|7. Create| Reg
    Gateway -->|8. Create| Gen
    Gateway -->|9. Start| API
    
    Reg -->|10. Subscribe| Bus
    Bus -->|11. Receive| Reg
    Reg -->|12. Update| Gen
    Gen -->|13. Generate| API
    
    Sup -->|14. Monitor| Monitor
    Monitor -->|15. Health Checks| S1
    Monitor -->|15. Health Checks| S2
    Monitor -->|15. Health Checks| S3
    
    style Sup fill:#4a90e2
    style Bus fill:#e1f5ff
    style Reg fill:#ff6b6b
    style Gen fill:#50c878
    style API fill:#f39c12
```

### Service Discovery Protocol

```mermaid
sequenceDiagram
    participant Service as New Service
    participant Bus as Message Bus
    participant Registry as Registry Aggregator
    participant Router as Route Generator
    participant Gateway as Gateway API
    
    Service->>Service: on_start()
    Service->>Bus: Publish ServiceAnnouncement
    Note over Service,Bus: Includes: module, version, methods, schemas
    
    Bus->>Registry: Deliver Announcement
    Registry->>Registry: Update Registry
    Registry->>Router: Notify Registry Changed
    Router->>Router: Regenerate Routes
    Router->>Gateway: Update FastAPI Routes
    
    Note over Service,Gateway: Service is now available via HTTP
    
    Service->>Service: on_stop()
    Service->>Bus: Publish ServiceDeparture
    Bus->>Registry: Deliver Departure
    Registry->>Registry: Remove from Registry
    Registry->>Router: Notify Registry Changed
    Router->>Router: Mark Routes as Unavailable
    Router->>Gateway: Update FastAPI Routes
    
    Note over Service,Gateway: Service no longer available
```

## Related Documentation

- [GATEWAY.md](./GATEWAY.md): Complete gateway documentation
- [MESSAGING_ARCHITECTURE.md](./MESSAGING_ARCHITECTURE.md): Detailed message bus documentation
- [TESTING_PROCESS_MODE.md](./TESTING_PROCESS_MODE.md): Process mode testing guide
- [README.process-mode.md](../README.process-mode.md): Process mode overview
- [TECHSTACK.md](./TECHSTACK.md): Technology stack details

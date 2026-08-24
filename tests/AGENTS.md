# Testing -- Agent Guide

> **Scope**: `tests/` -- Unit, integration, e2e, and performance tests.
> **Parent**: [Root AGENTS.md](../AGENTS.md) for global rules.

---

## Test Structure

```
tests/
├── conftest.py                  # Root fixtures
├── fixtures/
│   ├── mock_services.py         # Service mocks
│   ├── process_mode.py          # Process mode fixtures
│   └── test_data.py             # Test data factories
├── unit/                        # Isolated component tests
│   ├── app/                     # By-module unit tests
│   │   ├── config/
│   │   ├── database/
│   │   ├── messaging/
│   │   ├── scheduler/
│   │   ├── speech_to_text/
│   │   └── text_to_speech/
│   ├── contracts/               # Contract registry tests
│   ├── db/                      # DB service tests
│   ├── gateway/                 # Gateway subsystem tests (largest)
│   ├── orchestrator/            # Orchestrator tests
│   ├── services/                # Supervisor, gateway integration
│   ├── stt_coordinator/
│   ├── stt_transcription/
│   ├── stt_wakeword/
│   └── tooling/
├── integration/                 # Component interaction tests
│   ├── test_auth_*.py           # Auth pairing, endpoints
│   ├── test_mesh_*.py           # Mesh routing, failover, permissions
│   ├── test_principal_*.py      # Principal/token management
│   ├── messaging/
│   │   └── test_bullmq_redis_roundtrip.py  # Live Redis + BullMQ (skipped if no Redis)
│   └── test_process_mode.py     # Multi-process tests
├── e2e/                         # Full workflow tests
└── performance/                 # Benchmarks
```

---

## Running Tests

```bash
make test              # All tests except performance
make unit              # Unit tests only (~3-5 min)
make integration       # Integration tests (~5-8 min)
make coverage          # Coverage report (~8-12 min)
pytest tests/performance  # Performance tests (~15-30 min)
```

### Filtering

```bash
pytest -m unit                          # By marker
pytest -m "not external and not gpu"    # Exclude markers
pytest tests/unit/gateway/              # By directory
pytest tests/unit/gateway/test_rpc.py   # By file
pytest tests/unit/gateway/test_rpc.py::test_handle_call_success  # By test
pytest -n auto                          # Parallel execution
```

## Live Mesh and Mobile Gates

Use mocks only for unit-level behavior. Pairing, reconnect, revocation, scoped
route access, WebRTC data paths, and mobile background behavior must eventually
be proved against real service boundaries before they are reported as accepted.

For hosted-browser mesh coverage, the maintained full-service gate is:

```bash
pnpm test:hosted-peer:live
```

That command starts an isolated thread-mode `main.py` Python stack with Auth,
DB, Gateway, Tooling, WebRTC signaling, and the hosted shell. It is the current
replacement for mock-server acceptance in this area; use the
`pnpm test:web-thin:live` alias only for compatibility with older scripts.

For Android packaged WebView/WebRTC coverage, use Waydroid as the local default
device after unit, integration, SDK, Rust, and artifact-proof checks are already
green:

```bash
pnpm --filter @aurora/tauri-ui android:webrtc:interop
```

Rerun the Waydroid full-stack/background E2E gate when Android native, Rust mesh
session, SDK transport, pairing, reconnect, revocation, foreground-service, or
mobile lifecycle code changed. If an integration branch already contains the
same commits and only documentation or CI metadata moved, record the existing
Waydroid evidence and let CI own the platform matrix instead of repeating the
device run.

iOS build, simulator smoke, and MobileSafari/WKWebView WebRTC interop are
macOS/Xcode gates owned by CI or a macOS runner. Linux policy/source checks are
useful guards, but they are not iOS runtime proof.

---

## Test Markers

```python
@pytest.mark.unit          # Unit test (isolated)
@pytest.mark.integration   # Integration test (component interaction)
@pytest.mark.e2e           # End-to-end test (full workflow)
@pytest.mark.performance   # Performance benchmark
@pytest.mark.process_mode  # Requires process mode setup (Redis in CI for some tests)
@pytest.mark.bullmq_redis  # Live BullMQ + Redis (see tests/integration/messaging/)
@pytest.mark.slow          # Takes >5 seconds
@pytest.mark.external      # Requires external services (Redis, APIs)
@pytest.mark.gpu           # Requires GPU
```

---

## Writing Tests

### Async Test Pattern

All service tests use `pytest-asyncio`:

```python
import pytest

@pytest.mark.asyncio
async def test_something():
    result = await my_async_function()
    assert result.ok
```

### Mocking the Bus

```python
from unittest.mock import AsyncMock
from app.messaging.bus import QueryResult

mock_bus = AsyncMock()
mock_bus.request.return_value = QueryResult(ok=True, data={"key": "value"})
mock_bus.publish = AsyncMock()
```

### Mocking MethodInfo

When mocking `MethodInfo` with `MagicMock(spec=MethodInfo)`, you MUST set all attributes that the code accesses. The `spec=` parameter prevents auto-creating attributes.

```python
from unittest.mock import MagicMock
from app.shared.contracts.models.gateway import MethodInfo

method_info = MagicMock(spec=MethodInfo)
method_info.name = "DoSomething"
method_info.required_perms = ["user"]
method_info.method_type = "use"          # REQUIRED -- rpc.py accesses this
method_info.bus_topic = "SomeService.DoSomething"
```

Missing `method_type` will cause `AttributeError: Mock object has no attribute 'method_type'`.

---

## Gateway Test Patterns

Gateway tests require special singleton setup because `GatewayAuth` and `RTCClient` are module-level singletons in `dependencies.py`.

### Fixture Pattern

```python
@pytest.fixture
def gateway_setup():
    from app.services.gateway import dependencies as deps
    
    mock_auth_service = AsyncMock()
    gateway_auth = GatewayAuth(...)
    
    # Assign directly to module-level singletons
    deps._auth_service = mock_auth_service
    deps._gateway_auth = gateway_auth
    
    yield gateway_auth, mock_auth_service
    
    # Restore originals on teardown
    deps._auth_service = None
    deps._gateway_auth = None
```

Do NOT use `patch` context managers for these singletons -- they don't persist outside the `with` block for FastAPI request handling.

---

## Test Database

- `tests/test_scheduler.db` is created/cleaned during scheduler tests
- Use `tmp_path` fixture for isolated DB instances
- DB migrations run automatically via `MigrationManager`
- Integration tests that need a real DB should create temporary SQLite files

---

## Common Pitfalls

1. **Forgetting `@pytest.mark.asyncio`** -- async tests silently pass without running
2. **Missing `spec=` attributes on MagicMock** -- causes AttributeError at runtime
3. **Not cleaning up singletons** -- one test's state leaks into the next
4. **Blocking calls in async tests** -- use `asyncio.to_thread()` or mock blocking I/O
5. **Daemon thread tests** -- ensure threads with `daemon=True` so they don't hang the test runner

# Aurora Testing Guide

This guide explains how to run and extend the Aurora test suite.

## Test Categories

Aurora's test suite is divided into several categories:

1. **Unit Tests** - Test individual components in isolation
   - Location: `tests/unit/`
   - Run with: `pytest tests/unit`

2. **Integration Tests** - Test interactions between components
   - Location: `tests/integration/`
   - Run with: `pytest tests/integration`

3. **End-to-End Tests** - Test complete user workflows
   - Location: `tests/e2e/`
   - Run with: `pytest tests/e2e`

4. **Performance Tests** - Test system performance
   - Location: `tests/performance/`
   - Run with: `pytest tests/performance`

5. **Browser E2E Tests** - Run real browser-engine storage, UI, and WebRTC scenarios
   - Locations: `tests/e2e/browser_persistence/`, `tests/e2e/hosted_thin_shell/`, `tests/e2e/webrtc_interop/`
   - Run hosted peer persistence with: `pnpm test:web-persistence`
   - Run the hosted invite/SAS/approval/route/reload product flow against an isolated full Python service with: `pnpm test:web-thin:live`
   - Run live browser/Python WebRTC lanes with the root `test:webrtc:*` scripts
   - Run packaged Android System WebView ↔ Python peer WebRTC E2E with `pnpm --filter @aurora/tauri-ui android:webrtc:interop` while an emulator/device is running

## Running Tests

### Running All Tests

To run all tests except performance tests (default behavior):
```bash
pytest
```

To run all tests including performance tests:
```bash
pytest --no-skip-performance
```

### Running Specific Test Categories

Run tests by directory:
```bash
pytest tests/unit
pytest tests/integration
pytest tests/e2e
pytest tests/performance
```

Run tests by marker:
```bash
pytest -m unit
pytest -m integration
pytest -m e2e
pytest -m performance
```

### Running Simplified Tests

Run only simplified versions of tests (using mocks instead of real dependencies):
```bash
pytest -m simple
```

### Running Tests for Specific Modules

```bash
pytest -m langgraph
pytest -m scheduler
pytest -m stt
pytest -m tts
```

## Test Dependencies

Each test category has its own dependencies:

- **Unit Tests**: `pip install -e ".[test-unit]"`
- **Integration Tests**: `pip install -e ".[test-integration]"`
- **End-to-End Tests**: `pip install -e ".[test-e2e]"`
- **Performance Tests**: `pip install -e ".[test-performance]"`
- **All Tests**: `pip install -e ".[test-all]"`

## Test Coverage

Generate a test coverage report:
```bash
pytest --cov=app
```

Generate an HTML coverage report:
```bash
pytest --cov=app --cov-report=html
```

## Documentation hygiene

Documentation links and stale workflow/report references are checked separately:

```bash
uv run python scripts/check_docs.py
# or
make check-docs
```

## CI/CD Pipeline

Aurora's CI/CD pipeline is configured with durable workflow lanes. See `docs/CI_CD.md` for the full map.
See `docs/TEST_HARNESS_INVENTORY.md` for which executable scripts are product/build runners, which assertions already have normal tests, and which live harnesses still merit partial conversion.

1. **Python Tests** - Consolidated unit, integration, Redis-backed process-mode, and Python E2E tests
   - Workflow file: `.github/workflows/python-tests.yml`

2. **Performance and Benchmarks** - Scheduled/manual performance and SDK resilience tests
   - Workflow file: `.github/workflows/performance.yml`

3. **Frontend and SDK** - TypeScript SDK/UI/web tests and builds
   - Workflow file: `.github/workflows/frontend-sdk.yml`

4. **Browser persistence and WebRTC interoperability** - One consolidated check for cross-engine encrypted refresh restoration, the hosted thin-shell UI pairing/reload flow, plus live browser/Python direct, STUN, and TURN lanes
   - Workflow file: `.github/workflows/webrtc-interop.yml`

5. **Platform-specific packaged WebViews** - Existing Android and iOS workflows own emulator-only assertions that cannot run in the general browser lane
   - Android keeps APK/AAB proof, API 30/API 35 UI/native smoke, and API 35 packaged WebView ↔ external Python peer WebRTC interop in `.github/workflows/tauri-android.yml`
   - iOS keeps Xcode build plus simulator install/launch/screenshot/keep-alive evidence in `.github/workflows/tauri-ios.yml`
   - These are platform workflows, not one-test-per-assertion checks

## Writing Tests

### Test File Naming

- Unit tests: `tests/unit/[module]/test_[feature].py`
- Integration tests: `tests/integration/test_[module1]_[module2]_integration.py`
- E2E tests: `tests/e2e/test_[workflow].py`
- Performance tests: `tests/performance/test_[component]_performance.py`

### Simplified Tests

For tests that would normally require external dependencies or API keys:

1. Create a simplified version using mocks: `test_[feature]_simple.py`
2. Mark with `@pytest.mark.simple` and/or `@pytest.mark.mocked`

### Test Fixtures

Common test fixtures are available in:
- `tests/conftest.py` - Global fixtures
- `tests/fixtures/` - Specific fixtures by category

### Best Practices

1. Make tests independent and idempotent
2. Use fixtures for setup and teardown
3. Mock external dependencies
4. Mark slow tests with `@pytest.mark.slow`
5. Use simplified tests for CI/CD where possible

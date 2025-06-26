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

## CI/CD Pipeline

Aurora's CI/CD pipeline is configured with separate workflows for different test categories:

1. **Unit and Integration Tests** - Run on every push
   - Workflow file: `.github/workflows/test-core.yml`

2. **End-to-End Tests** - Run on pull requests
   - Workflow file: `.github/workflows/test-e2e.yml`

3. **Performance Tests** - Run on schedule and manually
   - Workflow file: `.github/workflows/test-performance.yml`

4. **Full Test Suite** - Run on releases and manually
   - Workflow file: `.github/workflows/test-all.yml`

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

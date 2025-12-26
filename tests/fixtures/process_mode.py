"""Fixtures for process mode testing."""

import os
import subprocess
import threading
import time
from collections import deque
from typing import Generator

import pytest
import redis


@pytest.fixture(scope="session")
def redis_server():
    """Ensure Redis server is running."""
    client = redis.Redis(host="localhost", port=6379, decode_responses=True)
    try:
        client.ping()
        yield client
    except redis.ConnectionError:
        pytest.skip("Redis server not available")
    finally:
        client.close()


@pytest.fixture
def process_mode_environment():
    """Set up environment for process mode."""
    old_env = os.environ.copy()
    os.environ["AURORA_ARCHITECTURE_MODE"] = "processes"
    os.environ["REDIS_URL"] = "redis://localhost:6379"
    yield
    os.environ.clear()
    os.environ.update(old_env)


class ServiceProcessManager:
    """Context manager for managing service processes."""

    def __init__(self):
        self.processes: dict[str, subprocess.Popen] = {}

    def start_service(self, service_name: str, module_path: str):
        """Start a service process."""
        proc = subprocess.Popen(
            ["python", "-m", module_path],
            env=os.environ,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.processes[service_name] = proc
        time.sleep(1)  # Give service time to start
        return proc

    def stop_all(self):
        """Stop all managed processes."""
        for name, proc in self.processes.items():
            try:
                proc.terminate()
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            except Exception:
                pass  # Process may already be dead
        self.processes.clear()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop_all()


@pytest.fixture
def service_manager():
    """Fixture for managing service processes."""
    with ServiceProcessManager() as manager:
        yield manager

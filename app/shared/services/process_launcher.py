"""Process launcher utility for spawning services in separate processes.

This module provides utilities for launching services as standalone processes,
enabling true microservices architecture with process isolation.
"""

from __future__ import annotations

import asyncio
import contextlib
import multiprocessing
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any

from app.helpers.aurora_logger import log_error, log_info


class ShutdownSignalWaiter:
    """Installed SIGINT/SIGTERM waiter for standalone service shutdown."""

    def __init__(self, service_name: str) -> None:
        self._service_name = service_name
        self._loop = asyncio.get_running_loop()
        self._shutdown_requested = asyncio.Event()
        self._installed_on_loop: list[signal.Signals] = []
        self._previous_handlers: dict[signal.Signals, Any] = {}
        self._install()

    async def wait(self) -> None:
        """Wait for an installed shutdown signal handler to fire."""
        await self._shutdown_requested.wait()

    def close(self) -> None:
        """Remove loop handlers and restore fallback signal handlers."""
        for shutdown_signal in self._installed_on_loop:
            with contextlib.suppress(NotImplementedError, RuntimeError):
                self._loop.remove_signal_handler(shutdown_signal)
        self._installed_on_loop.clear()

        for shutdown_signal, previous_handler in self._previous_handlers.items():
            signal.signal(shutdown_signal, previous_handler)
        self._previous_handlers.clear()

    def _request_shutdown(self, signum: int) -> None:
        signal_name = signal.Signals(signum).name
        log_info(f"Received {signal_name}; stopping {self._service_name}")
        self._shutdown_requested.set()

    def _install(self) -> None:
        for shutdown_signal in (signal.SIGINT, signal.SIGTERM):
            with contextlib.suppress(NotImplementedError, RuntimeError):
                self._loop.add_signal_handler(
                    shutdown_signal,
                    self._request_shutdown,
                    shutdown_signal,
                )
                self._installed_on_loop.append(shutdown_signal)
                continue

            self._previous_handlers[shutdown_signal] = signal.getsignal(shutdown_signal)
            signal.signal(
                shutdown_signal,
                lambda signum, _frame: self._request_shutdown(signum),
            )


async def wait_for_shutdown_signal(service_name: str) -> None:
    """Wait until SIGINT or SIGTERM requests standalone service shutdown."""
    waiter = ShutdownSignalWaiter(service_name)

    try:
        await waiter.wait()
    finally:
        waiter.close()


def run_standalone_service(main_coro: Any) -> None:
    """Run a standalone service coroutine with normal Ctrl+C semantics."""
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main_coro())


def run_service_process(service_module_path: str, service_name: str) -> None:
    """Run a service in a separate process.

    Args:
        service_module_path: Python module path to the service (e.g., "app.services.db")
        service_name: Name of the service (e.g., "DBService")
    """
    try:
        # Import the service module and run main
        import importlib

        module = importlib.import_module(f"{service_module_path}.__main__")
        if hasattr(module, "main"):
            run_standalone_service(module.main)
        else:
            raise AttributeError(f"Module {service_module_path} has no 'main' function")
    except Exception as e:
        log_error(f"Error in {service_name} process: {e}", exc_info=True)
        sys.exit(1)


class ProcessLauncher:
    """Enhanced process launcher with monitoring."""

    def __init__(self):
        """Initialize the process launcher."""
        self.processes: dict[str, subprocess.Popen] = {}
        self.monitoring: bool = False
        self.monitor_thread: threading.Thread | None = None
        self.process_logs: dict[str, deque] = {}  # Store last N log lines
        self.process_stats: dict[str, dict[str, Any]] = {}
        self.shutdown_event = threading.Event()

    def start_service(
        self, service_name: str, service_module_path: str, daemon: bool = False
    ) -> subprocess.Popen:
        """Start a service with enhanced error handling.

        Args:
            service_name: Name of the service
            service_module_path: Python module path to the service
            daemon: Whether the process should be a daemon (ignored for subprocess)

        Returns:
            The spawned process
        """
        log_info(f"Starting {service_name} as separate process...")

        # Capture output
        process = subprocess.Popen(
            ["python", "-m", service_module_path],
            env=os.environ.copy(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        self.processes[service_name] = process
        self.process_logs[service_name] = deque(maxlen=100)  # Keep last 100 lines

        # Start log monitoring thread
        log_thread = threading.Thread(
            target=self._monitor_process_logs,
            args=(service_name, process),
            daemon=True,
        )
        log_thread.start()

        # Start monitoring if not already started
        if not self.monitoring:
            self.start_monitoring()

        log_info(f"{service_name} process started (PID: {process.pid})")
        return process

    def _monitor_process_logs(self, service_name: str, process: subprocess.Popen):
        """Monitor process output and store logs."""
        if process.stdout:
            try:
                for line in iter(process.stdout.readline, ""):
                    if not line:
                        break
                    self.process_logs[service_name].append(
                        {
                            "timestamp": datetime.utcnow().isoformat(),
                            "line": line.strip(),
                        }
                    )
            except Exception as e:
                log_error(f"Error monitoring logs for {service_name}: {e}")

    def start_monitoring(self):
        """Start monitoring all processes."""
        if self.monitoring:
            return

        self.monitoring = True
        self.monitor_thread = threading.Thread(
            target=self._monitor_processes,
            daemon=True,
        )
        self.monitor_thread.start()
        log_info("Process monitoring started")

    def _monitor_processes(self):
        """Monitor all processes for health."""
        try:
            import psutil
        except ImportError:
            log_error("psutil not available - process stats will not be collected")
            psutil = None

        while not self.shutdown_event.is_set():
            for service_name, process in list(self.processes.items()):
                if process.poll() is not None:
                    log_error(
                        f"{service_name} process died unexpectedly (exit code: {process.returncode})"
                    )
                    # Optionally restart?

                # Collect stats if psutil is available
                if psutil:
                    try:
                        proc = psutil.Process(process.pid)
                        self.process_stats[service_name] = {
                            "cpu_percent": proc.cpu_percent(),
                            "memory_mb": proc.memory_info().rss / 1024 / 1024,
                            "status": proc.status(),
                        }
                    except psutil.NoSuchProcess:
                        pass

            self.shutdown_event.wait(5)  # Check every 5 seconds

    def get_logs(self, service_name: str, lines: int = 50) -> list[str]:
        """Get recent logs for a service.

        Args:
            service_name: Name of the service
            lines: Number of lines to retrieve

        Returns:
            List of log lines
        """
        if service_name not in self.process_logs:
            return []

        logs = list(self.process_logs[service_name])
        return [log["line"] for log in logs[-lines:]]

    def get_stats(self, service_name: str) -> dict[str, Any] | None:
        """Get statistics for a service.

        Args:
            service_name: Name of the service

        Returns:
            Statistics dictionary or None
        """
        return self.process_stats.get(service_name)

    def stop_service(self, service_name: str, timeout: float = 5.0) -> bool:
        """Stop a service process.

        Args:
            service_name: Name of the service
            timeout: Timeout in seconds for graceful shutdown

        Returns:
            True if process was stopped successfully, False otherwise
        """
        if service_name not in self.processes:
            log_error(f"Service {service_name} not found in process list")
            return False

        process = self.processes[service_name]

        log_info(f"Stopping {service_name} process (PID: {process.pid})...")

        # Terminate the process
        try:
            process.terminate()
        except Exception as e:
            log_error(f"Error terminating {service_name} process: {e}")

        # Wait for process to terminate
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log_error(f"{service_name} process did not terminate gracefully, forcing kill...")
            try:
                process.kill()
                process.wait()
            except Exception as e:
                log_error(f"Error killing {service_name} process: {e}")
        except Exception as e:
            log_error(f"Error stopping {service_name} process: {e}")

        # Clean up
        if service_name in self.processes:
            del self.processes[service_name]
        if service_name in self.process_logs:
            del self.process_logs[service_name]
        if service_name in self.process_stats:
            del self.process_stats[service_name]

        log_info(f"{service_name} process stopped")
        return True

    def stop_all(self, timeout: float = 5.0) -> None:
        """Stop all service processes with enhanced error handling.

        Args:
            timeout: Timeout in seconds for graceful shutdown
        """
        log_info("Stopping all service processes...")

        # Signal shutdown
        self.shutdown_event.set()

        # Stop monitoring
        if self.monitor_thread:
            self.monitor_thread.join(timeout=2)

        # Stop all processes
        service_names = list(self.processes.keys())
        for service_name in service_names:
            self.stop_service(service_name, timeout=timeout)

        log_info("All service processes stopped")

    def is_running(self, service_name: str) -> bool:
        """Check if a service process is running.

        Args:
            service_name: Name of the service

        Returns:
            True if process is running, False otherwise
        """
        if service_name not in self.processes:
            return False

        process = self.processes[service_name]
        return process.poll() is None

    def get_process_info(self, service_name: str) -> dict[str, Any] | None:
        """Get information about a service process.

        Args:
            service_name: Name of the service

        Returns:
            Dictionary with process information or None if not found
        """
        if service_name not in self.processes:
            return None

        process = self.processes[service_name]
        stats = self.process_stats.get(service_name, {})

        return {
            "name": service_name,
            "pid": process.pid,
            "is_running": process.poll() is None,
            "returncode": process.returncode,
            "stats": stats,
        }

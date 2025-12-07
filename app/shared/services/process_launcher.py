"""Process launcher utility for spawning services in separate processes.

This module provides utilities for launching services as standalone processes,
enabling true microservices architecture with process isolation.
"""

from __future__ import annotations

import asyncio
import multiprocessing
import sys
from typing import Any

from app.helpers.aurora_logger import log_error, log_info


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
            asyncio.run(module.main())
        else:
            raise AttributeError(f"Module {service_module_path} has no 'main' function")
    except Exception as e:
        log_error(f"Error in {service_name} process: {e}", exc_info=True)
        sys.exit(1)


class ProcessLauncher:
    """Process launcher for managing service processes."""

    def __init__(self):
        """Initialize the process launcher."""
        self.processes: dict[str, multiprocessing.Process] = {}

    def start_service(
        self, service_name: str, service_module_path: str, daemon: bool = False
    ) -> multiprocessing.Process:
        """Start a service in a separate process.

        Args:
            service_name: Name of the service
            service_module_path: Python module path to the service
            daemon: Whether the process should be a daemon

        Returns:
            The spawned process
        """
        log_info(f"Starting {service_name} as separate process...")

        process = multiprocessing.Process(
            target=run_service_process,
            args=(service_module_path, service_name),
            name=service_name,
            daemon=daemon,
        )

        process.start()
        self.processes[service_name] = process

        log_info(f"{service_name} process started (PID: {process.pid})")
        return process

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
        process.terminate()

        # Wait for process to terminate
        try:
            process.join(timeout=timeout)
            if process.is_alive():
                log_error(f"{service_name} process did not terminate gracefully, forcing kill...")
                process.kill()
                process.join()
        except Exception as e:
            log_error(f"Error stopping {service_name} process: {e}")

        del self.processes[service_name]
        log_info(f"{service_name} process stopped")
        return True

    def stop_all(self, timeout: float = 5.0) -> None:
        """Stop all service processes.

        Args:
            timeout: Timeout in seconds for graceful shutdown
        """
        log_info("Stopping all service processes...")

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

        return self.processes[service_name].is_alive()

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

        return {
            "name": service_name,
            "pid": process.pid,
            "is_alive": process.is_alive(),
            "daemon": process.daemon,
        }

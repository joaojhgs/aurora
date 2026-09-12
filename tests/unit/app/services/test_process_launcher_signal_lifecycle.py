"""Standalone process signal lifecycle regressions."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest


@pytest.mark.parametrize("shutdown_signal", [signal.SIGINT, signal.SIGTERM])
def test_wait_for_shutdown_signal_allows_async_cleanup(
    shutdown_signal: signal.Signals,
) -> None:
    """SIGINT/SIGTERM wake the async wait path so cleanup runs before exit."""
    project_root = Path(__file__).resolve().parents[4]
    script = """
import asyncio

from app.shared.services.process_launcher import wait_for_shutdown_signal


async def main():
    shutdown_task = asyncio.create_task(wait_for_shutdown_signal("LifecycleProbe"))
    await asyncio.sleep(0)
    print("ready", flush=True)
    try:
        await shutdown_task
    finally:
        print("cleanup", flush=True)


asyncio.run(main())
"""
    process = subprocess.Popen(
        [sys.executable, "-c", script],
        cwd=project_root,
        env={**os.environ, "PYTHONPATH": str(project_root)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    assert process.stdout is not None
    startup_output: list[str] = []
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        line = process.stdout.readline()
        if not line:
            break
        startup_output.append(line)
        if line.strip() == "ready":
            break
    else:
        process.kill()
        process.wait(timeout=5)
        pytest.fail("Lifecycle probe did not become ready before timeout")

    assert any(line.strip() == "ready" for line in startup_output)

    process.send_signal(shutdown_signal)
    output, _ = process.communicate(timeout=10)

    assert process.returncode == 0
    assert "cleanup" in "".join(startup_output + [output])

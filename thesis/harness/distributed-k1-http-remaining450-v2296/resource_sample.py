"""Single-shot, read-only host/child resource snapshot for a future controller.

Importing this module performs no I/O. The caller must explicitly invoke
``sample_resources(pid)`` at its chosen sampling cadence.
"""

from __future__ import annotations

import os
import pathlib
import time
from typing import Any


_STATUS_FIELDS = {"VmRSS", "VmHWM", "VmSize", "Threads"}
_MAX_ERRORS = 32


def _read_text(path: pathlib.Path, field: str, errors: list[dict[str, Any]]) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {
                    "field": field,
                    "errorClass": type(exc).__name__,
                    "errno": exc.errno,
                }
            )
        return None


def _parse_proc_net_dev(
    text: str | None, field: str, errors: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if text is None:
        return None
    interfaces: dict[str, dict[str, int]] = {}
    try:
        for line in text.splitlines()[2:]:
            if ":" not in line:
                continue
            name, raw = line.split(":", 1)
            values = [int(value) for value in raw.split()]
            if len(values) < 16:
                raise ValueError("counter_shape")
            interfaces[name.strip()] = {
                "rx_bytes": values[0],
                "rx_packets": values[1],
                "tx_bytes": values[8],
                "tx_packets": values[9],
            }
    except (ValueError, IndexError):
        if len(errors) < _MAX_ERRORS:
            errors.append({"field": field, "errorClass": "CounterParseError", "errno": None})
        return None
    return {
        "scope": "aggregate_interface_counters_not_per_request_attribution",
        "interfaces": interfaces,
    }


def _parse_host_cpu(text: str | None, errors: list[dict[str, Any]]) -> list[int] | None:
    if text is None:
        return None
    try:
        line = next(line for line in text.splitlines() if line.startswith("cpu "))
        return [int(value) for value in line.split()[1:]]
    except (StopIteration, ValueError):
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": "hostCpuTicks", "errorClass": "CounterParseError", "errno": None}
            )
        return None


def _parse_child_stat(text: str | None, errors: list[dict[str, Any]]) -> dict[str, Any] | None:
    if text is None:
        return None
    try:
        # comm is parenthesized and may itself contain spaces or ')'. The
        # fields following the final ')' begin with proc stat field 3.
        fields = text.rsplit(")", 1)[1].split()
        return {
            "state": fields[0],
            "userCpuTicks": int(fields[11]),
            "systemCpuTicks": int(fields[12]),
            "startTicks": int(fields[19]),
        }
    except (IndexError, ValueError):
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": "childProcStat", "errorClass": "CounterParseError", "errno": None}
            )
        return None


def _parse_child_status(text: str | None, errors: list[dict[str, Any]]) -> dict[str, Any] | None:
    if text is None:
        return None
    values: dict[str, Any] = {name: None for name in _STATUS_FIELDS}
    try:
        for line in text.splitlines():
            if ":" not in line:
                continue
            key, raw = line.split(":", 1)
            if key not in _STATUS_FIELDS:
                continue
            token = raw.strip().split()[0]
            values[key] = int(token)
    except (IndexError, ValueError):
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": "childStatus", "errorClass": "CounterParseError", "errno": None}
            )
        return None
    for name, value in values.items():
        if value is None and len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": f"childStatus.{name}", "errorClass": "CounterMissing", "errno": None}
            )
    # Status memory fields are reported in KiB by procfs; Threads is a count.
    return values


def _amd_gpu_snapshot(errors: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    drm = pathlib.Path("/sys/class/drm")
    try:
        devices = sorted(drm.glob("card*/device"))
    except OSError as exc:
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": "gpuDevices", "errorClass": type(exc).__name__, "errno": exc.errno}
            )
        return None
    result: list[dict[str, Any]] = []
    for device in devices:
        vendor = _read_text(device / "vendor", "gpu.vendor", errors)
        if vendor is None or vendor.strip().lower() != "0x1002":
            continue
        values: dict[str, Any] = {"vendor": vendor.strip().lower()}
        for name in ("device", "gpu_busy_percent", "mem_info_vram_used"):
            raw = _read_text(device / name, f"gpu.{name}", errors)
            if raw is None:
                values[name] = None
                continue
            try:
                values[name] = int(raw.strip(), 0) if name == "device" else int(raw.strip())
            except ValueError:
                values[name] = None
                if len(errors) < _MAX_ERRORS:
                    errors.append(
                        {"field": f"gpu.{name}", "errorClass": "CounterParseError", "errno": None}
                    )
        result.append(values)
    return result


def sample_resources(pid: int) -> dict[str, Any]:
    """Read one best-effort snapshot; absent counters are null, never zero-filled.

    Network counters are aggregate interface context for the host and the
    process network namespace; they do not attribute bytes to a request or
    process. This function does not sleep, retry, spawn work, or enforce
    admission thresholds. The campaign controller remains responsible for
    resource floors and process lifecycle.
    """
    errors: list[dict[str, Any]] = []
    valid_pid = isinstance(pid, int) and not isinstance(pid, bool) and pid > 0
    base = pathlib.Path(f"/proc/{pid}") if valid_pid else None
    if not valid_pid and len(errors) < _MAX_ERRORS:
        errors.append({"field": "pid", "errorClass": "InvalidPid", "errno": None})

    host_stat = _read_text(pathlib.Path("/proc/stat"), "hostProcStat", errors)
    host_net = _read_text(pathlib.Path("/proc/net/dev"), "hostNetwork", errors)
    child_net = _read_text(base / "net/dev", "childNetwork", errors) if base else None
    child_stat = _read_text(base / "stat", "childProcStat", errors) if base else None
    child_status = _read_text(base / "status", "childStatus", errors) if base else None
    try:
        ticks_per_second: int | None = int(os.sysconf("SC_CLK_TCK"))
    except (OSError, ValueError, TypeError):
        ticks_per_second = None
        if len(errors) < _MAX_ERRORS:
            errors.append(
                {"field": "ticksPerSecond", "errorClass": "SysconfUnavailable", "errno": None}
            )

    return {
        "schema": "aurora.resource_sample.v1",
        "pid": pid if valid_pid else None,
        "monotonic_ns": time.monotonic_ns(),
        "ticks_per_second": ticks_per_second,
        "host_cpu_ticks": _parse_host_cpu(host_stat, errors),
        "host_network": _parse_proc_net_dev(host_net, "hostNetwork", errors),
        "child_network": _parse_proc_net_dev(child_net, "childNetwork", errors),
        "child_proc_stat": _parse_child_stat(child_stat, errors),
        "child_status": _parse_child_status(child_status, errors),
        "amd_drm_devices": _amd_gpu_snapshot(errors),
        "counter_errors": errors[:_MAX_ERRORS],
    }

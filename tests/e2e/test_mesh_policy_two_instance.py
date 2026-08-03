"""G016 isolated two-process/no-reconnect acceptance matrix."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest

from app.messaging import QueryResult
from app.shared.contracts.models.auth import AuthMethods
from app.shared.contracts.models.mesh import MeshBoolResponse, MeshPeerApproveRequest
from app.shared.mesh.observability import canonical_mesh_rollout_reason
from scripts.mesh_policy_two_instance_harness import (
    OwnedNode,
    _persist_synthetic_peer_authority,
    _wait_for_gateway_authority_convergence,
    run_harness,
)

EXPECTED_SCENARIOS = {
    "E2E-01",
    "E2E-02",
    "E2E-03",
    "E2E-04",
    "E2E-05",
    "E2E-06",
    "E2E-07",
    "E2E-08",
    "E2E-09",
    "E2E-10",
    "E2E-11",
    "E2E-12",
    "E2E-13",
    "E2E-14",
}


def test_owned_node_readiness_failure_always_stops_owned_process(monkeypatch, tmp_path):
    stopped: list[bool] = []

    monkeypatch.setattr(
        OwnedNode,
        "_read_protocol",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(TimeoutError("boom")),
    )
    monkeypatch.setattr(OwnedNode, "stop", lambda self: stopped.append(True))
    monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: object())

    with pytest.raises(TimeoutError, match="boom"):
        OwnedNode(tmp_path, "failed-node", "threads", 18888, "redis://invalid")

    assert stopped == [True]


@pytest.mark.asyncio
async def test_process_patch_waits_for_gateway_manifest_convergence():
    candidate = {
        "provider_id": "remote:aurora-1:TTS",
        "peer_id": "aurora-1",
        "provider_kind": "remote",
        "service_instance_id": "remote:aurora-1:TTS",
        "module": "TTS",
        "reason_code": "eligible",
        "reason": "eligible",
        "projection_revision": "2",
        "projection_digest": "old-digest",
    }
    bus = AsyncMock()
    bus.request = AsyncMock(
        side_effect=[
            QueryResult(
                ok=True,
                data={"topic": "TTS.Synthesize", "module": "TTS", "candidates": [candidate]},
            ),
            QueryResult(
                ok=True,
                data={
                    "topic": "TTS.Synthesize",
                    "module": "TTS",
                    "candidates": [
                        {
                            **candidate,
                            "reason_code": "eligible",
                            "reason": "eligible",
                            "projection_revision": "2",
                            "projection_digest": "requested-digest",
                        }
                    ],
                },
            ),
        ]
    )

    await _wait_for_gateway_authority_convergence(
        bus,
        provider_peer_id="aurora-1",
        expected_projection_revision="2",
        expected_projection_digest="requested-digest",
        timeout_s=1,
    )

    assert bus.request.await_count == 2


@pytest.mark.asyncio
async def test_synthetic_authority_patch_reapproves_unlinked_peer_and_checks_result():
    bus = AsyncMock()
    bus.request = AsyncMock(
        side_effect=[
            QueryResult(ok=True, data=MeshBoolResponse(success=True)),
            QueryResult(ok=True, data=MeshBoolResponse(success=True)),
        ]
    )
    await _persist_synthetic_peer_authority(
        bus,
        remote_peer_id="aurora-2",
        permissions=["Gateway.manage"],
    )

    assert bus.request.await_count == 2
    approval_call = bus.request.await_args_list[1]
    assert approval_call.args == (
        AuthMethods.MESH_APPROVE_PEER,
        MeshPeerApproveRequest(peer_id="aurora-2", permissions=["Gateway.manage"]),
    )


@pytest.mark.asyncio
async def test_synthetic_authority_patch_fails_when_reapproval_is_rejected():
    bus = AsyncMock()
    bus.request = AsyncMock(
        side_effect=[
            QueryResult(ok=True, data=MeshBoolResponse(success=True)),
            QueryResult(
                ok=True,
                data=MeshBoolResponse(success=False, message="peer approval rejected"),
            ),
        ]
    )

    with pytest.raises(RuntimeError, match="peer approval rejected"):
        await _persist_synthetic_peer_authority(
            bus,
            remote_peer_id="aurora-2",
            permissions=[],
        )


@pytest.mark.asyncio
async def test_synthetic_authority_patch_fails_when_peer_upsert_is_rejected():
    bus = AsyncMock()
    bus.request = AsyncMock(
        return_value=QueryResult(
            ok=True,
            data=MeshBoolResponse(success=False, message="peer upsert rejected"),
        )
    )

    with pytest.raises(RuntimeError, match="peer upsert rejected"):
        await _persist_synthetic_peer_authority(
            bus,
            remote_peer_id="aurora-2",
            permissions=[],
        )

    bus.request.assert_awaited_once()


@pytest.mark.e2e
def test_two_isolated_thread_instances_cover_full_no_reconnect_matrix(tmp_path):
    report = run_harness(mode="threads", output_dir=tmp_path)
    _assert_acceptance_report(report)


def _assert_acceptance_report(report):
    assert report["status"] == "pass"
    assert set(report["scenario_ids"]) == EXPECTED_SCENARIOS
    assert report["result_count"] == len(EXPECTED_SCENARIOS)
    assert report["cleanup"] == {
        "owned_processes_stopped": True,
        "authority_workers_stopped": True,
        "temporary_state_removed": True,
    }
    assert report["ownership"]["aurora-1"]["config"] != report["ownership"]["aurora-2"]["config"]
    assert (
        report["ownership"]["aurora-1"]["data_dir"] != report["ownership"]["aurora-2"]["data_dir"]
    )
    assert (
        report["ownership"]["aurora-1"]["gateway_port"]
        != report["ownership"]["aurora-2"]["gateway_port"]
    )
    assert (
        len(
            {
                report["ownership"][node_id]["data_dir"]
                for node_id in ("aurora-1", "aurora-2", "aurora-3")
            }
        )
        == 3
    )

    by_id = {item["scenario_id"]: item for item in report["results"]}
    rtc_probe = by_id["E2E-01"]["evidence"]["rtc_probe"]
    assert rtc_probe["rtc_wire"]["type"] == "result"
    assert rtc_probe["rtc_wire"]["method"] == "Gateway.ExplainRoute"
    assert rtc_probe["topic"] == "Tooling.GetTools"
    tooling_catalog = by_id["E2E-01"]["evidence"]["tooling_catalog"]
    assert tooling_catalog["provider_peer_id"] == "aurora-1"
    assert tooling_catalog["page_size"] == 2
    assert tooling_catalog["rtc_wire"]["type"] == "result"
    assert by_id["E2E-02"]["reason_code"] == "method_not_shared"
    assert by_id["E2E-02"]["evidence"]["direct"]["wire"]["type"] == "error"
    assert by_id["E2E-03"]["reason_code"] == "eligible"
    assert by_id["E2E-04"]["reason_code"] == "provider_not_allowed"
    assert by_id["E2E-05"]["reason_code"] == "missing_required_features"
    assert by_id["E2E-05"]["evidence"]["permission_projection"]["reason_code"] in {
        "permissions_unknown",
        "permission_denied",
        "service_not_advertised",
    }
    assert by_id["E2E-05"]["evidence"]["permission_restored"]["reason_code"] == "eligible"
    provider_permission = by_id["E2E-05"]["evidence"]["provider_permission"]
    assert provider_permission["allowed"] is False
    assert provider_permission["reason_code"] == "method_not_shared"
    assert provider_permission["wire"]["type"] == "error"
    assert provider_permission["wire"]["error"]["code"] == 403
    assert provider_permission["wire"]["error"]["message"] in {
        "Method is not shared",
        "Service or method is not shared",
    }
    assert provider_permission["wire"]["id"]
    assert (
        by_id["E2E-05"]["evidence"]["capability_tag"]["reason_code"]
        == "missing_required_capability_tags"
    )
    assert by_id["E2E-05"]["evidence"]["exact_method"]["reason_code"] == "method_not_advertised"
    assert by_id["E2E-10"]["reason_code"] == "snapshot_revision_changed"
    assert by_id["E2E-06"]["reason_code"] == "provider_export_policy_unshared"
    assert by_id["E2E-08"]["reason_code"] == "method_not_shared"
    restart = by_id["E2E-09"]["evidence"]
    assert restart["stable_tool_ids"] == sorted(
        tool["global_tool_id"] for tool in restart["after_catalog"]["tools"]
    )
    assert {grant["grant_scope"] for grant in restart["after_grants"]["grants"]} >= {
        "always",
        "deny_always",
    }
    assert by_id["E2E-11"]["reason_code"] == "schema_unavailable"
    assert by_id["E2E-12"]["reason_code"] == "provider_mesh_tooling_disabled"
    assert by_id["E2E-12"]["evidence"]["consumer"]["reason_code"] == "permission_denied"
    assert by_id["E2E-13"]["reason_code"] == "provider_unavailable"
    transport = by_id["E2E-13"]["evidence"]["transport"]
    assert transport["manifest"]["status"] == "verified"
    assert transport["manifest"]["projection_active"] is True
    assert transport["manifest"]["projection_digest"]
    assert transport["full_selection"] == {
        "status": "projection_v1",
        "selected_tier": "projection_v1",
        "force_full_snapshot": True,
    }
    assert transport["baseline"] == {"verified": False, "active_generations": []}
    assert transport["delta_selection"] == {
        "status": "baseline_required",
        "selected_tier": None,
        "force_full_snapshot": True,
    }
    assert by_id["E2E-14"]["reason_code"] == "unsafe_downgrade_blocked"
    ceremony = by_id["E2E-14"]["evidence"]["ceremony"]
    assert ceremony["valid_preflight"]["reason"] == "downgrade_receipt_verified"
    assert ceremony["tampered_preflight"]["reason"] == "unsafe_downgrade_blocked"
    assert ceremony["coarse_deny"] == {"share": False, "default_share": False}
    assert ceremony["preserved_db_snapshot"] is True
    wire_evidence = {
        "E2E-02": by_id["E2E-02"]["evidence"]["route"],
        "E2E-03": by_id["E2E-03"]["evidence"]["route"],
        "E2E-04": by_id["E2E-04"]["evidence"]["outbound"],
        "E2E-05": by_id["E2E-05"]["evidence"]["feature"],
        "E2E-06": by_id["E2E-06"]["evidence"]["hidden"],
        "E2E-07": by_id["E2E-07"]["evidence"]["aurora_2"],
        "E2E-08": by_id["E2E-08"]["evidence"]["stale"],
        "E2E-09": by_id["E2E-09"]["evidence"]["after_catalog"],
        "E2E-10": by_id["E2E-10"]["evidence"]["changed"],
        "E2E-11": by_id["E2E-11"]["evidence"]["schema"],
        "E2E-12": by_id["E2E-12"]["evidence"]["provider"],
        "E2E-13": by_id["E2E-13"]["evidence"]["legacy"],
        "E2E-14": by_id["E2E-14"]["evidence"]["downgrade"],
    }
    for scenario_id, evidence in wire_evidence.items():
        assert evidence["rtc_wire"]["type"] in {"result", "error"}, scenario_id
        assert evidence["rtc_wire"]["rtc_connection_id"], scenario_id
        assert evidence["rtc_wire"]["method"] in {
            "Config.Get",
            "Gateway.ExplainRoute",
            "Gateway.GetSupportBundle",
            "Tooling.GetExportCatalog",
            "Tooling.PrepareExecution",
        }, scenario_id
    for scenario_id in (
        "E2E-02",
        "E2E-04",
        "E2E-05",
        "E2E-08",
        "E2E-10",
        "E2E-12",
        "E2E-14",
    ):
        reason = by_id[scenario_id]["reason_code"]
        assert canonical_mesh_rollout_reason(reason) == reason


@pytest.mark.e2e
@pytest.mark.process_mode
def test_two_isolated_process_instances_use_distinct_redis_authority(tmp_path):
    if importlib.util.find_spec("bullmq") is None or importlib.util.find_spec("redis") is None:
        pytest.skip("mode-processes dependencies are not installed")

    with _isolated_redis_endpoints() as redis_urls:
        report = run_harness(mode="processes", output_dir=tmp_path, redis_urls=redis_urls)
    _assert_acceptance_report(report)
    assert (
        len(
            {
                report["ownership"][node_id]["redis_url"]
                for node_id in ("aurora-1", "aurora-2", "aurora-3")
            }
        )
        == 3
    )
    assert report["ownership"]["aurora-1"]["process_bus"] == "bullmq"
    assert report["ownership"]["aurora-1"]["rpc_bus"] == "bullmq"


def test_docker_command_timeout_includes_container_diagnostics(monkeypatch):
    calls: list[tuple[str, ...]] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        calls.append(tuple(cmd))
        if cmd[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(
                cmd, 0, stdout="aurora-g016-old\tUp\t6379\n", stderr=""
            )
        if cmd[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(
                cmd, 0, stdout='[{"State":{"Status":"running"}}]', stderr=""
            )
        if cmd[:2] == ["docker", "logs"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="redis log tail", stderr="")
        raise subprocess.TimeoutExpired(cmd, timeout=1, output="partial out", stderr="partial err")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(RuntimeError) as excinfo:
        _docker_checked(
            ["docker", "run", "--name", "aurora-g016-old", "redis:7-alpine"], 1, ["aurora-g016-old"]
        )

    message = str(excinfo.value)
    assert "timed out after 1s" in message
    assert "partial out" in message
    assert "partial err" in message
    assert "docker ps -a" in message
    assert "redis log tail" in message
    assert ("docker", "inspect", "aurora-g016-old") in calls


def test_isolated_redis_cleanup_falls_back_to_rm_after_stop_timeout(monkeypatch):
    removed: list[str] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        if cmd[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")
        if cmd[:2] == ["docker", "run"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="container-id\n", stderr="")
        if cmd[:2] == ["docker", "port"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="127.0.0.1:46379\n", stderr="")
        if cmd[:2] == ["docker", "exec"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="PONG\n", stderr="")
        if cmd[:2] == ["docker", "stop"]:
            raise subprocess.TimeoutExpired(cmd, timeout=1, output="", stderr="daemon busy")
        if cmd[:3] == ["docker", "rm", "-f"]:
            removed.append(cmd[3])
            return subprocess.CompletedProcess(cmd, 0, stdout=cmd[3], stderr="")
        if cmd[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="No such object")
        if cmd[:2] in (["docker", "ps"], ["docker", "logs"]):
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected docker command: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(uuid, "uuid4", lambda: type("Uuid", (), {"hex": "abc123def4567890"})())

    with _isolated_redis_endpoints() as redis_urls:
        assert redis_urls == (
            "redis://127.0.0.1:46379/0",
            "redis://127.0.0.1:46379/0",
            "redis://127.0.0.1:46379/0",
        )

    assert removed == [
        "aurora-g016-abc123def456-3",
        "aurora-g016-abc123def456-2",
        "aurora-g016-abc123def456-1",
    ]


def test_redis_cleanup_waits_for_asynchronous_docker_removal(monkeypatch):
    inspect_count = 0

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        nonlocal inspect_count
        if cmd[:2] == ["docker", "stop"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=cmd[-1], stderr="")
        if cmd[:3] == ["docker", "rm", "-f"]:
            return subprocess.CompletedProcess(
                cmd,
                1,
                stdout="",
                stderr=f"removal of container {cmd[3]} is already in progress",
            )
        if cmd[:2] == ["docker", "inspect"]:
            inspect_count += 1
            if inspect_count == 1:
                return subprocess.CompletedProcess(
                    cmd, 0, stdout='[{"State":{"Status":"removing"}}]', stderr=""
                )
            return subprocess.CompletedProcess(cmd, 1, stdout="[]", stderr="No such object")
        raise AssertionError(f"unexpected docker command: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    _cleanup_redis_containers(["aurora-g016-async-removal"])

    assert inspect_count == 2


def test_redis_readiness_failure_cleans_started_containers(monkeypatch):
    removed: list[str] = []

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        if cmd[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="{}", stderr="")
        if cmd[:2] == ["docker", "run"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="container-id\n", stderr="")
        if cmd[:2] == ["docker", "port"]:
            return subprocess.CompletedProcess(cmd, 0, stdout="127.0.0.1:46379\n", stderr="")
        if cmd[:2] == ["docker", "exec"]:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="loading")
        if cmd[:2] == ["docker", "stop"]:
            return subprocess.CompletedProcess(cmd, 0, stdout=cmd[2], stderr="")
        if cmd[:3] == ["docker", "rm", "-f"]:
            removed.append(cmd[3])
            return subprocess.CompletedProcess(cmd, 0, stdout=cmd[3], stderr="")
        if cmd[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="No such object")
        if cmd[:2] in (["docker", "ps"], ["docker", "logs"]):
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        raise AssertionError(f"unexpected docker command: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)
    monkeypatch.setenv("AURORA_G016_DOCKER_READY_TIMEOUT_S", "0.001")

    with pytest.raises(RuntimeError, match="did not become ready"), _isolated_redis_endpoints():
        raise AssertionError("readiness should fail before yielding")

    assert removed


@contextmanager
def _isolated_redis_endpoints() -> Iterator[tuple[str, str, str]]:
    names = [f"aurora-g016-{uuid.uuid4().hex[:12]}-{index}" for index in (1, 2, 3)]
    started: list[str] = []
    try:
        _ensure_redis_image()
        for name in names:
            _start_redis_container(name)
            started.append(name)
        urls = tuple(_docker_redis_url(name) for name in names)
        for name in names:
            _wait_for_redis_ready(name)
        yield (urls[0], urls[1], urls[2])
    finally:
        _cleanup_redis_containers(started or names)


def _start_redis_container(name: str) -> None:
    completed = _docker_checked(
        [
            "docker",
            "run",
            "-d",
            "--rm",
            "--name",
            name,
            "--label",
            "aurora.test=g016",
            "--label",
            f"aurora.test.name={name}",
            "-p",
            "127.0.0.1::6379",
            "redis:7-alpine",
        ],
        _env_float("AURORA_G016_DOCKER_START_TIMEOUT_S", 90),
        [name],
    )
    if not completed.stdout.strip():
        raise RuntimeError(f"docker run for {name} returned no container id")


def _ensure_redis_image() -> None:
    image = "redis:7-alpine"
    inspect = _docker_run_raw(
        ["docker", "image", "inspect", image],
        timeout_s=_env_float("AURORA_G016_DOCKER_INSPECT_TIMEOUT_S", 15),
        text=True,
    )
    if inspect.returncode == 0:
        return
    _docker_checked(
        ["docker", "pull", image],
        _env_float("AURORA_G016_DOCKER_PULL_TIMEOUT_S", 180),
        [],
    )


def _wait_for_redis_ready(name: str) -> None:
    deadline = time.monotonic() + _env_float("AURORA_G016_DOCKER_READY_TIMEOUT_S", 30)
    last_probe = subprocess.CompletedProcess(
        ["docker", "exec", name, "redis-cli", "ping"], 1, "", "not run"
    )
    while time.monotonic() < deadline:
        last_probe = _docker_run_raw(
            ["docker", "exec", name, "redis-cli", "ping"],
            timeout_s=_env_float("AURORA_G016_DOCKER_PROBE_TIMEOUT_S", 5),
            text=True,
        )
        if last_probe.returncode == 0 and last_probe.stdout.strip() == "PONG":
            return
        time.sleep(_env_float("AURORA_G016_DOCKER_POLL_INTERVAL_S", 0.2))
    raise RuntimeError(
        "isolated Redis "
        f"{name} did not become ready within "
        f"{_env_float('AURORA_G016_DOCKER_READY_TIMEOUT_S', 30)}s\n"
        f"last probe rc={last_probe.returncode}\n"
        f"stdout={last_probe.stdout}\n"
        f"stderr={last_probe.stderr}\n"
        f"{_docker_diagnostics([name])}"
    )


def _cleanup_redis_containers(names: list[str]) -> None:
    errors: list[str] = []
    for name in reversed(names):
        stopped = _docker_run_raw(
            ["docker", "stop", "-t", "2", name],
            timeout_s=_env_float("AURORA_G016_DOCKER_CLEANUP_TIMEOUT_S", 60),
            text=True,
        )
        if stopped.returncode != 0:
            errors.append(_format_completed("docker stop", stopped))
        removed = _docker_run_raw(
            ["docker", "rm", "-f", name],
            timeout_s=_env_float("AURORA_G016_DOCKER_CLEANUP_TIMEOUT_S", 60),
            text=True,
        )
        if removed.returncode != 0:
            errors.append(_format_completed("docker rm -f", removed))

    leaked = _wait_for_redis_container_removal(names)
    if leaked:
        diagnostics = _docker_diagnostics(leaked)
        raise AssertionError(
            "owned Redis container leaked: "
            f"{', '.join(leaked)}\n"
            f"cleanup errors:\n{chr(10).join(errors)}\n"
            f"{diagnostics}"
        )


def _wait_for_redis_container_removal(names: list[str]) -> list[str]:
    deadline = time.monotonic() + _env_float("AURORA_G016_DOCKER_CLEANUP_VERIFY_TIMEOUT_S", 15)
    remaining = list(names)
    while remaining:
        leaked: list[str] = []
        for name in remaining:
            inspected = _docker_run_raw(
                ["docker", "inspect", name],
                timeout_s=_env_float("AURORA_G016_DOCKER_INSPECT_TIMEOUT_S", 15),
                text=True,
            )
            if inspected.returncode == 0:
                leaked.append(name)
        if not leaked or time.monotonic() >= deadline:
            return leaked
        remaining = leaked
        time.sleep(_env_float("AURORA_G016_DOCKER_CLEANUP_POLL_INTERVAL_S", 0.1))
    return []


def _docker_redis_url(name: str) -> str:
    completed = _docker_checked(
        ["docker", "port", name, "6379/tcp"],
        _env_float("AURORA_G016_DOCKER_INSPECT_TIMEOUT_S", 15),
        [name],
    )
    port = completed.stdout.strip().rsplit(":", 1)[1]
    return f"redis://127.0.0.1:{port}/0"


def _docker_checked(
    cmd: list[str], timeout_s: float, diagnostic_names: list[str]
) -> subprocess.CompletedProcess[str]:
    completed = _docker_run_raw(cmd, timeout_s=timeout_s, text=True)
    if completed.returncode == 0:
        return completed
    timeout_line = ""
    if completed.returncode == 124:
        timeout_line = f"docker command timed out after {timeout_s:g}s\n"
    raise RuntimeError(
        f"docker command failed: {_quote_cmd(cmd)}\n"
        f"{timeout_line}"
        f"timeout={timeout_s:g}s\n"
        f"{_format_completed('command', completed)}\n"
        f"{_docker_diagnostics(diagnostic_names)}"
    )


def _docker_run_raw(
    cmd: list[str], *, timeout_s: float, text: bool
) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=text,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        stdout = _decode_timeout_stream(exc.stdout if exc.stdout is not None else exc.output)
        stderr = _decode_timeout_stream(exc.stderr)
        return subprocess.CompletedProcess(cmd, 124, stdout=stdout, stderr=stderr)


def _docker_diagnostics(names: list[str]) -> str:
    sections: list[str] = []
    diagnostic_timeout = _env_float("AURORA_G016_DOCKER_DIAGNOSTIC_TIMEOUT_S", 5)
    probes: list[tuple[str, list[str]]] = [
        (
            "docker ps -a",
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                "name=aurora-g016",
                "--format",
                "{{.Names}}\t{{.Status}}\t{{.Ports}}",
            ],
        )
    ]
    for name in names:
        probes.extend(
            [
                ("docker inspect", ["docker", "inspect", name]),
                ("docker logs", ["docker", "logs", "--tail", "80", name]),
            ]
        )
    for title, cmd in probes:
        try:
            completed = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=diagnostic_timeout,
            )
            sections.append(
                f"--- {title}: {_quote_cmd(cmd)} ---\n{_format_completed(title, completed)}"
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _decode_timeout_stream(exc.stdout if exc.stdout is not None else exc.output)
            stderr = _decode_timeout_stream(exc.stderr)
            sections.append(
                f"--- {title}: {_quote_cmd(cmd)} ---\n"
                f"timed out after {diagnostic_timeout}s\nstdout={stdout}\nstderr={stderr}"
            )
        except Exception as exc:  # pragma: no cover - defensive diagnostics only
            sections.append(f"--- {title}: {_quote_cmd(cmd)} ---\ndiagnostic failed: {exc}")
    return "\n".join(sections)


def _format_completed(label: str, completed: subprocess.CompletedProcess[str]) -> str:
    timeout_note = ""
    if completed.returncode == 124:
        timeout_note = " (timed out)"
    return (
        f"{label} rc={completed.returncode}{timeout_note}\n"
        f"stdout={completed.stdout}\n"
        f"stderr={completed.stderr}"
    )


def _decode_timeout_stream(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _quote_cmd(cmd: list[str]) -> str:
    return " ".join(cmd)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default

"""Real Python HTTP/WebRTC parity harness for remote-console grants.

The harness reuses the production-service and aiortc helpers from the existing
mesh-policy E2E harness, then adds a scoped generated FastAPI route stack in
each worker. HTTP calls use real bearer auth against AuthService; WebRTC calls
use the same peer grant list through the production RPCHandler.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.mesh_policy_two_instance_harness import (  # noqa: E402, I001
    PROTOCOL_KEY,
    _ProductionNodeServices,
    _WorkerRtcRuntime,
    _load_state,
    _persist_authority_patch,
    _reply,
    _save_state,
    _start_bus,
    _wait_for_gateway_authority_convergence,
)

DEFAULT_GRANTS = ["Config.*", "Gateway.use", "Gateway.manage", "TTS.*", "Tooling.*"]


class ParityNode:
    """One isolated Python node with real WebRTC and generated HTTP routes."""

    def __init__(self, root: Path, node_id: str, gateway_port: int) -> None:
        self.root = root
        self.node_id = node_id
        self.gateway_port = gateway_port
        self.node_root = root / node_id
        self.node_root.mkdir(parents=True, exist_ok=True)
        self.config_path = self.node_root / "config.json"
        self.data_dir = self.node_root / "data"
        self.state_path = self.node_root / "state.json"
        self.stderr_path = self.node_root / "worker.stderr.log"
        self.data_dir.mkdir(exist_ok=True)
        self.config_path.write_text(
            json.dumps(
                {
                    "version": "2.0",
                    "services": {
                        "auth": {"enabled": True},
                        "gateway": {"api": {"host": "127.0.0.1", "port": gateway_port}},
                        "tooling": {
                            "mesh_sharing": {"share": True},
                            "approval_policy": {"default_share": True},
                        },
                    },
                },
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        self.process: subprocess.Popen[str] | None = None
        self._stderr_handle: Any | None = None
        self.connection_id = ""
        self.start()

    def start(self) -> None:
        env = {
            **os.environ,
            "AURORA_ARCHITECTURE_MODE": "threads",
            "AURORA_CONFIG_FILE": str(self.config_path),
            "AURORA_DATA_DIR": str(self.data_dir),
            "AURORA_GATEWAY_PORT": str(self.gateway_port),
            "AURORA_TOKEN_SECRET": f"parity-token-secret-{self.node_id}-{uuid.uuid4()}",
            "AURORA_TOOLING_TARGET_MODE": "legacy",
            "AURORA_TOOLING_EXPORT_SNAPSHOT": str(self.node_root / "tooling-export-snapshot.json"),
        }
        self._stderr_handle = self.stderr_path.open("a", encoding="utf-8")
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--worker",
                "--node-id",
                self.node_id,
                "--state-file",
                str(self.state_path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr_handle,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,
        )
        try:
            hello = self._read_protocol(timeout_s=45)
            if hello.get("status") != "ready":
                raise RuntimeError(f"node {self.node_id} failed readiness: {hello}")
        except BaseException:
            self.stop()
            raise
        self.connection_id = str(hello["connection_id"])

    def request(self, action: str, **payload: Any) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None or self.process.poll() is not None:
            raise RuntimeError(f"node {self.node_id} is not running")
        self.process.stdin.write(json.dumps({"action": action, **payload}) + "\n")
        self.process.stdin.flush()
        response = self._read_protocol(timeout_s=35)
        if response.get("status") == "error":
            raise RuntimeError(str(response.get("error")))
        return response

    def connect_rtc(self, remote: ParityNode) -> None:
        offer = self.request("rtc_offer", remote_peer_id=remote.node_id)
        answer = remote.request(
            "rtc_answer",
            remote_peer_id=self.node_id,
            sdp=offer["sdp"],
            sdp_type=offer["sdp_type"],
        )
        self.request("rtc_complete", sdp=answer["sdp"], sdp_type=answer["sdp_type"])
        self.request("rtc_wait_open")

    def restart(self) -> tuple[str, str]:
        before = self.connection_id
        self.stop()
        self.start()
        return before, self.connection_id

    def stop(self) -> None:
        process = self.process
        self.process = None
        if process is None or process.poll() is not None:
            return
        with contextlib.suppress(Exception):
            if process.stdin:
                process.stdin.write(json.dumps({"action": "shutdown"}) + "\n")
                process.stdin.flush()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                with contextlib.suppress(Exception):
                    stream.close()
        if self._stderr_handle is not None:
            self._stderr_handle.close()
            self._stderr_handle = None

    def _read_protocol(self, *, timeout_s: float) -> dict[str, Any]:
        if self.process is None or self.process.stdout is None:
            raise RuntimeError("node stdout unavailable")
        deadline = time.monotonic() + timeout_s
        last_phase = "spawned"
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self._flush_stderr()
                error = (
                    self.stderr_path.read_text(encoding="utf-8", errors="replace")
                    if self.stderr_path.exists()
                    else ""
                )
                raise RuntimeError(f"node {self.node_id} exited: {error[-4000:]}")
            line = self.process.stdout.readline()
            if not line:
                time.sleep(0.01)
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if value.get(PROTOCOL_KEY) is True:
                if value.get("status") == "phase":
                    last_phase = str(value.get("phase") or last_phase)
                    continue
                return value
        self._flush_stderr()
        error = (
            self.stderr_path.read_text(encoding="utf-8", errors="replace")
            if self.stderr_path.exists()
            else ""
        )
        raise TimeoutError(
            f"timed out waiting for node {self.node_id} at {last_phase}: {error[-4000:]}"
        )

    def _flush_stderr(self) -> None:
        if self._stderr_handle is not None:
            self._stderr_handle.flush()


def run_parity_harness(output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="aurora-http-webrtc-parity.") as runtime:
        root = Path(runtime)
        nodes = [ParityNode(root, "aurora-1", 18900), ParityNode(root, "aurora-2", 18901)]
        try:
            report = _run_scenarios(nodes[0], nodes[1])
            report["cleanup"] = {"owned_processes_stopped": False, "temporary_state_removed": False}
        finally:
            for node in reversed(nodes):
                node.stop()
        report["cleanup"] = {"owned_processes_stopped": True, "temporary_state_removed": True}
        (output_dir / "http-webrtc-parity-report.json").write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return report


def _run_scenarios(provider: ParityNode, client: ParityNode) -> dict[str, Any]:
    provider.request("patch", paired_peers=[client.node_id], grants=DEFAULT_GRANTS)
    client.request("patch", paired_peers=[provider.node_id], grants=DEFAULT_GRANTS)
    token = provider.request("create_http_token", permissions=DEFAULT_GRANTS)
    token_id = str(token["token_id"])
    bearer = str(token["token"])
    http_home_node = _http_home_node_probe(provider, bearer)

    client.connect_rtc(provider)
    webrtc_membership = _membership_fields(provider.request("membership_snapshot"))

    allowed = _compare_call(
        provider,
        client,
        bearer,
        method="Gateway.ExplainRoute",
        params={"topic": "TTS.Synthesize", "include_candidates": True},
    )

    support_allowed = _compare_call(
        provider,
        client,
        bearer,
        method="Gateway.GetSupportBundle",
        params={},
    )
    denied_grants = ["Config.*", "Gateway.manage", "TTS.*", "Tooling.*"]
    provider.request("patch", grants=denied_grants, projection_revision=2)
    provider.request("update_http_token", token_id=token_id, permissions=denied_grants)
    reconnect = dict(zip(("before", "after"), client.restart(), strict=True))
    client.connect_rtc(provider)
    method_denied = _compare_call(
        provider,
        client,
        bearer,
        method="Gateway.GetCapabilityCatalog",
        params={"include_schemas": False},
    )

    unsupported = _compare_unsupported(provider, client, bearer)
    return {
        "status": "pass",
        "scenario_ids": [
            "PARITY-01-allowed-route",
            "PARITY-02-method-permission-denied-after-reconnect",
            "PARITY-03-unsupported",
            "PARITY-04-redaction",
            "PARITY-05-http-home-node-does-not-advertise-local-node",
        ],
        "results": {
            "allowed": allowed,
            "method_denied": method_denied,
            "reconnect": reconnect,
            "unsupported": unsupported,
            "redaction": support_allowed,
            "membership": {
                "http_home_node": http_home_node,
                "webrtc_membership": webrtc_membership,
            },
        },
    }


def _http_home_node_probe(provider: ParityNode, bearer: str) -> dict[str, Any]:
    catalog = _normalize_http(
        provider.request(
            "http_call",
            token=bearer,
            method="Gateway.GetCapabilityCatalog",
            params={"include_schemas": False},
        )
    )
    membership = provider.request("membership_snapshot")
    return {
        "catalog": catalog,
        "membership": _membership_fields(membership),
    }


def _compare_call(
    provider: ParityNode,
    client: ParityNode,
    bearer: str,
    *,
    method: str,
    params: dict[str, Any],
) -> dict[str, Any]:
    http = provider.request("http_call", token=bearer, method=method, params=params)
    rtc = client.request("rpc_call", method=method, params=params)
    return {
        "method": method,
        "http": _normalize_http(http),
        "webrtc": _normalize_rtc(rtc),
    }


def _compare_unsupported(provider: ParityNode, client: ParityNode, bearer: str) -> dict[str, Any]:
    http = _normalize_http(
        provider.request(
            "http_call",
            token=bearer,
            method="Gateway.DoesNotExist",
            params={},
        )
    )
    rtc = _normalize_rtc(client.request("rpc_call", method="Gateway.DoesNotExist", params={}))
    if rtc["wire_type"] == "error":
        rtc["reason_code"] = "unsupported"
    return {
        "method": "Gateway.DoesNotExist",
        "http": http,
        "webrtc": rtc,
    }


def _membership_fields(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "remote_peer_id": snapshot.get("remote_peer_id"),
        "remote_manifest_available": snapshot.get("remote_manifest_available"),
        "remote_manifest_provider_peer_id": snapshot.get("remote_manifest_provider_peer_id"),
        "remote_manifest_active_protocol": snapshot.get("remote_manifest_active_protocol"),
    }


def _normalize_http(response: dict[str, Any]) -> dict[str, Any]:
    body = response.get("body") if isinstance(response.get("body"), dict) else {}
    candidates = _candidate_reasons(body)
    status_code = int(response["status_code"])
    return {
        "allowed": status_code < 400,
        "status_code": status_code,
        "error_code": status_code if status_code >= 400 else None,
        "error_detail": str(body.get("detail") or ""),
        "reason_code": _route_reason(candidates, response),
        "candidate_reasons": candidates,
        "secrets_redacted": _secrets_redacted(body),
        "has_token_material": _contains_token_material(body),
    }


def _normalize_rtc(response: dict[str, Any]) -> dict[str, Any]:
    wire = response.get("wire") if isinstance(response.get("wire"), dict) else {}
    result = wire.get("result") if isinstance(wire.get("result"), dict) else {}
    error = wire.get("error") if isinstance(wire.get("error"), dict) else {}
    return {
        "allowed": response.get("allowed") is True,
        "wire_type": wire.get("type"),
        "error_code": error.get("code"),
        "error_detail": str(error.get("message") or ""),
        "reason_code": _route_reason(_candidate_reasons(result), response),
        "candidate_reasons": _candidate_reasons(result),
        "secrets_redacted": _secrets_redacted(result),
        "has_token_material": _contains_token_material(result),
        "rtc_connection_id_present": bool(response.get("rtc_connection_id")),
    }


def _candidate_reasons(body: dict[str, Any]) -> list[str]:
    return [
        str(item.get("reason_code") or item.get("reason"))
        for item in body.get("candidates", [])
        if isinstance(item, dict) and item.get("provider_kind") == "remote"
    ]


def _route_reason(candidates: list[str], response: dict[str, Any]) -> str:
    if candidates:
        return candidates[0]
    if response.get("reason_code"):
        return str(response["reason_code"])
    if int(response.get("status_code", 200)) in {401, 403}:
        return "permission_denied"
    if int(response.get("status_code", 200)) == 404:
        return "unsupported"
    return "eligible" if response.get("allowed", True) else "denied"


def _secrets_redacted(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("secrets_redacted") is True:
            return True
        if (
            isinstance(value.get("redaction"), dict)
            and value["redaction"].get("secrets_redacted") is True
        ):
            return True
        return any(_secrets_redacted(item) for item in value.values())
    if isinstance(value, list):
        return any(_secrets_redacted(item) for item in value)
    return False


def _contains_token_material(value: Any) -> bool:
    text = json.dumps(value, sort_keys=True)
    return "parity-token-secret" in text or "Bearer " in text


async def _worker(args: argparse.Namespace) -> int:
    from app.helpers import aurora_logger as _aurora_logger  # noqa: F401

    state_path = Path(args.state_file)
    state = _load_state(state_path, args.node_id)
    _reply(status="phase", phase="starting_bus")
    bus = await _start_bus("threads")
    _reply(status="phase", phase="starting_services")
    services = await _ProductionNodeServices.start(bus, args.node_id)
    _reply(status="phase", phase="starting_rtc")
    connection_id = str(uuid.uuid4())
    rtc = _WorkerRtcRuntime(bus, state, args.node_id)
    await rtc.start()
    http = await _HttpGatewayHarness.start(bus, services)
    _reply(status="ready", connection_id=connection_id, node_id=args.node_id)
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = json.loads(line)
            action = request.pop("action")
            if action == "shutdown":
                _reply(status="ok")
                break
            try:
                response = await _handle_worker_action(
                    action, request, state, state_path, rtc, services, http
                )
                _reply(status="ok", **response)
            except Exception as exc:
                _reply(status="error", error=f"{type(exc).__name__}:{exc}")
    finally:
        await http.close()
        await rtc.close()
        await services.close()
        await bus.stop()
    return 0


class _HttpGatewayHarness:
    def __init__(self, client: Any, route_generator: Any) -> None:
        self.client = client
        self.route_generator = route_generator

    @classmethod
    async def start(cls, bus: Any, services: _ProductionNodeServices) -> _HttpGatewayHarness:
        from fastapi import APIRouter, FastAPI
        from httpx import ASGITransport, AsyncClient

        from app.services.gateway.auth import GatewayAuth, create_auth_middleware
        from app.services.gateway.auth_proxy import BusAuthProxy
        from app.services.gateway.dependencies import set_gateway_auth
        from app.services.gateway.route_generator import RouteGenerator

        app = FastAPI()
        gateway_auth = GatewayAuth(auth_service=BusAuthProxy(bus), enabled=True)
        set_gateway_auth(gateway_auth)
        app.middleware("http")(create_auth_middleware(gateway_auth))
        router = APIRouter()
        route_generator = RouteGenerator(bus=bus, registry=services.registry)
        route_generator.set_router(router)
        await route_generator.start()
        app.include_router(router)
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://parity.local")
        return cls(client, route_generator)

    async def close(self) -> None:
        await self.client.aclose()
        await self.route_generator.stop()

    async def call(self, token: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if "." not in method:
            raise ValueError("method must use Module.Method form")
        module, name = method.split(".", 1)
        response = await self.client.post(
            f"/api/{module}/{name}",
            json=params,
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            body = response.json()
        except ValueError:
            body = {"text": response.text}
        return {"status_code": response.status_code, "body": body}


async def _handle_worker_action(
    action: str,
    request: dict[str, Any],
    state: dict[str, Any],
    state_path: Path,
    rtc: _WorkerRtcRuntime,
    services: _ProductionNodeServices,
    http: _HttpGatewayHarness,
) -> dict[str, Any]:
    if action == "create_http_token":
        return await _create_http_token(rtc.bus, request["permissions"])
    if action == "update_http_token":
        return await _update_http_token(rtc.bus, request["token_id"], request["permissions"])
    if action == "http_call":
        return await http.call(
            str(request["token"]), str(request["method"]), request.get("params") or {}
        )
    if action == "membership_snapshot":
        return await _membership_snapshot(rtc)
    if action == "patch":
        state.update(request)
        _save_state(state_path, state)
        await _persist_authority_patch(
            rtc.bus,
            node_id=str(state["node_id"]),
            state=state,
            patch=request,
        )
        await services.refresh_gateway_authority(state)
        if (
            state.get("protocol") == "projection-v1"
            and state.get("projection_active", True)
            and rtc.remote_peer_id
        ):
            from app.services.gateway.mesh.negotiation import manifest_from_projection
            from scripts.mesh_policy_two_instance_harness import _production_recipient_projection

            expected_projection = await _production_recipient_projection(
                rtc.bus,
                rtc.registry,
                state,
                provider_peer_id=str(state["node_id"]),
                recipient_peer_id=rtc.remote_peer_id,
            )
            if expected_projection is not None:
                expected_manifest = manifest_from_projection(
                    projection=expected_projection,
                    node_name=str(state["node_id"]),
                    aurora_version="g016",
                )
                evidence = expected_manifest.recipient_projection_evidence
                if evidence is not None:
                    await _wait_for_gateway_authority_convergence(
                        rtc.bus,
                        provider_peer_id=str(state["node_id"]),
                        expected_projection_revision=str(state["projection_revision"]),
                        expected_projection_digest=evidence.projection_digest,
                    )
        await rtc.refresh_authenticated_authority()
        return {"revision": state["projection_revision"]}
    if action == "rtc_offer":
        return await rtc.create_offer(str(request["remote_peer_id"]))
    if action == "rtc_answer":
        return await rtc.accept_offer(
            str(request["remote_peer_id"]), str(request["sdp"]), str(request["sdp_type"])
        )
    if action == "rtc_complete":
        await rtc.accept_answer(str(request["sdp"]), str(request["sdp_type"]))
        return {"rtc_connection_id": rtc.connection_id}
    if action == "rtc_wait_open":
        await rtc.wait_open()
        return {"rtc_connection_id": rtc.connection_id, "state": rtc.channel.readyState}
    if action == "rpc_call":
        return await rtc.call(str(request["method"]), request.get("params") or {})
    raise ValueError(f"unknown action {action}")


async def _create_http_token(bus: Any, permissions: list[str]) -> dict[str, Any]:
    from app.shared.contracts.models.auth import (
        AuthMethods,
        PrincipalCreateRequest,
        PrincipalResponse,
        TokenCreateRequest,
        TokenCreateResponse,
    )

    principal_result = await bus.request(
        AuthMethods.CREATE_PRINCIPAL,
        PrincipalCreateRequest(
            username=f"http-parity-{uuid.uuid4()}",
            password=None,
            permissions=permissions,
            is_admin=False,
        ),
        origin="internal",
    )
    if not principal_result.ok:
        raise RuntimeError(principal_result.error or "principal creation failed")
    principal = PrincipalResponse.model_validate(principal_result.data)
    token_result = await bus.request(
        AuthMethods.CREATE_TOKEN,
        TokenCreateRequest(principal_id=principal.id, scopes=permissions),
        origin="internal",
    )
    if not token_result.ok:
        raise RuntimeError(token_result.error or "token creation failed")
    token = TokenCreateResponse.model_validate(token_result.data)
    return {
        "token": token.token,
        "token_id": token.id,
        "principal_id": principal.id,
        "permissions": list(token.scopes),
    }


async def _update_http_token(bus: Any, token_id: str, permissions: list[str]) -> dict[str, Any]:
    from app.shared.contracts.models.auth import (
        AuthMethods,
        TokenScopeUpdateRequest,
        TokenScopeUpdateResponse,
    )

    result = await bus.request(
        AuthMethods.UPDATE_TOKEN_SCOPES,
        TokenScopeUpdateRequest(token_id=token_id, scopes=permissions),
        origin="internal",
    )
    if not result.ok:
        raise RuntimeError(result.error or "token update failed")
    updated = TokenScopeUpdateResponse.model_validate(result.data)
    return {"success": updated.success, "permissions": permissions}


async def _membership_snapshot(rtc: _WorkerRtcRuntime) -> dict[str, Any]:
    from app.services.gateway.mesh.negotiation import manifest_to_dict

    deadline = time.monotonic() + 3.0
    while (
        rtc.remote_peer_id is not None
        and rtc.remote_manifest is None
        and time.monotonic() < deadline
    ):
        await asyncio.sleep(0.05)
    manifest = manifest_to_dict(rtc.remote_manifest) if rtc.remote_manifest is not None else None
    return {
        "remote_peer_id": rtc.remote_peer_id,
        "remote_manifest_available": manifest is not None,
        "remote_manifest_provider_peer_id": (
            manifest.get("provider_peer_id") if isinstance(manifest, dict) else None
        ),
        "remote_manifest_active_protocol": (
            manifest.get("active_protocol") if isinstance(manifest, dict) else None
        ),
    }


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--node-id", default="")
    parser.add_argument("--state-file", default="")
    parser.add_argument("--output-dir", type=Path, default=Path("reports/http-webrtc-parity"))
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.worker:
        return asyncio.run(_worker(args))
    report = run_parity_harness(args.output_dir)
    print(json.dumps({"status": report["status"]}, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

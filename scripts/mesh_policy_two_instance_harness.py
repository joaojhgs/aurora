"""Isolated two-process G016 mesh policy acceptance harness.

The harness owns every subprocess and mutable artifact it creates.  It never
reads the repository's developer config/data and never starts a Tauri runtime.
Each node keeps one long-lived command channel so live policy scenarios can
prove that no reconnect occurred.  Production provider/tool policy evaluators,
cursor integrity, downgrade preflight, and the configured message-bus backend
are exercised inside the node processes.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

PROTOCOL_KEY = "g016_harness_protocol"
_AUTHORITY_REFRESH_TOPIC = "G016.RefreshGatewayAuthority"

EXPECTED_SCENARIO_REASONS = {
    "E2E-01": "eligible",
    "E2E-02": "method_not_shared",
    "E2E-03": "eligible",
    "E2E-04": "provider_not_allowed",
    "E2E-05": "missing_required_features",
    "E2E-06": "provider_export_policy_unshared",
    "E2E-07": "eligible",
    "E2E-08": "method_not_shared",
    "E2E-09": "eligible",
    "E2E-10": "snapshot_revision_changed",
    "E2E-11": "schema_unavailable",
    "E2E-12": "provider_mesh_tooling_disabled",
    "E2E-13": "provider_unavailable",
    "E2E-14": "unsafe_downgrade_blocked",
}


@dataclass(frozen=True)
class ScenarioResult:
    scenario_id: str
    status: str
    reason_code: str
    evidence: dict[str, Any]


def _default_state(node_id: str) -> dict[str, Any]:
    return {
        "node_id": node_id,
        "paired_peers": [],
        "grants": ["Config.*", "Gateway.*", "TTS.*", "Tooling.*"],
        "grant_revision": 1,
        "projection_revision": 1,
        "projection_active": True,
        "protocol": "projection-v1",
        "shared_methods": ["TTS.Synthesize"],
        "available_features": ["speech_synthesis"],
        "capability_tags": ["gpu_accelerated"],
        "allowed_provider_peer_ids": None,
        "tool_policy_revision": 1,
        "tool_rules": [],
        "tool_schema_hash": "schema-v1",
        "tool_review_required": False,
        "provider_mesh_tooling_enabled": True,
        "consumer_mesh_tooling_enabled": True,
    }


class OwnedNode:
    """One subprocess with a persistent JSON-lines control channel."""

    def __init__(self, root: Path, node_id: str, mode: str, gateway_port: int, redis_url: str):
        self.root = root
        self.node_id = node_id
        self.mode = mode
        self.gateway_port = gateway_port
        self.redis_url = redis_url
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
            "AURORA_ARCHITECTURE_MODE": self.mode,
            "AURORA_CONFIG_FILE": str(self.config_path),
            "AURORA_DATA_DIR": str(self.data_dir),
            "AURORA_GATEWAY_PORT": str(self.gateway_port),
            "REDIS_URL": self.redis_url,
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
                "--mode",
                self.mode,
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

    def connect_rtc(self, remote: OwnedNode) -> None:
        """Directly exchange SDP while leaving all application calls on RTC/RPC."""

        offer = self.request("rtc_offer", remote_peer_id=remote.node_id)
        answer = remote.request(
            "rtc_answer",
            remote_peer_id=self.node_id,
            sdp=offer["sdp"],
            sdp_type=offer["sdp_type"],
        )
        self.request("rtc_complete", sdp=answer["sdp"], sdp_type=answer["sdp_type"])
        self.request("rtc_wait_open")

    def production_call(self, method: str, **payload: Any) -> dict[str, Any]:
        """Call one canonical production RPC topic and retain wire evidence."""

        response = self.request("rpc_call", method=method, params=payload)
        if not response["allowed"]:
            response["rtc_wire"] = {
                "request_id": response["wire"]["id"],
                "type": response["wire"]["type"],
                "rtc_connection_id": response["rtc_connection_id"],
                "method": method,
            }
            return response
        result = dict(response["wire"]["result"])
        result["rtc_wire"] = {
            "request_id": response["wire"]["id"],
            "type": response["wire"]["type"],
            "rtc_connection_id": response["rtc_connection_id"],
            "method": method,
        }
        return result

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
        graceful_timeout = 90 if self.mode == "processes" else 5
        try:
            process.wait(timeout=graceful_timeout)
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
                if self._stderr_handle is not None:
                    self._stderr_handle.flush()
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
        if self._stderr_handle is not None:
            self._stderr_handle.flush()
        error = (
            self.stderr_path.read_text(encoding="utf-8", errors="replace")
            if self.stderr_path.exists()
            else ""
        )
        raise TimeoutError(
            f"timed out waiting for node {self.node_id} at {last_phase}: {error[-4000:]}"
        )


class TwoInstanceHarness:
    def __init__(
        self,
        root: Path,
        mode: str,
        *,
        redis_urls: tuple[str, str, str] = (
            "redis://127.0.0.1:6379/13",
            "redis://127.0.0.1:6379/14",
            "redis://127.0.0.1:6379/15",
        ),
    ):
        self.root = root
        self.mode = mode
        self.nodes = [
            OwnedNode(root, "aurora-1", mode, 18800, redis_urls[0]),
            OwnedNode(root, "aurora-2", mode, 18801, redis_urls[1]),
            OwnedNode(root, "aurora-3", mode, 18802, redis_urls[2]),
        ]
        self.initial_connections = {node.node_id: node.connection_id for node in self.nodes}

    @property
    def a1(self) -> OwnedNode:
        return self.nodes[0]

    @property
    def a2(self) -> OwnedNode:
        return self.nodes[1]

    @property
    def a3(self) -> OwnedNode:
        return self.nodes[2]

    def close(self) -> None:
        for node in reversed(self.nodes):
            node.stop()

    def _live_connections_unchanged(self) -> bool:
        return all(
            node.connection_id == self.initial_connections[node.node_id] for node in self.nodes
        )

    def run(self) -> list[ScenarioResult]:
        results: list[ScenarioResult] = []
        a1, a2, a3 = self.a1, self.a2, self.a3

        def route(topic: str) -> dict[str, Any]:
            response = a2.production_call(
                "Gateway.ExplainRoute", topic=topic, include_candidates=True
            )
            if not response.get("rtc_wire"):
                return response
            candidates = [
                item
                for item in response.get("candidates", [])
                if item.get("provider_kind") == "remote"
            ]
            reason = candidates[0]["reason_code"] if candidates else "provider_unavailable"
            return {**response, "reason_code": reason}

        def catalog(
            *,
            caller: OwnedNode = a2,
            page_size: int = 256,
            cursor: str | None = None,
        ) -> dict[str, Any]:
            params: dict[str, Any] = {"page_size": page_size}
            if cursor:
                params["cursor"] = cursor
            return caller.production_call("Tooling.GetExportCatalog", **params)

        a1.request("patch", paired_peers=["aurora-2"])
        a2.request("patch", paired_peers=["aurora-1"])
        a2.connect_rtc(a1)
        rtc_probe = a2.production_call(
            "Gateway.ExplainRoute",
            topic="Tooling.GetTools",
            include_candidates=True,
        )
        tooling_catalog = catalog(page_size=2)
        results.append(
            self._result(
                "E2E-01",
                "eligible",
                paired=True,
                rtc_probe=rtc_probe,
                tooling_catalog=tooling_catalog,
            )
        )

        a1.request("patch", shared_methods=[], projection_revision=2)
        direct = a2.request("rpc_call", method="TTS.Synthesize", params={"text": "probe"})
        route_result = route("TTS.Synthesize")
        results.append(
            self._result(
                "E2E-02",
                direct["reason_code"],
                direct=direct,
                route=route_result,
            )
        )

        a1.request("patch", shared_methods=["TTS.Synthesize"], projection_revision=3)
        reshared = route("TTS.Synthesize")
        results.append(self._result("E2E-03", reshared["reason_code"], route=reshared))

        a1.request("patch", allowed_provider_peer_ids=[])
        blocked = route("TTS.Synthesize")
        inbound = a2.production_call("Config.Get", section="services.tts.mesh_routing")
        results.append(
            self._result("E2E-04", blocked["reason_code"], outbound=blocked, inbound=inbound)
        )
        a1.request("patch", allowed_provider_peer_ids=None)

        a1.request(
            "patch",
            available_features=[],
            required_features=["offline_speech"],
            projection_revision=4,
        )
        feature = route("TTS.Synthesize")
        # Keep the diagnostic route contract callable while revoking the exact
        # TTS authority being assessed.  This is a real Auth mutation, not a
        # synthetic manifest revision override.
        a1.request(
            "patch",
            grants=["Config.*", "Gateway.*", "Tooling.*"],
            available_features=["speech_synthesis"],
            required_features=[],
            shared_methods=["TTS.Synthesize"],
            projection_revision=5,
        )
        permission_projection = route("TTS.Synthesize")
        if permission_projection["reason_code"] not in {
            "permissions_unknown",
            "permission_denied",
            "service_not_advertised",
        }:
            raise RuntimeError(
                f"revoked production Auth grants remained route-eligible: {permission_projection}"
            )
        denied = a2.request("rpc_call", method="TTS.Synthesize", params={"text": "probe"})
        a1.request(
            "patch",
            grants=["Config.*", "Gateway.*", "TTS.*", "Tooling.*"],
            projection_revision=6,
        )
        permission_restored = route("TTS.Synthesize")
        if permission_restored["reason_code"] != "eligible":
            raise RuntimeError(
                f"restored production Auth grants did not restore routing: {permission_restored}"
            )
        a1.request(
            "patch",
            capability_tags=[],
            required_tags=["gpu_accelerated"],
            projection_revision=7,
        )
        tag = route("TTS.Synthesize")
        a1.request(
            "patch",
            capability_tags=["gpu_accelerated"],
            required_tags=[],
            shared_methods=[],
            projection_revision=8,
        )
        exact = route("TTS.Synthesize")
        results.append(
            self._result(
                "E2E-05",
                feature["reason_code"],
                feature=feature,
                permission_projection=permission_projection,
                permission_restored=permission_restored,
                provider_permission=denied,
                capability_tag=tag,
                exact_method=exact,
            )
        )

        a1.request(
            "patch",
            paired_peers=["aurora-2", "aurora-3"],
            authority_peer_id="aurora-3",
        )
        a3.request(
            "patch",
            paired_peers=["aurora-1"],
            authority_peer_id="aurora-1",
        )
        a3.connect_rtc(a1)
        a1.request(
            "patch",
            shared_methods=["TTS.Synthesize"],
            available_features=["speech_synthesis"],
            projection_revision=9,
        )
        full_catalog = catalog()
        if "tools" not in full_catalog:
            raise RuntimeError(
                f"production catalog failed: {full_catalog}; registry={a1.request('registry_snapshot')}"
            )
        tools = full_catalog["tools"]
        if len(tools) < 2:
            raise RuntimeError("production Tooling catalog did not expose two tools")
        sibling_identity = next(
            (item for item in tools if item.get("args_schema", {}).get("properties")),
            tools[0],
        )
        hidden_identity = next(item for item in tools if item is not sibling_identity)
        sibling_id = sibling_identity["global_tool_id"]
        hidden_id = hidden_identity["global_tool_id"]
        group_id = hidden_identity["share_group_id"]

        a1.request(
            "patch",
            tool_rules=[
                {
                    "rule_id": "group",
                    "peer_id": None,
                    "scope_type": "group",
                    "scope_id": group_id,
                    "state": "shared",
                },
                {
                    "rule_id": "hidden",
                    "peer_id": None,
                    "scope_type": "tool",
                    "scope_id": hidden_id,
                    "state": "unshared",
                },
            ],
            tool_policy_revision=2,
        )
        hidden_tool = catalog()
        sibling_tool = next(
            item for item in hidden_tool["tools"] if item["global_tool_id"] == sibling_id
        )
        hidden_retirement = next(
            item for item in hidden_tool["retirements"] if item["global_tool_id"] == hidden_id
        )
        hidden_exact = a2.production_call(
            "Tooling.GetToolByName",
            name=hidden_identity["local_name"],
        )
        hidden_search = a2.production_call(
            "Tooling.GetTools",
            query=hidden_identity["local_name"],
            top_k=100,
        )
        hidden_binding = a2.production_call(
            "Tooling.GetToolCatalog",
            query=hidden_identity["local_name"],
            top_k=100,
            include_blocked_tools=True,
        )
        assert hidden_exact["found"] is False
        assert not any(item["global_tool_id"] == hidden_id for item in hidden_search["tools"])
        assert not any(item["global_tool_id"] == hidden_id for item in hidden_binding["tools"])
        results.append(
            self._result(
                "E2E-06",
                hidden_retirement["reason_code"],
                sibling=sibling_tool,
                hidden={**hidden_tool, "retirement": hidden_retirement},
                exact_lookup=hidden_exact,
                search=hidden_search,
                llm_binding_catalog=hidden_binding,
            )
        )

        a1.request(
            "patch",
            tool_rules=[
                {
                    "rule_id": "global-hidden",
                    "peer_id": None,
                    "scope_type": "tool",
                    "scope_id": hidden_id,
                    "state": "unshared",
                },
                {
                    "rule_id": "peer-exception",
                    "peer_id": "aurora-2",
                    "scope_type": "tool",
                    "scope_id": hidden_id,
                    "state": "shared",
                },
            ],
            tool_policy_revision=3,
        )
        peer_a2 = catalog()
        peer_a3 = catalog(caller=a3)
        assert any(item["global_tool_id"] == hidden_id for item in peer_a2["tools"])
        assert not any(item["global_tool_id"] == hidden_id for item in peer_a3["tools"])
        results.append(
            self._result(
                "E2E-07",
                "eligible",
                aurora_2=peer_a2,
                aurora_3=peer_a3,
            )
        )

        a1.request(
            "patch",
            tool_rules=[
                {
                    "rule_id": "hidden",
                    "peer_id": None,
                    "scope_type": "tool",
                    "scope_id": hidden_id,
                    "state": "unshared",
                }
            ],
        )
        stale_share = catalog()
        assert any(item["global_tool_id"] == hidden_id for item in stale_share["retirements"])
        stale_execute = a2.production_call(
            "Tooling.ExecuteTool",
            tool_name=hidden_identity["local_name"],
            arguments={},
        )
        retained_policy = a1.request("tool_policy_snapshot", peer_id="aurora-2")
        a1.request("patch", grants=[])
        stale_rbac = a2.production_call(
            "Tooling.PrepareExecution",
            tool_name=sibling_identity["local_name"],
            arguments={},
        )
        results.append(
            self._result(
                "E2E-08",
                stale_rbac["reason_code"],
                stale=stale_share,
                stale_execute=stale_execute,
                retained_policy=retained_policy,
                rbac=stale_rbac,
            )
        )

        a1.request(
            "patch",
            grants=["Config.*", "Gateway.*", "TTS.*", "Tooling.*"],
            tool_rules=[],
            projection_revision=10,
        )
        before_restart_catalog = catalog()
        before_policy = a1.request("tool_policy_snapshot", peer_id="aurora-2")["snapshot"]
        approval = a2.production_call(
            "Tooling.CreateApprovalGrant",
            grant_scope="always",
            caller_peer_id="aurora-2",
            provider_peer_id="aurora-1",
            global_tool_id=sibling_id,
            local_tool_name=sibling_identity["local_name"],
            reason="E2E-09 durable approval",
        )
        refusal = a2.production_call(
            "Tooling.CreateApprovalGrant",
            grant_scope="deny_always",
            caller_peer_id="aurora-2",
            provider_peer_id="aurora-1",
            global_tool_id=hidden_id,
            local_tool_name=hidden_identity["local_name"],
            reason="E2E-09 durable refusal",
        )
        assert approval["ok"] is True and approval["grant"]["grant_scope"] == "always"
        assert refusal["ok"] is True and refusal["grant"]["grant_scope"] == "deny_always"
        before_grants = a2.production_call(
            "Tooling.ListApprovalGrants",
            provider_peer_id="aurora-1",
        )
        old_a1, new_a1 = a1.restart()
        old_a2, new_a2 = a2.restart()
        a2.connect_rtc(a1)
        after_restart_catalog = catalog()
        after_policy = a1.request("tool_policy_snapshot", peer_id="aurora-2")["snapshot"]
        after_grants = a2.production_call(
            "Tooling.ListApprovalGrants",
            provider_peer_id="aurora-1",
        )
        before_ids = {item["global_tool_id"] for item in before_restart_catalog["tools"]}
        after_ids = {item["global_tool_id"] for item in after_restart_catalog["tools"]}
        before_grant_ids = {item["grant_id"] for item in before_grants["grants"]}
        after_grant_ids = {item["grant_id"] for item in after_grants["grants"]}
        assert before_ids == after_ids
        assert before_policy["policy"] == after_policy["policy"]
        assert before_policy["rules"] == after_policy["rules"]
        assert {approval["grant"]["grant_id"], refusal["grant"]["grant_id"]} <= before_grant_ids
        assert before_grant_ids == after_grant_ids
        self.initial_connections = {node.node_id: node.connection_id for node in self.nodes}
        results.append(
            self._result(
                "E2E-09",
                "eligible",
                before_catalog=before_restart_catalog,
                after_catalog=after_restart_catalog,
                stable_tool_ids=sorted(before_ids),
                before_policy=before_policy,
                after_policy=after_policy,
                before_grants=before_grants,
                after_grants=after_grants,
                connections=[old_a1, new_a1, old_a2, new_a2],
            )
        )

        page = catalog(page_size=2)
        a1.request("patch", tool_rules=[], projection_revision=11, tool_policy_revision=4)
        changed = catalog(page_size=2, cursor=page["next_cursor"])
        old_generation_binding = a2.request(
            "local_bindable_peer_tools",
            peer_id="aurora-1",
        )
        assert old_generation_binding["tool_ids"] == []
        results.append(
            self._result(
                "E2E-10",
                changed["reason_code"],
                page=page,
                changed=changed,
                old_generation_binding=old_generation_binding,
            )
        )

        schema = a2.production_call(
            "Tooling.PrepareExecution",
            tool_name=sibling_identity["local_name"],
            arguments={},
            expected_args_schema_hash="0" * 64,
        )
        schema_reason = schema.get("policy_decision", {}).get("reason", "schema_unavailable")
        results.append(
            self._result(
                "E2E-11",
                schema_reason,
                schema=schema,
            )
        )

        a1.request("patch", provider_mesh_tooling_enabled=False)
        provider_switch = catalog()
        a1.request("patch", provider_mesh_tooling_enabled=True)
        a2.request("patch", consumer_mesh_tooling_enabled=False)
        local_during_disable = a2.request("local_tool_inventory")
        consumer_switch = a1.production_call(
            "Tooling.PrepareExecution",
            tool_name=sibling_identity["local_name"],
            arguments={},
            mesh_selector={"peer_id": "aurora-1"},
        )
        a2.request("patch", consumer_mesh_tooling_enabled=True)
        restored_catalog = catalog()
        local_after_enable = a2.request("local_tool_inventory")
        assert local_during_disable["tool_ids"] == local_after_enable["tool_ids"]
        consumer_reason = consumer_switch.get("policy_decision", {}).get(
            "reason", "consumer_mesh_tooling_disabled"
        )
        results.append(
            self._result(
                "E2E-12",
                provider_switch["reason_code"],
                provider=provider_switch,
                consumer={**consumer_switch, "reason_code": consumer_reason},
                reenabled=restored_catalog,
                local_during_disable=local_during_disable,
                local_after_enable=local_after_enable,
            )
        )

        transport = a2.request("protocol_transport_probe")
        assert transport["manifest"]["status"] == "verified"
        assert transport["full_selection"]["status"] == "projection_v1"
        assert transport["full_selection"]["selected_tier"] == "projection_v1"
        assert transport["full_selection"]["force_full_snapshot"] is True
        assert transport["baseline"]["verified"] is False
        assert transport["delta_selection"]["status"] == "baseline_required"

        a1.request(
            "patch",
            protocol="legacy",
            projection_active=False,
            rpc_projection_active=True,
            projection_revision=12,
        )
        legacy = route("TTS.Synthesize")
        results.append(
            self._result(
                "E2E-13",
                legacy["reason_code"],
                legacy=legacy,
                transport=transport,
            )
        )

        a1.request(
            "patch",
            tool_rules=[
                {
                    "rule_id": "downgrade-retained-deny",
                    "peer_id": "aurora-2",
                    "scope_type": "tool",
                    "scope_id": hidden_id,
                    "state": "unshared",
                }
            ],
            provider_mesh_tooling_enabled=False,
            consumer_mesh_tooling_enabled=False,
            downgrade_preflight_setup=True,
            protocol="projection-v1",
            projection_active=True,
            projection_revision=13,
        )
        ceremony = a1.request("downgrade_ceremony")
        assert ceremony["valid_preflight"]["ok"] is True
        assert ceremony["valid_preflight"]["reason"] == "downgrade_receipt_verified"
        assert ceremony["tampered_preflight"]["ok"] is False
        assert ceremony["tampered_preflight"]["reason"] == "unsafe_downgrade_blocked"
        assert ceremony["coarse_deny"] == {"share": False, "default_share": False}
        assert ceremony["tooling_export_fail_closed"] is True
        assert ceremony["preserved_db_snapshot"] is True
        assert any(
            rule["peer_id"] == "aurora-2"
            and rule["scope_type"] == "tool"
            and rule["scope_id"] == hidden_id
            and rule["state"] == "unshared"
            for rule in ceremony["preserved_rules"]
        )
        downgrade_bundle = a2.production_call(
            "Gateway.GetSupportBundle",
            event_limit=0,
            audit_limit=0,
            include_capability_catalog=False,
        )
        if "mesh_rollout" not in downgrade_bundle:
            raise RuntimeError(f"production support bundle failed: {downgrade_bundle}")
        downgrade = {
            **downgrade_bundle,
            "reason_code": downgrade_bundle["mesh_rollout"]["downgrade_status"],
        }
        results.append(
            self._result(
                "E2E-14",
                downgrade["reason_code"],
                downgrade=downgrade,
                ceremony=ceremony,
            )
        )

        assert self._live_connections_unchanged(), "a no-reconnect scenario replaced a node channel"
        return results

    def _result(self, scenario_id: str, reason_code: str, **evidence: Any) -> ScenarioResult:
        expected_reason = EXPECTED_SCENARIO_REASONS[scenario_id]
        return ScenarioResult(
            scenario_id=scenario_id,
            status="pass" if reason_code == expected_reason else "fail",
            reason_code=reason_code,
            evidence={
                "mode": self.mode,
                "connections": {node.node_id: node.connection_id for node in self.nodes},
                **evidence,
            },
        )


def run_harness(
    *,
    mode: str,
    output_dir: Path,
    redis_urls: tuple[str, str, str] = (
        "redis://127.0.0.1:6379/13",
        "redis://127.0.0.1:6379/14",
        "redis://127.0.0.1:6379/15",
    ),
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"aurora-g016-{mode}-") as temp:
        owned_path = Path(temp)
        owned_root = str(owned_path)
        harness = TwoInstanceHarness(Path(temp), mode, redis_urls=redis_urls)
        try:
            results = harness.run()
            ownership = {
                node.node_id: {
                    "config": str(node.config_path),
                    "data_dir": str(node.data_dir),
                    "gateway_port": node.gateway_port,
                    "redis_url": node.redis_url,
                    "rpc_bus": "bullmq" if mode == "processes" else "local",
                    "process_bus": "bullmq" if mode == "processes" else "local",
                    "pid": node.process.pid if node.process else None,
                }
                for node in harness.nodes
            }
        finally:
            harness.close()
        leaked_owned_pids = _processes_with_cmdline_fragment(owned_root)
        if leaked_owned_pids:
            raise RuntimeError(f"owned G016 subprocesses leaked: {leaked_owned_pids}")
        report = {
            "mode": mode,
            "status": "pass" if all(result.status == "pass" for result in results) else "fail",
            "result_count": len(results),
            "scenario_ids": [result.scenario_id for result in results],
            "results": [asdict(result) for result in results],
            "ownership": ownership,
            "cleanup": {
                "owned_processes_stopped": not leaked_owned_pids,
                "authority_workers_stopped": not leaked_owned_pids,
                "temporary_state_removed": False,
            },
        }
    report["cleanup"]["temporary_state_removed"] = not owned_path.exists()
    if not report["cleanup"]["temporary_state_removed"]:
        raise RuntimeError(f"owned G016 temporary state leaked: {owned_path}")
    (output_dir / f"{mode}-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return report


def _processes_with_cmdline_fragment(fragment: str) -> list[int]:
    matches: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
        if fragment in command:
            matches.append(int(entry.name))
    return matches


async def _start_bus(mode: str) -> Any:
    if mode == "threads":
        from app.messaging.local_bus import LocalBus

        bus = LocalBus(command_queue_size=32, event_queue_size=32, validate_topics=False)
    else:
        from redis.asyncio import from_url as redis_from_url

        from app.messaging.bullmq_bus import BullMQBus

        redis_url = os.environ["REDIS_URL"]
        redis_client = redis_from_url(redis_url)
        try:
            if not await asyncio.wait_for(redis_client.ping(), timeout=3):
                raise RuntimeError("isolated Redis endpoint did not answer PING")
        finally:
            await redis_client.aclose()
        bus = BullMQBus(redis_url=redis_url, validate_topics=False)
    await bus.start()
    return bus


def _load_state(path: Path, node_id: str) -> dict[str, Any]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    state = _default_state(node_id)
    path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
    return state


def _save_state(path: Path, state: dict[str, Any]) -> None:
    path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")


async def _persist_authority_patch(
    bus: Any, *, node_id: str, state: dict[str, Any], patch: dict[str, Any]
) -> None:
    """Apply harness setup mutations only through canonical production topics."""

    from app.services.config.messages import UpdateConfigCommand
    from app.shared.contracts.models.config import ConfigMethods
    from app.shared.contracts.models.db import (
        DBGetToolingExportPolicySnapshotRequest,
        DBGetToolingExportPolicySnapshotResponse,
        DBMethods,
        DBMutateToolingExportPolicyRequest,
        DBSetToolingMeshSwitchesRequest,
    )

    remote_peer_id = str(
        patch.get("authority_peer_id") or ("aurora-2" if node_id == "aurora-1" else "aurora-1")
    )
    if "paired_peers" in patch or "grants" in patch:
        await _persist_synthetic_peer_authority(
            bus,
            remote_peer_id=remote_peer_id,
            permissions=list(state["grants"]),
        )

    if "tool_rules" in patch:
        snapshot_result = await bus.request(
            DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
            DBGetToolingExportPolicySnapshotRequest(peer_id=remote_peer_id),
            origin="internal",
        )
        snapshot = DBGetToolingExportPolicySnapshotResponse.model_validate(snapshot_result.data)
        revision = snapshot.policy.revision
        for rule in snapshot.rules:
            cleared = await bus.request(
                DBMethods.MUTATE_TOOLING_EXPORT_POLICY,
                DBMutateToolingExportPolicyRequest(
                    action="clear_rule",
                    expected_revision=revision,
                    peer_id=rule.peer_id,
                    scope_type=rule.scope_type,
                    scope_id=rule.scope_id,
                    actor_principal_id="g016-harness",
                    reason="replace isolated acceptance policy",
                ),
                origin="internal",
            )
            revision = int(cleared.data["revision"])
        for raw in patch["tool_rules"]:
            mutated = await bus.request(
                DBMethods.MUTATE_TOOLING_EXPORT_POLICY,
                DBMutateToolingExportPolicyRequest(
                    action="upsert_rule",
                    expected_revision=revision,
                    state=raw["state"],
                    peer_id=raw.get("peer_id"),
                    scope_type=raw["scope_type"],
                    scope_id=raw["scope_id"],
                    actor_principal_id="g016-harness",
                    reason="isolated acceptance policy mutation",
                ),
                origin="internal",
            )
            revision = int(mutated.data["revision"])

    if {
        "provider_mesh_tooling_enabled",
        "consumer_mesh_tooling_enabled",
    } & patch.keys():
        snapshot_result = await bus.request(
            DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
            DBGetToolingExportPolicySnapshotRequest(peer_id=None, include_rules=False),
            origin="internal",
        )
        snapshot = DBGetToolingExportPolicySnapshotResponse.model_validate(snapshot_result.data)
        switches = snapshot.mesh_switches
        await bus.request(
            DBMethods.SET_TOOLING_MESH_SWITCHES,
            DBSetToolingMeshSwitchesRequest(
                provider_mesh_tooling_enabled=bool(state["provider_mesh_tooling_enabled"]),
                consumer_mesh_tooling_enabled=bool(state["consumer_mesh_tooling_enabled"]),
                expected_revision=switches.revision,
                actor_principal_id="g016-harness",
                reason="isolated acceptance switch mutation",
            ),
            origin="internal",
        )

    # Config remains the canonical source.  The worker synchronizes the live
    # Gateway MeshPolicyStore/PeerRegistry after these setup mutations below.
    config_values = {
        "services.gateway.mesh.enabled": True,
        "services.gateway.mesh.node_name": f"{node_id}-r{state['projection_revision']}",
        "services.tts.mesh_routing.allowed_provider_peer_ids": state["allowed_provider_peer_ids"],
        "services.tts.mesh_routing.required_provider_feature_ids": state.get(
            "required_features", []
        ),
        "services.tts.mesh_routing.required_provider_capability_tags": state.get(
            "required_tags", []
        ),
        "services.tts.mesh_sharing.unshared_method_ids": sorted(
            {"TTS.Synthesize"} - set(state["shared_methods"])
        ),
    }
    for path, value in config_values.items():
        await bus.request(
            ConfigMethods.SET,
            UpdateConfigCommand(key_path=path, value=value),
            origin="internal",
        )
    if os.environ.get("AURORA_ARCHITECTURE_MODE") == "processes":
        # The RTC worker and the production authority services are separate
        # processes in this acceptance topology.  Queue a setup-only refresh in
        # the authority process, then prove completion through the production
        # Gateway.ExplainRoute contract below.  A raw ``subscribe`` handler does
        # not implement BullMQ request/reply, so awaiting ``bus.request`` here
        # would wait forever even after the handler completed successfully.
        await bus.publish(
            _AUTHORITY_REFRESH_TOPIC,
            {
                "node_id": node_id,
                "projection_revision": int(state["projection_revision"]),
            },
            event=False,
            origin="internal",
        )


async def _persist_synthetic_peer_authority(
    bus: Any,
    *,
    remote_peer_id: str,
    permissions: list[str],
) -> None:
    """Persist grants for the harness's intentionally unlinked peer row."""

    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.mesh import (
        MeshBoolResponse,
        MeshPeerApproveRequest,
        MeshPeerUpsertRequest,
    )

    upsert_result = await bus.request(
        AuthMethods.MESH_UPSERT_PEER,
        MeshPeerUpsertRequest(
            peer_id=remote_peer_id,
            room_name="g016-isolated",
            node_name=remote_peer_id,
        ),
        origin="internal",
    )
    if not upsert_result.ok:
        raise RuntimeError(upsert_result.error or "synthetic mesh peer upsert failed")
    upsert = MeshBoolResponse.model_validate(upsert_result.data)
    if not upsert.success:
        raise RuntimeError(upsert.message or "synthetic mesh peer upsert was rejected")

    # Harness-created peer rows intentionally have no linked credential graph.
    # Re-approval supports that pre-exchange state; permission update correctly
    # fails closed when an approved peer has no linked user/token authority.
    approval_result = await bus.request(
        AuthMethods.MESH_APPROVE_PEER,
        MeshPeerApproveRequest(peer_id=remote_peer_id, permissions=permissions),
        origin="internal",
    )
    if not approval_result.ok:
        raise RuntimeError(approval_result.error or "synthetic mesh peer approval failed")
    approval = MeshBoolResponse.model_validate(approval_result.data)
    if not approval.success:
        raise RuntimeError(approval.message or "synthetic mesh peer approval was rejected")


async def _wait_for_gateway_authority_convergence(
    bus: Any,
    *,
    provider_peer_id: str,
    expected_projection_revision: str,
    expected_projection_digest: str,
    timeout_s: float = 20.0,
) -> None:
    """Wait until Gateway exposes the exact authority revision and digest queued by patch."""

    if not expected_projection_digest:
        raise ValueError("expected_projection_digest is required for authority convergence")

    from app.shared.contracts.models.gateway import (
        GatewayMethods,
        RouteExplainRequest,
        RouteExplainResponse,
    )

    deadline = time.monotonic() + timeout_s
    last_reason = "gateway authority refresh not observed"
    while time.monotonic() < deadline:
        result = await bus.request(
            GatewayMethods.EXPLAIN_ROUTE,
            RouteExplainRequest(topic="TTS.Synthesize", include_candidates=True),
            origin="internal",
            timeout=5,
        )
        if result.ok and result.data is not None:
            response = RouteExplainResponse.model_validate(result.data)
            candidate = next(
                (
                    item
                    for item in response.candidates
                    if item.provider_kind == "remote" and item.peer_id == provider_peer_id
                ),
                None,
            )
            if candidate is not None:
                revision_matches = candidate.projection_revision == expected_projection_revision
                digest_matches = candidate.projection_digest == expected_projection_digest
                if (
                    candidate.reason_code != "manifest_projection_stale"
                    and revision_matches
                    and digest_matches
                ):
                    return
                last_reason = (
                    f"observed projection revision={candidate.projection_revision!r} "
                    f"digest={candidate.projection_digest!r} reason={candidate.reason_code!r}; "
                    f"expected revision={expected_projection_revision!r} "
                    f"digest={expected_projection_digest!r}"
                )
            else:
                last_reason = "refreshed remote provider candidate not published"
        else:
            last_reason = result.error or "Gateway.ExplainRoute failed"
        await asyncio.sleep(0.1)
    raise TimeoutError(f"Gateway authority for {provider_peer_id} did not converge: {last_reason}")


def _reply(**payload: Any) -> None:
    print(json.dumps({PROTOCOL_KEY: True, **payload}, sort_keys=True), flush=True)


async def _production_recipient_projection(
    bus: Any,
    registry: Any,
    state: dict[str, Any],
    *,
    provider_peer_id: str,
    recipient_peer_id: str,
) -> Any | None:
    """Build the exact production projection from durable Auth and registry authority."""

    if state.get("protocol") != "projection-v1" or not state.get("projection_active", True):
        return None
    from app.services.gateway.mesh.provider_export import (
        GrantEvidence,
        PolicySnapshot,
        ProtocolEvidence,
        RecipientEvidence,
        ServiceExportPolicy,
        project_provider_export,
    )
    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.mesh import (
        MeshPeerAuthoritySnapshotRequest,
        MeshPeerAuthoritySnapshotResponse,
    )

    authority_result = await bus.request(
        AuthMethods.MESH_GET_AUTHORITY_SNAPSHOT,
        MeshPeerAuthoritySnapshotRequest(peer_id=recipient_peer_id),
        origin="internal",
    )
    if not authority_result.ok:
        return None
    authorities = MeshPeerAuthoritySnapshotResponse.model_validate(
        authority_result.data
    ).authorities
    if not authorities:
        return None
    authority = authorities[0]
    recipient = RecipientEvidence(
        peer_id=recipient_peer_id,
        revision=authority.auth_grant_revision,
        grants=tuple(
            GrantEvidence(str(permission)) for permission in authority.effective_permissions
        ),
        state=authority.state,
    )
    policies = []
    for service in registry.snapshot_registry().services:
        unshared_methods: tuple[str, ...] = ()
        if service.service_id == "TTS":
            unshared_methods = tuple(sorted({"TTS.Synthesize"} - set(state["shared_methods"])))
        policies.append(
            ServiceExportPolicy(
                service_id=service.service_id,
                share=service.service_id in {"Config", "Gateway", "TTS", "Tooling"},
                unshared_method_ids=unshared_methods,
            )
        )
    return project_provider_export(
        provider_peer_id=provider_peer_id,
        registry=registry.snapshot_registry(),
        policy=PolicySnapshot(revision=str(state["projection_revision"]), services=tuple(policies)),
        recipient=recipient,
        protocol=ProtocolEvidence(evidence_revision=int(state["projection_revision"])),
    )


class _WorkerRtcRuntime:
    """One authenticated production RPCHandler carried by a real aiortc channel."""

    def __init__(
        self,
        bus: Any,
        state: dict[str, Any],
        node_id: str,
        *,
        state_path: Path | None = None,
    ) -> None:
        self.bus = bus
        self.state = state
        self.node_id = node_id
        self.state_path = state_path
        self.remote_peer_id: str | None = None
        self.pc: Any | None = None
        self.channel: Any | None = None
        self.handler: Any | None = None
        self.open = asyncio.Event()
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.connection_id = str(uuid.uuid4())
        self.registry: Any | None = None
        self.active_projection: Any | None = None
        self.authenticated_identity: Any | None = None
        self.remote_manifest: Any | None = None
        self.accepted_sessions: list[_WorkerRtcRuntime] = []

    async def start(self) -> None:
        from app.services.gateway.registry_aggregator import RegistryAggregator
        from app.shared.contracts.models.common import EmptyInput
        from app.shared.contracts.models.gateway import (
            GatewayMethods,
            GetRegistryResponse,
            ServiceAnnouncement,
        )

        registry_result = await self.bus.request(
            GatewayMethods.GET_REGISTRY,
            EmptyInput(),
            origin="internal",
            timeout=15,
        )
        if not registry_result.ok:
            raise RuntimeError(registry_result.error or "production Gateway registry unavailable")
        registry_export = GetRegistryResponse.model_validate(registry_result.data)
        # Bind the connection to a production-ingested immutable registry
        # generation. This is the same ServiceAnnouncement validation and
        # RegistrySnapshot builder used by live process-mode discovery, without
        # allowing unrelated later service departure events to rewrite an
        # already authenticated RTC connection's contract generation.
        self.registry = RegistryAggregator(self.bus, mode="processes")
        for module in registry_export.modules:
            announcement = ServiceAnnouncement(
                module=module.module,
                version=module.version,
                summary=module.summary,
                capabilities=module.capabilities,
                callable_features=module.callable_features,
                methods=module.methods,
            )
            await self.registry._on_service_announce(SimpleNamespace(payload=announcement))

    async def refresh_authenticated_authority(self) -> None:
        if not self.remote_peer_id or self.registry is None:
            return
        projection = await _production_recipient_projection(
            self.bus,
            self.registry,
            self._refresh_state(),
            provider_peer_id=self.node_id,
            recipient_peer_id=self.remote_peer_id,
        )
        self.active_projection = projection
        if projection is None or projection.grants is None:
            self.authenticated_identity = None
            return
        from app.shared.auth.identity import build_identity

        permissions = [grant.permission for grant in projection.grants]
        self.authenticated_identity = build_identity(
            user_id=f"mesh:{self.remote_peer_id}",
            username=self.remote_peer_id,
            user_permissions=permissions,
            user_is_admin="*" in permissions,
            token_scopes=permissions,
            device_id=self.remote_peer_id,
            source="webrtc_peer",
        )
        for session in self.accepted_sessions:
            await session.refresh_authenticated_authority()

    def _refresh_state(self) -> dict[str, Any]:
        if self.state_path is not None and self.state_path.exists():
            self.state.clear()
            self.state.update(json.loads(self.state_path.read_text(encoding="utf-8")))
        return self.state

    def _identity(self) -> Any:
        from app.services.gateway.acl.identity import ANONYMOUS

        return self.authenticated_identity or ANONYMOUS

    def _mesh_config(self) -> Any:
        from app.services.gateway.config import (
            MeshConfig,
            MeshServiceExportPolicy,
            MeshServicePolicy,
        )

        return MeshConfig(
            enabled=True,
            services={
                name: MeshServicePolicy(export=MeshServiceExportPolicy(share=True))
                for name in ("TTS", "Tooling", "Gateway", "Config")
            },
        )

    def _install_channel(self, channel: Any) -> None:
        from app.services.gateway.webrtc.rpc import RPCHandler

        self.channel = channel
        if channel.readyState == "open":
            self.open.set()
        self.handler = RPCHandler(
            self.bus,
            self.registry,
            lambda message: channel.send(message),
            self._identity,
            mesh_config=self._mesh_config(),
            peer_id=self.remote_peer_id,
            stable_peer_id_provider=lambda: self.remote_peer_id,
            policy_provider=lambda: SimpleNamespace(mesh_config=self._mesh_config()),
            active_projection_provider=lambda: self.active_projection,
            authenticated_peer_validator=lambda: self.authenticated_identity is not None,
            tooling_authority_revision_provider=lambda: (
                (
                    int(self.active_projection.cache_key.authority_revision),
                    int(self.state["projection_revision"]),
                )
                if self.active_projection is not None
                else None
            ),
        )

        @channel.on("open")
        def on_open() -> None:
            self.open.set()

        @channel.on("message")
        def on_message(message: str | bytes) -> None:
            text = message.decode() if isinstance(message, bytes) else message
            value = json.loads(text)
            if value.get("type") == "manifest":
                from app.services.gateway.mesh.negotiation import parse_manifest_with_evidence

                parsed = parse_manifest_with_evidence(
                    value,
                    expected_provider_peer_id=self.remote_peer_id,
                    expected_recipient_peer_id=self.node_id,
                )
                if parsed.usable:
                    self.remote_manifest = parsed.manifest
                return
            request_id = str(value.get("id") or "")
            if value.get("type") in {"result", "error"} and request_id in self.pending:
                future = self.pending.pop(request_id)
                if not future.done():
                    future.set_result(value)
                return
            asyncio.create_task(self.handler.on_message(text))

    async def _gather(self) -> None:
        if self.pc.iceGatheringState == "complete":
            return
        done = asyncio.Event()

        @self.pc.on("icegatheringstatechange")
        def changed() -> None:
            if self.pc.iceGatheringState == "complete":
                done.set()

        await asyncio.wait_for(done.wait(), timeout=8)

    async def create_offer(self, remote_peer_id: str) -> dict[str, str]:
        from aiortc import RTCPeerConnection

        self.remote_peer_id = remote_peer_id
        await self.refresh_authenticated_authority()
        self.pc = RTCPeerConnection()
        self._install_channel(self.pc.createDataChannel("aurora-rpc"))
        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)
        await self._gather()
        return {"sdp": self.pc.localDescription.sdp, "sdp_type": self.pc.localDescription.type}

    async def accept_offer(self, remote_peer_id: str, sdp: str, sdp_type: str) -> dict[str, str]:
        from aiortc import RTCPeerConnection, RTCSessionDescription

        if self.pc is not None:
            session = _WorkerRtcRuntime(
                self.bus,
                self.state,
                self.node_id,
                state_path=self.state_path,
            )
            await session.start()
            self.accepted_sessions.append(session)
            return await session.accept_offer(remote_peer_id, sdp, sdp_type)
        self.remote_peer_id = remote_peer_id
        await self.refresh_authenticated_authority()
        self.pc = RTCPeerConnection()

        @self.pc.on("datachannel")
        def datachannel(channel: Any) -> None:
            self._install_channel(channel)

        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)
        await self._gather()
        return {"sdp": self.pc.localDescription.sdp, "sdp_type": self.pc.localDescription.type}

    async def accept_answer(self, sdp: str, sdp_type: str) -> None:
        from aiortc import RTCSessionDescription

        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))

    async def wait_open(self) -> None:
        await asyncio.wait_for(self.open.wait(), timeout=10)
        await self.refresh_authenticated_authority()
        if self.active_projection is not None:
            from app.services.gateway.mesh.negotiation import (
                manifest_from_projection,
                manifest_to_dict,
            )

            manifest = manifest_from_projection(
                projection=self.active_projection,
                node_name=self.node_id,
                aurora_version="g016",
            )
            self.channel.send(json.dumps(manifest_to_dict(manifest)))

    async def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        await self.wait_open()
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        self.channel.send(
            json.dumps({"type": "call", "id": request_id, "method": method, "params": params})
        )
        response = await asyncio.wait_for(future, timeout=10)
        error = response.get("error") if isinstance(response.get("error"), dict) else {}
        message = str(error.get("message") or response.get("message") or "")
        if message == "Service or method is not shared" or message == "Method is not shared":
            reason = "method_not_shared"
        elif message == "Authentication required":
            reason = "authentication_required"
        elif message.startswith("Permission denied") or message == "Forbidden":
            reason = "permission_denied"
        elif message in {
            "provider_mesh_tooling_disabled",
            "consumer_mesh_tooling_disabled",
            "snapshot_revision_changed",
            "projection_authority_unknown",
            "unsafe_downgrade_blocked",
        }:
            reason = message
        elif message == "projection_restart_required":
            reason = "snapshot_revision_changed"
        elif response.get("type") == "result":
            reason = "eligible"
        else:
            reason = "rpc_error"
        return {
            "reason_code": reason,
            "allowed": response.get("type") == "result",
            "wire": response,
            "rtc_connection_id": self.connection_id,
        }

    async def close(self) -> None:
        for session in self.accepted_sessions:
            await session.close()
        self.accepted_sessions.clear()
        if self.pc is not None:
            await self.pc.close()
        if self.registry is not None:
            await self.registry.stop()
            self.registry = None


class _ProductionNodeServices:
    """Lifecycle owner for the isolated production authority services."""

    def __init__(
        self,
        bus: Any,
        db: Any,
        config: Any,
        auth: Any,
        tts: Any,
        tooling: Any,
        gateway: Any,
        registry: Any,
    ) -> None:
        self.bus = bus
        self.db = db
        self.config = config
        self.auth = auth
        self.tts = tts
        self.tooling = tooling
        self.gateway = gateway
        self.registry = registry
        self._authority_refresh_handler: Any | None = None

    @classmethod
    async def start(cls, bus: Any, node_id: str) -> _ProductionNodeServices:
        from app.messaging.bus_runtime import set_bus as set_runtime_bus
        from app.services.auth.service import AuthService
        from app.services.config.service import ConfigService
        from app.services.db.service import DBService
        from app.services.gateway.registry_aggregator import RegistryAggregator
        from app.services.gateway.service import GatewayService
        from app.services.tooling.service import ToolingService
        from app.services.tts.service import TTSService
        from app.shared.messaging.bus_init import set_bus

        set_bus(bus)
        set_runtime_bus(bus)
        _reply(status="phase", phase="production_db_construct")
        db_path = Path(os.environ["AURORA_DATA_DIR"]) / "aurora.db"
        db = DBService(str(db_path))
        await db._subscribe_registered_contracts()
        if os.environ.get("AURORA_ARCHITECTURE_MODE") == "processes":
            await asyncio.sleep(1.0)
        await db.db_manager.initialize()
        await db.scheduler_db.initialize()

        _reply(status="phase", phase="production_config_auth_construct")
        config = ConfigService()
        await config._subscribe_registered_contracts()
        auth = AuthService()
        await auth._subscribe_registered_contracts()
        await auth.on_start()
        # Exercise the production TTS contract and request handlers without
        # starting host audio/model resources in the isolated acceptance node.
        tts = TTSService()
        await tts._subscribe_registered_contracts()

        _reply(status="phase", phase="production_tooling_construct")
        tooling = ToolingService()
        await tooling._subscribe_registered_contracts()
        if os.environ.get("AURORA_ARCHITECTURE_MODE") == "processes":
            await asyncio.sleep(1.0)
        await tooling._load_sharing_policy_from_config()
        await tooling._ensure_tooling_policy_tables()
        tooling._stable_peer_id = node_id
        _reply(status="phase", phase="production_tools_initialize")
        if os.environ.get("AURORA_ARCHITECTURE_MODE") == "processes":
            # Process-mode worker bootstrapping cannot use Tooling's startup
            # RAG synchronization before Supervisor has launched its separate
            # DB worker. Load the exact production core tool set, then persist
            # canonical identities through the in-process DB service below.
            await tooling.tools_manager._load_core_tools()
            tooling.tools_manager._initialized = True
        else:
            await tooling.tools_manager.initialize()
        await tooling._reconcile_local_tool_identities()
        _reply(status="phase", phase="production_policy_migrate")
        await tooling._migrate_legacy_tool_export_policy()

        _reply(status="phase", phase="production_gateway_construct")
        gateway = GatewayService()
        await gateway._subscribe_registered_contracts()
        gateway._tooling_invalidation_subscription_ready = True
        registry = RegistryAggregator(bus, mode="threads")
        await registry.start()
        gateway._registry_aggregator = registry
        services = cls(bus, db, config, auth, tts, tooling, gateway, registry)
        state_path = Path(os.environ["AURORA_DATA_DIR"]).parent / "state.json"

        async def refresh_gateway_authority(envelope: Any) -> None:
            payload = envelope.payload
            if str(payload.get("node_id")) != node_id:
                raise ValueError("authority refresh addressed to the wrong node")
            state = _load_state(state_path, node_id)
            await services.refresh_gateway_authority(state)

        services._authority_refresh_handler = refresh_gateway_authority
        bus.subscribe(_AUTHORITY_REFRESH_TOPIC, refresh_gateway_authority)
        await services.refresh_gateway_authority(_load_state(state_path, node_id))
        if not await gateway._coordinate_tooling_mesh_activation():
            raise RuntimeError("production Tooling mesh enforcement activation failed")
        return services

    async def close(self) -> None:
        if self._authority_refresh_handler is not None:
            self.bus.unsubscribe(_AUTHORITY_REFRESH_TOPIC, self._authority_refresh_handler)
            self._authority_refresh_handler = None
        self.gateway._unsubscribe_registered_contracts()
        await self.registry.stop()
        await self.tooling.on_stop()
        self.tooling._unsubscribe_registered_contracts()
        await self.auth.on_stop()
        self.auth._unsubscribe_registered_contracts()
        self.tts._unsubscribe_registered_contracts()
        self.config._unsubscribe_registered_contracts()
        self.db._unsubscribe_registered_contracts()
        await self.db.db_manager.close()

    async def refresh_gateway_authority(self, state: dict[str, Any]) -> None:
        """Rebuild Gateway's live policy/peer projection from durable authorities."""

        if state.get("downgrade_preflight_setup"):
            os.environ["AURORA_TOOLING_TARGET_MODE"] = "legacy"
            os.environ["AURORA_TOOLING_EXPORT_SNAPSHOT"] = str(
                Path(os.environ["AURORA_DATA_DIR"]).parent / "tooling-export-snapshot.json"
            )

        from app.services.gateway.config import (
            MeshConfig,
            MeshServiceExportPolicy,
            MeshServicePolicy,
            MeshServiceRoutingPolicy,
        )
        from app.services.gateway.mesh.negotiation import (
            manifest_from_projection,
            manifest_to_dict,
            parse_manifest_with_evidence,
        )
        from app.services.gateway.mesh.peer_registry import PeerRegistry
        from app.services.gateway.mesh.routing_table import RoutingTable

        routing = MeshServiceRoutingPolicy(
            prefer="network",
            allowed_provider_peer_ids=state["allowed_provider_peer_ids"],
            required_provider_feature_ids=state.get("required_features", []),
            required_provider_capability_tags=state.get("required_tags", []),
        )
        mesh_config = MeshConfig(
            enabled=True,
            services={
                "TTS": MeshServicePolicy(
                    export=MeshServiceExportPolicy(share=True), routing=routing
                )
            },
        )
        snapshot = self.gateway._mesh_policy_store.replace(mesh_config)
        registry = PeerRegistry(snapshot.mesh_config, self.gateway._mesh_policy_provider)
        provider_peer_id = str(state["node_id"])
        recipient_peer_id = "aurora-2" if provider_peer_id == "aurora-1" else "aurora-1"
        await registry.register_peer(provider_peer_id, provider_peer_id)
        projection = await _production_recipient_projection(
            self.bus,
            self.registry,
            state,
            provider_peer_id=provider_peer_id,
            recipient_peer_id=recipient_peer_id,
        )
        if projection is not None:
            generated = manifest_from_projection(
                projection=projection,
                node_name=provider_peer_id,
                aurora_version="g016",
            )
            parsed = parse_manifest_with_evidence(
                manifest_to_dict(generated),
                expected_provider_peer_id=provider_peer_id,
                expected_recipient_peer_id=recipient_peer_id,
            )
            if not parsed.usable or parsed.manifest is None:
                raise RuntimeError(f"production manifest negotiation failed: {parsed.reason_code}")
            await registry.update_manifest(provider_peer_id, parsed.manifest)
        self.gateway._mesh_peer_registry = registry
        self.gateway._mesh_routing_table = RoutingTable(
            snapshot.mesh_config,
            registry,
            policy_provider=self.gateway._mesh_policy_provider,
        )
        self.gateway._mesh_peer_id = recipient_peer_id
        if not await self.gateway._coordinate_tooling_mesh_activation():
            raise RuntimeError("production Tooling mesh enforcement refresh failed")
        from app.shared.contracts.models.tooling import (
            ToolingMeshEnforcementActivated,
            ToolingMethods,
        )

        activation = await self.bus.request(
            ToolingMethods.MESH_ENFORCEMENT_ACTIVATED,
            ToolingMeshEnforcementActivated(revision=int(state["projection_revision"])),
            origin="internal",
        )
        if not activation.ok:
            raise RuntimeError("production Tooling mesh enforcement handler did not acknowledge")


async def _authority_worker(args: argparse.Namespace) -> int:
    """Separate process-mode DB/Tooling/policy BullMQ worker for one node."""

    bus = await _start_bus("processes")
    services = await _ProductionNodeServices.start(bus, args.node_id)
    Path(args.ready_file).write_text("ready\n", encoding="utf-8")
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stopped.set)
    await stopped.wait()
    await services.close()
    await bus.stop()
    return 0


async def _start_authority_subprocess(
    args: argparse.Namespace,
) -> tuple[subprocess.Popen[Any], Any]:
    ready_file = Path(args.state_file).with_suffix(".authority-ready")
    ready_file.unlink(missing_ok=True)
    log_handle = ready_file.with_suffix(".log").open("a", encoding="utf-8")
    process = subprocess.Popen(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--authority-worker",
            "--node-id",
            args.node_id,
            "--state-file",
            args.state_file,
            "--ready-file",
            str(ready_file),
        ],
        env=os.environ.copy(),
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if ready_file.exists():
            return process, log_handle
        if process.poll() is not None:
            log_handle.flush()
            error = ready_file.with_suffix(".log").read_text(encoding="utf-8")
            process.wait(timeout=5)
            log_handle.close()
            raise RuntimeError(error)
        await asyncio.sleep(0.05)
    process.terminate()
    try:
        await asyncio.to_thread(process.wait, 10)
    except subprocess.TimeoutExpired:
        process.kill()
        await asyncio.to_thread(process.wait, 5)
    log_handle.close()
    raise TimeoutError(f"authority worker for {args.node_id} did not become ready")


async def _worker(args: argparse.Namespace) -> int:
    # Stdout is the machine protocol. Keep production lifecycle logs in the
    # dedicated stderr artifact instead of letting INFO chatter delay framing.
    from app.helpers import aurora_logger as _aurora_logger  # noqa: F401

    logging.getLogger("Aurora").setLevel(logging.ERROR)
    for handler in logging.getLogger("Aurora").handlers:
        handler.setLevel(logging.ERROR)
    state_path = Path(args.state_file)
    state = _load_state(state_path, args.node_id)
    _reply(status="phase", phase="starting_bus")
    try:
        bus = await _start_bus(args.mode)
    except Exception as exc:
        _reply(status="error", error=f"message_bus_unavailable:{type(exc).__name__}:{exc}")
        return 2
    _reply(status="phase", phase="starting_production_services")
    services: _ProductionNodeServices | None = None
    authority_process: subprocess.Popen[Any] | None = None
    authority_log: Any | None = None
    try:
        if args.mode == "processes":
            authority_process, authority_log = await _start_authority_subprocess(args)
        else:
            services = await _ProductionNodeServices.start(bus, args.node_id)
    except Exception as exc:
        await bus.stop()
        _reply(status="error", error=f"production_services_unavailable:{type(exc).__name__}:{exc}")
        return 2
    _reply(status="phase", phase="starting_rtc_authority")
    connection_id = str(uuid.uuid4())
    rtc = _WorkerRtcRuntime(
        bus,
        state,
        args.node_id,
        state_path=state_path if args.mode == "processes" else None,
    )
    await rtc.start()
    _reply(status="ready", connection_id=connection_id, node_id=args.node_id, mode=args.mode)
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
                response = await _handle_action(
                    action, request, state, state_path, connection_id, rtc, services
                )
                _reply(status="ok", **response)
            except Exception as exc:
                _reply(status="error", error=f"{type(exc).__name__}:{exc}")
    finally:
        await rtc.close()
        if services is not None:
            await services.close()
        if authority_process is not None:
            authority_process.terminate()
            try:
                await asyncio.to_thread(authority_process.wait, 75)
            except subprocess.TimeoutExpired:
                authority_process.kill()
                await asyncio.to_thread(authority_process.wait, 5)
        if authority_log is not None:
            authority_log.close()
        await bus.stop()
    return 0


async def _handle_action(
    action: str,
    request: dict[str, Any],
    state: dict[str, Any],
    state_path: Path,
    connection_id: str,
    rtc: _WorkerRtcRuntime,
    services: _ProductionNodeServices | None,
) -> dict[str, Any]:
    if action == "state":
        return {**state, "connection_id": connection_id}
    if action == "tool_policy_snapshot":
        from app.shared.contracts.models.db import (
            DBGetToolingExportPolicySnapshotRequest,
            DBGetToolingExportPolicySnapshotResponse,
            DBMethods,
        )

        result = await rtc.bus.request(
            DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
            DBGetToolingExportPolicySnapshotRequest(peer_id=request.get("peer_id")),
            origin="internal",
        )
        if not result.ok:
            raise RuntimeError(result.error or "tooling export policy snapshot unavailable")
        snapshot = DBGetToolingExportPolicySnapshotResponse.model_validate(result.data)
        return {"snapshot": snapshot.model_dump(mode="json")}
    if action == "local_tool_inventory":
        from app.shared.contracts.models.tooling import ToolingGetToolsRequest, ToolingMethods

        result = await rtc.bus.request(
            ToolingMethods.GET_TOOLS,
            ToolingGetToolsRequest(top_k=10_000),
            origin="internal",
        )
        if not result.ok:
            raise RuntimeError(result.error or "local Tooling inventory unavailable")
        tools = result.data.get("tools", []) if isinstance(result.data, dict) else result.data.tools
        return {
            "tool_ids": sorted(
                str(tool.get("global_tool_id") if isinstance(tool, dict) else tool.global_tool_id)
                for tool in tools
            )
        }
    if action == "local_bindable_peer_tools":
        from app.shared.contracts.models.tooling import (
            ToolingGetToolCatalogRequest,
            ToolingMethods,
        )

        result = await rtc.bus.request(
            ToolingMethods.GET_TOOL_CATALOG,
            ToolingGetToolCatalogRequest(top_k=10_000),
            origin="internal",
        )
        if not result.ok:
            raise RuntimeError(result.error or "local bindable Tooling catalog unavailable")
        tools = result.data.get("tools", []) if isinstance(result.data, dict) else result.data.tools
        peer_id = str(request["peer_id"])
        return {
            "tool_ids": sorted(
                str(tool.get("global_tool_id") if isinstance(tool, dict) else tool.global_tool_id)
                for tool in tools
                if str(
                    tool.get("provider_peer_id")
                    if isinstance(tool, dict)
                    else tool.provider_peer_id
                )
                == peer_id
            )
        }
    if action == "registry_snapshot":
        services = rtc.registry.snapshot_services() if rtc.registry is not None else {}
        return {
            "services": {
                name: sorted(str(method.bus_topic) for method in announcement.methods)
                for name, announcement in services.items()
            }
        }
    if action == "protocol_transport_probe":
        from app.services.gateway.mesh.negotiation import (
            manifest_to_dict,
            parse_manifest_with_evidence,
        )
        from app.services.gateway.mesh.tooling_projection_transport import (
            select_tooling_protocol,
        )
        from app.shared.contracts.models.db import (
            DBGetToolingRemoteCatalogRequest,
            DBGetToolingRemoteCatalogResponse,
            DBMethods,
        )

        if rtc.remote_manifest is None or rtc.remote_peer_id is None:
            raise RuntimeError("authenticated remote manifest unavailable")
        parsed = parse_manifest_with_evidence(
            manifest_to_dict(rtc.remote_manifest),
            expected_provider_peer_id=rtc.remote_peer_id,
            expected_recipient_peer_id=rtc.node_id,
        )
        if parsed.manifest is None:
            raise RuntimeError(f"remote manifest rejected: {parsed.reason_code}")

        catalog_result = await rtc.bus.request(
            DBMethods.GET_TOOLING_REMOTE_CATALOG,
            DBGetToolingRemoteCatalogRequest(
                peer_id=rtc.remote_peer_id,
                provider_id=rtc.remote_peer_id,
                include_inactive=True,
            ),
            origin="internal",
        )
        if not catalog_result.ok:
            raise RuntimeError(catalog_result.error or "remote catalog baseline unavailable")
        catalog = DBGetToolingRemoteCatalogResponse.model_validate(catalog_result.data)
        baseline_headers = [
            header
            for header in catalog.headers
            if header.availability == "active"
            and header.sync_state == "committed"
            and header.protocol_tier == "projection_v1"
            and header.current_generation >= 1
        ]
        has_verified_baseline = bool(baseline_headers)
        full = select_tooling_protocol(
            parsed.manifest,
            manifest_status=parsed.status,
            has_verified_baseline=has_verified_baseline,
        )
        delta_offer = SimpleNamespace(
            recipient_projection_evidence=SimpleNamespace(protocol_tier="projection-v1-delta"),
            tooling_protocol_tiers=["projection_v1_delta"],
        )
        delta = select_tooling_protocol(
            delta_offer,
            manifest_status=parsed.status,
            has_verified_baseline=has_verified_baseline,
        )
        return {
            "manifest": {
                "status": parsed.status,
                "active_protocol": parsed.manifest.active_protocol,
                "projection_active": parsed.manifest.projection_active,
                "projection_digest": (
                    parsed.manifest.recipient_projection_evidence.projection_digest
                    if parsed.manifest.recipient_projection_evidence is not None
                    else None
                ),
            },
            "baseline": {
                "verified": has_verified_baseline,
                "active_generations": sorted(
                    header.current_generation for header in baseline_headers
                ),
            },
            "full_selection": asdict(full),
            "delta_selection": asdict(delta),
        }
    if action == "downgrade_ceremony":
        from copy import deepcopy

        from app.services.config.mesh_policy_migration import (
            create_tooling_downgrade_receipt,
            preflight_tooling_downgrade_start,
            reverse_migrate_service_policy,
        )
        from app.shared.contracts.models.db import (
            DBGetToolingExportPolicySnapshotRequest,
            DBGetToolingExportPolicySnapshotResponse,
            DBMethods,
        )

        snapshot_result = await rtc.bus.request(
            DBMethods.GET_TOOLING_EXPORT_POLICY_SNAPSHOT,
            DBGetToolingExportPolicySnapshotRequest(
                peer_id=str(request.get("peer_id", "aurora-2"))
            ),
            origin="internal",
        )
        if not snapshot_result.ok:
            raise RuntimeError(snapshot_result.error or "downgrade snapshot unavailable")
        snapshot = DBGetToolingExportPolicySnapshotResponse.model_validate(
            snapshot_result.data
        ).model_dump(mode="json")
        snapshot["secrets_redacted"] = True
        snapshot["normalized_projection_present"] = True
        preserved_snapshot = deepcopy(snapshot)
        snapshot_path = state_path.parent / "tooling-export-snapshot.json"
        snapshot_path.write_text(json.dumps(snapshot, sort_keys=True), encoding="utf-8")

        current_config = json.loads(
            Path(os.environ["AURORA_CONFIG_FILE"]).read_text(encoding="utf-8")
        )
        reversed_policy = reverse_migrate_service_policy(
            current_config,
            tooling_export_snapshot=snapshot,
        )
        output_file = Path(os.environ["AURORA_CONFIG_FILE"])
        output_file.write_text(
            json.dumps(reversed_policy.config, sort_keys=True),
            encoding="utf-8",
        )
        receipt_path = create_tooling_downgrade_receipt(
            output_config=reversed_policy.config,
            output_file=str(output_file),
            tooling_export_snapshot=snapshot,
        )
        valid = preflight_tooling_downgrade_start(
            output_config=reversed_policy.config,
            output_file=str(output_file),
            tooling_export_snapshot=snapshot,
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["snapshot_sha256"] = "0" * 64
        receipt_path.write_text(json.dumps(receipt, sort_keys=True), encoding="utf-8")
        os.chmod(receipt_path, 0o600)
        # Point the production Gateway diagnostic at the actual reverse-migrated
        # launch artifact.  The worker is torn down immediately after this final
        # scenario, so no subsequent runtime config operation observes it.
        os.environ["AURORA_CONFIG_FILE"] = str(output_file)
        tampered = preflight_tooling_downgrade_start(
            output_config=reversed_policy.config,
            output_file=str(output_file),
            tooling_export_snapshot=snapshot,
        )
        tooling = reversed_policy.config.get("services", {}).get("tooling", {})
        return {
            "valid_preflight": asdict(valid),
            "tampered_preflight": asdict(tampered),
            "coarse_deny": {
                "share": tooling.get("mesh_sharing", {}).get("share"),
                "default_share": tooling.get("approval_policy", {}).get("default_share"),
            },
            "tooling_export_fail_closed": reversed_policy.tooling_export_fail_closed,
            "preserved_db_snapshot": snapshot == preserved_snapshot,
            "preserved_rules": snapshot["rules"],
        }
    if action == "patch":
        downgrade_setup = bool(request.get("downgrade_preflight_setup", False))
        state.update(request)
        _save_state(state_path, state)
        if downgrade_setup:
            snapshot_path = state_path.parent / "tooling-export-snapshot.json"
            os.environ["AURORA_TOOLING_TARGET_MODE"] = "legacy"
            os.environ["AURORA_TOOLING_EXPORT_SNAPSHOT"] = str(snapshot_path)
        await _persist_authority_patch(
            rtc.bus,
            node_id=str(state["node_id"]),
            state=state,
            patch=request,
        )
        if services is not None:
            await services.refresh_gateway_authority(state)
        if (
            state.get("protocol") == "projection-v1"
            and state.get("projection_active", True)
            and rtc.remote_peer_id
        ):
            expected_projection = await _production_recipient_projection(
                rtc.bus,
                rtc.registry,
                state,
                provider_peer_id=str(state["node_id"]),
                recipient_peer_id=rtc.remote_peer_id,
            )
            if expected_projection is None:
                raise RuntimeError("unable to rebuild projection for convergence digest")
            from app.services.gateway.mesh.negotiation import manifest_from_projection

            expected_manifest = manifest_from_projection(
                projection=expected_projection,
                node_name=str(state["node_id"]),
                aurora_version="g016",
            )
            expected_evidence = expected_manifest.recipient_projection_evidence
            if expected_evidence is None or not expected_evidence.projection_digest:
                raise RuntimeError("rebuilt projection did not produce manifest digest evidence")
            await _wait_for_gateway_authority_convergence(
                rtc.bus,
                provider_peer_id=str(state["node_id"]),
                expected_projection_revision=str(state["projection_revision"]),
                expected_projection_digest=expected_evidence.projection_digest,
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


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--authority-worker", action="store_true")
    parser.add_argument("--node-id", default="")
    parser.add_argument("--mode", choices=["threads", "processes"], default="threads")
    parser.add_argument("--state-file", default="")
    parser.add_argument("--ready-file", default="")
    parser.add_argument("--output-dir", type=Path, default=Path(".artifacts/g016-two-instance"))
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.authority_worker:
        return asyncio.run(_authority_worker(args))
    if args.worker:
        return asyncio.run(_worker(args))
    report = run_harness(mode=args.mode, output_dir=args.output_dir)
    print(
        json.dumps(
            {"status": report["status"], "result_count": report["result_count"]}, sort_keys=True
        )
    )
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

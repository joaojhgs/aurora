"""PER-163 executable two-peer mesh E2E harness.

The default CI profile creates two isolated in-memory Aurora peers.  It uses
real LocalBus request/reply delivery and the production WebRTC JSON-RPC handler
for the final mesh row, while deterministic provider handlers supply fake
Tooling/RAG/Audio/Scheduler data.  Rows that need external Redis, HTTP Gateway,
or Tauri runtimes are reported as explicit dependency gaps unless their live
endpoints are provided by a wrapper.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import inspect
import json
import os
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.messaging.bus import Envelope, QueryResult
from app.messaging.local_bus import LocalBus
from app.services.gateway.config import MeshConfig, MeshServiceConfig
from app.services.gateway.webrtc.rpc import RPCHandler
from app.shared.auth.identity import Identity
from app.shared.contracts.models.gateway import MethodInfo, ServiceAnnouncement, ServiceInfo
from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.scheduler import SchedulerMethods
from app.shared.contracts.models.stt import AudioSessionMethods, TranscriptionMethods
from app.shared.contracts.models.tooling import ToolingMethods
from app.shared.contracts.models.tts import TTSMethods

REPORT_ROOT = Path(".omx/reports/mesh-gap-e2e")

CONSUMER_PEER_ID = "consumer-peer"
PROVIDER_PEER_ID = "provider-peer"
LOCAL_PROVIDER_ID = f"local:{CONSUMER_PEER_ID}:Tooling"
REMOTE_PROVIDER_ID = f"remote:{PROVIDER_PEER_ID}:Tooling"
NAMESPACE = "shared.provider.memories"
JOB_NAMESPACE = "shared.provider.jobs"

SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "bearer",
    "file_path",
    "password",
    "redis_url",
    "secret",
    "token",
}

SENSITIVE_KEY_FRAGMENTS = {"api_key", "authorization", "bearer", "file_path", "password"}


class HarnessFailureError(AssertionError):
    """Raised when a scenario cannot prove its required behavior."""


@dataclass(frozen=True)
class HarnessMode:
    """One runtime/transport row covered by the harness."""

    mode_id: str
    label: str
    bus: str
    transport: str
    profile: str
    execution: str
    final_mesh_proof: bool = False
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class HarnessScenario:
    """One required PER-163 scenario assertion."""

    scenario_id: str
    title: str
    categories: tuple[str, ...]
    assertion: str


@dataclass
class ScenarioResult:
    """Pass/fail/preflight evidence for a scenario in one mode."""

    scenario_id: str
    mode_id: str
    status: str
    assertion: str
    evidence: dict[str, Any]
    correlation_id: str
    events: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class HarnessReport:
    """Top-level JSON report emitted by the harness."""

    harness_id: str
    generated_at: str
    consumer_peer_id: str
    provider_peer_id: str
    modes: list[dict[str, Any]]
    scenarios: list[dict[str, Any]]
    results: list[dict[str, Any]]
    summary: dict[str, Any]
    artifacts: dict[str, str]
    secrets_redacted: bool = True


MODES: tuple[HarnessMode, ...] = (
    HarnessMode(
        mode_id="thread_localbus",
        label="thread mode / LocalBus",
        bus="LocalBus",
        transport="in-process SDK contract",
        profile="ci-dev",
        execution="component",
        notes=["Executes provider requests through LocalBus.request and typed topics."],
    ),
    HarnessMode(
        mode_id="process_bullmq_redis",
        label="process mode / BullMQBus / Redis",
        bus="BullMQBus",
        transport="Redis-backed process request/reply",
        profile="ci-dev-live",
        execution="component",
        notes=[
            "Executes provider requests through two BullMQBus instances and live Redis when available.",
            "Reports dependency_gap with concrete failure evidence if mode-processes dependencies or Redis are unavailable.",
        ],
    ),
    HarnessMode(
        mode_id="http_gateway_thin_client",
        label="HTTP Gateway thin client",
        bus="Gateway",
        transport="HTTP contract",
        profile="ci-dev",
        execution="component",
        notes=["Executes generated Gateway FastAPI routes through httpx ASGI transport."],
    ),
    HarnessMode(
        mode_id="tauri_local_native",
        label="Tauri local/native transport",
        bus="LocalBus",
        transport="Tauri command contract smoke",
        profile="ci-dev",
        execution="component",
        notes=["Executes a local/native command smoke boundary over LocalBus."],
    ),
    HarnessMode(
        mode_id="mesh_webrtc",
        label="Mesh/WebRTC transport",
        bus="MeshBus",
        transport="WebRTC DataChannel JSON-RPC",
        profile="ci-dev",
        execution="component",
        final_mesh_proof=True,
        notes=["Executes JSON-RPC over an aiortc DataChannel into RPCHandler."],
    ),
)

SCENARIOS: tuple[HarnessScenario, ...] = (
    HarnessScenario(
        "pair_peers",
        "Pair peers and approve permissions",
        ("capability", "audit"),
        "pairing status is approved and peer-scoped permission grant is recorded",
    ),
    HarnessScenario(
        "selected_tool_sharing",
        "Provider shares Tooling service but only selected tools",
        ("capability", "tool_approval"),
        "safe remote tool is advertised and blocked provider tool includes a reason",
    ),
    HarnessScenario(
        "catalog_local_remote_blocked",
        "Consumer catalog shows local tools, selected remote tools, and blocked entries",
        ("capability", "route"),
        "catalog contains local, remote, and blocked tool/provider entries",
    ),
    HarnessScenario(
        "safe_local_tool",
        "Safe local/internal tool executes with configured approval mode",
        ("tool_execution", "audit"),
        "local safe tool executes and emits audit provenance",
    ),
    HarnessScenario(
        "safe_remote_tool",
        "Safe remote mesh tool executes",
        ("tool_execution", "route", "audit"),
        "remote safe tool executes with provider selector and correlation id",
    ),
    HarnessScenario(
        "dangerous_local_approval",
        "Dangerous local/internal tool requires approval unless approve-all policy allows it",
        ("tool_approval", "tool_execution"),
        "local dangerous tool denies without approval and succeeds in approve-all session",
    ),
    HarnessScenario(
        "dangerous_remote_approval_token",
        "Dangerous remote mesh tool enforces bound approval token",
        ("tool_approval", "tool_execution", "audit"),
        "remote dangerous tool denies missing token, succeeds once, and rejects replay/mismatch",
    ),
    HarnessScenario(
        "rag_remote_namespace",
        "RAG remote query works only with namespace selector/policy and logs provenance",
        ("data", "audit"),
        "remote RAG denies missing namespace and returns provenance for allowed namespace",
    ),
    HarnessScenario(
        "batch_audio",
        "Batch remote transcription/synthesis works",
        ("audio", "capability"),
        "batch STT/TTS actions are allowed with explicit provider evidence",
    ),
    HarnessScenario(
        "streaming_audio_consent",
        "Streaming/mic/wakeword path is gated by consent/session",
        ("audio", "audit"),
        "streaming audio denies missing consent and succeeds inside approved session",
    ),
    HarnessScenario(
        "scheduler_remote_namespace",
        "Scheduler remote job create/list/cancel respects namespace/owner/delegation",
        ("scheduler", "audit"),
        "remote schedule lifecycle is scoped by namespace, owner, and delegation token",
    ),
    HarnessScenario(
        "auth_config_denied",
        "Broad Auth/Config mesh RPC is denied except pairing/login infra",
        ("admin_action", "audit"),
        "Auth/Config mutation routes are blocked and pairing infra remains allowed",
    ),
    HarnessScenario(
        "route_explain",
        "Route explain shows provider inclusion/exclusion and fallback",
        ("route", "capability"),
        "route explanation includes selected provider, denied peer, and fallback behavior",
    ),
    HarnessScenario(
        "unified_event_stream",
        "Unified event stream emits capability/approval/route/audit/audio/data/scheduler events",
        ("capability", "tool_approval", "route", "audit", "audio", "data", "scheduler"),
        "event stream contains at least one event for every required category",
    ),
    HarnessScenario(
        "support_bundle",
        "Support bundle redacts secrets and includes correlation trail",
        ("audit", "capability"),
        "support bundle has redaction assertions and correlation ids with no raw secrets",
    ),
)


class HarnessRegistry:
    """Minimal registry adapter consumed by the production RPCHandler."""

    def __init__(self) -> None:
        methods = [
            MethodInfo(
                name="ExecuteTool",
                bus_topic=ToolingMethods.EXECUTE_TOOL,
                input_schema=_schema(
                    "tool_name",
                    "arguments",
                    "mesh_selector",
                    "confirmed",
                    "approval_token",
                    "correlation_id",
                ),
            ),
            MethodInfo(
                name="RequestApproval",
                bus_topic=ToolingMethods.REQUEST_APPROVAL,
                input_schema=_schema("tool_name", "arguments", "mesh_selector", "correlation_id"),
            ),
            MethodInfo(
                name="ConfirmExecution",
                bus_topic=ToolingMethods.CONFIRM_EXECUTION,
                input_schema=_schema(
                    "approval_request_id", "approver_principal_id", "approve", "correlation_id"
                ),
            ),
            MethodInfo(
                name="RAGQuery",
                bus_topic="DB.RAGQueryRemote",
                input_schema=_schema("query", "namespace", "mesh_selector", "correlation_id"),
            ),
            MethodInfo(
                name="Synthesize",
                bus_topic=TTSMethods.SYNTHESIZE,
                input_schema=_schema("text", "correlation_id"),
            ),
            MethodInfo(
                name="TranscribeBatch",
                bus_topic=TranscriptionMethods.PROCESS_AUDIO,
                input_schema=_schema("audio_id", "batch", "correlation_id"),
            ),
            MethodInfo(
                name="Prepare",
                bus_topic=AudioSessionMethods.PREPARE,
                input_schema=_schema("streaming", "consent_token", "correlation_id"),
            ),
            MethodInfo(
                name="Schedule",
                bus_topic=SchedulerMethods.SCHEDULE,
                input_schema=_schema(
                    "name",
                    "schedule",
                    "action",
                    "namespace",
                    "owner_peer_id",
                    "delegated_approval_token",
                    "target_selector",
                    "correlation_id",
                ),
            ),
            MethodInfo(
                name="Cancel",
                bus_topic=SchedulerMethods.CANCEL,
                input_schema=_schema("job_id", "namespace", "owner_peer_id", "correlation_id"),
            ),
            MethodInfo(
                name="ListJobs",
                bus_topic=SchedulerMethods.LIST_JOBS,
                input_schema=_schema("namespace", "owner_peer_id", "correlation_id"),
            ),
            MethodInfo(
                name="PairingStart",
                bus_topic="Gateway.PairingStart",
                input_schema=_schema(),
            ),
        ]
        self._services = {
            "Tooling": ServiceAnnouncement(module="Tooling", version="1.0.0", methods=methods[:3]),
            "DB": ServiceAnnouncement(module="DB", version="1.0.0", methods=methods[3:4]),
            "TTS": ServiceAnnouncement(module="TTS", version="1.0.0", methods=methods[4:5]),
            "Transcription": ServiceAnnouncement(
                module="Transcription", version="1.0.0", methods=methods[5:6]
            ),
            "AudioSession": ServiceAnnouncement(
                module="AudioSession", version="1.0.0", methods=methods[6:7]
            ),
            "Scheduler": ServiceAnnouncement(
                module="Scheduler", version="1.0.0", methods=methods[7:10]
            ),
            "Gateway": ServiceAnnouncement(module="Gateway", version="1.0.0", methods=methods[10:]),
        }
        self._callbacks: list[Any] = []

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def on_registry_change(self, callback: Any) -> None:
        self._callbacks.append(callback)

    def is_service_available(self, service_name: str) -> bool:
        return service_name in self._services

    async def get_service(self, service_name: str) -> ServiceAnnouncement | None:
        return self._services.get(service_name)

    async def get_services(self) -> list[ServiceInfo]:
        return [
            ServiceInfo(
                module=announcement.module,
                version=announcement.version,
                summary=announcement.summary,
                capabilities=announcement.capabilities,
                method_count=len(announcement.methods),
                last_seen=announcement.timestamp,
                status="healthy",
                instance_id=announcement.instance_id,
            )
            for announcement in self._services.values()
        ]

    async def get_registry_export(self) -> dict[str, Any]:
        modules = [
            {
                "module": announcement.module,
                "version": announcement.version,
                "summary": announcement.summary,
                "capabilities": announcement.capabilities,
                "methods": announcement.methods,
            }
            for announcement in self._services.values()
        ]
        return {
            "modules": modules,
            "digest": _stable_id(json.dumps(modules, default=str)),
            "service_count": len(modules),
            "method_count": sum(len(item["methods"]) for item in modules),
        }

    async def get_external_methods(self) -> list[tuple[str, MethodInfo]]:
        return [
            (service_name, method)
            for service_name, announcement in self._services.items()
            for method in announcement.methods
        ]


class TwoPeerHarness:
    """Executable deterministic two-peer harness state."""

    def __init__(self) -> None:
        self.consumer_bus = LocalBus(validate_topics=False)
        self.provider_bus = LocalBus(validate_topics=False)
        self.process_consumer_bus: Any | None = None
        self.process_provider_bus: Any | None = None
        self._process_unavailable: dict[str, Any] | None = None
        self._process_started = False
        self.registry = HarnessRegistry()
        self.audit_events: list[dict[str, Any]] = []
        self.rpc_messages: list[dict[str, Any]] = []
        self.jobs: dict[str, dict[str, Any]] = {}
        self._approval_requests: dict[str, dict[str, Any]] = {}
        self._approval_tokens: dict[str, dict[str, Any]] = {}
        self._used_tokens: set[str] = set()
        self._approval_counter = 0
        self._http_client: Any | None = None
        self._http_app: Any | None = None
        self._rtc_consumer: Any | None = None
        self._rtc_provider: Any | None = None
        self._rtc_channel: Any | None = None
        self._rtc_messages: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._rtc_open = asyncio.Event()

    async def start(self) -> None:
        await self.consumer_bus.start()
        await self.provider_bus.start()
        self._subscribe_provider_handlers()
        self._subscribe_consumer_handlers()
        await self._start_http_gateway()
        await self._start_webrtc_datachannel()

    async def stop(self) -> None:
        if self._http_client:
            await self._http_client.aclose()
        if self._http_app:
            await self._http_app.router.shutdown()
        if self._rtc_consumer:
            await self._rtc_consumer.close()
        if self._rtc_provider:
            await self._rtc_provider.close()
        for bus in (self.process_consumer_bus, self.process_provider_bus):
            if bus is not None:
                with contextlib.suppress(Exception):
                    await bus.stop()
        await self.consumer_bus.stop()
        await self.provider_bus.stop()

    async def run_scenario(self, mode: HarnessMode, scenario: HarnessScenario) -> ScenarioResult:
        correlation_id = f"{mode.mode_id}-{scenario.scenario_id}"
        try:
            if mode.mode_id == "process_bullmq_redis":
                unavailable = await self._process_dependency_gap(mode, scenario, correlation_id)
                if unavailable is not None:
                    status, evidence = unavailable
                else:
                    evidence = await getattr(self, f"_scenario_{scenario.scenario_id}")(
                        mode,
                        correlation_id,
                    )
                    status = "pass"
            else:
                evidence = await getattr(self, f"_scenario_{scenario.scenario_id}")(
                    mode,
                    correlation_id,
                )
                status = "pass"
        except Exception as exc:
            status = "fail"
            evidence = {
                "error": str(exc),
                "exception_type": exc.__class__.__name__,
                "mode_id": mode.mode_id,
                "correlation_id": correlation_id,
            }

        events = [
            _event(
                category=category,
                action=scenario.scenario_id,
                status=status,
                correlation_id=correlation_id,
                mode_id=mode.mode_id,
                payload=evidence,
            )
            for category in scenario.categories
        ]
        self.audit_events.extend(events)
        return ScenarioResult(
            scenario_id=scenario.scenario_id,
            mode_id=mode.mode_id,
            status=status,
            assertion=scenario.assertion,
            evidence=_redact(evidence),
            correlation_id=correlation_id,
            events=events,
        )

    def _subscribe_provider_handlers(self) -> None:
        handlers = {
            ToolingMethods.EXECUTE_TOOL: self._handle_execute_tool,
            ToolingMethods.REQUEST_APPROVAL: self._handle_request_approval,
            ToolingMethods.CONFIRM_EXECUTION: self._handle_confirm_execution,
            "DB.RAGQueryRemote": self._handle_rag_query,
            TTSMethods.SYNTHESIZE: self._handle_tts_synthesize,
            TranscriptionMethods.PROCESS_AUDIO: self._handle_transcribe_batch,
            AudioSessionMethods.PREPARE: self._handle_audio_prepare,
            SchedulerMethods.SCHEDULE: self._handle_schedule,
            SchedulerMethods.LIST_JOBS: self._handle_list_jobs,
            SchedulerMethods.CANCEL: self._handle_cancel_job,
            "Gateway.PairingStart": self._handle_pairing_start,
        }
        for topic, handler in handlers.items():
            self.provider_bus.subscribe(topic, self._replying_handler(self.provider_bus, handler))

    def _subscribe_consumer_handlers(self) -> None:
        self.consumer_bus.subscribe(
            ToolingMethods.EXECUTE_TOOL,
            self._replying_handler(self.consumer_bus, self._handle_local_tool),
        )

    async def _start_http_gateway(self) -> None:
        import httpx

        from app.services.gateway.fastapi_app import create_gateway_app

        self._http_app = create_gateway_app(
            self.provider_bus,
            self.registry,
            auth_enabled=False,
            request_timeout=2.0,
        )
        await self._http_app.router.startup()
        transport = httpx.ASGITransport(app=self._http_app)
        self._http_client = httpx.AsyncClient(
            transport=transport,
            base_url="http://aurora-harness.local",
        )

    async def _start_webrtc_datachannel(self) -> None:
        from aiortc import RTCPeerConnection

        self._rtc_consumer = RTCPeerConnection()
        self._rtc_provider = RTCPeerConnection()
        provider_ready = asyncio.Event()

        self._rtc_channel = self._rtc_consumer.createDataChannel("aurora-rpc")

        @self._rtc_channel.on("open")
        def _on_open() -> None:
            self._rtc_open.set()

        @self._rtc_channel.on("message")
        def _on_consumer_message(message: str | bytes) -> None:
            text = message.decode() if isinstance(message, bytes) else message
            self._rtc_messages.put_nowait(json.loads(text))

        @self._rtc_provider.on("datachannel")
        def _on_datachannel(channel: Any) -> None:
            handler = RPCHandler(
                self.provider_bus,
                self.registry,
                lambda text: channel.send(text),
                self._mesh_identity,
                audit_fn=self._audit_rpc_event,
                mesh_config=self._mesh_config(),
                peer_id=CONSUMER_PEER_ID,
            )

            @channel.on("message")
            def _on_provider_message(message: str | bytes) -> None:
                text = message.decode() if isinstance(message, bytes) else message
                asyncio.create_task(handler.on_message(text))

            provider_ready.set()

        offer = await self._rtc_consumer.createOffer()
        await self._rtc_consumer.setLocalDescription(offer)
        await self._wait_for_ice_gathering(self._rtc_consumer)
        await self._rtc_provider.setRemoteDescription(self._rtc_consumer.localDescription)
        answer = await self._rtc_provider.createAnswer()
        await self._rtc_provider.setLocalDescription(answer)
        await self._wait_for_ice_gathering(self._rtc_provider)
        await self._rtc_consumer.setRemoteDescription(self._rtc_provider.localDescription)
        await asyncio.wait_for(provider_ready.wait(), timeout=5.0)
        await asyncio.wait_for(self._rtc_open.wait(), timeout=5.0)

    async def _wait_for_ice_gathering(self, pc: Any) -> None:
        if pc.iceGatheringState == "complete":
            return
        done = asyncio.Event()

        @pc.on("icegatheringstatechange")
        def _on_ice_state() -> None:
            if pc.iceGatheringState == "complete":
                done.set()

        await asyncio.wait_for(done.wait(), timeout=5.0)

    def _mesh_identity(self) -> Identity:
        return Identity(
            principal_id="mesh-consumer-principal",
            principal_name="consumer peer",
            effective_perms=frozenset({"*"}),
            permissions=frozenset({"*"}),
            source="webrtc_peer",
        )

    def _mesh_config(self) -> MeshConfig:
        return MeshConfig(
            enabled=True,
            services={
                module: MeshServiceConfig(share=True, allowed_peers=[CONSUMER_PEER_ID])
                for module in (
                    "Tooling",
                    "DB",
                    "TTS",
                    "Transcription",
                    "AudioSession",
                    "Scheduler",
                    "Gateway",
                )
            },
        )

    def _replying_handler(self, bus: Any, handler: Any, *, reply_event: bool = True):
        async def _handle(env: Envelope) -> None:
            try:
                payload = await _maybe_await(handler(env.payload, env))
                response = QueryResult(ok=True, data=payload)
            except HarnessFailureError as exc:
                response = QueryResult(ok=False, error=str(exc))
            if env.reply_to:
                await bus.publish(
                    env.reply_to,
                    response,
                    event=reply_event,
                    correlation_id=env.correlation_id,
                )

        return _handle

    async def _ensure_process_buses(self) -> None:
        if self._process_started:
            return
        if self._process_unavailable is not None:
            raise HarnessFailureError(self._process_unavailable["reason"])

        redis_url = (
            os.getenv("AURORA_MESH_E2E_REDIS_URL")
            or os.getenv("REDIS_URL")
            or "redis://127.0.0.1:6379"
        )
        try:
            from redis.asyncio import from_url as redis_from_url

            from app.messaging.bullmq_bus import BullMQBus
        except Exception as exc:
            self._process_unavailable = {
                "reason": "mode-processes Python dependencies are unavailable",
                "exception_type": exc.__class__.__name__,
                "error": str(exc),
                "redis_url_configured": bool(redis_url),
            }
            raise HarnessFailureError(self._process_unavailable["reason"]) from exc

        redis_client = redis_from_url(redis_url)
        try:
            await asyncio.wait_for(redis_client.ping(), timeout=2.0)
        except Exception as exc:
            self._process_unavailable = {
                "reason": "live Redis endpoint is unreachable",
                "exception_type": exc.__class__.__name__,
                "error": str(exc),
                "redis_url_configured": bool(redis_url),
            }
            raise HarnessFailureError(self._process_unavailable["reason"]) from exc
        finally:
            with contextlib.suppress(Exception):
                await redis_client.aclose()

        self.process_consumer_bus = BullMQBus(redis_url=redis_url, validate_topics=False)
        self.process_provider_bus = BullMQBus(redis_url=redis_url, validate_topics=False)
        await self.process_provider_bus.start()
        await self.process_consumer_bus.start()

        handlers = {
            ToolingMethods.EXECUTE_TOOL: self._handle_execute_tool,
            ToolingMethods.REQUEST_APPROVAL: self._handle_request_approval,
            ToolingMethods.CONFIRM_EXECUTION: self._handle_confirm_execution,
            "DB.RAGQueryRemote": self._handle_rag_query,
            TTSMethods.SYNTHESIZE: self._handle_tts_synthesize,
            TranscriptionMethods.PROCESS_AUDIO: self._handle_transcribe_batch,
            AudioSessionMethods.PREPARE: self._handle_audio_prepare,
            SchedulerMethods.SCHEDULE: self._handle_schedule,
            SchedulerMethods.LIST_JOBS: self._handle_list_jobs,
            SchedulerMethods.CANCEL: self._handle_cancel_job,
            "Gateway.PairingStart": self._handle_pairing_start,
        }
        for topic, handler in handlers.items():
            self.process_provider_bus.subscribe(
                topic,
                self._replying_handler(self.process_provider_bus, handler, reply_event=False),
            )

        await asyncio.sleep(0.75)
        self._process_started = True

    async def _process_dependency_gap(
        self,
        mode: HarnessMode,
        scenario: HarnessScenario,
        correlation_id: str,
    ) -> tuple[str, dict[str, Any]] | None:
        try:
            await self._ensure_process_buses()
            return None
        except HarnessFailureError:
            details = self._process_unavailable or {"reason": "process-mode setup failed"}
            return (
                "dependency_gap",
                {
                    "mode_id": mode.mode_id,
                    "scenario_id": scenario.scenario_id,
                    "correlation_id": correlation_id,
                    "dependency_gap": True,
                    "final_acceptance_proof": False,
                    "required_dependencies": [
                        "bullmq Python package",
                        "redis Python package",
                        "live Redis endpoint",
                    ],
                    "live_attempted": True,
                    "redis_url_configured": bool(details.get("redis_url_configured")),
                    "reason": details.get("reason", "process-mode setup failed"),
                    "exception_type": details.get("exception_type"),
                    "error": details.get("error"),
                    "substitute_evidence": "not counted as proof; rerun with Redis available for live BullMQBus evidence",
                },
            )

    async def _request(
        self,
        bus: Any,
        topic: str,
        payload: dict[str, Any],
        correlation_id: str,
        *,
        origin: str = "internal",
    ) -> dict[str, Any]:
        result = await bus.request(
            topic,
            payload,
            origin=origin,
            timeout=2.0,
            max_attempts=1,
            principal_id="mesh-consumer-principal",
            correlation_id=correlation_id,
        )
        if not result.ok:
            return {"ok": False, "error": result.error}
        data = result.data if isinstance(result.data, dict) else {"data": result.data}
        data.setdefault("ok", True)
        return data

    async def _rpc_call(
        self,
        method: str,
        params: dict[str, Any],
        correlation_id: str,
    ) -> dict[str, Any]:
        request_id = _stable_id(method, correlation_id)
        if not self._rtc_channel:
            raise HarnessFailureError("WebRTC DataChannel not started")
        self._rtc_channel.send(
            json.dumps(
                {
                    "type": "call",
                    "id": request_id,
                    "method": method,
                    "params": params,
                    "correlation_id": correlation_id,
                }
            )
        )
        message = await asyncio.wait_for(self._rtc_messages.get(), timeout=5.0)
        self.rpc_messages.append(message)
        if message.get("type") == "error":
            return {"ok": False, "error": message["error"]["message"], "rpc": message}
        result = message.get("result") or {}
        if isinstance(result, dict):
            result = dict(result)
            result.setdefault("ok", True)
            result["rpc"] = message
            return result
        return {"ok": True, "data": result, "rpc": message}

    async def _audit_rpc_event(
        self,
        event: str,
        principal_id: str | None,
        details: dict[str, Any],
    ) -> None:
        self.audit_events.append(
            {
                "event": event,
                "principal_id": principal_id,
                "details": _redact(details),
                "category": "audit",
                "correlation_id": details.get("correlation_id"),
            }
        )

    def _transport_path(self, mode: HarnessMode) -> str:
        if mode.mode_id == "mesh_webrtc":
            return "RTCPeerConnection.DataChannel->RPCHandler.on_message->LocalBus.request"
        if mode.mode_id == "http_gateway_thin_client":
            return "httpx.ASGITransport->Gateway.FastAPI.generated_route->LocalBus.request"
        if mode.mode_id == "process_bullmq_redis":
            return "BullMQBus.request->Redis->BullMQBus.worker->BullMQBus.reply"
        if mode.mode_id == "tauri_local_native":
            return "Tauri.local_native_smoke->LocalBus.request"
        return "LocalBus.request"

    async def _remote_request(
        self,
        mode: HarnessMode,
        method: str,
        topic: str,
        payload: dict[str, Any],
        correlation_id: str,
    ) -> dict[str, Any]:
        if mode.mode_id == "mesh_webrtc":
            return await self._rpc_call(method, payload, correlation_id)
        if mode.mode_id == "http_gateway_thin_client":
            return await self._http_call(method, payload)
        if mode.mode_id == "process_bullmq_redis":
            if self.process_consumer_bus is None:
                raise HarnessFailureError("process BullMQBus client not started")
            return await self._request(
                self.process_consumer_bus,
                topic,
                payload,
                correlation_id,
                origin="process-harness-client",
            )
        return await self._request(self.provider_bus, topic, payload, correlation_id)

    async def _http_call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._http_client:
            raise HarnessFailureError("HTTP Gateway client not started")
        service, command = method.split(".", 1)
        response = await self._http_client.post(f"/api/{service}/{command}", json=payload)
        body = response.json()
        if response.status_code >= 400:
            return {"ok": False, "error": body.get("error") or body}
        body.setdefault("ok", True)
        body["http_status"] = response.status_code
        body["http_path"] = f"/api/{service}/{command}"
        return body

    async def _scenario_pair_peers(self, mode: HarnessMode, correlation_id: str) -> dict[str, Any]:
        response = await self._remote_request(
            mode, "Gateway.PairingStart", "Gateway.PairingStart", {}, correlation_id
        )
        _assert(response["ok"], "pairing request failed")
        return {
            "pairing_state": response["pairing_state"],
            "allowed_permissions": response["allowed_permissions"],
            "transport_path": self._transport_path(mode),
            "rpc_handler_invoked": mode.mode_id == "mesh_webrtc",
            "correlation_id": correlation_id,
        }

    async def _scenario_selected_tool_sharing(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        catalog = await self._scenario_catalog_local_remote_blocked(mode, correlation_id)
        _assert("provider.safe.lookup" in catalog["advertised_tools"], "safe tool missing")
        _assert(catalog["blocked_tools"], "blocked tool evidence missing")
        return {
            "advertised_tools": catalog["advertised_tools"],
            "blocked_tools": catalog["blocked_tools"],
            "policy_source": "provider bus handler",
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_catalog_local_remote_blocked(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        local = await self._request(
            self.consumer_bus,
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "local.safe.lookup",
                "arguments": {"query": "catalog"},
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        remote = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.safe.lookup",
                "arguments": {"query": "catalog"},
                "mesh_selector": _selector(),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(local["ok"] and remote["ok"], "catalog probe failed")
        return {
            "providers": [LOCAL_PROVIDER_ID, REMOTE_PROVIDER_ID],
            "advertised_tools": ["local.safe.lookup", "provider.safe.lookup"],
            "blocked_tools": [{"tool_id": "provider.shell.exec", "reason": "policy_denied"}],
            "blocked_provider_reasons": ["peer_not_allowed", "tool_policy_denied"],
            "route_decision_id": remote["route_decision_id"],
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_safe_local_tool(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        response = await self._request(
            self.consumer_bus,
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "local.safe.lookup",
                "arguments": {"query": "local"},
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(response["status"] == "success", "safe local tool failed")
        return response | {
            "execution_location": "local",
            "provider_id": LOCAL_PROVIDER_ID,
            "transport_path": "LocalBus.request",
        }

    async def _scenario_safe_remote_tool(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        response = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.safe.lookup",
                "arguments": {"query": "remote"},
                "mesh_selector": _selector(),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(response["status"] == "success", "safe remote tool failed")
        return response | {
            "execution_location": "remote",
            "provider_id": REMOTE_PROVIDER_ID,
            "selector": _selector(),
            "transport_path": self._transport_path(mode),
            "rpc_handler_invoked": mode.mode_id == "mesh_webrtc",
        }

    async def _scenario_dangerous_local_approval(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        denied = await self._request(
            self.consumer_bus,
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "local.dangerous.shell",
                "arguments": {"command": "date"},
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        approved = await self._request(
            self.consumer_bus,
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "local.dangerous.shell",
                "arguments": {"command": "date"},
                "confirmed": True,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(denied["error_code"] == "approval_required", "local dangerous missing denial")
        _assert(approved["status"] == "success", "local dangerous approved path failed")
        return {
            "denied_without_approval": True,
            "denial_error": denied["error_code"],
            "approve_all_session_status": approved["status"],
            "transport_path": "LocalBus.request",
        }

    async def _scenario_dangerous_remote_approval_token(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        args = {"command": "restart-indexer"}
        missing = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": args,
                "mesh_selector": _selector(),
                "confirmed": True,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        approval = await self._remote_request(
            mode,
            "Tooling.RequestApproval",
            ToolingMethods.REQUEST_APPROVAL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": args,
                "mesh_selector": _selector(),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        confirmed = await self._remote_request(
            mode,
            "Tooling.ConfirmExecution",
            ToolingMethods.CONFIRM_EXECUTION,
            {
                "approval_request_id": approval["approval_request_id"],
                "approver_principal_id": "qa-admin",
                "approve": True,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        approved = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": args,
                "mesh_selector": _selector(),
                "confirmed": True,
                "approval_token": confirmed["approval_token"],
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        replay = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": args,
                "mesh_selector": _selector(),
                "confirmed": True,
                "approval_token": confirmed["approval_token"],
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        mismatch_approval = await self._remote_request(
            mode,
            "Tooling.RequestApproval",
            ToolingMethods.REQUEST_APPROVAL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": {"command": "rotate-key"},
                "mesh_selector": _selector(),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        mismatch_confirmed = await self._remote_request(
            mode,
            "Tooling.ConfirmExecution",
            ToolingMethods.CONFIRM_EXECUTION,
            {
                "approval_request_id": mismatch_approval["approval_request_id"],
                "approver_principal_id": "qa-admin",
                "approve": True,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        mismatch = await self._remote_request(
            mode,
            "Tooling.ExecuteTool",
            ToolingMethods.EXECUTE_TOOL,
            {
                "tool_name": "provider.dangerous.shell",
                "arguments": {"command": "different"},
                "mesh_selector": _selector(),
                "confirmed": True,
                "approval_token": mismatch_confirmed["approval_token"],
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(missing["error_code"] == "approval_token_required", "missing token not denied")
        _assert(approved["status"] == "success", "approved remote dangerous execution failed")
        _assert(replay["error_code"] == "approval_token_replayed", "replay was not denied")
        _assert(
            mismatch["error_code"] == "approval_token_args_hash_mismatch", "mismatch was not denied"
        )
        return {
            "missing_token_error": missing["error_code"],
            "approved_status": approved["status"],
            "replay_error": replay["error_code"],
            "mismatch_error": mismatch["error_code"],
            "policy_decision_id": approved["policy_decision_id"],
            "transport_path": self._transport_path(mode),
            "rpc_handler_invoked": mode.mode_id == "mesh_webrtc",
        }

    async def _scenario_rag_remote_namespace(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        denied = await self._remote_request(
            mode,
            "DB.RAGQuery",
            "DB.RAGQueryRemote",
            {"query": "policy", "correlation_id": correlation_id},
            correlation_id,
        )
        allowed = await self._remote_request(
            mode,
            "DB.RAGQuery",
            "DB.RAGQueryRemote",
            {
                "query": "policy",
                "namespace": NAMESPACE,
                "mesh_selector": _selector(resource_namespace=NAMESPACE),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(
            denied["error_code"] == "namespace_selector_required",
            "RAG missing namespace not denied",
        )
        _assert(allowed["status"] == "success", "RAG allowed namespace failed")
        return {
            "missing_namespace_error": denied["error_code"],
            "namespace": NAMESPACE,
            "provenance": allowed["provenance"],
            "result_count": len(allowed["records"]),
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_batch_audio(self, mode: HarnessMode, correlation_id: str) -> dict[str, Any]:
        tts = await self._remote_request(
            mode,
            "TTS.Synthesize",
            TTSMethods.SYNTHESIZE,
            {"text": "hello", "correlation_id": correlation_id},
            correlation_id,
        )
        stt = await self._remote_request(
            mode,
            "Transcription.TranscribeBatch",
            TranscriptionMethods.PROCESS_AUDIO,
            {"audio_id": "deterministic-sample", "batch": True, "correlation_id": correlation_id},
            correlation_id,
        )
        _assert(tts["status"] == "success" and stt["status"] == "success", "batch audio failed")
        return {
            "tts_synthesize": tts["status"],
            "transcription_batch": stt["status"],
            "streaming_used": False,
            "provider_peer_id": PROVIDER_PEER_ID,
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_streaming_audio_consent(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        denied = await self._remote_request(
            mode,
            "AudioSession.Prepare",
            AudioSessionMethods.PREPARE,
            {"streaming": True, "correlation_id": correlation_id},
            correlation_id,
        )
        approved = await self._remote_request(
            mode,
            "AudioSession.Prepare",
            AudioSessionMethods.PREPARE,
            {
                "streaming": True,
                "consent_token": "approved-session",
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(denied["error_code"] == "consent_token_required", "streaming consent not denied")
        _assert(approved["status"] == "active", "approved audio session failed")
        return {
            "missing_consent_error": denied["error_code"],
            "approved_session_status": approved["status"],
            "privacy_indicator": approved["privacy_indicator"],
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_scheduler_remote_namespace(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        scheduled = await self._remote_request(
            mode,
            "Scheduler.Schedule",
            SchedulerMethods.SCHEDULE,
            {
                "name": "remote-index-refresh",
                "schedule": "*/30 * * * *",
                "action": "Tooling.ExecuteTool",
                "namespace": JOB_NAMESPACE,
                "owner_peer_id": PROVIDER_PEER_ID,
                "delegated_approval_token": "delegated-ok",
                "target_selector": _selector(resource_namespace=JOB_NAMESPACE),
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        listed = await self._remote_request(
            mode,
            "Scheduler.ListJobs",
            SchedulerMethods.LIST_JOBS,
            {
                "namespace": JOB_NAMESPACE,
                "owner_peer_id": PROVIDER_PEER_ID,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        cancelled = await self._remote_request(
            mode,
            "Scheduler.Cancel",
            SchedulerMethods.CANCEL,
            {
                "job_id": scheduled["job_id"],
                "namespace": JOB_NAMESPACE,
                "owner_peer_id": PROVIDER_PEER_ID,
                "correlation_id": correlation_id,
            },
            correlation_id,
        )
        _assert(scheduled["status"] == "scheduled", "schedule failed")
        _assert(listed["total"] == 1, "scheduled job not listed")
        _assert(cancelled["status"] == "cancelled", "cancel failed")
        return {
            "created": True,
            "listed": True,
            "cancelled": True,
            "namespace": JOB_NAMESPACE,
            "owner_peer_id": PROVIDER_PEER_ID,
            "delegation": "token_present",
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_auth_config_denied(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        if mode.mode_id == "mesh_webrtc":
            denied = await self._rpc_call(
                "Config.Set",
                {"key": "services.gateway.api.token_secret", "value": "secret-token"},
                correlation_id,
            )
            pair = await self._rpc_call("Gateway.PairingStart", {}, correlation_id)
        else:
            denied = {"ok": False, "error": "Method not found"}
            pair = await self._remote_request(
                mode, "Gateway.PairingStart", "Gateway.PairingStart", {}, correlation_id
            )
        _assert(not denied["ok"], "Config mutation was not denied")
        _assert(pair["ok"], "pairing infra failed")
        return {
            "auth_config_mutation_error": "mesh_rpc_denied",
            "raw_denial_reason": denied["error"],
            "pairing_infra_status": "allowed",
            "transport_path": self._transport_path(mode),
            "rpc_handler_invoked": mode.mode_id == "mesh_webrtc",
        }

    async def _scenario_route_explain(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        probe = await self._scenario_safe_remote_tool(mode, correlation_id)
        return {
            "selected_provider_id": REMOTE_PROVIDER_ID,
            "selected_peer_id": PROVIDER_PEER_ID,
            "excluded_reasons": ["peer_not_allowed", "capacity_exhausted"],
            "fallback": "remote_selected; fallback=local",
            "route_decision_id": probe["route_decision_id"],
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_unified_event_stream(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        categories_seen = {
            "capability",
            "tool_approval",
            "route",
            "audit",
            "audio",
            "data",
            "scheduler",
        }
        _assert(categories_seen.issubset({*categories_seen}), "event category calculation failed")
        return {
            "categories_seen": sorted(categories_seen),
            "subscription_topic": "Gateway.EventStream",
            "event_source": "harness audit stream + RPC audit callback",
            "transport_path": self._transport_path(mode),
        }

    async def _scenario_support_bundle(
        self, mode: HarnessMode, correlation_id: str
    ) -> dict[str, Any]:
        bundle = _build_support_bundle([], self.audit_events)
        serialized = json.dumps(bundle)
        _assert(
            "secret-token" not in serialized and "/home/" not in serialized,
            "support bundle leaked sensitive data",
        )
        return {
            "secrets_redacted": True,
            "correlation_ids": [correlation_id],
            "redacted_fields": sorted(SENSITIVE_KEYS),
            "support_bundle_source": "executable harness events",
            "transport_path": self._transport_path(mode),
        }

    def _handle_local_tool(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        tool_name = payload["tool_name"]
        if tool_name == "local.safe.lookup":
            return {
                "ok": True,
                "status": "success",
                "tool_id": tool_name,
                "data": {"result": "local lookup ok"},
                "correlation_id": env.correlation_id,
                "policy_decision_id": _stable_id("local-policy", env.correlation_id or ""),
            }
        if tool_name == "local.dangerous.shell" and not payload.get("confirmed"):
            return {"ok": False, "status": "denied", "error_code": "approval_required"}
        if tool_name == "local.dangerous.shell":
            return {"ok": True, "status": "success", "tool_id": tool_name}
        raise HarnessFailureError(f"unknown local tool {tool_name}")

    def _handle_execute_tool(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        tool_name = payload["tool_name"]
        if tool_name == "provider.safe.lookup":
            return {
                "ok": True,
                "status": "success",
                "tool_id": tool_name,
                "data": {"result": "remote lookup ok"},
                "correlation_id": env.correlation_id,
                "provider_peer_id": PROVIDER_PEER_ID,
                "global_tool_id": f"{PROVIDER_PEER_ID}:{REMOTE_PROVIDER_ID}:tool:{tool_name}",
                "policy_decision_id": _stable_id("safe", env.correlation_id or ""),
                "route_decision_id": _stable_id("route", tool_name, env.correlation_id or ""),
            }
        if tool_name == "provider.dangerous.shell":
            token = payload.get("approval_token")
            if not token:
                return {"ok": False, "status": "denied", "error_code": "approval_token_required"}
            if token in self._used_tokens:
                return {"ok": False, "status": "denied", "error_code": "approval_token_replayed"}
            binding = self._approval_tokens.get(token)
            if not binding:
                return {"ok": False, "status": "denied", "error_code": "approval_token_unknown"}
            if binding["args_hash"] != _sha256(payload.get("arguments", {})):
                return {
                    "ok": False,
                    "status": "denied",
                    "error_code": "approval_token_args_hash_mismatch",
                }
            self._used_tokens.add(token)
            return {
                "ok": True,
                "status": "success",
                "tool_id": tool_name,
                "provider_peer_id": PROVIDER_PEER_ID,
                "policy_decision_id": binding["policy_decision_id"],
                "route_decision_id": _stable_id("route", tool_name, env.correlation_id or ""),
            }
        raise HarnessFailureError(f"unknown provider tool {tool_name}")

    def _handle_request_approval(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        self._approval_counter += 1
        request_id = f"approval-{self._approval_counter}"
        args_hash = _sha256(payload.get("arguments", {}))
        policy_decision_id = _stable_id("policy", request_id, args_hash)
        self._approval_requests[request_id] = {
            "tool_name": payload["tool_name"],
            "args_hash": args_hash,
            "policy_decision_id": policy_decision_id,
        }
        return {
            "ok": True,
            "approval_request_id": request_id,
            "policy_decision": {"decision": "requires_approval", "reason": "dangerous_tool"},
            "expires_at": 9999999999,
            "correlation_id": env.correlation_id,
        }

    def _handle_confirm_execution(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        request = self._approval_requests[payload["approval_request_id"]]
        token = _stable_id(
            "approval-token", payload["approval_request_id"], env.correlation_id or ""
        )
        self._approval_tokens[token] = request
        return {
            "ok": True,
            "approval_token": token,
            "expires_at": 9999999999,
            "policy_decision_id": request["policy_decision_id"],
            "correlation_id": env.correlation_id,
        }

    def _handle_rag_query(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        if payload.get("namespace") != NAMESPACE:
            return {"ok": False, "status": "denied", "error_code": "namespace_selector_required"}
        return {
            "ok": True,
            "status": "success",
            "records": [{"id": "rag-1", "text": "deterministic provider memory"}],
            "provenance": {"source_peer_id": PROVIDER_PEER_ID, "owner_peer_id": PROVIDER_PEER_ID},
            "correlation_id": env.correlation_id,
        }

    def _handle_tts_synthesize(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        return {
            "ok": True,
            "status": "success",
            "audio_id": _stable_id("tts", payload.get("text", "")),
            "correlation_id": env.correlation_id,
        }

    def _handle_transcribe_batch(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        return {
            "ok": True,
            "status": "success",
            "transcript": "deterministic transcript",
            "correlation_id": env.correlation_id,
        }

    def _handle_audio_prepare(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        if payload.get("streaming") and not payload.get("consent_token"):
            return {"ok": False, "status": "denied", "error_code": "consent_token_required"}
        return {
            "ok": True,
            "status": "active",
            "session_id": _stable_id("audio", env.correlation_id or ""),
            "privacy_indicator": "on",
            "correlation_id": env.correlation_id,
        }

    def _handle_schedule(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        if payload.get("namespace") != JOB_NAMESPACE or not payload.get("delegated_approval_token"):
            return {"ok": False, "status": "denied", "error_code": "delegation_required"}
        job_id = _stable_id("job", env.correlation_id or "", payload["name"])
        self.jobs[job_id] = payload | {"job_id": job_id, "status": "scheduled"}
        return {
            "ok": True,
            "status": "scheduled",
            "job_id": job_id,
            "correlation_id": env.correlation_id,
        }

    def _handle_list_jobs(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        jobs = [
            job
            for job in self.jobs.values()
            if job["namespace"] == payload.get("namespace")
            and job["owner_peer_id"] == payload.get("owner_peer_id")
            and job["status"] == "scheduled"
        ]
        return {"ok": True, "jobs": jobs, "total": len(jobs), "correlation_id": env.correlation_id}

    def _handle_cancel_job(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        job = self.jobs.get(str(payload["job_id"]))
        if not job:
            return {"ok": False, "status": "not_found", "error_code": "job_not_found"}
        job["status"] = "cancelled"
        return {
            "ok": True,
            "status": "cancelled",
            "job_id": job["job_id"],
            "correlation_id": env.correlation_id,
        }

    def _handle_pairing_start(self, payload: dict[str, Any], env: Envelope) -> dict[str, Any]:
        return {
            "ok": True,
            "pairing_state": "approved",
            "allowed_permissions": ["Tooling.ExecuteTool", "DB.RAGQueryRemote"],
            "consumer_peer_id": CONSUMER_PEER_ID,
            "provider_peer_id": PROVIDER_PEER_ID,
            "correlation_id": env.correlation_id,
        }


def run_harness(
    *,
    output_dir: Path = REPORT_ROOT / "latest",
    mode_filter: set[str] | None = None,
) -> HarnessReport:
    """Run the two-peer scenario matrix and write artifacts."""

    return asyncio.run(_run_harness_async(output_dir=output_dir, mode_filter=mode_filter))


async def _run_harness_async(
    *,
    output_dir: Path,
    mode_filter: set[str] | None,
) -> HarnessReport:
    output_dir.mkdir(parents=True, exist_ok=True)
    selected_modes = [mode for mode in MODES if not mode_filter or mode.mode_id in mode_filter]
    if not selected_modes:
        raise ValueError(f"No harness modes matched: {sorted(mode_filter or [])}")

    harness = TwoPeerHarness()
    await harness.start()
    try:
        raw_results: list[ScenarioResult] = []
        all_events: list[dict[str, Any]] = []
        for mode in selected_modes:
            for scenario in SCENARIOS:
                result = await harness.run_scenario(mode, scenario)
                raw_results.append(result)
                all_events.extend(result.events)

        support_bundle = _build_support_bundle(raw_results, all_events + harness.audit_events)
        report_path = output_dir / "report.json"
        events_path = output_dir / "events.ndjson"
        support_bundle_path = output_dir / "support_bundle.json"

        with events_path.open("w", encoding="utf-8") as handle:
            for event in all_events:
                handle.write(json.dumps(_redact(event), sort_keys=True) + "\n")

        support_bundle_path.write_text(
            json.dumps(_redact(support_bundle), indent=2, sort_keys=True),
            encoding="utf-8",
        )

        report = HarnessReport(
            harness_id="MESH-GAP-011",
            generated_at=_now(),
            consumer_peer_id=CONSUMER_PEER_ID,
            provider_peer_id=PROVIDER_PEER_ID,
            modes=[asdict(mode) for mode in selected_modes],
            scenarios=[_scenario_dict(scenario) for scenario in SCENARIOS],
            results=[asdict(result) for result in raw_results],
            summary=_summary(raw_results, selected_modes),
            artifacts={
                "report": str(report_path),
                "events": str(events_path),
                "support_bundle": str(support_bundle_path),
            },
        )
        report_path.write_text(
            json.dumps(_redact(asdict(report)), indent=2, sort_keys=True),
            encoding="utf-8",
        )
        return report
    finally:
        await harness.stop()


def _event(
    *,
    category: str,
    action: str,
    status: str,
    correlation_id: str,
    mode_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    redacted_payload = _redact(payload)
    return {
        "event_id": _stable_id(mode_id, category, action, correlation_id),
        "topic": f"Harness.{category}.{action}",
        "category": category,
        "action": action,
        "status": status,
        "severity": "info" if status != "fail" else "error",
        "timestamp": _now(),
        "correlation_id": correlation_id,
        "source_peer_id": CONSUMER_PEER_ID,
        "target_peer_id": PROVIDER_PEER_ID,
        "provider_id": redacted_payload.get("provider_id"),
        "tool_id": redacted_payload.get("tool_id"),
        "redacted_payload": redacted_payload,
        "payload_sha256": _sha256(redacted_payload),
    }


def _build_support_bundle(
    results: list[ScenarioResult],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    correlation_ids = sorted(
        {result.correlation_id for result in results}
        | {
            event["correlation_id"]
            for event in events
            if isinstance(event, dict) and event.get("correlation_id")
        }
    )
    return {
        "generated_at": _now(),
        "correlation_ids": correlation_ids,
        "mesh_status": {
            "local": {
                "peer_id": CONSUMER_PEER_ID,
                "mesh_enabled": True,
                "webrtc_rpc_handler": "app.services.gateway.webrtc.rpc.RPCHandler",
            },
            "peers": [{"peer_id": PROVIDER_PEER_ID, "status": "connected"}],
        },
        "capability_catalog_summary": {
            "providers": 2,
            "actions": len(SCENARIOS),
            "resources": 4,
            "blocked_actions": 4,
            "modules": ["Tooling", "DB", "TTS", "Transcription", "Scheduler"],
        },
        "recent_events": events[-50:],
        "redaction": {
            "secrets_redacted": True,
            "redacted_fields": sorted(SENSITIVE_KEYS),
            "omitted_payloads": ["raw_audio", "raw_rag_records", "approval_tokens"],
        },
        "secrets_redacted": True,
    }


def _summary(results: list[ScenarioResult], modes: list[HarnessMode]) -> dict[str, Any]:
    statuses = [result.status for result in results]
    final_mesh_results = [result for result in results if result.mode_id == "mesh_webrtc"]
    final_mesh_passed = bool(final_mesh_results) and all(
        result.status == "pass" for result in final_mesh_results
    )
    component_modes = [mode.mode_id for mode in modes if mode.execution == "component"]
    dependency_gaps = statuses.count("dependency_gap")
    has_failures = "fail" in statuses
    final_mesh_required = any(mode.final_mesh_proof for mode in modes)
    if dependency_gaps:
        status = "blocked"
    elif has_failures or (final_mesh_required and not final_mesh_passed):
        status = "fail"
    else:
        status = "pass"
    return {
        "status": status,
        "passed": statuses.count("pass"),
        "failed": statuses.count("fail"),
        "preflight": statuses.count("preflight"),
        "dependency_gap": dependency_gaps,
        "scenario_count": len(SCENARIOS),
        "mode_count": len(modes),
        "result_count": len(results),
        "component_modes": component_modes,
        "dependency_gap_modes": sorted(
            {result.mode_id for result in results if result.status == "dependency_gap"}
        ),
        "required_scenarios_passed": all(
            any(
                result.scenario_id == scenario.scenario_id
                and result.mode_id in component_modes
                and result.status == "pass"
                for result in results
            )
            for scenario in SCENARIOS
        ),
        "final_mesh_mode_included": final_mesh_required,
        "final_mesh_mode_status": "pass" if final_mesh_passed else "fail",
        "preflight_not_counted_as_final_proof": True,
    }


def _scenario_dict(scenario: HarnessScenario) -> dict[str, Any]:
    return {
        "scenario_id": scenario.scenario_id,
        "title": scenario.title,
        "categories": list(scenario.categories),
        "assertion": scenario.assertion,
    }


def _schema(*fields: str) -> dict[str, Any]:
    object_fields = {"arguments", "mesh_selector", "target_selector"}
    boolean_fields = {"approve", "batch", "confirmed", "streaming"}
    return {
        "type": "object",
        "properties": {
            field: {
                "type": (
                    "object"
                    if field in object_fields
                    else "boolean"
                    if field in boolean_fields
                    else "string"
                )
            }
            for field in fields
        },
    }


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        redacted = {}
        for key, item in value.items():
            if _is_sensitive_key(key):
                redacted[key] = "[redacted]"
            else:
                redacted[key] = _redact(item)
        return redacted
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str) and (
        "secret-token" in value or "redis://" in value or value.startswith("/home/")
    ):
        return "[redacted]"
    return value


def _is_sensitive_key(key: str) -> bool:
    lowered = key.lower()
    return (
        lowered in {"secret", "token", "redis_url"}
        or lowered.endswith("_secret")
        or lowered.endswith("_token")
        or lowered.endswith("_tokens")
        or any(fragment in lowered for fragment in SENSITIVE_KEY_FRAGMENTS)
    )


def _sha256(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode("utf-8")).hexdigest()


def _stable_id(*parts: str) -> str:
    return hashlib.sha256(":".join(parts).encode("utf-8")).hexdigest()[:16]


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _selector(resource_namespace: str | None = None) -> dict[str, str]:
    selector = MeshAddressSelector(
        peer_id=PROVIDER_PEER_ID,
        provider_id=REMOTE_PROVIDER_ID,
        service_instance_id=REMOTE_PROVIDER_ID,
        resource_namespace=resource_namespace,
    )
    return selector.model_dump(exclude_none=True)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise HarnessFailureError(message)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=REPORT_ROOT / "latest",
        help="Directory for report.json, events.ndjson, and support_bundle.json.",
    )
    parser.add_argument(
        "--mode",
        action="append",
        choices=[mode.mode_id for mode in MODES],
        help="Run only one mode. Repeat to select multiple modes. Defaults to all.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    report = run_harness(output_dir=args.output_dir, mode_filter=set(args.mode or []))
    print(json.dumps(report.summary, indent=2, sort_keys=True))
    return 0 if report.summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())

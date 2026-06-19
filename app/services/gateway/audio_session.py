"""Audio session consent service for privacy-sensitive mesh audio streams."""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from app.shared.contracts.models.stt import (
    AudioSessionConsentRequest,
    AudioSessionConsentResponse,
    AudioSessionEvent,
    AudioSessionEventsRequest,
    AudioSessionEventsResponse,
    AudioSessionMethods,
    AudioSessionModule,
    AudioSessionPrepareRequest,
    AudioSessionPrepareResponse,
    AudioSessionSampleLimits,
    AudioSessionStartRequest,
    AudioSessionStatusRequest,
    AudioSessionStatusResponse,
    AudioSessionStopRequest,
)
from app.shared.contracts.registry import method_contract
from app.shared.services.base_service import BaseService


class AudioSessionService(BaseService):
    """Owns process-local audio session consent and event buffering."""

    def __init__(self) -> None:
        super().__init__(
            module=AudioSessionModule.NAME,
            summary="Audio session consent and event stream policy service",
            capabilities=["audio_session_consent", "audio_event_stream"],
        )
        self._sessions: dict[str, dict[str, Any]] = {}
        self._events: list[AudioSessionEvent] = []
        self._limits = AudioSessionSampleLimits()

    async def on_start(self) -> None:
        """Audio session state is initialized in memory."""

    async def on_stop(self) -> None:
        """Drop process-local audio session state on service stop."""
        self._sessions.clear()
        self._events.clear()

    async def reload(self, config_section: str | None = None) -> None:
        """No dynamic config yet."""

    @method_contract(
        method_id=AudioSessionMethods.PREPARE,
        summary="Prepare a privacy-scoped remote audio session",
        input_model=AudioSessionPrepareRequest,
        output_model=AudioSessionPrepareResponse,
        exposure="external",
        method_type="manage",
        required_perms=["AudioSession.manage"],
    )
    async def prepare_audio_session(
        self,
        data: AudioSessionPrepareRequest,
    ) -> AudioSessionPrepareResponse:
        """Prepare session policy before any streaming audio chunks are accepted."""
        if not data.mesh_selector.has_routing_target():
            raise ValueError("audio session requires an explicit peer/provider selector")
        self._validate_audio_sample_format(data.sample_rate, data.channels, data.format, 0)

        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=min(data.requested_ttl_s, 3600))
        session_id = str(uuid.uuid4())
        correlation_id = data.correlation_id or str(uuid.uuid4())
        target_peer_id = (
            data.target_peer_id
            or data.mesh_selector.peer_id
            or _peer_id_from_provider(data.mesh_selector.provider_id)
            or _peer_id_from_provider(data.mesh_selector.service_instance_id)
        )
        session = {
            "session_id": session_id,
            "status": "prepared",
            "operation": data.operation,
            "mesh_selector": data.mesh_selector,
            "caller_principal_id": data.caller_principal_id,
            "caller_peer_id": data.caller_peer_id,
            "caller_device_id": data.caller_device_id,
            "target_peer_id": target_peer_id,
            "target_device_id": data.target_device_id
            or data.mesh_selector.hardware_target
            or data.mesh_selector.resource_namespace,
            "privacy_class": data.privacy_class,
            "privacy_indicator_state": data.privacy_indicator_state,
            "sample_rate": data.sample_rate,
            "channels": data.channels,
            "format": data.format,
            "estimated_bandwidth_bps": data.estimated_bandwidth_bps,
            "expires_at": expires_at,
            "correlation_id": correlation_id,
            "consent_token": None,
            "consent_granted": False,
        }
        self._sessions[session_id] = session
        await self._record_event(
            session,
            "prepared",
            status="prepared",
            payload={"operation": data.operation},
        )
        return AudioSessionPrepareResponse(
            session_id=session_id,
            expires_at=expires_at.isoformat(),
            correlation_id=correlation_id,
        )

    @method_contract(
        method_id=AudioSessionMethods.REQUEST_CONSENT,
        summary="Request or record consent for a prepared audio session",
        input_model=AudioSessionConsentRequest,
        output_model=AudioSessionConsentResponse,
        exposure="external",
        method_type="manage",
        required_perms=["AudioSession.manage"],
    )
    async def request_audio_session_consent(
        self,
        data: AudioSessionConsentRequest,
    ) -> AudioSessionConsentResponse:
        """Record consent for a prepared session and issue a scoped token."""
        session = self._get_session(data.session_id)
        if not data.approved:
            session["status"] = "denied"
            session["consent_granted"] = False
            await self._record_event(
                session,
                "consent_denied",
                status="denied",
                payload={"reason": data.reason or "denied"},
            )
            return AudioSessionConsentResponse(
                session_id=data.session_id,
                status="denied",
                reason=data.reason or "denied",
            )

        now = datetime.now(UTC)
        expires_at: datetime = session["expires_at"]
        if data.expires_in_s is not None:
            expires_at = min(expires_at, now + timedelta(seconds=data.expires_in_s))
        session["expires_at"] = expires_at
        session["status"] = "consented"
        session["consent_granted"] = True
        session["consent_token"] = secrets.token_urlsafe(32)
        session["approver_principal_id"] = data.approver_principal_id
        session["approver_device_id"] = data.approver_device_id
        await self._record_event(session, "consent_granted", status="consented")
        return AudioSessionConsentResponse(
            session_id=data.session_id,
            status="consented",
            consent_token=session["consent_token"],
            expires_at=expires_at.isoformat(),
        )

    @method_contract(
        method_id=AudioSessionMethods.START,
        summary="Start or validate an approved audio session",
        input_model=AudioSessionStartRequest,
        output_model=AudioSessionStatusResponse,
        exposure="both",
        method_type="use",
        required_perms=["AudioSession.use"],
    )
    async def start_audio_session(
        self,
        data: AudioSessionStartRequest,
    ) -> AudioSessionStatusResponse:
        """Validate consent token and mark a session active."""
        session = self._get_session(data.session_id)
        self._assert_session_valid(session, data.consent_token)
        if session["status"] != "active":
            session["status"] = "active"
            await self._record_event(session, "started", status="active")
        return _status_response(session)

    @method_contract(
        method_id=AudioSessionMethods.STOP,
        summary="Stop or revoke an audio session",
        input_model=AudioSessionStopRequest,
        output_model=AudioSessionStatusResponse,
        exposure="external",
        method_type="manage",
        required_perms=["AudioSession.manage"],
    )
    async def stop_audio_session(
        self,
        data: AudioSessionStopRequest,
    ) -> AudioSessionStatusResponse:
        """Stop an active or prepared session."""
        session = self._get_session(data.session_id)
        session["status"] = "stopped"
        await self._record_event(
            session,
            "stopped",
            status="stopped",
            payload={"reason": data.reason},
        )
        return _status_response(session)

    @method_contract(
        method_id=AudioSessionMethods.STATUS,
        summary="Get audio session status",
        input_model=AudioSessionStatusRequest,
        output_model=AudioSessionStatusResponse,
        exposure="external",
        method_type="manage",
        required_perms=["AudioSession.manage"],
    )
    async def get_audio_session_status(
        self,
        data: AudioSessionStatusRequest,
    ) -> AudioSessionStatusResponse:
        """Return a redacted audio session status snapshot."""
        return _status_response(self._get_session(data.session_id))

    @method_contract(
        method_id=AudioSessionMethods.LIST_EVENTS,
        summary="Read buffered audio session events",
        input_model=AudioSessionEventsRequest,
        output_model=AudioSessionEventsResponse,
        exposure="external",
        method_type="use",
        required_perms=["AudioSession.use"],
    )
    async def get_audio_session_events(
        self,
        data: AudioSessionEventsRequest,
    ) -> AudioSessionEventsResponse:
        """Return buffered audio session events for UI/API consumers."""
        events = self._events
        if data.session_id:
            events = [event for event in events if event.session_id == data.session_id]
        sliced = events[data.since_index : data.since_index + data.limit]
        return AudioSessionEventsResponse(events=sliced, next_index=data.since_index + len(sliced))

    def _get_session(self, session_id: str) -> dict[str, Any]:
        session = self._sessions.get(session_id)
        if not session:
            raise ValueError(f"audio session '{session_id}' was not found")
        return session

    def _assert_session_valid(self, session: dict[str, Any], consent_token: str) -> None:
        if session["status"] in {"stopped", "denied", "expired"}:
            raise PermissionError(f"audio session is {session['status']}")
        if datetime.now(UTC) >= session["expires_at"]:
            session["status"] = "expired"
            raise PermissionError("audio session expired")
        if not session.get("consent_granted") or not session.get("consent_token"):
            raise PermissionError("audio session consent was not granted")
        if not secrets.compare_digest(str(session["consent_token"]), consent_token):
            raise PermissionError("audio session consent token is invalid")

    def _validate_audio_sample_format(
        self,
        sample_rate: int,
        channels: int,
        format_name: str,
        chunk_bytes: int,
    ) -> None:
        limits = self._limits
        if sample_rate < limits.min_sample_rate or sample_rate > limits.max_sample_rate:
            raise ValueError("audio sample_rate is outside session limits")
        if channels < 1 or channels > limits.max_channels:
            raise ValueError("audio channels are outside session limits")
        if format_name.lower() not in limits.allowed_formats:
            raise ValueError("audio format is outside session limits")
        if chunk_bytes > limits.max_chunk_bytes:
            raise ValueError("audio chunk exceeds session limits")

    async def _record_event(
        self,
        session: dict[str, Any],
        event_type: str,
        *,
        status: str | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        event = AudioSessionEvent(
            session_id=session["session_id"],
            event_type=event_type,
            status=status,
            source_peer_id=session.get("caller_peer_id"),
            target_peer_id=session.get("target_peer_id"),
            privacy_class=session.get("privacy_class") or "microphone",
            redacted=True,
            correlation_id=session.get("correlation_id"),
            payload=payload or {},
        )
        self._events.append(event)
        self._events = self._events[-1000:]
        await self.bus.publish(
            AudioSessionMethods.EVENTS,
            event,
            event=True,
            mesh=True,
            origin="internal",
        )


def _peer_id_from_provider(value: str | None) -> str | None:
    if not value:
        return None
    parts = value.split(":")
    if len(parts) == 3 and parts[0] in {"local", "remote"}:
        return parts[1]
    if len(parts) == 2:
        return parts[0]
    return value


def _status_response(session: dict[str, Any]) -> AudioSessionStatusResponse:
    expires_at = session.get("expires_at")
    return AudioSessionStatusResponse(
        session_id=session["session_id"],
        status=session["status"],
        operation=session["operation"],
        caller_principal_id=session.get("caller_principal_id"),
        caller_peer_id=session.get("caller_peer_id"),
        target_peer_id=session.get("target_peer_id"),
        target_device_id=session.get("target_device_id"),
        privacy_class=session.get("privacy_class") or "microphone",
        privacy_indicator_state=session.get("privacy_indicator_state") or "required",
        expires_at=expires_at.isoformat() if hasattr(expires_at, "isoformat") else expires_at,
        correlation_id=session.get("correlation_id"),
        consent_granted=bool(session.get("consent_granted")),
    )

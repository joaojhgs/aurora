from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import math
import re
import secrets
import time
import uuid
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import (
    dataclass,
    replace as dataclass_replace,
)
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING, Any

from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp

from app.helpers.aurora_logger import log_debug, log_error, log_info, log_warning
from app.services.gateway.acl.audit import audit_event
from app.services.gateway.acl.identity import ANONYMOUS, OPEN_PEER, Identity
from app.services.gateway.mesh.provider_export import (
    ConflictingAuthorityRevisionError,
    GrantEvidence,
    PeerProviderExportCache,
    PolicySnapshot,
    ProjectionResult,
    ProtocolEvidence,
    RecipientEvidence,
    ServiceExportPolicy,
    StaleAuthorityRevisionError,
    canonical_digest,
    project_provider_export,
)
from app.services.gateway.mesh.tooling_projection_transport import (
    TOOLING_PROJECTION_INVALIDATED_TOPIC,
    TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
    select_tooling_protocol,
)
from app.shared.contracts.models.auth import AuthMethods, build_mesh_reconnect_proof_message
from app.shared.contracts.models.gateway import (
    WebRTCDiagnosticError,
    WebRTCDiagnosticsResponse,
    WebRTCPeerDiagnostic,
    WebRTCSignalingDiagnostic,
)
from app.shared.models.db import Token

from ..utils.crypto import aead_open, aead_seal, derive_room_keys
from .datachannel_flow import DataChannelFlowController, DataChannelFlowLimits
from .event_subscriptions import MeshEventSubscriptionRegistry
from .pairing_sas import (
    PAIRING_COMMIT_TYPE,
    PAIRING_REVEAL_TYPE,
    PAIRING_TERMINAL_TYPE,
    PairingProtocolError,
    PairingSAS,
    PairingSASHandshake,
    derive_channel_binding,
    pairing_identity,
)
from .peer_protocol import (
    CAP_BACKPRESSURE_V1,
    CAP_FRAGMENTATION_V1,
    CAP_PROVIDER_LEASE_V1,
    DEFAULT_PEER_CAPABILITIES,
    FRAGMENT_FRAME_TYPE,
    MESH_PEER_STANDBY_TYPE,
    PROTOCOL_HELLO_TYPE,
    FragmentProtocolError,
    FragmentReassembler,
    NegotiatedPeerProtocol,
    PeerProtocolError,
    PeerProtocolLimits,
    ProtocolHello,
    build_protocol_hello,
    fragment_message,
    negotiate_protocol,
    parse_mesh_peer_standby_frame,
    parse_protocol_hello,
    parse_provider_lease_frame,
)
from .rpc import (
    WEBRTC_MAX_FRAME_TEXT_BYTES,
    RPCHandler,
    WebRTCFrameParseError,
    WebRTCParserLimits,
    parse_webrtc_json_frame,
)
from .signaling.mqtt_client import MQTTSignaling

if TYPE_CHECKING:
    from app.messaging.bus import MessageBus
    from app.services.gateway.config import MeshConfig, Settings
    from app.services.gateway.mesh.peer_bridge import PeerBridge
    from app.services.gateway.mesh.peer_registry import PeerRegistry
    from app.services.gateway.mesh.policy_store import MeshPolicyProvider
    from app.services.gateway.registry_aggregator import RegistryAggregator
    from app.shared.mesh.observability import MeshRolloutMetrics

    from .signaling.base import SignalingAdapter


def _diagnostic_float(value: float | None) -> float | None:
    if value is None or value == float("inf") or value != value:
        return None
    return float(value)


def _diagnostic_auth_state(identity: Identity) -> str:
    if identity == ANONYMOUS:
        return "anonymous"
    if identity == OPEN_PEER:
        return "open"
    if identity.is_admin:
        return "authenticated_admin"
    return "authenticated"


@dataclass(frozen=True, slots=True)
class _ActiveProjectionRecord:
    generation: int
    peer_generation: int
    projection: ProjectionResult


@dataclass(slots=True)
class _QueuedPeerSend:
    text: str
    future: asyncio.Future[bool]


@dataclass(frozen=True, slots=True)
class _ManifestAckExpectation:
    session_peer_id: str
    connection_epoch: str
    projection_digest: str
    active_protocol: str
    active_version: str
    active_tier: str
    protocol_revision: str
    registry_revision: str
    export_policy_revision: str
    auth_grant_revision: int
    advertised_services: tuple[str, ...]
    compatible_services: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class _LocalProviderUnavailableWork:
    session_peer_id: str
    connection_epoch: str
    projection_digest: str
    availability_revision: int
    reason_code: str
    local_provider_peer_id: str | None
    expectation: _ManifestAckExpectation


@dataclass(slots=True)
class _LocalProviderUnavailableQueue:
    items: deque[_LocalProviderUnavailableWork]
    task: asyncio.Task[None]


@dataclass(frozen=True, slots=True)
class _ReconnectChallengeRecord:
    pc: RTCPeerConnection
    challenge: str
    channel_binding: str
    claimant_peer_id: str
    verifier_peer_id: str
    claimant_signaling_peer_id: str
    verifier_signaling_peer_id: str
    room_name: str
    issued_at_ms: int
    expires_at_ms: int


@dataclass(frozen=True, slots=True)
class _PendingProtocolHello:
    pc: RTCPeerConnection
    hello: ProtocolHello


_DIAGNOSTIC_REDACTED = "[REDACTED]"
_DIAGNOSTIC_WEBRTC_REDACTED = "[REDACTED_WEBRTC_PAYLOAD]"
_DIAGNOSTIC_MAX_INPUT_CHARS = 4096
_DIAGNOSTIC_MAX_OUTPUT_CHARS = 240
_DIAGNOSTIC_SENSITIVE_KEY_RE = re.compile(
    r"(token|password|passwd|secret|credential|key|api[_-]?key|bearer|room[_-]?key|room[_-]?secret|"
    r"private[_-]?key|access[_-]?key|refresh[_-]?token|ice[_-]?(?:pwd|ufrag)|sdp|candidate|"
    r"fingerprint|audio|bytes|pcm)",
    re.IGNORECASE,
)
_DIAGNOSTIC_JSON_STRING_FIELD_RE = re.compile(
    r"(?P<prefix>[\"'])(?P<key>[^\"']{0,64})(?P=prefix)\s*:\s*"
    r"(?P<value_prefix>[\"'])(?:\\\\.|(?!(?P=value_prefix)).){0,2048}(?P=value_prefix)",
    re.IGNORECASE | re.VERBOSE,
)
_DIAGNOSTIC_SCALAR_FIELD_RE = re.compile(
    r"(?P<key>\b[\w.-]{0,64}(?:token|password|passwd|secret|credential|key|api[_-]?key|bearer|"
    r"room[_-]?key|room[_-]?secret|private[_-]?key|access[_-]?key|refresh[_-]?token|"
    r"ice[_-]?(?:pwd|ufrag)|sdp|candidate|fingerprint|audio|bytes|pcm)[\w.-]*\b)"
    r"\s*(?P<sep>[:=])\s*(?P<value>[^\s,;}\]]{1,2048})",
    re.IGNORECASE,
)
_DIAGNOSTIC_IPV4_RE = re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)")
_DIAGNOSTIC_IPV6_RE = re.compile(r"(?i)(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?![\w:])")
_DIAGNOSTIC_BASE64_RE = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/])")
_DIAGNOSTIC_SDP_LINE_RE = re.compile(r"^\s*(?:v|o|s|t|a|m|c|b|i|u|e|p|r|z|k)=", re.IGNORECASE)
_DIAGNOSTIC_CANDIDATE_RE = re.compile(r"(?i)(?:^|\b|a=)candidate(?::|\s)")
_DIAGNOSTIC_FINGERPRINT_RE = re.compile(r"(?i)(?:dtls\s+)?fingerprint\s*[:=]|a=fingerprint:")
_DIAGNOSTIC_AUDIO_RE = re.compile(
    r"(?i)\b(?:raw\s+audio|audio\s+bytes|audio\/|pcm(?:16|32)?|wav\s+bytes|data:audio|"
    r"microphone\s+frame|media\s+bytes|base64\s+audio)\b"
)
_DIAGNOSTIC_SECRET_WORD_RE = re.compile(
    r"(?i)\b(?:bearer|token|password|passwd|secret|credential|key|api[_-]?key|private[_-]?key)\b"
)


def _diagnostic_truncate(value: str) -> str:
    if len(value) <= _DIAGNOSTIC_MAX_OUTPUT_CHARS:
        return value
    return f"{value[: _DIAGNOSTIC_MAX_OUTPUT_CHARS - 3].rstrip()}..."


def _redact_diagnostic_json(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if _DIAGNOSTIC_SENSITIVE_KEY_RE.search(key_text):
                redacted[_DIAGNOSTIC_REDACTED] = _DIAGNOSTIC_REDACTED
            else:
                redacted[key_text] = _redact_diagnostic_json(item)
        return redacted
    if isinstance(value, list):
        return [_redact_diagnostic_json(item) for item in value[:25]]
    if isinstance(value, str):
        return _redact_diagnostic_text(value)
    return value


def _redact_diagnostic_text(message: str) -> str:
    text = message[:_DIAGNOSTIC_MAX_INPUT_CHARS]

    def redact_json_string_field(match: re.Match[str]) -> str:
        key = match.group("key")
        if not _DIAGNOSTIC_SENSITIVE_KEY_RE.search(key):
            return match.group(0)
        quote = match.group("prefix")
        return f"{quote}{_DIAGNOSTIC_REDACTED}{quote}:{quote}{_DIAGNOSTIC_REDACTED}{quote}"

    text = _DIAGNOSTIC_JSON_STRING_FIELD_RE.sub(redact_json_string_field, text)
    text = _DIAGNOSTIC_SCALAR_FIELD_RE.sub(
        lambda match: f"{_DIAGNOSTIC_REDACTED}{match.group('sep')}{_DIAGNOSTIC_REDACTED}", text
    )
    text = _DIAGNOSTIC_BASE64_RE.sub(_DIAGNOSTIC_REDACTED, text)

    redacted_lines: list[str] = []
    for raw_line in text.splitlines() or [text]:
        line = raw_line.strip()
        lowered = line.lower()
        has_sdp_blob = "v=0" in lowered or "application/sdp" in lowered
        has_webrtc_blob = (
            _DIAGNOSTIC_SDP_LINE_RE.search(line)
            or _DIAGNOSTIC_CANDIDATE_RE.search(line)
            or _DIAGNOSTIC_FINGERPRINT_RE.search(line)
            or _DIAGNOSTIC_AUDIO_RE.search(line)
            or "ice-pwd" in lowered
            or "ice-ufrag" in lowered
            or ("sdp" in lowered and ("offer" in lowered or "answer" in lowered or has_sdp_blob))
        )
        if has_webrtc_blob:
            redacted_lines.append(_DIAGNOSTIC_WEBRTC_REDACTED)
            continue
        line = _DIAGNOSTIC_IPV4_RE.sub(_DIAGNOSTIC_REDACTED, line)
        line = _DIAGNOSTIC_IPV6_RE.sub(_DIAGNOSTIC_REDACTED, line)
        line = _DIAGNOSTIC_SECRET_WORD_RE.sub(_DIAGNOSTIC_REDACTED, line)
        redacted_lines.append(line)

    compact = " ".join(part for part in redacted_lines if part)
    compact = re.sub(r"\s+", " ", compact).strip()
    return compact or "redacted diagnostic event"


def _redact_diagnostic_message(message: str) -> str:
    """Return a bounded operator diagnostic with WebRTC secrets normalized away."""
    candidate = message[:_DIAGNOSTIC_MAX_INPUT_CHARS].strip()
    if candidate and candidate[0] in "[{":
        with contextlib.suppress(json.JSONDecodeError, TypeError, ValueError):
            parsed = json.loads(candidate)
            return _diagnostic_truncate(
                json.dumps(_redact_diagnostic_json(parsed), separators=(",", ":"), sort_keys=True)
            )
    return _diagnostic_truncate(_redact_diagnostic_text(message))


class _PairingRetryRequiredError(RuntimeError):
    """The approval session ended normally and should restart on a fresh PC."""


class _PairingDeniedError(RuntimeError):
    """An administrator explicitly denied the bilateral pairing request."""


_MESH_AUTH_CHALLENGE_TYPE = "mesh_auth_challenge_v1"
_MESH_AUTH_PROOF_TYPE = "mesh_auth_proof_v1"
_MESH_AUTH_CHALLENGE_TTL_MS = 20_000
_PROVIDER_UNAVAILABLE_CLOSE_DRAIN_TIMEOUT_S = 0.25
_PROVIDER_EXPORT_DIAGNOSTIC_LIMIT = 50
_PROVIDER_EXPORT_DIAGNOSTIC_FIELDS = frozenset(
    {
        "status",
        "reason_code",
        "readiness",
        "routable",
        "registry_revision",
        "registry_digest",
        "policy_revision",
        "policy_digest",
        "authority_revision",
        "authority_digest",
        "projection_digest",
        "included_service_count",
        "included_method_count",
        "excluded_count",
    }
)
_MANIFEST_REANNOUNCE_RETRY_ATTEMPTS = 3
_MANIFEST_REANNOUNCE_RETRY_MAX_DELAY_S = 30.0
_MAX_PENDING_ICE_CANDIDATES_PER_PEER = 64


class PeerAuthorityApplyStatus(str, Enum):
    APPLIED = "applied"
    DUPLICATE = "duplicate"
    STALE = "stale"
    GAP = "gap"
    CONFLICT = "conflict"
    INVALID = "invalid"
    ABSENT = "absent"
    PENDING = "pending"


@dataclass(frozen=True, slots=True)
class PeerAuthorityApplyResult:
    status: PeerAuthorityApplyStatus
    peer_id: str = ""
    revision: int = 0
    previous_revision: int = 0
    reannounce: bool = False

    @property
    def applied(self) -> bool:
        return self.status in {
            PeerAuthorityApplyStatus.APPLIED,
            PeerAuthorityApplyStatus.DUPLICATE,
            PeerAuthorityApplyStatus.ABSENT,
        }


class RTCClient:
    def __init__(
        self,
        settings: Settings,
        bus: MessageBus,
        registry: RegistryAggregator,
        auth_service: Any,
        require_auth: bool = False,
        rollout_metrics: MeshRolloutMetrics | None = None,
        event_topic_authorizer: Any | None = None,
        outbound_ice_candidate_allowed: Callable[[str], bool] | None = None,
    ):
        self._settings = settings
        self._bus = bus
        self._registry = registry
        self._auth_service = auth_service
        self._require_auth: bool = require_auth
        self._rollout_metrics = rollout_metrics
        self._event_topic_authorizer = event_topic_authorizer
        self._outbound_ice_candidate_allowed = outbound_ice_candidate_allowed
        # WebRTC/MQTT signaling session id. This may change on reconnect and
        # must not be used for mesh policy, manifests, or persisted trust.
        self._peer_id = str(uuid.uuid4())
        self._mesh_peer_id: str | None = None
        self._mesh_node_name: str = ""
        self._keys = derive_room_keys(
            settings.webrtc.password, settings.webrtc.app_id, settings.webrtc.room
        )
        self._adapter: SignalingAdapter | None = None
        self._pcs: dict[str, RTCPeerConnection] = {}
        self._peer_acl: dict[str, Identity] = {}
        self._peer_tokens: dict[str, Token] = {}  # Original tokens for re-resolution
        self._peer_timeout_tasks: dict[str, asyncio.Task] = {}  # Auth timeout tasks
        # Reconnect credential checks can legitimately outlive the short
        # anonymous-peer watchdog while Auth waits on the database. Keep each
        # validation tied to its exact transport so the watchdog can extend its
        # bound without allowing a late result to authenticate a replacement PC.
        self._reconnect_proof_tasks: dict[str, tuple[RTCPeerConnection, asyncio.Task[None]]] = {}
        self._system_token: str | None = None
        self._auth_timeout: float = 10.0  # seconds
        self._peer_pairing_active: set[str] = set()  # Peers in active pairing flow
        self._pairing_timeout: float = 300.0  # Set from config
        self._pairing_retry_delay: float = 1.0
        self._offer_timeout: float = 30.0
        self._closing: bool = False
        # Peer connections closed through an explicit local disconnect must not
        # enter the automatic pairing reconnect path.  Track the connection
        # object rather than only its peer ID so a later connection for the same
        # peer is not accidentally suppressed.
        self._reconnect_suppressed_pcs: set[RTCPeerConnection] = set()
        # Outbound offers need their own timeout because the auth/pairing timer
        # starts only after the DataChannel opens. Keep each watchdog tied to the
        # exact PC so an old timeout cannot tear down a replacement connection.
        self._negotiation_watchdogs: dict[str, tuple[RTCPeerConnection, asyncio.Task[None]]] = {}
        self._negotiation_retry_pcs: set[RTCPeerConnection] = set()
        self._peer_reconnect_tasks: dict[str, asyncio.Task[None]] = {}
        self._offer_in_progress: set[str] = set()
        # MQTT signaling channels are distinct topics and therefore do not
        # guarantee that an ICE candidate arrives after its SDP answer. Bind
        # early candidates to the exact PC that observed them and drain only
        # after that PC has a remote description.
        self._pending_ice_candidates: dict[str, list[tuple[RTCPeerConnection, Any]]] = {}
        # Per-peer credentials from prior pairing exchanges.  The raw bearer is
        # retained locally only to derive an HMAC; reconnect never transmits it.
        # Values may be legacy strings or {token, token_id} records while old DB
        # rows migrate through one fresh bilateral pairing.
        self._saved_auth_tokens: dict[str, Any] = {}
        # Fresh verifier nonce per exact peer connection.  A proof is accepted
        # only for this challenge and the SDP-derived channel binding.
        self._peer_auth_challenges: dict[str, _ReconnectChallengeRecord] = {}
        self._used_peer_auth_challenges: dict[str, int] = {}
        # Callback invoked with (token_str) when pairing succeeds
        self._on_token_saved: Any = None
        # Pending outbound RPC calls (for pairing flow)
        self._pending_rpc: dict[str, asyncio.Future] = {}
        self._pending_rpc_peers: dict[str, str] = {}
        # Active pairing tasks (peer_id → task) for cancellation on disconnect
        self._pairing_tasks: dict[str, asyncio.Task] = {}
        # Pairing is symmetric: each endpoint owns an outbound credential
        # request and receives an inbound request over the same canonical
        # DataChannel. Keep those directions separate so one completion cannot
        # cancel the other side's still-pending approval.
        self._peer_pairing_directions: dict[str, set[str]] = {}
        self._pairing_handshake_timeout: float = 10.0
        self._pairing_handshakes: dict[str, tuple[RTCPeerConnection, PairingSASHandshake]] = {}
        self._pairing_result_futures: dict[
            str, tuple[RTCPeerConnection, asyncio.Future[PairingSAS]]
        ] = {}
        self._pairing_results: dict[str, PairingSAS] = {}
        self._pairing_transports: dict[str, dict[str, Any]] = {}
        self._pairing_commits_sent: set[str] = set()
        self._pairing_bootstrapped: set[str] = set()
        # Inbound RPC handlers are keyed by signaling peer id so their dispatch
        # bus can be rewired after GatewayService creates the MeshBus.
        self._rpc_handlers: dict[str, RPCHandler] = {}

        # Mesh P2P attributes (set externally by GatewayService when mesh is enabled)
        self._mesh_enabled: bool = False
        self._mesh_config: MeshConfig | None = None
        self._mesh_policy_provider: MeshPolicyProvider | None = None
        self._peer_registry: PeerRegistry | None = None
        self._peer_bridge: PeerBridge | None = None
        # Per-peer DataChannel send functions for outbound messaging
        self._peer_send_fns: dict[str, Any] = {}
        # Per-peer DataChannel objects (for reverse-pairing / bilateral auth)
        self._peer_data_channels: dict[str, Any] = {}
        # Active WebRTC session id -> stable mesh peer_id learned from auth/manifest.
        self._peer_stable_ids: dict[str, str] = {}
        # Stable mesh peer_id -> active WebRTC session id for transport sends.
        self._stable_peer_sessions: dict[str, str] = {}
        # Per-peer human-readable names (Fix 6)
        self._peer_names: dict[str, str] = {}
        # Signaling identity claims are untrusted until a reconnect proof or
        # fresh SAS-bound token validates.  They may select a proof credential
        # and populate the pairing transcript, but never route authenticated IO.
        self._peer_claimed_stable_ids: dict[str, str] = {}
        self._peer_claimed_names: dict[str, str] = {}
        self._diagnostic_errors: deque[WebRTCDiagnosticError] = deque(maxlen=50)
        self._provider_export_cache = PeerProviderExportCache()
        self._provider_export_authority: dict[str, RecipientEvidence] = {}
        self._provider_export_authority_pending: set[str] = set()
        self._provider_export_authority_absent: dict[str, int] = {}
        self._provider_export_generation = 0
        self._provider_export_peer_generations: dict[str, int] = {}
        self._provider_export_active: dict[str, _ActiveProjectionRecord] = {}
        self._manifest_ack_expectations: dict[str, _ManifestAckExpectation] = {}
        self._local_provider_ready: dict[str, _ManifestAckExpectation] = {}
        self._local_provider_lease_revisions: dict[str, int] = {}
        self._local_provider_lease_tasks: dict[str, tuple[str, str, int, asyncio.Task[None]]] = {}
        self._local_provider_unavailable_tasks: dict[str, _LocalProviderUnavailableQueue] = {}
        self._provider_export_tasks: set[asyncio.Task[None]] = set()
        self._rpc_send_tasks: set[asyncio.Task[bool]] = set()
        self._tooling_projection_refresh_tasks: dict[str, asyncio.Task[None]] = {}
        self._tooling_remote_authority_revisions: dict[str, tuple[int, int]] = {}
        self._tooling_remote_authority_grants: dict[str, tuple[str, ...]] = {}
        self._tooling_projection_sync_after_lease: set[str] = set()
        self._tooling_outbound_manifest_revisions: dict[str, int] = {}
        self._latest_tooling_projection_invalidation: Any | None = None
        self._latest_tooling_projection_invalidations_by_peer: OrderedDict[str, Any] = OrderedDict()
        self._tooling_invalidation_retry_tasks: dict[str, asyncio.Task[None]] = {}
        self._manifest_reannounce_retry_tasks: dict[str, asyncio.Task[None]] = {}
        self._provider_export_diagnostics: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._provider_export_registry_callback_registered = False
        self._authority_refresh_callback: Any = None
        self._peer_send_queues: dict[str, deque[_QueuedPeerSend]] = {}
        self._peer_send_workers: dict[str, asyncio.Task[None]] = {}
        self._local_protocol_hello = build_protocol_hello(
            role="hybrid",
            capabilities=DEFAULT_PEER_CAPABILITIES,
            limits=PeerProtocolLimits(),
        )
        self._peer_protocol_hellos: dict[str, Any] = {}
        self._peer_protocols: dict[str, NegotiatedPeerProtocol] = {}
        self._pending_peer_protocol_hellos: dict[str, _PendingProtocolHello] = {}
        self._manifest_sync_pending_protocol: set[str] = set()
        self._manifest_protocol_timeout_tasks: dict[str, asyncio.Task[None]] = {}
        self._fragment_reassembler = FragmentReassembler(limits=PeerProtocolLimits())
        self._fragment_reassemblers: dict[str, FragmentReassembler] = {}
        self._flow_controllers: dict[str, DataChannelFlowController] = {}
        self._peer_send_locks: dict[str, asyncio.Lock] = {}
        self._event_subscriptions = MeshEventSubscriptionRegistry()
        self._provider_lease_tasks: dict[str, tuple[str, str, int, asyncio.Task[None]]] = {}
        self._provider_lease_clock_ms: Callable[[], int] = lambda: int(time.time() * 1000)
        self._provider_lease_sleep: Callable[[float], Any] = asyncio.sleep
        self._auth_timeout_sleep: Callable[[float], Any] = asyncio.sleep

    _PUBLIC_BROKERS = {"broker.emqx.io", "test.mosquitto.org"}

    def _peer_label(self, peer: str) -> str:
        """Human-readable label for a peer: 'node-name (a1b2c3d4)' or 'a1b2c3d4…'."""
        name = self._peer_names.get(peer, "")
        short = peer[:8]
        return f"{name} ({short})" if name else f"{short}…"

    def set_mesh_identity(self, peer_id: str, node_name: str = "") -> None:
        """Set this node's stable mesh identity.

        ``_peer_id`` remains the ephemeral signaling/session id used by MQTT
        and WebRTC. ``_mesh_peer_id`` is the durable policy identity used in
        manifests, peer registry rows, saved credentials, and diagnostics.
        """
        if self._mesh_peer_id != peer_id:
            self._invalidate_provider_export_all()
        self._mesh_peer_id = peer_id
        self._mesh_node_name = node_name

    def _local_mesh_peer_id(self) -> str:
        return self._mesh_peer_id or self._peer_id

    def _local_mesh_node_name(self) -> str:
        return self._mesh_node_name or self._local_mesh_peer_id()

    def _presence_metadata(self) -> dict[str, str]:
        stable_peer_id = self._local_mesh_peer_id()
        metadata = {
            "stable_peer_id": stable_peer_id,
            "mesh_peer_id": stable_peer_id,
        }
        node_name = self._local_mesh_node_name()
        if node_name:
            metadata["node_name"] = node_name
            metadata["mesh_node_name"] = node_name
        return metadata

    async def refresh_presence(self) -> None:
        """Re-publish retained signaling presence with current stable mesh identity."""
        if not self._adapter:
            return
        s = self._settings
        await self._adapter.join_room(
            s.webrtc.app_id,
            s.webrtc.room,
            self._peer_id,
            metadata=self._presence_metadata(),
        )

    def _stable_peer_id_for_session(self, peer: str) -> str:
        return self._peer_stable_ids.get(peer, peer)

    def _claimed_stable_peer_id_for_session(self, peer: str) -> str:
        return self._peer_stable_ids.get(
            peer,
            self._peer_claimed_stable_ids.get(peer, peer),
        )

    def _remember_claimed_peer_identity(
        self,
        session_peer_id: str,
        stable_peer_id: str | None,
        node_name: str = "",
    ) -> str:
        stable = stable_peer_id or session_peer_id
        if stable != session_peer_id:
            self._peer_claimed_stable_ids[session_peer_id] = stable
        if node_name:
            self._peer_claimed_names[session_peer_id] = node_name
        return stable

    def _session_for_peer_id(self, peer_id: str) -> str:
        return self._stable_peer_sessions.get(peer_id, peer_id)

    @property
    def event_subscriptions(self) -> MeshEventSubscriptionRegistry:
        """Return the shared exact-topic WebRTC event subscription registry."""

        return self._event_subscriptions

    def peer_supports_capability(self, peer_id: str, capability: str) -> bool:
        """Return whether a stable/session peer negotiated an additive WebRTC capability."""

        session_peer_id = self._session_for_peer_id(peer_id)
        protocol = self._peer_protocols.get(session_peer_id)
        return bool(protocol and protocol.supports(capability))

    def peer_protocol_role(self, peer_id: str) -> str:
        """Return the negotiated peer role, defaulting legacy peers to hybrid."""

        session_peer_id = self._session_for_peer_id(peer_id)
        protocol = self._peer_protocols.get(session_peer_id)
        return protocol.role if protocol else "hybrid"

    def _cleanup_peer_protocol_state(
        self, session_peer_id: str, stable_peer_id: str | None = None
    ) -> None:
        """Drop G002 negotiated protocol state for one disconnected peer only."""

        stable = stable_peer_id or self._stable_peer_id_for_session(session_peer_id)
        self._cancel_manifest_protocol_timeout(stable)
        for key in {session_peer_id, stable}:
            self._peer_protocol_hellos.pop(key, None)
            self._peer_protocols.pop(key, None)
            self._manifest_sync_pending_protocol.discard(key)
            self._event_subscriptions.cleanup_peer(key)
            with contextlib.suppress(Exception):
                self._fragment_reassembler.cleanup_peer(key)
            reassembler = self._fragment_reassemblers.pop(key, None)
            if reassembler is not None:
                with contextlib.suppress(Exception):
                    reassembler.cleanup_peer(key)
        controller = self._flow_controllers.pop(session_peer_id, None)
        if controller is not None:
            controller.cleanup()
        self._tooling_projection_sync_after_lease.discard(stable)
        self._cancel_peer_send_lane(session_peer_id)
        self._peer_send_locks.pop(session_peer_id, None)
        self._pending_peer_protocol_hellos.pop(session_peer_id, None)

    def _buffer_pre_auth_protocol_hello(
        self,
        peer_id: str,
        pc: RTCPeerConnection,
        frame: dict[str, Any],
    ) -> bool:
        """Retain one validated hello for the exact connection awaiting authentication.

        Validation here is deliberately not negotiation: an anonymous peer cannot
        install capability state. The parsed frame is promoted only after the
        matching connection proves its identity.
        """

        try:
            hello = parse_protocol_hello(frame)
        except PeerProtocolError as exc:
            self._record_diagnostic_error("protocol_hello_rejected", str(exc), peer_id)
            return False
        self._pending_peer_protocol_hellos[peer_id] = _PendingProtocolHello(pc=pc, hello=hello)
        log_debug(
            f"Peer {peer_id[:8]}… sent protocol hello while authentication was pending; "
            "buffering for authenticated replay"
        )
        return True

    def _replay_pre_auth_protocol_hello(self, peer_id: str) -> bool:
        """Promote the exact active connection's buffered hello after authentication."""

        pending = self._pending_peer_protocol_hellos.pop(peer_id, None)
        if pending is None or self._pcs.get(peer_id) is not pending.pc:
            return False
        self._handle_protocol_hello(peer_id, pending.hello)
        return True

    def _send_protocol_hello(self, peer_id: str) -> bool:
        """Send the local additive protocol hello after authentication/open access."""

        session_peer_id = self._session_for_peer_id(peer_id)
        if session_peer_id not in self._peer_data_channels:
            return False
        try:
            return self.send_to_peer(session_peer_id, json.dumps(self._local_protocol_hello))
        except Exception as exc:
            self._record_diagnostic_error("protocol_hello_send_failed", str(exc), session_peer_id)
            return False

    def _handle_protocol_hello(
        self,
        peer_id: str,
        frame: dict[str, Any] | ProtocolHello,
    ) -> None:
        """Store an authenticated peer hello and negotiated common capabilities."""

        session_peer_id = self._session_for_peer_id(peer_id)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        try:
            remote_hello = (
                frame if isinstance(frame, ProtocolHello) else parse_protocol_hello(frame)
            )
            negotiated = negotiate_protocol(self._local_protocol_hello, remote_hello)
        except PeerProtocolError as exc:
            self._record_diagnostic_error("protocol_hello_rejected", str(exc), session_peer_id)
            return
        for key in {session_peer_id, stable_peer_id}:
            self._peer_protocol_hellos[key] = remote_hello
            self._peer_protocols[key] = negotiated
        self._cancel_manifest_protocol_timeout(stable_peer_id)
        if stable_peer_id in self._manifest_sync_pending_protocol:
            self._manifest_sync_pending_protocol.discard(stable_peer_id)
            if negotiated.supports(CAP_FRAGMENTATION_V1):

                async def _resume_manifest_sync() -> None:
                    current_session = self._session_for_peer_id(stable_peer_id)
                    if (
                        not self._mesh_enabled
                        or not self._peer_registry
                        or current_session != session_peer_id
                        or self._peer_acl.get(session_peer_id, ANONYMOUS) == ANONYMOUS
                        or not self._is_peer_session_active(session_peer_id)
                    ):
                        return
                    if await self._send_manifest(stable_peer_id, force_send=True):
                        self._request_manifest(
                            stable_peer_id,
                            reason="protocol negotiation",
                        )

                task = asyncio.create_task(
                    _resume_manifest_sync(),
                    name=f"manifest-after-protocol:{stable_peer_id[:8]}",
                )
                self._provider_export_tasks.add(task)
                task.add_done_callback(self._provider_export_tasks.discard)
            else:
                self._record_diagnostic_error(
                    "manifest_fragmentation_unsupported",
                    "Peer does not support fragmentation required by the manifest",
                    session_peer_id,
                )
        if negotiated.supports(CAP_PROVIDER_LEASE_V1) and self._peer_registry:
            asyncio.create_task(self._peer_registry.require_provider_lease(stable_peer_id))

    def _schedule_manifest_protocol_timeout(
        self,
        stable_peer_id: str,
        session_peer_id: str,
    ) -> None:
        existing = self._manifest_protocol_timeout_tasks.get(stable_peer_id)
        if existing is not None and not existing.done():
            return

        async def report_timeout() -> None:
            current = asyncio.current_task()
            try:
                await asyncio.sleep(self._auth_timeout)
                if (
                    stable_peer_id not in self._manifest_sync_pending_protocol
                    or self._session_for_peer_id(stable_peer_id) != session_peer_id
                    or not self._is_peer_session_active(session_peer_id)
                ):
                    return
                message = "Peer did not negotiate fragmentation required by the manifest"
                self._record_diagnostic_error(
                    "manifest_protocol_negotiation_timeout",
                    message,
                    session_peer_id,
                )
                log_warning(
                    "RTCClient: Manifest protocol negotiation timed out for peer "
                    f"{self._peer_label(stable_peer_id)}"
                )
                await self._audit(
                    "mesh.manifest_protocol_negotiation_timeout",
                    details={
                        "peer_id": stable_peer_id,
                        "secrets_redacted": True,
                    },
                )
            finally:
                if self._manifest_protocol_timeout_tasks.get(stable_peer_id) is current:
                    self._manifest_protocol_timeout_tasks.pop(stable_peer_id, None)

        task = asyncio.create_task(
            report_timeout(),
            name=f"manifest-protocol-timeout:{stable_peer_id[:8]}",
        )
        self._manifest_protocol_timeout_tasks[stable_peer_id] = task
        self._provider_export_tasks.add(task)
        task.add_done_callback(self._provider_export_tasks.discard)

    def _cancel_manifest_protocol_timeout(self, stable_peer_id: str) -> None:
        task = self._manifest_protocol_timeout_tasks.pop(stable_peer_id, None)
        if task is not None and not task.done():
            task.cancel()

    def _cancel_manifest_protocol_timeouts(self) -> None:
        tasks = tuple(self._manifest_protocol_timeout_tasks.values())
        self._manifest_protocol_timeout_tasks.clear()
        for task in tasks:
            if not task.done():
                task.cancel()

    def _handle_fragment_frame(self, peer_id: str, frame: dict[str, Any]) -> str | None:
        """Accept one authenticated fragment and return completed logical JSON if ready."""

        session_peer_id = self._session_for_peer_id(peer_id)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        if not self.peer_supports_capability(session_peer_id, CAP_FRAGMENTATION_V1):
            self._record_diagnostic_error(
                "fragment_unnegotiated",
                "Peer sent a fragment without negotiated fragmentation",
                session_peer_id,
            )
            with contextlib.suppress(Exception):
                self._fragment_reassembler.cleanup_peer(stable_peer_id)
            reassembler = self._fragment_reassemblers.pop(stable_peer_id, None)
            if reassembler is not None:
                with contextlib.suppress(Exception):
                    reassembler.cleanup_peer(stable_peer_id)
            return None
        negotiated = self._peer_protocols.get(session_peer_id)
        if negotiated is None:
            return None
        reassembler = self._fragment_reassemblers.get(stable_peer_id)
        if reassembler is None or reassembler.limits != negotiated.limits:
            reassembler = FragmentReassembler(limits=negotiated.limits)
            self._fragment_reassemblers[stable_peer_id] = reassembler
        try:
            return reassembler.receive(stable_peer_id, frame)
        except FragmentProtocolError as exc:
            self._record_diagnostic_error("fragment_rejected", str(exc), session_peer_id)
            return None

    def _cancel_provider_lease_task(
        self,
        stable_peer_id: str,
        *,
        session_peer_id: str | None = None,
    ) -> None:
        current = self._provider_lease_tasks.get(stable_peer_id)
        if current is None:
            return
        current_session, _, _, task = current
        if session_peer_id is not None and current_session != session_peer_id:
            return
        self._provider_lease_tasks.pop(stable_peer_id, None)
        if task is not asyncio.current_task() and not task.done():
            task.cancel()

    async def _expire_provider_lease_after(
        self,
        stable_peer_id: str,
        session_peer_id: str,
        connection_epoch: str,
        availability_revision: int,
        expires_at_ms: int,
    ) -> None:
        try:
            delay_s = max(0.0, (expires_at_ms - self._provider_lease_clock_ms()) / 1000.0)
            await self._provider_lease_sleep(delay_s)
            if self._stable_peer_sessions.get(stable_peer_id, stable_peer_id) != session_peer_id:
                return
            if not self._peer_registry:
                return
            await self._peer_registry.expire_provider_lease(
                stable_peer_id,
                connection_epoch=connection_epoch,
                availability_revision=availability_revision,
                now_ms=self._provider_lease_clock_ms(),
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._record_diagnostic_error(
                "provider_lease_expiry_failed",
                str(exc),
                session_peer_id,
            )
        finally:
            current = self._provider_lease_tasks.get(stable_peer_id)
            task = asyncio.current_task()
            if (
                current
                and current[0] == session_peer_id
                and current[1] == connection_epoch
                and current[2] == availability_revision
                and current[3] is task
            ):
                self._provider_lease_tasks.pop(stable_peer_id, None)

    def _schedule_provider_lease_expiry(
        self,
        stable_peer_id: str,
        session_peer_id: str,
        connection_epoch: str,
        availability_revision: int,
        expires_at_ms: int,
    ) -> None:
        self._cancel_provider_lease_task(stable_peer_id)
        task = asyncio.create_task(
            self._expire_provider_lease_after(
                stable_peer_id,
                session_peer_id,
                connection_epoch,
                availability_revision,
                expires_at_ms,
            ),
            name=f"provider-lease-expiry:{stable_peer_id[:8]}",
        )
        self._provider_lease_tasks[stable_peer_id] = (
            session_peer_id,
            connection_epoch,
            availability_revision,
            task,
        )

    def _reset_local_provider_readiness(
        self,
        stable_peer_id: str,
        *,
        session_peer_id: str | None = None,
    ) -> None:
        current = self._local_provider_lease_tasks.get(stable_peer_id)
        if current is not None:
            current_session, _, _, task = current
            if session_peer_id is None or current_session == session_peer_id:
                self._local_provider_lease_tasks.pop(stable_peer_id, None)
                if task is not asyncio.current_task() and not task.done():
                    task.cancel()
        ready = self._local_provider_ready.get(stable_peer_id)
        if ready is not None and (
            session_peer_id is None or ready.session_peer_id == session_peer_id
        ):
            self._local_provider_ready.pop(stable_peer_id, None)

    def _schedule_local_provider_unavailable(
        self,
        stable_peer_id: str,
        *,
        reason_code: str,
        session_peer_id: str | None = None,
    ) -> bool:
        ready = self._local_provider_ready.get(stable_peer_id)
        if ready is None:
            return False
        if session_peer_id is not None and ready.session_peer_id != session_peer_id:
            return False
        work = _LocalProviderUnavailableWork(
            session_peer_id=ready.session_peer_id,
            connection_epoch=ready.connection_epoch,
            projection_digest=ready.projection_digest,
            availability_revision=self._local_provider_lease_revisions.get(stable_peer_id, 0),
            reason_code=reason_code,
            local_provider_peer_id=self._mesh_peer_id,
            expectation=ready,
        )
        current = self._local_provider_unavailable_tasks.get(stable_peer_id)
        if current is not None:
            has_matching_work = any(
                self._same_unavailable_snapshot(pending, work) for pending in current.items
            )
            if not has_matching_work:
                current.items.append(work)
            if current.task.done() and current.items:
                self._start_local_provider_unavailable_drain(stable_peer_id, current.items)
            if has_matching_work:
                return True
            return True
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return False

        self._start_local_provider_unavailable_drain(stable_peer_id, deque([work]))
        return True

    def _start_local_provider_unavailable_drain(
        self,
        stable_peer_id: str,
        items: deque[_LocalProviderUnavailableWork],
    ) -> None:
        task = asyncio.create_task(
            self._drain_local_provider_unavailable(
                stable_peer_id,
            ),
            name=f"provider-unavailable:{stable_peer_id[:8]}",
        )
        self._local_provider_unavailable_tasks[stable_peer_id] = _LocalProviderUnavailableQueue(
            items,
            task,
        )
        task.add_done_callback(
            lambda completed, peer=stable_peer_id: self._local_provider_unavailable_done(
                peer,
                completed,
            )
        )

    @staticmethod
    def _same_unavailable_snapshot(
        left: _LocalProviderUnavailableWork,
        right: _LocalProviderUnavailableWork,
    ) -> bool:
        return (
            left.session_peer_id == right.session_peer_id
            and left.connection_epoch == right.connection_epoch
            and left.projection_digest == right.projection_digest
            and left.availability_revision == right.availability_revision
        )

    async def _drain_local_provider_unavailable(self, stable_peer_id: str) -> None:
        while True:
            current = self._local_provider_unavailable_tasks.get(stable_peer_id)
            if current is None or not current.items:
                return
            work = current.items[0]
            try:
                await self._send_local_provider_unavailable(
                    stable_peer_id,
                    reason_code=work.reason_code,
                    session_peer_id=work.session_peer_id,
                    expectation=work.expectation,
                    local_provider_peer_id=work.local_provider_peer_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._record_diagnostic_error(
                    "provider_unavailable_send_failed",
                    str(exc),
                    work.session_peer_id,
                )
            current = self._local_provider_unavailable_tasks.get(stable_peer_id)
            if current is not None and current.items and current.items[0] is work:
                current.items.popleft()

    def _local_provider_unavailable_done(
        self,
        stable_peer_id: str,
        task: asyncio.Task[None],
    ) -> None:
        current = self._local_provider_unavailable_tasks.get(stable_peer_id)
        if current is not None and current.task is task:
            self._local_provider_unavailable_tasks.pop(stable_peer_id, None)
        if task.cancelled():
            return
        with contextlib.suppress(Exception):
            task.result()

    async def _wait_for_local_provider_unavailable(self, stable_peer_id: str) -> None:
        while True:
            current = self._local_provider_unavailable_tasks.get(stable_peer_id)
            if current is None or current.task is asyncio.current_task():
                return
            await asyncio.gather(current.task, return_exceptions=True)

    async def _drain_local_provider_unavailable_for_close(
        self,
        tasks: list[asyncio.Task[Any]],
    ) -> None:
        if not tasks:
            return
        done, pending = await asyncio.wait(
            tasks,
            timeout=_PROVIDER_UNAVAILABLE_CLOSE_DRAIN_TIMEOUT_S,
        )
        if pending:
            self._record_diagnostic_error(
                "provider_unavailable_shutdown_timeout",
                f"Timed out draining {len(pending)} provider unavailable task(s) during shutdown",
            )
            for task in pending:
                task.cancel()
        await asyncio.gather(*done, *pending, return_exceptions=True)

    def _is_local_provider_ready_for_session(
        self,
        session_peer_id: str,
        service_id: str | None = None,
    ) -> bool:
        stable_peer_id = self._peer_stable_ids.get(session_peer_id)
        if not stable_peer_id:
            return False
        # Legacy authenticated peers did not negotiate provider leases. When the
        # RTC-owned readiness callback is installed for all handlers, preserve
        # their existing manifest/ACL gate instead of requiring an impossible ACK.
        if not self.peer_supports_capability(session_peer_id, CAP_PROVIDER_LEASE_V1):
            return self._stable_peer_sessions.get(
                stable_peer_id
            ) == session_peer_id and self._has_authenticated_stable_peer(stable_peer_id)
        ready = self._local_provider_ready.get(stable_peer_id)
        return bool(
            ready
            and ready.session_peer_id == session_peer_id
            and self._stable_peer_sessions.get(stable_peer_id) == session_peer_id
            and self._has_authenticated_stable_peer(stable_peer_id)
            and (service_id is None or service_id in ready.compatible_services)
        )

    def _local_provider_binding_state_for_session(
        self,
        session_peer_id: str,
    ) -> tuple[_ManifestAckExpectation, int] | None:
        stable_peer_id = self._peer_stable_ids.get(session_peer_id)
        if not stable_peer_id:
            return None
        ready = self._local_provider_ready.get(stable_peer_id)
        if (
            ready is None
            or ready.session_peer_id != session_peer_id
            or self._stable_peer_sessions.get(stable_peer_id) != session_peer_id
            or not self._has_authenticated_stable_peer(stable_peer_id)
        ):
            return None
        revision = self._local_provider_lease_revisions.get(stable_peer_id, 0)
        return ready, revision

    async def _send_local_provider_unavailable(
        self,
        stable_peer_id: str,
        *,
        reason_code: str,
        session_peer_id: str | None = None,
        expectation: _ManifestAckExpectation | None = None,
        local_provider_peer_id: str | None = None,
    ) -> bool:
        provider_peer_id = local_provider_peer_id or self._mesh_peer_id
        if not provider_peer_id:
            return False
        session = session_peer_id or self._stable_peer_sessions.get(stable_peer_id)
        if not session or not self._is_peer_session_active(session):
            return False
        current = expectation or self._local_provider_ready.get(stable_peer_id)
        connection_epoch = current.connection_epoch if current else uuid.uuid4().hex
        revision = self._local_provider_lease_revisions.get(stable_peer_id, 0) + 1
        self._local_provider_lease_revisions[stable_peer_id] = revision
        now_ms = self._provider_lease_clock_ms()
        frame = {
            "type": "provider_unavailable",
            "peer_id": provider_peer_id,
            "connection_epoch": connection_epoch,
            "availability_revision": revision,
            "issued_at_ms": now_ms,
            "expires_at_ms": now_ms,
            "available": False,
            "reason_code": reason_code,
        }
        return await self.send_to_peer_async(session, json.dumps(frame))

    async def _send_local_provider_lease_frame(
        self,
        stable_peer_id: str,
        expectation: _ManifestAckExpectation,
    ) -> bool:
        if (
            not self._mesh_peer_id
            or self._local_provider_ready.get(stable_peer_id) != expectation
            or self._stable_peer_sessions.get(stable_peer_id) != expectation.session_peer_id
        ):
            return False
        revision = self._local_provider_lease_revisions.get(stable_peer_id, 0) + 1
        self._local_provider_lease_revisions[stable_peer_id] = revision
        now_ms = self._provider_lease_clock_ms()
        frame = {
            "type": "provider_lease",
            "peer_id": self._mesh_peer_id,
            "connection_epoch": expectation.connection_epoch,
            "availability_revision": revision,
            "issued_at_ms": now_ms,
            "expires_at_ms": now_ms + 60_000,
            "available": True,
        }
        return await self.send_to_peer_async(expectation.session_peer_id, json.dumps(frame))

    async def _renew_local_provider_lease(
        self,
        stable_peer_id: str,
        expectation: _ManifestAckExpectation,
    ) -> None:
        try:
            while True:
                await self._provider_lease_sleep(20.0)
                await self._send_local_provider_lease_frame(stable_peer_id, expectation)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._record_diagnostic_error(
                "provider_lease_renewal_failed",
                str(exc),
                expectation.session_peer_id,
            )
        finally:
            current = self._local_provider_lease_tasks.get(stable_peer_id)
            task = asyncio.current_task()
            if (
                current
                and current[0] == expectation.session_peer_id
                and current[1] == expectation.connection_epoch
                and current[3] is task
            ):
                self._local_provider_lease_tasks.pop(stable_peer_id, None)

    async def _open_local_provider_readiness(
        self,
        stable_peer_id: str,
        expectation: _ManifestAckExpectation,
    ) -> bool:
        self._reset_local_provider_readiness(
            stable_peer_id,
            session_peer_id=expectation.session_peer_id,
        )
        self._local_provider_ready[stable_peer_id] = expectation
        self._local_provider_lease_revisions[stable_peer_id] = 0
        if not await self._send_local_provider_lease_frame(stable_peer_id, expectation):
            self._reset_local_provider_readiness(
                stable_peer_id,
                session_peer_id=expectation.session_peer_id,
            )
            return False
        revision = self._local_provider_lease_revisions[stable_peer_id]
        task = asyncio.create_task(
            self._renew_local_provider_lease(stable_peer_id, expectation),
            name=f"provider-lease-renew:{stable_peer_id[:8]}",
        )
        self._local_provider_lease_tasks[stable_peer_id] = (
            expectation.session_peer_id,
            expectation.connection_epoch,
            revision,
            task,
        )
        return True

    async def _handle_provider_lease_frame(
        self, session_peer_id: str, frame: dict[str, Any]
    ) -> None:
        if not self.peer_supports_capability(session_peer_id, CAP_PROVIDER_LEASE_V1):
            self._record_diagnostic_error(
                "provider_lease_unnegotiated",
                "Peer sent provider lease without negotiated capability",
                session_peer_id,
            )
            return
        try:
            lease_frame = parse_provider_lease_frame(frame)
        except PeerProtocolError as exc:
            self._record_diagnostic_error("provider_lease_malformed", str(exc), session_peer_id)
            return
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        if lease_frame.peer_id != stable_peer_id:
            self._record_diagnostic_error(
                "provider_lease_wrong_peer",
                "Provider lease peer_id did not match authenticated peer",
                session_peer_id,
            )
            return
        if self._stable_peer_sessions.get(stable_peer_id, stable_peer_id) != session_peer_id:
            self._record_diagnostic_error(
                "provider_lease_stale_session",
                "Provider lease arrived on a stale peer session",
                session_peer_id,
            )
            return
        if not self._peer_registry:
            return

        from app.services.gateway.mesh.models import ProviderLeaseState

        lease = ProviderLeaseState(
            peer_id=stable_peer_id,
            connection_epoch=lease_frame.connection_epoch,
            availability_revision=lease_frame.availability_revision,
            issued_at_ms=lease_frame.issued_at_ms,
            expires_at_ms=lease_frame.expires_at_ms,
            available=lease_frame.is_available,
            reason_code=lease_frame.reason_code or "",
            lease_required=True,
        )
        applied = await self._peer_registry.apply_provider_lease(
            lease,
            now_ms=self._provider_lease_clock_ms(),
        )
        if not applied:
            return
        if lease.available:
            self._schedule_provider_lease_expiry(
                stable_peer_id,
                session_peer_id,
                lease.connection_epoch,
                lease.availability_revision,
                lease.expires_at_ms,
            )
            if stable_peer_id in self._tooling_projection_sync_after_lease:
                self._tooling_projection_sync_after_lease.discard(stable_peer_id)
                await self._request_tooling_projection_sync(
                    stable_peer_id,
                    reason="provider_lease_available",
                )
        else:
            self._cancel_provider_lease_task(stable_peer_id, session_peer_id=session_peer_id)

    def _dispatch_authenticated_datachannel_message(
        self,
        *,
        peer: str,
        handler: RPCHandler,
        text: str,
        obj: dict[str, Any],
    ) -> None:
        """Dispatch an already-authenticated logical DataChannel JSON message."""

        msg_type = obj.get("type")
        if msg_type == "manifest":
            asyncio.create_task(self._on_peer_manifest(peer, obj))
        elif msg_type in {"provider_lease", "provider_unavailable"}:
            asyncio.create_task(self._handle_provider_lease_frame(peer, obj))
        elif msg_type == "manifest_request":
            stable_peer_id = self._stable_peer_id_for_session(peer)
            asyncio.create_task(self._send_manifest(stable_peer_id, force_send=True))
        elif msg_type == "manifest_ack":
            asyncio.create_task(self._on_manifest_ack(self._stable_peer_id_for_session(peer), obj))
        elif msg_type == "capacity_update":
            asyncio.create_task(
                self._on_capacity_update(self._stable_peer_id_for_session(peer), obj)
            )
        elif msg_type == MESH_PEER_STANDBY_TYPE:
            asyncio.create_task(
                self._on_mesh_peer_standby(self._stable_peer_id_for_session(peer), obj)
            )
        elif msg_type == "ping":
            self._send_pong(self._stable_peer_id_for_session(peer), obj)
        elif msg_type == "pong":
            if self._peer_bridge:
                self._peer_bridge.on_pong(self._stable_peer_id_for_session(peer), obj)
        elif msg_type in ("result", "error", "chunk", "eof"):
            if self._peer_bridge:
                self._peer_bridge.on_response(self._stable_peer_id_for_session(peer), obj)
            else:
                log_debug(f"RTCClient: Received {msg_type} but no PeerBridge configured")
        else:
            asyncio.create_task(handler.on_parsed_message(obj))

    async def _send_to_peer_now(self, peer_id: str, text: str) -> bool:
        """Send one already-ordered message with fragmentation and backpressure."""

        session_peer_id = self._session_for_peer_id(peer_id)
        channel = self._peer_data_channels.get(session_peer_id)
        if channel is None or getattr(channel, "readyState", None) != "open":
            self._record_diagnostic_error(
                "datachannel_send_unavailable", "DataChannel is unavailable", session_peer_id
            )
            return False
        encoded_len = len(text.encode("utf-8"))
        protocol = self._peer_protocols.get(session_peer_id)
        default_limits = PeerProtocolLimits()
        if encoded_len > default_limits.max_logical_bytes:
            self._record_diagnostic_error(
                "datachannel_payload_oversize",
                "Payload exceeds maximum logical size",
                session_peer_id,
            )
            return False
        if encoded_len > default_limits.fragment_payload_bytes and (
            protocol is None or not protocol.supports(CAP_FRAGMENTATION_V1)
        ):
            self._record_diagnostic_error(
                "datachannel_fragmentation_unavailable",
                "Payload requires negotiated DataChannel fragmentation",
                session_peer_id,
            )
            return False
        lock = self._peer_send_locks.setdefault(session_peer_id, asyncio.Lock())
        async with lock:
            try:
                if (
                    protocol
                    and protocol.supports(CAP_FRAGMENTATION_V1)
                    and encoded_len > protocol.limits.fragment_payload_bytes
                ):
                    frames = fragment_message(text, limits=protocol.limits)
                    payloads = [
                        self._encode_datachannel_message(json.dumps(frame)) for frame in frames
                    ]
                else:
                    payloads = [self._encode_datachannel_message(text)]
                if protocol and protocol.supports(CAP_BACKPRESSURE_V1):
                    controller = self._flow_controllers.get(session_peer_id)
                    if controller is None:
                        controller = DataChannelFlowController(
                            channel,
                            limits=DataChannelFlowLimits(
                                high_watermark_bytes=protocol.limits.max_peer_aggregate_bytes,
                                low_watermark_bytes=max(
                                    1, protocol.limits.fragment_payload_bytes * 4
                                ),
                                max_queue_messages=protocol.limits.max_fragments,
                                max_queue_bytes=protocol.limits.max_peer_aggregate_bytes,
                            ),
                        )
                        self._flow_controllers[session_peer_id] = controller
                    await controller.send_many(payloads)
                else:
                    for payload in payloads:
                        if getattr(channel, "readyState", None) != "open":
                            return False
                        channel.send(payload)
                return True
            except Exception as exc:
                self._record_diagnostic_error(
                    "datachannel_async_send_failed", str(exc), session_peer_id
                )
                return False

    def _enqueue_peer_send(self, peer_id: str, text: str) -> asyncio.Future[bool]:
        """Reserve a FIFO position before any asynchronous send work can race."""

        session_peer_id = self._session_for_peer_id(peer_id)
        future = asyncio.get_running_loop().create_future()
        if self._closing:
            future.set_result(False)
            return future

        queue = self._peer_send_queues.setdefault(session_peer_id, deque())
        queue.append(_QueuedPeerSend(text=text, future=future))
        worker = self._peer_send_workers.get(session_peer_id)
        if worker is None or worker.done():
            worker = asyncio.create_task(
                self._drain_peer_send_lane(session_peer_id),
                name=f"webrtc-peer-send:{session_peer_id[:8]}",
            )
            self._peer_send_workers[session_peer_id] = worker
            self._rpc_send_tasks.add(worker)
            worker.add_done_callback(
                lambda completed, peer=session_peer_id: self._peer_send_worker_done(peer, completed)
            )
        return future

    async def _drain_peer_send_lane(self, session_peer_id: str) -> None:
        """Drain one peer's outbound messages strictly in enqueue order."""

        queue = self._peer_send_queues.get(session_peer_id)
        if queue is None:
            return
        while queue:
            item = queue[0]
            try:
                sent = await self._send_to_peer_now(session_peer_id, item.text)
            except asyncio.CancelledError:
                if not item.future.done():
                    item.future.set_result(False)
                raise
            except Exception as exc:
                self._record_diagnostic_error(
                    "datachannel_async_send_failed", str(exc), session_peer_id
                )
                sent = False
            if not item.future.done():
                item.future.set_result(sent)
            if queue and queue[0] is item:
                queue.popleft()

    def _peer_send_worker_done(
        self,
        session_peer_id: str,
        worker: asyncio.Task[None],
    ) -> None:
        """Release one completed FIFO worker without disturbing a replacement."""

        self._rpc_send_tasks.discard(worker)
        if self._peer_send_workers.get(session_peer_id) is not worker:
            return
        self._peer_send_workers.pop(session_peer_id, None)
        queue = self._peer_send_queues.get(session_peer_id)
        if not queue:
            self._peer_send_queues.pop(session_peer_id, None)

    def _cancel_peer_send_lane(self, session_peer_id: str) -> None:
        """Fail queued sends and stop the exact disconnected peer's worker."""

        worker = self._peer_send_workers.pop(session_peer_id, None)
        if worker is not None and worker is not asyncio.current_task():
            worker.cancel()
        queue = self._peer_send_queues.pop(session_peer_id, deque())
        for item in queue:
            if not item.future.done():
                item.future.set_result(False)

    async def send_to_peer_async(self, peer_id: str, text: str) -> bool:
        """Send through the peer FIFO with fragmentation and backpressure."""

        return await self._enqueue_peer_send(peer_id, text)

    def _schedule_rpc_send(self, peer_id: str, text: str) -> None:
        """Queue an RPC frame through ordered fragmentation and backpressure."""

        future = self._enqueue_peer_send(peer_id, text)

        def _warn_on_failure(completed: asyncio.Future[bool]) -> None:
            if not completed.cancelled() and completed.result() is False:
                log_warning(f"RTCClient: Failed to send RPC frame to peer {peer_id}")

        future.add_done_callback(_warn_on_failure)

    def _remember_stable_peer_id(
        self, session_peer_id: str, stable_peer_id: str | None, node_name: str = ""
    ) -> str:
        """Record a stable mesh peer_id for an active signaling session."""
        stable = stable_peer_id or session_peer_id
        self._cancel_stale_stable_peer_session_tasks(stable, session_peer_id)
        previous_session = self._stable_peer_sessions.get(stable)
        if previous_session and previous_session != session_peer_id:
            self._cancel_provider_lease_task(stable, session_peer_id=previous_session)
            self._schedule_local_provider_unavailable(
                stable,
                reason_code="session_replaced",
                session_peer_id=previous_session,
            )
            self._reset_local_provider_readiness(stable, session_peer_id=previous_session)
        if stable != session_peer_id:
            self._peer_stable_ids[session_peer_id] = stable
            self._stable_peer_sessions[stable] = session_peer_id
        self._peer_claimed_stable_ids.pop(session_peer_id, None)
        self._peer_claimed_names.pop(session_peer_id, None)
        if node_name:
            self._peer_names[stable] = node_name
            self._peer_names[session_peer_id] = node_name
        return stable

    def _stable_peer_candidate_sessions(self, stable_peer_id: str) -> set[str]:
        """Return session IDs that are known or claimed to belong to one stable peer."""

        sessions = {
            session_peer_id
            for session_peer_id, known_stable_peer_id in self._peer_stable_ids.items()
            if known_stable_peer_id == stable_peer_id
        }
        sessions.update(
            session_peer_id
            for session_peer_id, claimed_stable_peer_id in self._peer_claimed_stable_ids.items()
            if claimed_stable_peer_id == stable_peer_id
        )
        previous_session = self._stable_peer_sessions.get(stable_peer_id)
        if previous_session:
            sessions.add(previous_session)
        return sessions

    def _cancel_stale_stable_peer_session_tasks(
        self,
        stable_peer_id: str,
        active_session_peer_id: str,
    ) -> None:
        """Stop stale pending work once a newer session owns a stable peer."""

        try:
            current_task = asyncio.current_task()
        except RuntimeError:
            current_task = None
        for stale_session_peer_id in self._stable_peer_candidate_sessions(stable_peer_id):
            if stale_session_peer_id == active_session_peer_id:
                continue

            pc = self._pcs.get(stale_session_peer_id)
            if pc is not None:
                self._reconnect_suppressed_pcs.add(pc)
                self._negotiation_retry_pcs.discard(pc)

            self._offer_in_progress.discard(stale_session_peer_id)

            watchdog_entry = self._negotiation_watchdogs.get(stale_session_peer_id)
            if watchdog_entry is not None and (pc is None or watchdog_entry[0] is pc):
                self._negotiation_watchdogs.pop(stale_session_peer_id, None)
                watchdog_task = watchdog_entry[1]
                if watchdog_task is not current_task and not watchdog_task.done():
                    watchdog_task.cancel()

            reconnect_proof_entry = self._reconnect_proof_tasks.get(stale_session_peer_id)
            if reconnect_proof_entry is not None and (pc is None or reconnect_proof_entry[0] is pc):
                self._reconnect_proof_tasks.pop(stale_session_peer_id, None)
                reconnect_proof_task = reconnect_proof_entry[1]
                if reconnect_proof_task is not current_task and not reconnect_proof_task.done():
                    reconnect_proof_task.cancel()

            for tasks in (
                self._peer_timeout_tasks,
                self._peer_reconnect_tasks,
                self._pairing_tasks,
            ):
                task = tasks.pop(stale_session_peer_id, None)
                if task is not None and task is not current_task and not task.done():
                    task.cancel()

    @staticmethod
    def _saved_credential_parts(value: Any) -> tuple[str, str] | None:
        """Normalize persisted and legacy credential shapes."""
        if isinstance(value, str):
            return (value, "") if value else None
        if isinstance(value, dict):
            token = str(value.get("token") or "")
            token_id = str(value.get("token_id") or "")
        else:
            token = str(getattr(value, "token", "") or "")
            token_id = str(getattr(value, "token_id", "") or "")
        return (token, token_id) if token else None

    def _saved_auth_credential_for_peer(self, peer: str) -> tuple[str, str] | None:
        """Return a saved credential only when it can be scoped to this peer.

        Per-peer credentials are keyed by stable mesh peer ID. A session-keyed
        token is accepted for migration from older runtime state. The legacy
        ``_default`` credential is only accepted when it is the sole saved
        credential for the room; once peer-scoped credentials exist, using a
        default token for an unknown peer is ambiguous and must fail safe.
        """
        stable_peer_id = self._claimed_stable_peer_id_for_session(peer)
        candidate_keys = [stable_peer_id]
        if peer != stable_peer_id:
            candidate_keys.append(peer)

        for key in candidate_keys:
            credential = self._saved_credential_parts(self._saved_auth_tokens.get(key))
            if credential:
                log_debug(
                    f"Saved WebRTC credential lookup hit for peer {peer[:8]}… "
                    f"using credential key {key[:8]}…"
                )
                return credential

        peer_scoped_keys = [key for key in self._saved_auth_tokens if key != "_default"]
        default_credential = self._saved_credential_parts(self._saved_auth_tokens.get("_default"))
        if default_credential and not peer_scoped_keys:
            log_info(
                f"Using legacy default saved WebRTC credential for peer {peer[:8]}…; "
                "no peer-scoped credentials are loaded"
            )
            return default_credential

        if default_credential and peer_scoped_keys:
            log_warning(
                f"Saved WebRTC credential lookup miss for peer {peer[:8]}… "
                f"(stable={stable_peer_id[:8]}…); refusing legacy default because "
                "peer-scoped credentials are loaded"
            )
        elif peer_scoped_keys:
            log_info(
                f"Saved WebRTC credential lookup miss for peer {peer[:8]}… "
                f"(stable={stable_peer_id[:8]}…); pairing is required"
            )
        else:
            log_debug(f"No saved WebRTC credential available for peer {peer[:8]}…")
        return None

    def _mark_pairing_direction(self, peer: str, direction: str) -> None:
        directions = self._peer_pairing_directions.setdefault(peer, set())
        directions.add(direction)
        self._peer_pairing_active.add(peer)

    def _clear_pairing_direction(self, peer: str, direction: str) -> None:
        directions = self._peer_pairing_directions.get(peer)
        if directions is None:
            return
        directions.discard(direction)
        if directions:
            return
        self._peer_pairing_directions.pop(peer, None)
        self._peer_pairing_active.discard(peer)
        self._maybe_finish_peer_auth_timeout(peer)

    def _maybe_finish_peer_auth_timeout(self, peer: str) -> None:
        """Cancel the auth watchdog only after bilateral work is complete.

        Receiving a valid credential authenticates the remote caller, but the
        opposite pairing direction may still be waiting for local approval on
        that caller.  Keeping the watchdog alive until *both* directions have
        completed prevents a half-paired connection from polling forever.
        """
        if peer in self._peer_pairing_active:
            return
        if self._peer_acl.get(peer, ANONYMOUS) == ANONYMOUS:
            return
        timeout_task = self._peer_timeout_tasks.pop(peer, None)
        current_task = asyncio.current_task()
        if timeout_task and timeout_task is not current_task:
            timeout_task.cancel()

    def _pairing_direction_active(self, peer: str, direction: str) -> bool:
        return direction in self._peer_pairing_directions.get(peer, set())

    def _pairing_context_for_peer(self, peer: str) -> dict[str, str] | None:
        result = self._pairing_results.get(peer)
        if result is None:
            return None
        return {
            "pairing_session_id": result.pairing_session_id,
            "verification_code": result.verification_code,
            "device_name": result.remote_node_name or result.remote_stable_peer_id,
            "remote_peer_id": result.remote_stable_peer_id,
            "remote_node_name": result.remote_node_name,
            "room_name": str(self._settings.webrtc.room),
        }

    def _resolve_peer_rpc_calls(self, peer: str) -> None:
        """Resolve only outbound RPC calls owned by one disconnected peer."""
        for call_id, call_peer in list(self._pending_rpc_peers.items()):
            if call_peer != peer:
                continue
            self._pending_rpc_peers.pop(call_id, None)
            future = self._pending_rpc.pop(call_id, None)
            if future is not None and not future.done():
                future.set_result(None)

    def _cancel_peer_rpc_work(self, *peer_ids: str) -> None:
        """Cancel inbound RPC handler tasks for session or stable peer IDs."""

        for peer_id in peer_ids:
            handler = self._rpc_handlers.get(peer_id)
            if handler is not None:
                handler.cancel_active_work()

    def _clear_pairing_state(
        self,
        peer: str,
        pc: RTCPeerConnection | None = None,
    ) -> None:
        """Drop commit/reveal state only for the exact peer connection."""
        self._cancel_reconnect_proof_task(peer, pc)

        handshake_entry = self._pairing_handshakes.get(peer)
        if handshake_entry is not None and (pc is None or handshake_entry[0] is pc):
            self._pairing_handshakes.pop(peer, None)

        future_entry = self._pairing_result_futures.get(peer)
        if future_entry is not None and (pc is None or future_entry[0] is pc):
            self._pairing_result_futures.pop(peer, None)
            future = future_entry[1]
            if not future.done():
                future.cancel()

        transport = self._pairing_transports.get(peer)
        if transport is not None and (pc is None or transport.get("pc") is pc):
            self._pairing_transports.pop(peer, None)
            self._pairing_results.pop(peer, None)
            self._pairing_commits_sent.discard(peer)
            self._pairing_bootstrapped.discard(peer)

        challenge_entry = self._peer_auth_challenges.get(peer)
        if challenge_entry is not None and (pc is None or challenge_entry.pc is pc):
            self._peer_auth_challenges.pop(peer, None)

        pending_hello = self._pending_peer_protocol_hellos.get(peer)
        if pending_hello is not None and (pc is None or pending_hello.pc is pc):
            self._pending_peer_protocol_hellos.pop(peer, None)

        self._peer_pairing_directions.pop(peer, None)
        self._peer_pairing_active.discard(peer)

    def _cancel_reconnect_proof_task(
        self,
        peer: str,
        pc: RTCPeerConnection | None = None,
    ) -> None:
        """Cancel proof validation only when it belongs to the selected PC."""
        entry = self._reconnect_proof_tasks.get(peer)
        if entry is None or (pc is not None and entry[0] is not pc):
            return
        self._reconnect_proof_tasks.pop(peer, None)
        task = entry[1]
        if task is not asyncio.current_task() and not task.done():
            task.cancel()

    def _track_reconnect_proof_task(
        self,
        peer: str,
        pc: RTCPeerConnection,
        task: asyncio.Task[None],
    ) -> None:
        """Own one reconnect proof validation for an exact peer connection."""
        previous = self._reconnect_proof_tasks.get(peer)
        if previous is not None and previous[1] is not task:
            self._cancel_reconnect_proof_task(peer, previous[0])
        self._reconnect_proof_tasks[peer] = (pc, task)

        def discard_if_current(completed: asyncio.Task[None]) -> None:
            entry = self._reconnect_proof_tasks.get(peer)
            if entry is not None and entry[0] is pc and entry[1] is completed:
                self._reconnect_proof_tasks.pop(peer, None)

        task.add_done_callback(discard_if_current)

    async def _discard_failed_negotiation_pc(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> bool:
        """Remove an exact failed negotiation before accepting a fresh offer.

        Early SDP failures do not reliably emit aiortc state-change callbacks.
        Removing the exact connection first also prevents a delayed callback
        from deleting a replacement connection created by the next retry.
        Claimed stable identity metadata is intentionally retained so the
        deterministic offer owner can retry the same discovered session.
        """
        if self._pcs.get(peer) is not pc:
            return False

        self._cancel_negotiation_watchdog(peer, pc)
        timeout_task = self._peer_timeout_tasks.pop(peer, None)
        if timeout_task is not None and timeout_task is not asyncio.current_task():
            timeout_task.cancel()
        pairing_task = self._pairing_tasks.pop(peer, None)
        if pairing_task is not None and pairing_task is not asyncio.current_task():
            pairing_task.cancel()
        self._resolve_peer_rpc_calls(peer)
        self._cancel_peer_rpc_work(peer)
        self._clear_pairing_state(peer, pc)
        self._pcs.pop(peer, None)
        self._peer_acl.pop(peer, None)
        self._peer_tokens.pop(peer, None)
        self._rpc_handlers.pop(peer, None)
        self._peer_send_fns.pop(peer, None)
        self._peer_data_channels.pop(peer, None)
        self._discard_pending_ice_candidates(peer, pc)
        self._cleanup_peer_protocol_state(peer)
        self._peer_auth_challenges.pop(peer, None)
        self._negotiation_retry_pcs.discard(pc)
        self._reconnect_suppressed_pcs.discard(pc)
        with contextlib.suppress(Exception):
            await self._close_peer_connection(pc)
        return True

    async def _close_peer_connection(self, pc: RTCPeerConnection) -> None:
        """Cancel aioice retry work before closing a peer connection.

        aioice 0.10.x can leave STUN transaction timers scheduled while its
        datagram transport is being closed. A late retry then calls ``sendto``
        on the cleared transport. The dependency does not expose transaction
        cancellation publicly, so this compatibility guard feature-detects its
        current internals and becomes a no-op when they are unavailable.
        """

        ice_transports = getattr(pc, "_RTCPeerConnection__iceTransports", ())
        if isinstance(ice_transports, (list, set, tuple)):
            check_tasks: list[asyncio.Task[Any]] = []
            current_task = asyncio.current_task()
            for ice_transport in list(ice_transports):
                connection = getattr(ice_transport, "_connection", None)
                if connection is None:
                    continue
                for pair in list(getattr(connection, "_check_list", ()) or ()):
                    task = getattr(pair, "task", None)
                    if (
                        isinstance(task, asyncio.Task)
                        and task is not current_task
                        and not task.done()
                    ):
                        task.cancel()
                        check_tasks.append(task)
                for protocol in list(getattr(connection, "_protocols", ()) or ()):
                    transactions = getattr(protocol, "transactions", None)
                    if not isinstance(transactions, dict):
                        continue
                    for transaction in list(transactions.values()):
                        timeout_handle = getattr(
                            transaction,
                            "_Transaction__timeout_handle",
                            None,
                        )
                        if timeout_handle is not None:
                            timeout_handle.cancel()
                        future = getattr(transaction, "_Transaction__future", None)
                        if isinstance(future, asyncio.Future) and not future.done():
                            future.cancel()
            if check_tasks:
                await asyncio.gather(*check_tasks, return_exceptions=True)
        await pc.close()

    def _suppress_durably_denied_pairing(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> None:
        """Make an exact local administrative denial terminal for reconnect."""
        if self._pcs.get(peer) is not pc:
            return
        self._clear_pairing_direction(peer, "inbound")
        self._reconnect_suppressed_pcs.add(pc)

    def set_saved_auth_token(self, token: str | None) -> None:
        """Set a single saved auth token (legacy/fallback).

        Stores the token under a special ``_default`` key for legacy state
        migration. Mesh reconnects never transmit it: credentials without a
        peer-scoped public token ID are repaired through fresh SAS pairing.

        Args:
            token: The plain-text token string, or None to clear.
        """
        if token:
            self._saved_auth_tokens["_default"] = token
        else:
            self._saved_auth_tokens.pop("_default", None)

    def set_saved_peer_tokens(self, creds: dict[str, Any]) -> None:
        """Set per-peer saved credentials from prior pairing exchanges.

        Called on startup with credentials loaded from the DB.

        Args:
            creds: Mapping of stable mesh ``peer_id`` → credential record.
        """
        self._saved_auth_tokens.update(creds)

    def set_on_token_saved(self, callback: Any) -> None:
        """Set a callback invoked when pairing completes and a token is received.

        The callback receives ``(token_str, remote_device_id, remote_user_id)``
        and should persist the token to the database so it can be reloaded on
        next startup.

        Args:
            callback: Async callable accepting token string and optional
                remote_device_id/remote_user_id.
        """
        self._on_token_saved = callback

    def set_authority_refresh_callback(self, callback: Any) -> None:
        """Set Gateway callback for durable per-peer authority reconciliation."""

        self._authority_refresh_callback = callback

    async def start(self, *, join_room: bool = True) -> None:
        # Gap 3A: Validate room password when auth is required
        if self._require_auth and not self._settings.webrtc.password:
            log_error(
                "WebRTC room password is empty but auth is enabled. "
                "Set 'services.gateway.webrtc.password' in config.json to a strong random value. "
                "WebRTC client will NOT start."
            )
            return

        if not self._require_auth and not self._settings.webrtc.password:
            log_warning(
                "WebRTC room password is empty. Signaling encryption is weak. "
                "Consider setting 'services.gateway.webrtc.password' in config.json."
            )

        self._system_token = await self._auth_service.get_system_token()
        s = self._settings
        if s.webrtc.strategy == "mqtt":
            self._adapter = MQTTSignaling(
                brokers=s.signaling_mqtt.brokers,
                topic_root=s.signaling_mqtt.topic_root,
                username=s.signaling_mqtt.username,
                password=s.signaling_mqtt.password,
                encrypt_presence=s.webrtc.encrypt_signaling,
                sig_key=self._keys.k_sig,
                app_id=str(s.webrtc.app_id),
                room=str(s.webrtc.room),
                peer_id=self._peer_id,
            )
        else:
            raise RuntimeError(f"Unsupported signaling strategy: {s.webrtc.strategy}")

        await self._adapter.connect()

        # Gap 3D: Warn about public brokers when auth is enabled
        broker_hosts = {
            b.split("://")[-1].split(":")[0].split("/")[0] for b in s.signaling_mqtt.brokers
        }
        if self._require_auth and broker_hosts & self._PUBLIC_BROKERS:
            log_warning(
                "Auth is enabled but using PUBLIC MQTT brokers. "
                "Anyone can see signaling traffic. "
                "Use a private MQTT broker for production deployments."
            )

        self._adapter.on_message("presence", self._on_presence)
        self._adapter.on_message("offer", self._on_offer)
        self._adapter.on_message("answer", self._on_answer)
        self._adapter.on_message("candidate", self._on_candidate)
        self._adapter.on_message("broadcast", self._on_broadcast)

        if join_room:
            await self.refresh_presence()
            log_info(f"RTCClient joined room {s.webrtc.room} as {self._peer_id}")
        else:
            log_debug("RTCClient signaling connected; room join deferred until mesh bootstrap")

    async def close(self) -> None:
        if not self._closing:
            for stable_peer_id, expectation in list(self._local_provider_ready.items()):
                self._schedule_local_provider_unavailable(
                    stable_peer_id,
                    reason_code="peer_closing",
                    session_peer_id=expectation.session_peer_id,
                )
            tombstone_tasks = [
                queue.task for queue in self._local_provider_unavailable_tasks.values()
            ]
            await self._drain_local_provider_unavailable_for_close(tombstone_tasks)
        # Set this before broadcasting or closing any peer connection. aiortc
        # dispatches state-change callbacks asynchronously, so those callbacks
        # may run while (or just after) the close loop below is in progress.
        self._closing = True

        # Broadcast graceful departure before tearing down connections
        if self._mesh_enabled and self._adapter:
            with contextlib.suppress(Exception):
                await self.send_broadcast("peer_leaving", {"peer_id": self._peer_id})

        # Cancel all pending auth timeout tasks
        for task in self._peer_timeout_tasks.values():
            task.cancel()
        self._peer_timeout_tasks.clear()
        reconnect_proof_tasks = [entry[1] for entry in self._reconnect_proof_tasks.values()]
        for task in reconnect_proof_tasks:
            task.cancel()
        if reconnect_proof_tasks:
            await asyncio.gather(*reconnect_proof_tasks, return_exceptions=True)
        self._reconnect_proof_tasks.clear()
        for task in self._pairing_tasks.values():
            task.cancel()
        self._pairing_tasks.clear()
        for future in self._pending_rpc.values():
            if not future.done():
                future.set_result(None)
        self._pending_rpc.clear()
        self._pending_rpc_peers.clear()
        for handler in list(self._rpc_handlers.values()):
            handler.cancel_active_work()
        for peer in list(self._negotiation_watchdogs):
            self._cancel_negotiation_watchdog(peer)
        reconnect_tasks = list(self._peer_reconnect_tasks.values())
        for task in reconnect_tasks:
            task.cancel()
        if reconnect_tasks:
            await asyncio.gather(*reconnect_tasks, return_exceptions=True)
        self._peer_reconnect_tasks.clear()
        self._offer_in_progress.clear()
        self._negotiation_retry_pcs.clear()
        self._pending_ice_candidates.clear()
        shadow_tasks = list(self._provider_export_tasks)
        for task in shadow_tasks:
            task.cancel()
        if shadow_tasks:
            await asyncio.gather(*shadow_tasks, return_exceptions=True)
        self._provider_export_tasks.clear()
        self._manifest_sync_pending_protocol.clear()
        self._manifest_protocol_timeout_tasks.clear()
        unavailable_tasks = [
            queue.task for queue in self._local_provider_unavailable_tasks.values()
        ]
        await self._drain_local_provider_unavailable_for_close(unavailable_tasks)
        self._local_provider_unavailable_tasks.clear()
        rpc_send_tasks = list(self._rpc_send_tasks)
        for peer_id in list(self._peer_send_queues):
            self._cancel_peer_send_lane(peer_id)
        for task in rpc_send_tasks:
            task.cancel()
        if rpc_send_tasks:
            await asyncio.gather(*rpc_send_tasks, return_exceptions=True)
        self._rpc_send_tasks.clear()
        self._peer_send_queues.clear()
        self._peer_send_workers.clear()
        refresh_tasks = list(self._tooling_projection_refresh_tasks.values())
        for task in refresh_tasks:
            task.cancel()
        if refresh_tasks:
            await asyncio.gather(*refresh_tasks, return_exceptions=True)
        self._tooling_projection_refresh_tasks.clear()
        invalidation_retry_tasks = list(self._tooling_invalidation_retry_tasks.values())
        for task in invalidation_retry_tasks:
            task.cancel()
        if invalidation_retry_tasks:
            await asyncio.gather(*invalidation_retry_tasks, return_exceptions=True)
        self._tooling_invalidation_retry_tasks.clear()
        retry_tasks = self._cancel_manifest_reannounce_retries()
        if retry_tasks:
            await asyncio.gather(*retry_tasks, return_exceptions=True)
        provider_lease_tasks = [entry[3] for entry in self._provider_lease_tasks.values()]
        for task in provider_lease_tasks:
            task.cancel()
        if provider_lease_tasks:
            await asyncio.gather(*provider_lease_tasks, return_exceptions=True)
        self._provider_lease_tasks.clear()
        local_provider_lease_tasks = [
            entry[3] for entry in self._local_provider_lease_tasks.values()
        ]
        for task in local_provider_lease_tasks:
            task.cancel()
        if local_provider_lease_tasks:
            await asyncio.gather(*local_provider_lease_tasks, return_exceptions=True)
        self._local_provider_lease_tasks.clear()
        self._local_provider_ready.clear()
        self._local_provider_lease_revisions.clear()
        if self._peer_registry:
            lease_peers = set(self._stable_peer_sessions) | {
                self._stable_peer_id_for_session(peer_id) for peer_id in self._pcs
            }
            for stable_peer_id in lease_peers:
                with contextlib.suppress(Exception):
                    await self._peer_registry.clear_provider_lease_session(stable_peer_id)

        for pc in list(self._pcs.values()):
            await self._close_peer_connection(pc)
        self._pcs.clear()
        self._peer_acl.clear()
        self._peer_tokens.clear()
        self._saved_auth_tokens.clear()
        self._peer_send_fns.clear()
        self._peer_data_channels.clear()
        for controller in list(self._flow_controllers.values()):
            controller.cleanup()
        self._flow_controllers.clear()
        self._peer_send_locks.clear()
        self._peer_protocol_hellos.clear()
        self._peer_protocols.clear()
        self._pending_peer_protocol_hellos.clear()
        self._fragment_reassembler = FragmentReassembler(limits=PeerProtocolLimits())
        self._fragment_reassemblers.clear()
        self._event_subscriptions = MeshEventSubscriptionRegistry()
        for peer in list(self._pairing_transports):
            self._clear_pairing_state(peer)
        self._peer_stable_ids.clear()
        self._stable_peer_sessions.clear()
        self._peer_names.clear()
        self._peer_claimed_stable_ids.clear()
        self._peer_claimed_names.clear()
        self._peer_auth_challenges.clear()
        self._used_peer_auth_challenges.clear()
        self._reconnect_suppressed_pcs.clear()
        self._invalidate_provider_export_all(notify_provider_unavailable=False)
        self._provider_export_cache.trusted_reset_all_authority()
        self._provider_export_authority.clear()
        self._provider_export_authority_pending.clear()
        self._provider_export_authority_absent.clear()
        self._provider_export_peer_generations.clear()
        self._provider_export_diagnostics.clear()
        self._tooling_remote_authority_revisions.clear()
        self._tooling_remote_authority_grants.clear()
        self._tooling_projection_sync_after_lease.clear()
        self._tooling_outbound_manifest_revisions.clear()
        self._latest_tooling_projection_invalidation = None
        self._latest_tooling_projection_invalidations_by_peer.clear()
        self._manifest_ack_expectations.clear()
        self._authority_refresh_callback = None
        self._mesh_enabled = False
        self._mesh_config = None
        self._mesh_policy_provider = None
        self._peer_registry = None
        self._peer_bridge = None

        if self._adapter:
            await self._adapter.leave()
            await self._adapter.close()
            self._adapter = None
        log_info("RTCClient closed")

    # ── Peer lifecycle helpers ───────────────────────────────────────────

    def get_connected_peers(self) -> list[dict[str, Any]]:
        """Return info about connected peers with their Identity summary."""
        peers = []
        for peer_id, pc in self._pcs.items():
            identity = self._peer_acl.get(peer_id, ANONYMOUS)
            stable_peer_id = self._claimed_stable_peer_id_for_session(peer_id)
            channel = self._peer_data_channels.get(peer_id)
            peers.append(
                {
                    "peer_id": peer_id,
                    "stable_peer_id": stable_peer_id,
                    "connection_state": pc.connectionState,
                    "data_channel_state": getattr(channel, "readyState", "unknown"),
                    "session_active": self._is_peer_session_active(peer_id),
                    "principal_name": identity.principal_name,
                    "is_admin": identity.is_admin,
                    "effective_perms": list(identity.effective_perms),
                    "source": identity.source,
                }
            )
        return peers

    def _is_peer_session_active(self, session_peer_id: str) -> bool:
        """Return whether a peer has an operational RPC DataChannel."""
        pc = self._pcs.get(session_peer_id)
        channel = self._peer_data_channels.get(session_peer_id)
        connection_state = getattr(pc, "connectionState", None)
        return bool(
            pc is not None
            and channel is not None
            # WebRTC's disconnected state is transient. Some native stacks
            # retain a fully usable SCTP/DataChannel while ICE recovers, so the
            # authenticated epoch remains active until the channel closes or
            # the peer connection reaches a hard terminal state.
            and connection_state not in ("failed", "closed")
            and getattr(channel, "readyState", None) == "open"
        )

    def get_diagnostics(self) -> WebRTCDiagnosticsResponse:
        """Return a redacted WebRTC/ICE/DataChannel diagnostic snapshot."""
        signaling = WebRTCSignalingDiagnostic(
            strategy=self._settings.webrtc.strategy,
            connected=self._adapter is not None,
            encrypted_presence=bool(self._settings.webrtc.encrypt_signaling),
            app_id_configured=bool(self._settings.webrtc.app_id),
            room_configured=bool(self._settings.webrtc.room),
            broker_count=len(self._settings.signaling_mqtt.brokers),
            public_broker_warning=bool(
                {
                    broker.split("://")[-1].split(":")[0].split("/")[0]
                    for broker in self._settings.signaling_mqtt.brokers
                }
                & self._PUBLIC_BROKERS
            ),
        )

        peers: list[WebRTCPeerDiagnostic] = []
        connected_count = 0
        authenticated_count = 0
        for signaling_peer_id, pc in sorted(self._pcs.items()):
            authenticated_stable_peer_id = self._stable_peer_id_for_session(signaling_peer_id)
            stable_peer_id = self._claimed_stable_peer_id_for_session(signaling_peer_id)
            identity = self._peer_acl.get(signaling_peer_id) or self._peer_acl.get(
                authenticated_stable_peer_id,
                ANONYMOUS,
            )
            session_active = self._is_peer_session_active(signaling_peer_id)
            if session_active:
                connected_count += 1
            if session_active and identity != ANONYMOUS:
                authenticated_count += 1
            channel = self._peer_data_channels.get(signaling_peer_id)
            rtt_ms = None
            if self._peer_registry:
                peer_state = self._peer_registry.get_peer(stable_peer_id)
                if peer_state:
                    rtt_ms = _diagnostic_float(peer_state.latency_ms)
            pairing_result = (
                self._pairing_results.get(signaling_peer_id)
                if signaling_peer_id in self._peer_pairing_active
                else None
            )

            peers.append(
                WebRTCPeerDiagnostic(
                    signaling_peer_id=signaling_peer_id,
                    stable_peer_id=stable_peer_id,
                    node_name=self._peer_names.get(
                        authenticated_stable_peer_id,
                        self._peer_claimed_names.get(signaling_peer_id, ""),
                    ),
                    connection_state=str(getattr(pc, "connectionState", "unknown")),
                    ice_connection_state=str(getattr(pc, "iceConnectionState", "unknown")),
                    ice_gathering_state=str(getattr(pc, "iceGatheringState", "unknown")),
                    signaling_state=str(getattr(pc, "signalingState", "unknown")),
                    data_channel_state=str(getattr(channel, "readyState", "unknown")),
                    data_channel_label=str(getattr(channel, "label", "")),
                    has_send_channel=signaling_peer_id in self._peer_send_fns,
                    rtt_ms=rtt_ms,
                    auth_state=_diagnostic_auth_state(identity),
                    identity_source="" if identity == ANONYMOUS else identity.source,
                    is_admin=False if identity == ANONYMOUS else identity.is_admin,
                    effective_permission_count=0
                    if identity == ANONYMOUS
                    else len(identity.effective_perms),
                    pairing_active=signaling_peer_id in self._peer_pairing_active,
                    auth_timeout_pending=signaling_peer_id in self._peer_timeout_tasks,
                    pending_pairing_task=signaling_peer_id in self._pairing_tasks,
                    pairing_session_id=(
                        pairing_result.pairing_session_id if pairing_result else ""
                    ),
                    verification_code=(pairing_result.verification_code if pairing_result else ""),
                )
            )

        return WebRTCDiagnosticsResponse(
            enabled=bool(self._settings.webrtc.enabled),
            started=self._adapter is not None,
            mesh_enabled=self._mesh_enabled,
            local_signaling_peer_id=self._peer_id,
            local_mesh_peer_id=self._mesh_peer_id,
            local_node_name=self._local_mesh_node_name(),
            require_auth=self._require_auth,
            auth_timeout_seconds=self._auth_timeout,
            pairing_timeout_seconds=self._pairing_timeout,
            app_layer_e2ee_enabled=bool(self._settings.webrtc.enable_app_layer_e2ee),
            signaling=signaling,
            peers=peers,
            connected_peer_count=connected_count,
            authenticated_peer_count=authenticated_count,
            pairing_peer_count=len(self._peer_pairing_active),
            pending_rpc_count=len(self._pending_rpc),
            recent_errors=list(self._diagnostic_errors),
            secrets_redacted=True,
        )

    async def disconnect_peer(self, peer_id: str, by_principal_id: str | None = None) -> bool:
        """Force disconnect a peer."""
        session_peer_id = self._session_for_peer_id(peer_id)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        pc = self._pcs.get(session_peer_id)
        if not pc:
            return False
        identity = self._peer_acl.get(session_peer_id, ANONYMOUS)
        # Cancel auth timeout task if pending
        timeout_task = self._peer_timeout_tasks.pop(session_peer_id, None)
        if timeout_task:
            timeout_task.cancel()
        self._cancel_negotiation_watchdog(session_peer_id, pc)
        reconnect_task = self._peer_reconnect_tasks.pop(session_peer_id, None)
        if reconnect_task:
            reconnect_task.cancel()
        self._offer_in_progress.discard(session_peer_id)
        self._negotiation_retry_pcs.discard(pc)
        self._reconnect_suppressed_pcs.add(pc)
        await self._send_local_provider_unavailable(
            stable_peer_id,
            reason_code="peer_disconnected",
            session_peer_id=session_peer_id,
        )
        pairing_task = self._pairing_tasks.pop(session_peer_id, None)
        if pairing_task:
            pairing_task.cancel()
        self._resolve_peer_rpc_calls(session_peer_id)
        self._cancel_peer_rpc_work(session_peer_id, stable_peer_id, peer_id)
        self._clear_pairing_state(session_peer_id, pc)
        self._discard_pending_ice_candidates(session_peer_id, pc)
        await self._close_peer_connection(pc)
        self._pcs.pop(session_peer_id, None)
        self._peer_acl.pop(session_peer_id, None)
        self._peer_acl.pop(peer_id, None)
        self._peer_tokens.pop(session_peer_id, None)
        self._peer_tokens.pop(peer_id, None)
        self._rpc_handlers.pop(session_peer_id, None)
        self._rpc_handlers.pop(peer_id, None)
        self._peer_send_fns.pop(session_peer_id, None)
        self._peer_data_channels.pop(session_peer_id, None)
        self._cleanup_peer_protocol_state(session_peer_id, stable_peer_id)
        self._cancel_provider_lease_task(stable_peer_id, session_peer_id=session_peer_id)
        self._peer_names.pop(session_peer_id, None)
        self._peer_names.pop(stable_peer_id, None)
        self._peer_claimed_stable_ids.pop(session_peer_id, None)
        self._peer_claimed_names.pop(session_peer_id, None)
        self._peer_stable_ids.pop(session_peer_id, None)
        self._stable_peer_sessions.pop(stable_peer_id, None)
        self._invalidate_provider_export_peer(stable_peer_id, notify_provider_unavailable=False)
        if self._peer_registry:
            await self._peer_registry.remove_peer(stable_peer_id)
        log_info(f"Force disconnected peer {peer_id}")

        # Audit: peer force-disconnected
        await self._audit(
            "peer.force_disconnected",
            identity.principal_id,
            {
                "peer_id": peer_id,
                "signaling_peer_id": session_peer_id,
                "by_principal_id": by_principal_id,
            },
        )
        return True

    async def update_peer_permissions(
        self,
        peer_id: str,
        permissions: list[str] | None = None,
    ) -> bool:
        """Re-resolve Identity for a peer from DB (after permission change).

        Reloads both the principal and the stored token scopes so a previous
        revocation cannot permanently cap later restoration, and a previous
        wildcard grant cannot survive a downgrade in the cached token object.
        """
        session_peer_id = self._session_for_peer_id(peer_id)
        identity = self._peer_acl.get(peer_id) or self._peer_acl.get(session_peer_id)
        if not identity or identity == ANONYMOUS:
            return False
        # Re-load user and rebuild identity
        user = await self._auth_service.get_principal(identity.principal_id)
        if not user:
            return False
        from app.services.gateway.acl.identity import build_identity

        token = self._peer_tokens.get(peer_id) or self._peer_tokens.get(session_peer_id)
        token_scopes = list(token.scopes or []) if token else list(identity.effective_perms)
        if permissions is not None:
            # Auth publishes this event only after atomically syncing the mesh
            # row, User permissions/admin bit, and Token scopes. It is the one
            # authoritative source that also works for legacy bus proxy tokens
            # whose public validation response has no durable token selector.
            token_scopes = [str(permission) for permission in permissions]
            if token:
                token.scopes = token_scopes
        scope_loader = getattr(self._auth_service, "get_token_scopes", None)
        if permissions is None and token:
            if str(token.id) == "bus-validated":
                # Older Auth validation responses do not expose the durable
                # token row id.  Mesh principals are dedicated per peer and
                # Auth atomically keeps their User permissions/admin bit and
                # token scopes aligned, so the freshly loaded principal is the
                # authoritative fallback instead of clearing restored grants.
                token_scopes = (
                    ["*"]
                    if user.is_admin
                    else [str(permission) for permission in (user.permissions or [])]
                )
                token.scopes = token_scopes
            elif callable(scope_loader):
                fresh_scopes = await scope_loader(
                    str(token.id),
                    principal_id=identity.principal_id,
                )
                if fresh_scopes is None:
                    # A missing/revoked token must fail closed rather than retain
                    # an old wildcard from the long-lived RTC object.
                    token_scopes = []
                    token.scopes = []
                elif isinstance(fresh_scopes, (list, tuple, set)):
                    token_scopes = [str(scope) for scope in fresh_scopes]
                    token.scopes = token_scopes

        new_identity = build_identity(
            user_id=user.id,
            username=user.username,
            user_permissions=user.permissions or [],
            user_is_admin=user.is_admin,
            token_scopes=token_scopes,
            device_id=identity.device_id,
            source="webrtc_peer",
        )
        self._peer_acl[peer_id] = new_identity
        self._peer_acl[session_peer_id] = new_identity
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        if stable_peer_id != session_peer_id:
            self._mark_provider_export_authority_unknown(stable_peer_id)
        else:
            self._invalidate_provider_export_peer(stable_peer_id)
        return True

    # ── Internal ─────────────────────────────────────────────────────────

    async def _audit(
        self,
        event: str,
        principal_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        """Fire-and-forget audit event."""
        import contextlib

        with contextlib.suppress(Exception):
            await audit_event(
                self._auth_service.db_manager,
                event,
                principal_id=principal_id,
                details=details,
            )

    def _record_diagnostic_error(
        self,
        code: str,
        message: str,
        peer_id: str | None = None,
    ) -> None:
        """Store a short redacted diagnostic error for operator snapshots."""
        self._diagnostic_errors.appendleft(
            WebRTCDiagnosticError(
                timestamp=datetime.now(timezone.utc).isoformat(),
                code=code,
                message=_redact_diagnostic_message(message),
                peer_id=peer_id,
            )
        )

    def _signaling_envelope_matches_room(
        self,
        msg: dict[str, Any],
        *,
        channel: str,
        require_recipient: bool = True,
    ) -> bool:
        """Return whether one encrypted signaling frame is addressed here."""
        peer = msg.get("from")
        if (
            msg.get("app_id") != self._settings.webrtc.app_id
            or msg.get("room") != self._settings.webrtc.room
        ):
            log_debug(f"RTCClient: Ignoring {channel} for another signaling room")
            self._record_diagnostic_error(
                "signaling_room_mismatch",
                f"Ignored {channel} frame for another signaling room",
                str(peer) if peer else None,
            )
            return False
        if require_recipient and msg.get("to") != self._peer_id:
            log_debug(f"RTCClient: Ignoring {channel} addressed to another peer")
            self._record_diagnostic_error(
                "signaling_recipient_mismatch",
                f"Ignored {channel} frame addressed to another peer",
                str(peer) if peer else None,
            )
            return False
        return True

    async def _reauthenticate_legacy_peer(self, peer: str, token_str: str) -> bool:
        """Replace one legacy peer identity or fail it closed to anonymous."""
        try:
            token = await self._auth_service.authenticate_token(token_str)
            identity = (
                await self._auth_service.build_identity_from_token(
                    token,
                    source="webrtc_peer",
                )
                if token
                else None
            )
        except Exception:
            token = None
            identity = None

        if token is None or identity is None:
            self._peer_acl[peer] = ANONYMOUS
            self._peer_tokens.pop(peer, None)
            log_warning(f"Peer {peer} failed re-authentication")
            self._record_diagnostic_error(
                "reauth_failed",
                "Peer failed token re-authentication",
                peer,
            )
            return False

        self._peer_acl[peer] = identity
        self._peer_tokens[peer] = token
        log_info(f"Peer {peer} re-authenticated as {identity.principal_name}")
        return True

    # ── Mesh P2P helpers ─────────────────────────────────────────────────

    def _encode_datachannel_message(self, text: str) -> str | bytes:
        """Encode an outbound DataChannel JSON message for the configured mode."""
        if not self._settings.webrtc.enable_app_layer_e2ee:
            return text

        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError("DataChannel E2EE messages must be JSON objects") from exc
        if not isinstance(obj, dict):
            raise ValueError("DataChannel E2EE messages must be JSON objects")
        return aead_seal(self._keys.k_data, obj)

    def _decode_datachannel_message(
        self,
        peer: str,
        message: str | bytes | bytearray | memoryview,
    ) -> str | None:
        """Decode an inbound DataChannel message according to the configured mode."""
        e2ee_enabled = self._settings.webrtc.enable_app_layer_e2ee

        if isinstance(message, str):
            if len(message.encode("utf-8")) > WEBRTC_MAX_FRAME_TEXT_BYTES:
                self._record_diagnostic_error(
                    "datachannel_plaintext_oversize",
                    "DataChannel plaintext exceeded maximum frame size",
                    peer,
                )
                return None
            if e2ee_enabled:
                log_warning(
                    "RTCClient: Dropping plaintext DataChannel message from "
                    f"{peer}; app-layer E2EE is enabled"
                )
                return None
            return message

        if isinstance(message, (bytes, bytearray, memoryview)):
            payload = bytes(message)
            if len(payload) > WEBRTC_MAX_FRAME_TEXT_BYTES:
                self._record_diagnostic_error(
                    "datachannel_ciphertext_oversize",
                    "DataChannel binary payload exceeded maximum frame size",
                    peer,
                )
                return None
            try:
                if e2ee_enabled:
                    obj = aead_open(self._keys.k_data, payload)
                    text = json.dumps(obj)
                else:
                    text = payload.decode()
                if len(text.encode("utf-8")) > WEBRTC_MAX_FRAME_TEXT_BYTES:
                    self._record_diagnostic_error(
                        "datachannel_decoded_oversize",
                        "Decoded DataChannel payload exceeded maximum frame size",
                        peer,
                    )
                    return None
                return text
            except Exception as e:
                mode = "decrypt" if e2ee_enabled else "decode"
                self._record_diagnostic_error(
                    f"datachannel_{mode}_failed",
                    f"Failed to {mode} DataChannel message",
                    peer,
                )
                log_error(f"Failed to {mode} DataChannel message from {peer}: {e}")
                return None

        log_warning(
            "RTCClient: Dropping unsupported DataChannel message from "
            f"{peer}: {type(message).__name__}"
        )
        return None

    def _parse_datachannel_frame(
        self,
        peer: str,
        text: str,
        *,
        diagnostic_code: str = "datachannel_frame_invalid",
        parser_limits: WebRTCParserLimits | None = None,
    ) -> dict[str, Any] | None:
        """Parse one decoded DataChannel JSON frame before any work is scheduled."""

        try:
            return parse_webrtc_json_frame(text, limits=parser_limits or WebRTCParserLimits())
        except WebRTCFrameParseError as exc:
            self._record_diagnostic_error(diagnostic_code, str(exc), peer)
            log_warning(f"RTCClient: Rejected invalid DataChannel frame from {peer}: {exc}")
            return None

    def _logical_parser_limits(self, peer: str) -> WebRTCParserLimits:
        """Return parser limits for an already reassembled logical frame."""

        session_peer_id = self._session_for_peer_id(peer)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        negotiated = self._peer_protocols.get(session_peer_id) or self._peer_protocols.get(
            stable_peer_id
        )
        max_string_length = (
            negotiated.limits.max_logical_bytes
            if negotiated is not None
            else PeerProtocolLimits().max_logical_bytes
        )
        return WebRTCParserLimits(max_string_length=max_string_length)

    def _send_channel_text(self, channel: Any, text: str) -> bool:
        """Send JSON text on a DataChannel after applying configured encoding."""
        if channel.readyState != "open":
            return False
        channel.send(self._encode_datachannel_message(text))
        return True

    def send_to_peer(self, peer_id: str, text: str) -> bool:
        """Send a text message to a specific peer via their DataChannel.

        Args:
            peer_id: Target peer identifier
            text: JSON string to send. When app-layer E2EE is enabled this
                is sealed and sent as binary AEAD payload.

        Returns:
            True if the message was sent, False if peer not connected or send failed
        """
        session_peer_id = self._session_for_peer_id(peer_id)
        send_fn = self._peer_send_fns.get(session_peer_id)
        if send_fn:
            try:
                send_fn(text)
                return True
            except Exception as e:
                log_warning(f"RTCClient: Failed to send to peer {peer_id}: {e}")
                return False
        log_warning(f"RTCClient: No send function for peer {peer_id}")
        return False

    def configure_mesh(
        self,
        mesh_config: MeshConfig,
        peer_registry: PeerRegistry,
        peer_bridge: PeerBridge,
        policy_provider: MeshPolicyProvider | None = None,
    ) -> None:
        """Configure mesh components on the RTCClient.

        Called by GatewayService after mesh initialization.

        Args:
            mesh_config: Mesh network configuration
            peer_registry: Registry tracking connected peers
            peer_bridge: Bridge for outbound RPC calls
        """
        self._mesh_enabled = True
        self._mesh_config = mesh_config
        self._mesh_policy_provider = policy_provider
        self._peer_registry = peer_registry
        self._peer_bridge = peer_bridge
        if not self._provider_export_registry_callback_registered:
            on_change = getattr(self._registry, "on_registry_change", None)
            if callable(on_change):
                on_change(self._invalidate_provider_export_registry)
                self._provider_export_registry_callback_registered = True
        for handler in self._rpc_handlers.values():
            handler.set_mesh_policy_provider(policy_provider)
        log_info("RTCClient: Mesh P2P configured")

    def disable_mesh(
        self,
        *,
        policy_provider: MeshPolicyProvider | None = None,
    ) -> None:
        """Clear mesh runtime wiring while preserving fail-closed policy for handlers."""

        self._mesh_enabled = False
        self._mesh_config = None
        self._manifest_sync_pending_protocol.clear()
        self._cancel_manifest_protocol_timeouts()
        self._cancel_manifest_reannounce_retries()
        self._invalidate_provider_export_all(reason_code="mesh_disabled")
        if policy_provider is not None:
            self._mesh_policy_provider = policy_provider
        self._peer_registry = None
        self._peer_bridge = None
        self._mesh_peer_id = None
        self._mesh_node_name = ""
        for handler in self._rpc_handlers.values():
            handler.set_mesh_policy_provider(self._mesh_policy_provider)
        log_info("RTCClient: Mesh P2P disabled")

    def update_mesh_config(
        self,
        mesh_config: MeshConfig,
        policy_provider: MeshPolicyProvider | None = None,
    ) -> None:
        """Replace live mesh policy used by manifest generation and routing IO."""
        self._mesh_config = mesh_config
        if policy_provider is not None:
            self._mesh_policy_provider = policy_provider
            for handler in self._rpc_handlers.values():
                handler.set_mesh_policy_provider(policy_provider)
        self._invalidate_provider_export_all()
        self._schedule_tooling_projection_refresh_all()
        log_debug("RTCClient: Live mesh config updated")

    def _invalidate_provider_export_registry(self) -> None:
        self._invalidate_provider_export_all()
        self._schedule_tooling_projection_refresh_all()

    def _schedule_tooling_projection_refresh_all(self) -> None:
        """Coalesce one targeted manifest refresh per authenticated stable peer."""

        if not self._peer_registry:
            return
        for peer in self._peer_registry.get_negotiated_peers():
            stable_peer_id = str(peer.peer_id)
            current = self._tooling_projection_refresh_tasks.get(stable_peer_id)
            if current is not None and not current.done():
                continue

            async def _refresh(peer_id: str = stable_peer_id) -> None:
                try:
                    await self._wait_for_local_provider_unavailable(peer_id)
                    await self.reannounce_manifest_for_peer(peer_id)
                finally:
                    task = self._tooling_projection_refresh_tasks.get(peer_id)
                    if task is asyncio.current_task():
                        self._tooling_projection_refresh_tasks.pop(peer_id, None)

            self._tooling_projection_refresh_tasks[stable_peer_id] = asyncio.create_task(
                _refresh(),
                name=f"tooling-projection-refresh:{stable_peer_id}",
            )

    def _invalidate_provider_export_all(
        self,
        *,
        notify_provider_unavailable: bool = True,
        reason_code: str = "provider_export_invalidated",
    ) -> int:
        self._provider_export_generation += 1
        self._provider_export_active.clear()
        self._manifest_ack_expectations.clear()
        for stable_peer_id in list(self._local_provider_ready):
            if notify_provider_unavailable:
                self._schedule_local_provider_unavailable(
                    stable_peer_id,
                    reason_code=reason_code,
                )
            self._reset_local_provider_readiness(stable_peer_id)
        return self._provider_export_cache.invalidate_all()

    def _invalidate_provider_export_peer(
        self,
        stable_peer_id: str,
        *,
        notify_provider_unavailable: bool = True,
        reason_code: str = "provider_export_invalidated",
    ) -> int:
        generation = self._provider_export_peer_generations.get(stable_peer_id, 0) + 1
        self._provider_export_peer_generations[stable_peer_id] = generation
        self._provider_export_active.pop(stable_peer_id, None)
        self._manifest_ack_expectations.pop(stable_peer_id, None)
        if notify_provider_unavailable:
            self._schedule_local_provider_unavailable(
                stable_peer_id,
                reason_code=reason_code,
            )
        self._reset_local_provider_readiness(stable_peer_id)
        return self._provider_export_cache.invalidate_peer(stable_peer_id)

    def _cancel_manifest_reannounce_retries(
        self,
        stable_peer_id: str | None = None,
    ) -> list[asyncio.Task[None]]:
        if stable_peer_id is None:
            tasks = list(self._manifest_reannounce_retry_tasks.values())
            self._manifest_reannounce_retry_tasks.clear()
        else:
            task = self._manifest_reannounce_retry_tasks.pop(stable_peer_id, None)
            tasks = [task] if task is not None else []
        for task in tasks:
            if task is not asyncio.current_task() and not task.done():
                task.cancel()
        return tasks

    def _set_provider_export_diagnostic(
        self,
        peer_id: str | None,
        diagnostic: dict[str, Any],
    ) -> None:
        """Store bounded redacted shadow diagnostics with deterministic eviction."""

        key = str(peer_id or "unknown")
        redacted = {
            str(field): value
            for field, value in diagnostic.items()
            if str(field) in _PROVIDER_EXPORT_DIAGNOSTIC_FIELDS
            and isinstance(value, str | int | bool | type(None))
        }
        if key in self._provider_export_diagnostics:
            self._provider_export_diagnostics.move_to_end(key)
        self._provider_export_diagnostics[key] = redacted
        while len(self._provider_export_diagnostics) > _PROVIDER_EXPORT_DIAGNOSTIC_LIMIT:
            self._provider_export_diagnostics.popitem(last=False)

    def get_provider_export_shadow_diagnostics(self) -> dict[str, dict[str, Any]]:
        """Return redacted provider-export shadow diagnostics for tests/operators."""

        return {
            peer_id: dict(diagnostic)
            for peer_id, diagnostic in self._provider_export_diagnostics.items()
        }

    @staticmethod
    def _canonical_authority_permissions(raw_permissions: Any) -> tuple[str, ...]:
        if not isinstance(raw_permissions, (list, tuple)):
            raise ValueError("authority permissions must be a sequence")
        if not all(isinstance(permission, str) for permission in raw_permissions):
            raise ValueError("authority permissions must be strings")
        permissions = tuple(raw_permissions)
        if any(not permission.strip() for permission in permissions):
            raise ValueError("authority permissions must be nonblank")
        if tuple(sorted(set(permissions))) != permissions:
            raise ValueError("authority permissions must be sorted and unique")
        return permissions

    @staticmethod
    def _canonical_authority_peer_id(raw_peer_id: Any) -> str:
        if (
            not isinstance(raw_peer_id, str)
            or not raw_peer_id
            or raw_peer_id != raw_peer_id.strip()
        ):
            raise ValueError("authority peer_id must be a canonical nonblank string")
        return raw_peer_id

    def _authority_evidence_from_model(self, authority: Any) -> RecipientEvidence:
        peer_id = self._canonical_authority_peer_id(getattr(authority, "peer_id", ""))
        revision = int(getattr(authority, "auth_grant_revision", -1))
        disposition = str(getattr(authority, "disposition", "") or "")
        state = str(getattr(authority, "state", "") or "")
        permissions = self._canonical_authority_permissions(
            getattr(authority, "effective_permissions", ())
        )
        if not peer_id or revision < 0:
            raise ValueError("authority peer and revision are required")
        if revision == 0 and permissions:
            raise ValueError("revision zero cannot grant authority")
        if disposition == "removed" and (state != "revoked" or permissions):
            raise ValueError("removed authority must be revoked with empty grants")
        if state != "active" and permissions:
            raise ValueError("non-active authority must have empty grants")
        if state == "active" and disposition != "present":
            raise ValueError("active authority must be present")
        grants = (
            tuple(GrantEvidence(permission) for permission in permissions)
            if disposition == "present" and state == "active" and revision > 0
            else ()
        )
        evidence_state = state if disposition == "present" and revision > 0 else "revoked"
        return RecipientEvidence(
            peer_id=peer_id,
            revision=revision,
            grants=grants,
            state=evidence_state,
        )

    def apply_peer_authority_changed_detailed(self, event: Any) -> PeerAuthorityApplyResult:
        """Apply one canonical authority event with replay-safe monotonic checks."""

        from app.shared.contracts.models.mesh import MeshPeerAuthorityChangedEvent

        try:
            authority = (
                event
                if isinstance(event, MeshPeerAuthorityChangedEvent)
                else MeshPeerAuthorityChangedEvent.model_validate(event)
            )
            evidence = self._authority_evidence_from_model(authority)
            if evidence.revision < 1:
                raise ValueError("event authority revision must be positive")
        except Exception:
            self._set_provider_export_diagnostic(
                str(getattr(event, "peer_id", "") or ""),
                {"status": "error", "reason_code": "authority_event_invalid"},
            )
            return PeerAuthorityApplyResult(PeerAuthorityApplyStatus.INVALID)

        absent_floor = self._provider_export_authority_absent.get(evidence.peer_id)
        if absent_floor is not None and evidence.revision <= absent_floor:
            self._set_provider_export_diagnostic(
                evidence.peer_id,
                {
                    "status": "ignored",
                    "reason_code": "authority_revision_stale",
                    "authority_revision": evidence.revision,
                },
            )
            return PeerAuthorityApplyResult(
                PeerAuthorityApplyStatus.STALE,
                peer_id=evidence.peer_id,
                revision=evidence.revision,
                previous_revision=absent_floor,
            )

        current = self._provider_export_authority.get(evidence.peer_id)
        previous_revision = current.revision if current is not None else 0
        if evidence.peer_id in self._provider_export_authority_pending:
            self._sync_peer_authority_acl(evidence.peer_id, None)
            self._set_provider_export_diagnostic(
                evidence.peer_id,
                {
                    "status": "pending",
                    "reason_code": "authority_refresh_pending",
                    "authority_revision": previous_revision,
                },
            )
            return PeerAuthorityApplyResult(
                PeerAuthorityApplyStatus.PENDING,
                peer_id=evidence.peer_id,
                revision=evidence.revision,
                previous_revision=previous_revision,
            )
        if current is None:
            if absent_floor is not None and evidence.revision > absent_floor:
                pass
            elif evidence.revision != 1:
                self._mark_provider_export_authority_pending(
                    evidence.peer_id,
                    revision=previous_revision,
                    reason_code="authority_revision_gap",
                )
                self._sync_peer_authority_acl(evidence.peer_id, None)
                return PeerAuthorityApplyResult(
                    PeerAuthorityApplyStatus.GAP,
                    peer_id=evidence.peer_id,
                    revision=evidence.revision,
                    previous_revision=previous_revision,
                )
        else:
            if evidence.revision < current.revision:
                self._set_provider_export_diagnostic(
                    evidence.peer_id,
                    {
                        "status": "ignored",
                        "reason_code": "authority_revision_stale",
                        "authority_revision": evidence.revision,
                    },
                )
                return PeerAuthorityApplyResult(
                    PeerAuthorityApplyStatus.STALE,
                    peer_id=evidence.peer_id,
                    revision=evidence.revision,
                    previous_revision=current.revision,
                )
            if evidence.revision == current.revision:
                if evidence.digest != current.digest:
                    self._mark_provider_export_authority_pending(
                        evidence.peer_id,
                        revision=current.revision,
                        reason_code="authority_revision_conflict",
                    )
                    self._sync_peer_authority_acl(evidence.peer_id, None)
                    return PeerAuthorityApplyResult(
                        PeerAuthorityApplyStatus.CONFLICT,
                        peer_id=evidence.peer_id,
                        revision=evidence.revision,
                        previous_revision=current.revision,
                    )
                if evidence.peer_id in self._provider_export_authority_pending:
                    return PeerAuthorityApplyResult(
                        PeerAuthorityApplyStatus.PENDING,
                        peer_id=evidence.peer_id,
                        revision=evidence.revision,
                        previous_revision=current.revision,
                    )
                return PeerAuthorityApplyResult(
                    PeerAuthorityApplyStatus.DUPLICATE,
                    peer_id=evidence.peer_id,
                    revision=evidence.revision,
                    previous_revision=current.revision,
                )
            if evidence.revision != current.revision + 1:
                self._mark_provider_export_authority_pending(
                    evidence.peer_id,
                    revision=current.revision,
                    reason_code="authority_revision_gap",
                )
                self._sync_peer_authority_acl(evidence.peer_id, None)
                return PeerAuthorityApplyResult(
                    PeerAuthorityApplyStatus.GAP,
                    peer_id=evidence.peer_id,
                    revision=evidence.revision,
                    previous_revision=current.revision,
                )

        self._commit_peer_authority_evidence(evidence)
        return PeerAuthorityApplyResult(
            PeerAuthorityApplyStatus.APPLIED,
            peer_id=evidence.peer_id,
            revision=evidence.revision,
            previous_revision=previous_revision,
            reannounce=True,
        )

    def apply_peer_authority_changed(self, event: Any) -> bool:
        """Compatibility wrapper for older tests/direct seed callers.

        Gateway uses ``apply_peer_authority_changed_detailed`` for canonical
        event processing. Direct historical callers used this method to seed
        shadow evidence from an already trusted row and may start above
        revision 1, so an initial empty cache is treated as a trusted seed.
        """

        from app.shared.contracts.models.mesh import MeshPeerAuthorityChangedEvent

        try:
            authority = (
                event
                if isinstance(event, MeshPeerAuthorityChangedEvent)
                else MeshPeerAuthorityChangedEvent.model_validate(event)
            )
            peer_id = str(authority.peer_id)
        except Exception:
            return self.apply_peer_authority_changed_detailed(event).applied
        if (
            peer_id not in self._provider_export_authority
            and peer_id not in self._provider_export_authority_absent
            and peer_id not in self._provider_export_authority_pending
        ):
            return self.apply_trusted_peer_authority_snapshot(authority).applied
        return self.apply_peer_authority_changed_detailed(authority).applied

    def _capture_authority_runtime_state(self) -> dict[str, Any]:
        token_scopes: dict[int, tuple[str, ...]] = {}
        for token in self._peer_tokens.values():
            token_scopes[id(token)] = tuple(getattr(token, "scopes", ()) or ())
        cache_entries = {
            provider: {recipient: dict(entries) for recipient, entries in recipient_entries.items()}
            for provider, recipient_entries in self._provider_export_cache._entries.items()
        }
        return {
            "authority": dict(self._provider_export_authority),
            "pending": set(self._provider_export_authority_pending),
            "absent": dict(self._provider_export_authority_absent),
            "peer_generations": dict(self._provider_export_peer_generations),
            "diagnostics": OrderedDict(self._provider_export_diagnostics),
            "peer_acl": dict(self._peer_acl),
            "token_scopes": token_scopes,
            "cache_entries": cache_entries,
            "cache_authority": dict(self._provider_export_cache._authority),
            "active": dict(self._provider_export_active),
        }

    def _restore_authority_runtime_state(self, state: dict[str, Any]) -> None:
        self._provider_export_authority = dict(state["authority"])
        self._provider_export_authority_pending = set(state["pending"])
        self._provider_export_authority_absent = dict(state["absent"])
        self._provider_export_peer_generations = dict(state["peer_generations"])
        self._provider_export_diagnostics = OrderedDict(state["diagnostics"])
        self._peer_acl = dict(state["peer_acl"])
        for token in self._peer_tokens.values():
            scopes = state["token_scopes"].get(id(token))
            if scopes is not None:
                token.scopes = list(scopes)
        self._provider_export_cache._entries = {
            provider: {recipient: dict(entries) for recipient, entries in recipient_entries.items()}
            for provider, recipient_entries in state["cache_entries"].items()
        }
        self._provider_export_cache._authority = dict(state["cache_authority"])
        self._provider_export_active = dict(state.get("active", {}))

    def preflight_trusted_peer_authority_snapshot(self, row: Any) -> PeerAuthorityApplyResult:
        """Evaluate trusted snapshot semantics without publishing state."""

        state = self._capture_authority_runtime_state()
        try:
            return self.apply_trusted_peer_authority_snapshot(row)
        finally:
            self._restore_authority_runtime_state(state)

    def preflight_trusted_peer_authority_absence(
        self,
        stable_peer_id: str,
        *,
        revision_floor: int | None = None,
    ) -> PeerAuthorityApplyResult:
        """Evaluate trusted absence semantics without publishing state."""

        state = self._capture_authority_runtime_state()
        try:
            return self.apply_trusted_peer_authority_absence(
                stable_peer_id,
                revision_floor=revision_floor,
            )
        finally:
            self._restore_authority_runtime_state(state)

    def apply_trusted_peer_authority_snapshot(self, row: Any) -> PeerAuthorityApplyResult:
        """Apply one trusted Auth snapshot row; snapshots may jump revisions."""

        try:
            evidence = self._authority_evidence_from_model(row)
        except Exception:
            return PeerAuthorityApplyResult(PeerAuthorityApplyStatus.INVALID)

        current = self._provider_export_authority.get(evidence.peer_id)
        previous_revision = current.revision if current is not None else 0
        if evidence.revision == 0:
            return self.apply_trusted_peer_authority_absence(evidence.peer_id, revision_floor=0)
        absent_floor = self._provider_export_authority_absent.get(evidence.peer_id)
        if absent_floor is not None and evidence.revision <= absent_floor:
            self._sync_peer_authority_acl(evidence.peer_id, None)
            return PeerAuthorityApplyResult(
                PeerAuthorityApplyStatus.STALE,
                peer_id=evidence.peer_id,
                revision=evidence.revision,
                previous_revision=absent_floor,
            )
        if current is not None:
            if evidence.revision < current.revision:
                self._mark_provider_export_authority_pending(
                    evidence.peer_id,
                    revision=current.revision,
                    reason_code="authority_snapshot_regressed",
                )
                self._sync_peer_authority_acl(evidence.peer_id, None)
                return PeerAuthorityApplyResult(
                    PeerAuthorityApplyStatus.STALE,
                    peer_id=evidence.peer_id,
                    revision=evidence.revision,
                    previous_revision=current.revision,
                )
            if evidence.revision == current.revision:
                if evidence.digest == current.digest:
                    was_pending = evidence.peer_id in self._provider_export_authority_pending
                    self._provider_export_authority_pending.discard(evidence.peer_id)
                    self._sync_peer_authority_acl(evidence.peer_id, current)
                    if was_pending:
                        self._invalidate_provider_export_peer(evidence.peer_id)
                    return PeerAuthorityApplyResult(
                        PeerAuthorityApplyStatus.DUPLICATE,
                        peer_id=evidence.peer_id,
                        revision=evidence.revision,
                        previous_revision=current.revision,
                        reannounce=was_pending,
                    )
                self._provider_export_cache.trusted_reset_authority_peer(evidence.peer_id)
        self._commit_peer_authority_evidence(evidence)
        return PeerAuthorityApplyResult(
            PeerAuthorityApplyStatus.APPLIED,
            peer_id=evidence.peer_id,
            revision=evidence.revision,
            previous_revision=previous_revision,
            reannounce=True,
        )

    def apply_trusted_peer_authority_absence(
        self,
        stable_peer_id: str,
        *,
        revision_floor: int | None = None,
    ) -> PeerAuthorityApplyResult:
        """Apply trusted absence for one peer without clearing monotonic floors."""

        try:
            stable_peer_id = self._canonical_authority_peer_id(stable_peer_id)
        except Exception:
            return PeerAuthorityApplyResult(PeerAuthorityApplyStatus.INVALID)
        current = self._provider_export_authority.get(stable_peer_id)
        previous_revision = current.revision if current is not None else 0
        was_pending = stable_peer_id in self._provider_export_authority_pending
        previous_absent_floor = self._provider_export_authority_absent.get(stable_peer_id)
        floor = max(int(revision_floor or 0), previous_revision)
        self._provider_export_authority.pop(stable_peer_id, None)
        self._provider_export_authority_pending.discard(stable_peer_id)
        self._provider_export_authority_absent[stable_peer_id] = max(
            floor,
            self._provider_export_authority_absent.get(stable_peer_id, 0),
        )
        self._drop_reconnect_challenges_for_stable_peer(stable_peer_id)
        self._invalidate_provider_export_peer(stable_peer_id)
        self._sync_peer_authority_acl(stable_peer_id, None)
        self._set_provider_export_diagnostic(
            stable_peer_id,
            {
                "status": "absent",
                "reason_code": "authority_absent",
                "authority_revision": self._provider_export_authority_absent[stable_peer_id],
            },
        )
        return PeerAuthorityApplyResult(
            PeerAuthorityApplyStatus.ABSENT,
            peer_id=stable_peer_id,
            revision=self._provider_export_authority_absent[stable_peer_id],
            previous_revision=previous_revision,
            reannounce=bool(
                was_pending
                or current is not None
                or previous_absent_floor != self._provider_export_authority_absent[stable_peer_id]
            ),
        )

    def _commit_peer_authority_evidence(self, evidence: RecipientEvidence) -> None:
        self._provider_export_authority[evidence.peer_id] = evidence
        self._provider_export_authority_pending.discard(evidence.peer_id)
        self._provider_export_authority_absent.pop(evidence.peer_id, None)
        if evidence.state != "active":
            self._drop_reconnect_challenges_for_stable_peer(evidence.peer_id)
        self._invalidate_provider_export_peer(evidence.peer_id)
        self._sync_peer_authority_acl(evidence.peer_id, evidence)

    def _mark_provider_export_authority_pending(
        self,
        stable_peer_id: str,
        *,
        revision: int,
        reason_code: str = "authority_refresh_pending",
    ) -> None:
        self._provider_export_authority_pending.add(stable_peer_id)
        self._invalidate_provider_export_peer(stable_peer_id)
        self._set_provider_export_diagnostic(
            stable_peer_id,
            {
                "status": "pending",
                "reason_code": reason_code,
                "authority_revision": revision,
            },
        )

    def _zero_authority_identity(self, identity: Identity) -> Identity:
        return Identity(
            principal_id=identity.principal_id,
            principal_name=identity.principal_name,
            is_admin=False,
            permissions=frozenset(),
            effective_perms=frozenset(),
            device_id=identity.device_id,
            source="webrtc_peer",
            metadata=dict(identity.metadata),
        )

    def _authority_identity(self, identity: Identity, evidence: RecipientEvidence) -> Identity:
        permissions = frozenset(
            grant.permission for grant in (evidence.grants or ()) if grant.permission
        )
        return Identity(
            principal_id=identity.principal_id,
            principal_name=identity.principal_name,
            is_admin="*" in permissions,
            permissions=permissions,
            effective_perms=permissions,
            device_id=identity.device_id,
            source="webrtc_peer",
            metadata=dict(identity.metadata),
        )

    def _replace_peer_token_scopes(
        self,
        stable_peer_id: str,
        session_peer_id: str,
        scopes: tuple[str, ...],
    ) -> None:
        seen_tokens: set[int] = set()
        for key in (stable_peer_id, session_peer_id):
            token = self._peer_tokens.get(key)
            if token is None or id(token) in seen_tokens:
                continue
            seen_tokens.add(id(token))
            with contextlib.suppress(Exception):
                token.scopes = list(scopes)

    def _sync_peer_authority_acl(
        self,
        stable_peer_id: str,
        evidence: RecipientEvidence | None,
    ) -> bool:
        session_peer_id = self._stable_peer_sessions.get(stable_peer_id)
        if not session_peer_id or self._peer_stable_ids.get(session_peer_id) != stable_peer_id:
            return False
        session_identity = self._peer_acl.get(session_peer_id)
        stable_identity = self._peer_acl.get(stable_peer_id)
        if (
            session_identity is None
            or stable_identity is None
            or session_identity != stable_identity
            or session_identity in (ANONYMOUS, OPEN_PEER)
            or getattr(session_identity, "source", None) != "webrtc_peer"
            or getattr(stable_identity, "source", None) != "webrtc_peer"
        ):
            return False
        if evidence is not None and evidence.revision >= 1 and evidence.state == "active":
            scopes = tuple(grant.permission for grant in (evidence.grants or ()))
            replacement = self._authority_identity(session_identity, evidence)
        else:
            scopes = ()
            replacement = self._zero_authority_identity(session_identity)
            self._cancel_peer_rpc_work(session_peer_id, stable_peer_id)
        self._peer_acl[session_peer_id] = replacement
        self._peer_acl[stable_peer_id] = replacement
        self._replace_peer_token_scopes(stable_peer_id, session_peer_id, scopes)
        return True

    def _mark_provider_export_authority_unknown(self, stable_peer_id: str) -> None:
        """Fail closed after legacy permission refresh without resetting watermarks."""

        if not stable_peer_id:
            return
        current = self._provider_export_authority.get(stable_peer_id)
        revision = current.revision if current is not None else 0
        self._mark_provider_export_authority_pending(
            stable_peer_id,
            revision=revision,
            reason_code="authority_refresh_pending",
        )
        self._sync_peer_authority_acl(stable_peer_id, None)

    def _provider_export_policy_snapshot(
        self,
        mesh_config: MeshConfig,
        *,
        live_snapshot: Any = None,
    ) -> PolicySnapshot:
        policies = tuple(
            ServiceExportPolicy(
                service_id=str(service_id),
                share=bool(policy.export.share),
                unshared_feature_ids=tuple(policy.export.unshared_feature_ids),
                unshared_method_ids=tuple(policy.export.unshared_method_ids),
                max_concurrent=policy.export.max_concurrent,
            )
            for service_id, policy in sorted(mesh_config.services.items())
        )
        if live_snapshot is not None and getattr(live_snapshot, "mesh_config", None) is mesh_config:
            revision = str(live_snapshot.revision)
        else:
            policy_content_digest = canonical_digest(
                {"services": [policy.to_canonical() for policy in policies]}
            )
            revision = f"detached:{policy_content_digest}"
        return PolicySnapshot(revision=revision, services=policies)

    def _provider_export_recipient_evidence(self, stable_peer_id: str) -> RecipientEvidence:
        if stable_peer_id in self._provider_export_authority_pending:
            current = self._provider_export_authority.get(stable_peer_id)
            return RecipientEvidence(
                peer_id=stable_peer_id,
                revision=current.revision if current is not None else 0,
                grants=None,
                state="pending",
            )
        if stable_peer_id in self._provider_export_authority_absent:
            return RecipientEvidence(
                peer_id=stable_peer_id,
                revision=self._provider_export_authority_absent[stable_peer_id],
                grants=(),
                state="revoked",
            )
        return self._provider_export_authority.get(stable_peer_id) or RecipientEvidence(
            peer_id=stable_peer_id,
            revision=0,
            grants=None,
            state="unknown",
        )

    def _current_provider_export_projection(
        self,
        stable_peer_id: str,
        *,
        mesh_config: MeshConfig | None = None,
        live_policy_snapshot: Any = None,
    ) -> ProjectionResult | None:
        """Return the immutable current projection for one authenticated stable peer."""

        if not stable_peer_id:
            return None
        mesh_config = mesh_config or self._current_mesh_config()
        if not self._mesh_enabled and mesh_config is None:
            return None
        if not mesh_config or not mesh_config.enabled or not self._mesh_peer_id:
            return None
        if not self._has_authenticated_stable_peer(stable_peer_id):
            return None
        generation = self._provider_export_generation
        peer_generation = self._provider_export_peer_generations.get(stable_peer_id, 0)
        current = self._provider_export_active.get(stable_peer_id)
        if (
            current is not None
            and current.generation == generation
            and current.peer_generation == peer_generation
            and current.projection.cache_key.provider_peer_id == self._mesh_peer_id
            and current.projection.cache_key.recipient_peer_id == stable_peer_id
        ):
            return current.projection
        try:
            snapshot_reader = getattr(self._registry, "snapshot_registry", None)
            if callable(snapshot_reader):
                registry_snapshot = snapshot_reader()
            else:
                from app.services.gateway.mesh.negotiation import (
                    registry_snapshot_from_local_contracts,
                )

                registry_snapshot = registry_snapshot_from_local_contracts()
            policy_snapshot = self._provider_export_policy_snapshot(
                mesh_config,
                live_snapshot=live_policy_snapshot,
            )
            recipient = self._provider_export_recipient_evidence(stable_peer_id)
            if recipient.readiness == "ready":
                result = self._provider_export_cache.project(
                    provider_peer_id=self._mesh_peer_id,
                    registry=registry_snapshot,
                    policy=policy_snapshot,
                    recipient=recipient,
                    protocol=ProtocolEvidence(),
                )
            else:
                result = project_provider_export(
                    provider_peer_id=self._mesh_peer_id,
                    registry=registry_snapshot,
                    policy=policy_snapshot,
                    recipient=recipient,
                    protocol=ProtocolEvidence(),
                )
            if not isinstance(result, ProjectionResult):
                raise TypeError("active projection result is invalid")
        except (StaleAuthorityRevisionError, ConflictingAuthorityRevisionError):
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {"status": "error", "reason_code": "authority_revision_rejected"},
            )
            return None
        except Exception:
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {"status": "error", "reason_code": "active_projection_failed"},
            )
            return None
        if (
            generation != self._provider_export_generation
            or peer_generation != self._provider_export_peer_generations.get(stable_peer_id, 0)
            or not self._has_authenticated_stable_peer(stable_peer_id)
            or result.cache_key.provider_peer_id != self._mesh_peer_id
            or result.cache_key.recipient_peer_id != stable_peer_id
        ):
            self._provider_export_active.pop(stable_peer_id, None)
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {"status": "skipped", "reason_code": "active_projection_stale_generation"},
            )
            return None
        self._provider_export_active[stable_peer_id] = _ActiveProjectionRecord(
            generation=generation,
            peer_generation=peer_generation,
            projection=result,
        )
        self._set_provider_export_diagnostic(
            stable_peer_id,
            {
                "status": "ok",
                "reason_code": "active_projected",
                "readiness": result.readiness,
                "routable": result.routable,
                "registry_revision": registry_snapshot.revision,
                "registry_digest": registry_snapshot.digest,
                "policy_revision": policy_snapshot.revision,
                "policy_digest": policy_snapshot.digest,
                "authority_revision": recipient.revision,
                "authority_digest": recipient.digest,
                "projection_digest": result.digest,
                "included_service_count": result.diff.included_service_count,
                "included_method_count": result.diff.included_method_count,
                "excluded_count": result.diff.excluded_count,
            },
        )
        return result

    def _active_projection_for_session(self, session_peer_id: str) -> ProjectionResult | None:
        stable_peer_id = self._peer_stable_ids.get(session_peer_id)
        if not stable_peer_id:
            return None
        result = self._current_provider_export_projection(stable_peer_id)
        if result is None or not result.routable or result.readiness != "ready":
            return None
        if result.cache_key.recipient_peer_id != stable_peer_id:
            return None
        if result.cache_key.provider_peer_id != self._local_mesh_peer_id():
            return None
        return result

    def _schedule_provider_export_shadow(
        self,
        stable_peer_id: str,
        mesh_config: MeshConfig,
        *,
        live_policy_snapshot: Any = None,
    ) -> None:
        if not self._mesh_peer_id:
            self._set_provider_export_diagnostic(
                stable_peer_id or "unknown",
                {
                    "status": "skipped",
                    "reason_code": "local_mesh_identity_unavailable",
                },
            )
            return
        if not self._has_authenticated_stable_peer(stable_peer_id):
            self._set_provider_export_diagnostic(
                stable_peer_id or "unknown",
                {
                    "status": "skipped",
                    "reason_code": "authenticated_stable_peer_unavailable",
                },
            )
            return
        try:
            snapshot_reader = getattr(self._registry, "snapshot_registry", None)
            if not callable(snapshot_reader):
                self._set_provider_export_diagnostic(
                    stable_peer_id,
                    {
                        "status": "skipped",
                        "reason_code": "registry_snapshot_unavailable",
                    },
                )
                return
            provider_peer_id = self._mesh_peer_id
            registry_snapshot = snapshot_reader()
            policy_snapshot = self._provider_export_policy_snapshot(
                mesh_config,
                live_snapshot=live_policy_snapshot,
            )
            recipient = self._provider_export_recipient_evidence(stable_peer_id)
            generation = self._provider_export_generation
            peer_generation = self._provider_export_peer_generations.get(stable_peer_id, 0)
        except Exception:
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {
                    "status": "error",
                    "reason_code": "shadow_input_failed",
                },
            )
            return
        task = asyncio.create_task(
            self._run_provider_export_shadow(
                stable_peer_id,
                provider_peer_id=provider_peer_id,
                registry_snapshot=registry_snapshot,
                policy_snapshot=policy_snapshot,
                recipient=recipient,
                generation=generation,
                peer_generation=peer_generation,
            ),
            name=f"provider-export-shadow:{stable_peer_id}",
        )
        self._provider_export_tasks.add(task)
        task.add_done_callback(self._provider_export_tasks.discard)

    def _has_authenticated_stable_peer(self, stable_peer_id: str) -> bool:
        if not stable_peer_id:
            return False
        session_peer_id = self._stable_peer_sessions.get(stable_peer_id)
        if not session_peer_id:
            return False
        if self._peer_stable_ids.get(session_peer_id) != stable_peer_id:
            return False
        if not self._is_peer_session_active(session_peer_id):
            return False
        session_identity = self._peer_acl.get(session_peer_id)
        stable_identity = self._peer_acl.get(stable_peer_id)
        return bool(
            session_identity
            and stable_identity
            and session_identity == stable_identity
            and session_identity != ANONYMOUS
            and session_identity != OPEN_PEER
            and getattr(session_identity, "source", None) == "webrtc_peer"
            and getattr(stable_identity, "source", None) == "webrtc_peer"
        )

    async def _run_provider_export_shadow(
        self,
        stable_peer_id: str,
        *,
        provider_peer_id: str,
        registry_snapshot: Any,
        policy_snapshot: PolicySnapshot,
        recipient: RecipientEvidence,
        generation: int,
        peer_generation: int,
    ) -> None:
        try:
            if generation != self._provider_export_generation or peer_generation != (
                self._provider_export_peer_generations.get(stable_peer_id, 0)
            ):
                return
            if self._mesh_peer_id != provider_peer_id:
                self._set_provider_export_diagnostic(
                    stable_peer_id,
                    {
                        "status": "skipped",
                        "reason_code": "local_mesh_identity_changed",
                    },
                )
                return
            if recipient.state == "pending":
                self._set_provider_export_diagnostic(
                    stable_peer_id,
                    {
                        "status": "pending",
                        "reason_code": "authority_refresh_pending",
                        "readiness": "pending",
                        "routable": False,
                        "registry_revision": registry_snapshot.revision,
                        "registry_digest": registry_snapshot.digest,
                        "policy_revision": policy_snapshot.revision,
                        "policy_digest": policy_snapshot.digest,
                        "authority_revision": recipient.revision,
                        "authority_digest": recipient.digest,
                        "included_service_count": 0,
                        "included_method_count": 0,
                        "excluded_count": 0,
                    },
                )
                return
            result = self._provider_export_cache.project(
                provider_peer_id=provider_peer_id,
                registry=registry_snapshot,
                policy=policy_snapshot,
                recipient=recipient,
                protocol=ProtocolEvidence(),
            )
            if generation != self._provider_export_generation or peer_generation != (
                self._provider_export_peer_generations.get(stable_peer_id, 0)
            ):
                self._provider_export_cache.invalidate_peer(
                    stable_peer_id,
                    provider_peer_id=provider_peer_id,
                )
                return
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {
                    "status": "ok",
                    "reason_code": "shadow_projected",
                    "readiness": result.readiness,
                    "routable": result.routable,
                    "registry_revision": registry_snapshot.revision,
                    "registry_digest": registry_snapshot.digest,
                    "policy_revision": policy_snapshot.revision,
                    "policy_digest": policy_snapshot.digest,
                    "authority_revision": recipient.revision,
                    "authority_digest": recipient.digest,
                    "projection_digest": result.digest,
                    "included_service_count": result.diff.included_service_count,
                    "included_method_count": result.diff.included_method_count,
                    "excluded_count": result.diff.excluded_count,
                },
            )
        except (StaleAuthorityRevisionError, ConflictingAuthorityRevisionError):
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {
                    "status": "error",
                    "reason_code": "authority_revision_rejected",
                },
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            self._set_provider_export_diagnostic(
                stable_peer_id,
                {
                    "status": "error",
                    "reason_code": "shadow_projection_failed",
                },
            )

    def set_rpc_bus(self, bus: MessageBus) -> None:
        """Update the bus used by future and existing inbound RPC handlers."""
        self._bus = bus
        for handler in self._rpc_handlers.values():
            handler.set_bus(bus)

    def _local_shares_tooling(self, mesh_config: MeshConfig | None = None) -> bool:
        mesh_config = mesh_config or self._current_mesh_config()
        if not mesh_config:
            return False
        service_cfg = getattr(mesh_config, "services", {}).get("Tooling")
        return bool(service_cfg and service_cfg.export.share)

    def _current_mesh_config(self) -> MeshConfig | None:
        if self._mesh_policy_provider is not None:
            return self._mesh_policy_provider().mesh_config
        return self._mesh_config

    def _current_mesh_policy_pair(self) -> tuple[MeshConfig | None, Any]:
        if self._mesh_policy_provider is not None:
            snapshot = self._mesh_policy_provider()
            return snapshot.mesh_config, snapshot
        return self._mesh_config, None

    @staticmethod
    def _manifest_shares_tooling(manifest: Any) -> bool:
        return any(
            service.module == "Tooling" for service in getattr(manifest, "shared_services", [])
        )

    @staticmethod
    def _verified_manifest_grants(manifest: Any, status: str) -> list[str]:
        if status != "verified":
            return []
        evidence = getattr(manifest, "recipient_projection_evidence", None)
        if evidence is None or getattr(evidence, "auth_grant_state", None) != "active":
            return []
        return [str(grant.permission) for grant in (getattr(evidence, "grants", None) or [])]

    @staticmethod
    def _non_routable_manifest_for(peer_id: str, source: Any = None) -> Any:
        from app.services.gateway.mesh.models import PeerManifest
        from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL

        node_name = str(getattr(source, "node_name", "") or "")
        aurora_version = str(getattr(source, "aurora_version", "") or "")
        return PeerManifest(
            peer_id=peer_id,
            node_name=node_name,
            aurora_version=aurora_version,
            shared_services=[],
            granted_permissions=None,
            active_protocol=ACTIVE_MANIFEST_PROTOCOL,
            active_version="v1",
            active_tier="projection",
            supported_protocols=None,
            projection_supported=True,
            projection_active=False,
            recipient_projection_evidence=None,
            timestamp=datetime.now(timezone.utc).isoformat(),
        )

    async def _request_tooling_projection_sync(
        self,
        peer_id: str,
        *,
        reason: str,
        mesh_config: MeshConfig | None = None,
    ) -> None:
        """Request a full projection from one authenticated stable provider."""

        if not self._local_shares_tooling(mesh_config):
            return
        try:
            from app.messaging.priority_helpers import get_system_priority
            from app.shared.contracts.models.tooling import (
                ToolingProjectionSyncRequested,
            )

            await self._bus.publish(
                TOOLING_PROJECTION_SYNC_REQUESTED_TOPIC,
                ToolingProjectionSyncRequested(
                    provider_peer_id=peer_id,
                    service_instance_id=f"remote:{peer_id}:Tooling",
                    reason_code=reason,
                    force_full_snapshot=True,
                ),
                event=True,
                mesh=False,
                priority=get_system_priority(),
                origin="internal",
            )
            log_debug(
                f"RTCClient: Requested targeted Tooling projection sync after {reason} "
                f"with {peer_id}"
            )
        except Exception as exc:
            log_warning(f"RTCClient: Tooling projection sync request failed for {peer_id}: {exc}")

    def send_tooling_projection_invalidation(
        self,
        recipient_peer_id: str,
        invalidation: Any,
    ) -> bool:
        """Send metadata-only invalidation to exactly one authenticated peer."""

        latest_by_peer = getattr(self, "_latest_tooling_projection_invalidations_by_peer", None)
        if latest_by_peer is None:
            latest_by_peer = OrderedDict()
            self._latest_tooling_projection_invalidations_by_peer = latest_by_peer
        retained_invalidation = invalidation
        latest_by_peer.pop(recipient_peer_id, None)
        latest_by_peer[recipient_peer_id] = retained_invalidation
        while len(latest_by_peer) > 256:
            latest_by_peer.popitem(last=False)

        if not self._peer_bridge or not self._has_authenticated_stable_peer(recipient_peer_id):
            return False
        session_peer_id = self._stable_peer_sessions.get(recipient_peer_id)
        revisions = (
            self._provider_tooling_authority_revisions(session_peer_id) if session_peer_id else None
        )
        if revisions is None:
            return False
        auth_grant_revision, manifest_revision = revisions
        authority = getattr(invalidation, "authority_revision", None)
        if authority is None or not hasattr(invalidation, "model_copy"):
            return False
        invalidation = invalidation.model_copy(
            update={
                "authority_revision": authority.model_copy(
                    update={
                        "auth_grant_revision": auth_grant_revision,
                        "manifest_revision": manifest_revision,
                    }
                )
            }
        )
        sent = bool(
            self._peer_bridge.fire_event(
                recipient_peer_id,
                TOOLING_PROJECTION_INVALIDATED_TOPIC,
                invalidation,
                correlation_id=getattr(invalidation, "correlation_id", None),
            )
        )
        if sent and latest_by_peer.get(recipient_peer_id) is retained_invalidation:
            latest_by_peer.pop(recipient_peer_id, None)
        return sent

    def remember_tooling_projection_invalidation(self, invalidation: Any) -> None:
        """Retain latest authority revision for disconnected/reconnecting peers."""

        affected = getattr(invalidation, "affected_peer_ids", None)
        if affected is None:
            self._latest_tooling_projection_invalidation = invalidation
            return
        for peer_id in affected:
            peer_key = str(peer_id)
            self._latest_tooling_projection_invalidations_by_peer.pop(peer_key, None)
            self._latest_tooling_projection_invalidations_by_peer[peer_key] = invalidation
            while len(self._latest_tooling_projection_invalidations_by_peer) > 256:
                self._latest_tooling_projection_invalidations_by_peer.popitem(last=False)

    def retry_tooling_projection_invalidation(self, recipient_peer_id: str) -> bool:
        """Retry the latest applicable targeted invalidation after reconnect."""

        invalidation = self._latest_tooling_projection_invalidations_by_peer.get(
            recipient_peer_id,
            self._latest_tooling_projection_invalidation,
        )
        if invalidation is None:
            return True
        return self.send_tooling_projection_invalidation(recipient_peer_id, invalidation)

    def schedule_tooling_projection_invalidation_retry(self, recipient_peer_id: str) -> None:
        """Coalesce bounded immediate retries; retained latest state covers reconnect."""

        existing = self._tooling_invalidation_retry_tasks.get(recipient_peer_id)
        if existing is not None and not existing.done():
            return

        async def retry() -> None:
            current = asyncio.current_task()
            try:
                for delay in (0.1, 0.5, 2.0):
                    await asyncio.sleep(delay)
                    if self.retry_tooling_projection_invalidation(recipient_peer_id):
                        return
            finally:
                if self._tooling_invalidation_retry_tasks.get(recipient_peer_id) is current:
                    self._tooling_invalidation_retry_tasks.pop(recipient_peer_id, None)

        self._tooling_invalidation_retry_tasks[recipient_peer_id] = asyncio.create_task(retry())

    def tooling_projection_invalidation_recipients(self) -> list[str]:
        """Return only negotiated stable peers with current authenticated authority."""

        if not self._peer_registry:
            return []
        return sorted(
            stable_peer_id
            for stable_peer_id in {
                str(peer.peer_id) for peer in self._peer_registry.get_negotiated_peers()
            }
            if self._has_authenticated_stable_peer(stable_peer_id)
            and self._stable_peer_sessions.get(stable_peer_id)
            and self._provider_tooling_authority_revisions(
                self._stable_peer_sessions[stable_peer_id]
            )
            is not None
        )

    def remote_tooling_authority_revisions(self, stable_peer_id: str) -> tuple[int, int] | None:
        """Return revisions learned from a verified manifest for one stable peer."""

        if not self._has_authenticated_stable_peer(stable_peer_id):
            return None
        return self._tooling_remote_authority_revisions.get(stable_peer_id)

    def remote_tooling_authority_grants(self, stable_peer_id: str) -> tuple[str, ...] | None:
        """Return permissions learned from the same verified manifest authority."""

        if not self._has_authenticated_stable_peer(stable_peer_id):
            return None
        return self._tooling_remote_authority_grants.get(stable_peer_id)

    def _provider_tooling_authority_revisions(
        self,
        session_peer_id: str,
    ) -> tuple[int, int] | None:
        """Derive inbound Tooling authority solely from authenticated RTC state."""

        stable_peer_id = self._peer_stable_ids.get(session_peer_id)
        if not stable_peer_id or not self._has_authenticated_stable_peer(stable_peer_id):
            return None
        recipient = self._provider_export_recipient_evidence(stable_peer_id)
        if recipient.state != "active" or recipient.revision < 1:
            return None
        manifest_revision = self._tooling_outbound_manifest_revisions.get(stable_peer_id, 0)
        if manifest_revision < 1:
            return None
        return recipient.revision, manifest_revision

    async def _send_manifest(
        self,
        peer_id: str,
        *,
        mesh_config: MeshConfig | None = None,
        live_policy_snapshot: Any = None,
        force_send: bool = False,
    ) -> bool:
        """Send our local manifest to a peer after authentication.

        Args:
            peer_id: Target peer to send manifest to
        """
        if mesh_config is None:
            mesh_config, live_policy_snapshot = self._current_mesh_policy_pair()
        if not mesh_config:
            return False

        from app.services.gateway.mesh.negotiation import (
            manifest_from_projection,
            manifest_to_dict,
        )
        from app.shared.contracts.registry import _get_package_version

        session_peer_id = self._session_for_peer_id(peer_id)
        stable_peer_id = self._stable_peer_id_for_session(session_peer_id)
        await self._wait_for_local_provider_unavailable(stable_peer_id)
        projection = self._current_provider_export_projection(
            stable_peer_id,
            mesh_config=mesh_config,
            live_policy_snapshot=live_policy_snapshot,
        )
        if projection is None:
            return False
        manifest = manifest_from_projection(
            projection=projection,
            node_name=self._local_mesh_node_name(),
            aurora_version=_get_package_version(),
        )
        msg = manifest_to_dict(manifest)
        payload = json.dumps(msg)
        projection_size = sum(len(service.methods) for service in manifest.shared_services)
        advertised_services = tuple(sorted(service.module for service in manifest.shared_services))
        protocol = self._peer_protocols.get(session_peer_id)
        if len(payload.encode("utf-8")) > PeerProtocolLimits().fragment_payload_bytes:
            if protocol is None:
                self._manifest_sync_pending_protocol.add(stable_peer_id)
                self._schedule_manifest_protocol_timeout(stable_peer_id, session_peer_id)
                log_debug(
                    "RTCClient: Deferred large manifest until protocol negotiation "
                    f"for peer {self._peer_label(stable_peer_id)}"
                )
                return False
            if not protocol.supports(CAP_FRAGMENTATION_V1):
                self._manifest_sync_pending_protocol.discard(stable_peer_id)
                self._record_diagnostic_error(
                    "manifest_fragmentation_unsupported",
                    "Peer does not support fragmentation required by the manifest",
                    session_peer_id,
                )
                return False
        self._manifest_sync_pending_protocol.discard(stable_peer_id)
        pending_ack = self._manifest_ack_expectations.get(stable_peer_id)
        pending_matches_projection = self._manifest_expectation_matches_projection(
            stable_peer_id,
            session_peer_id,
            pending_ack,
            manifest,
            advertised_services,
        )
        active_readiness = self._local_provider_ready.get(stable_peer_id)
        active_matches_projection = self._manifest_expectation_matches_projection(
            stable_peer_id,
            session_peer_id,
            active_readiness,
            manifest,
            advertised_services,
        )
        reuse_active_readiness = not pending_matches_projection and active_matches_projection
        if (pending_matches_projection or active_matches_projection) and not force_send:
            return True
        await self._audit(
            "mesh.manifest_projection.generated",
            details={
                "peer_id": stable_peer_id,
                "projection_size": projection_size,
                "protocol_status": manifest.active_protocol,
                "secrets_redacted": True,
            },
        )
        if not pending_matches_projection and not active_matches_projection:
            if active_readiness is not None:
                await self._send_local_provider_unavailable(
                    stable_peer_id,
                    reason_code="manifest_replaced",
                    session_peer_id=session_peer_id,
                    expectation=active_readiness,
                )
            self._reset_local_provider_readiness(stable_peer_id, session_peer_id=session_peer_id)
        evidence = manifest.recipient_projection_evidence
        expected_ack: _ManifestAckExpectation | None = None
        if pending_matches_projection:
            expected_ack = pending_ack
        elif active_matches_projection:
            expected_ack = None
        elif evidence is not None:
            expected_ack = _ManifestAckExpectation(
                session_peer_id=session_peer_id,
                connection_epoch=uuid.uuid4().hex,
                projection_digest=evidence.projection_digest,
                active_protocol=str(manifest.active_protocol or ""),
                active_version=str(manifest.active_version or ""),
                active_tier=str(manifest.active_tier or ""),
                protocol_revision=str(manifest.active_version or ""),
                registry_revision=evidence.registry_revision,
                export_policy_revision=evidence.policy_revision,
                auth_grant_revision=evidence.auth_grant_revision,
                advertised_services=advertised_services,
                compatible_services=(),
            )
            self._manifest_ack_expectations[stable_peer_id] = expected_ack
        sent = await self.send_to_peer_async(session_peer_id, payload)
        if self._rollout_metrics is not None:
            self._rollout_metrics.record(
                "manifest_sent" if sent else "manifest_failed",
                peer_id=stable_peer_id,
                reason_code=None if sent else "projection_sync_failed",
                manifest_revision=self._tooling_outbound_manifest_revisions.get(stable_peer_id, 0)
                + (1 if sent else 0),
                projection_size=projection_size,
                protocol_status=manifest.active_protocol,
            )
        await self._audit(
            "mesh.manifest_projection.sent" if sent else "mesh.manifest_projection.failed",
            details={
                "peer_id": stable_peer_id,
                "manifest_revision": self._tooling_outbound_manifest_revisions.get(
                    stable_peer_id, 0
                )
                + (1 if sent else 0),
                "projection_size": projection_size,
                "reason_code": None if sent else "projection_sync_failed",
                "secrets_redacted": True,
            },
        )
        if not sent:
            if (
                not pending_matches_projection
                and expected_ack is not None
                and self._manifest_ack_expectations.get(stable_peer_id) == expected_ack
            ):
                self._manifest_ack_expectations.pop(stable_peer_id, None)
        else:
            log_debug(f"RTCClient: Sent manifest to peer {peer_id}")
            self._tooling_outbound_manifest_revisions[stable_peer_id] = (
                self._tooling_outbound_manifest_revisions.get(stable_peer_id, 0) + 1
            )
            if reuse_active_readiness and active_readiness is not None:
                await self._send_local_provider_lease_frame(
                    stable_peer_id,
                    active_readiness,
                )
            self.retry_tooling_projection_invalidation(stable_peer_id)
            self._schedule_provider_export_shadow(
                stable_peer_id,
                mesh_config,
                live_policy_snapshot=live_policy_snapshot,
            )
        return sent

    def _request_manifest(self, peer_id: str, *, reason: str) -> bool:
        """Ask an authenticated peer to resend its current manifest."""
        sent = self.send_to_peer(peer_id, json.dumps({"type": "manifest_request"}))
        if sent:
            log_debug(f"RTCClient: Requested manifest from {peer_id} after {reason}")
        return sent

    async def _on_peer_manifest(self, peer_id: str, data: dict) -> None:
        """Process an incoming manifest from a peer.

        Updates the PeerRegistry and sends back a manifest ACK.

        Args:
            peer_id: Peer that sent the manifest
            data: Parsed manifest message
        """
        from app.services.gateway.mesh.negotiation import (
            generate_manifest_ack,
            manifest_ack_to_dict,
            parse_manifest_with_evidence,
        )

        stable_peer_id = self._stable_peer_id_for_session(peer_id)
        parse_result = parse_manifest_with_evidence(
            data,
            expected_provider_peer_id=stable_peer_id if stable_peer_id != peer_id else None,
            expected_recipient_peer_id=self._local_mesh_peer_id(),
        )
        manifest = parse_result.manifest
        if not parse_result.usable or not manifest:
            self._tooling_projection_sync_after_lease.discard(stable_peer_id)
            self._tooling_remote_authority_revisions.pop(stable_peer_id, None)
            self._tooling_remote_authority_grants.pop(stable_peer_id, None)
            if self._peer_registry and stable_peer_id != peer_id:
                await self._peer_registry.register_peer(stable_peer_id, "")
                await self._peer_registry.update_manifest(
                    stable_peer_id,
                    self._non_routable_manifest_for(stable_peer_id, manifest),
                )
            log_warning(
                f"RTCClient: Invalid manifest from peer {peer_id}: {parse_result.reason_code}"
            )
            return
        mesh_config = self._current_mesh_config()
        if stable_peer_id == peer_id or manifest.peer_id != stable_peer_id:
            self._record_diagnostic_error(
                "manifest_identity_mismatch",
                "Peer manifest identity did not match authenticated identity",
                peer_id,
            )
            log_warning(
                f"RTCClient: Rejected manifest identity {manifest.peer_id!r} "
                f"from authenticated peer {stable_peer_id!r}"
            )
            return
        if manifest.node_name:
            self._peer_names[stable_peer_id] = manifest.node_name
            self._peer_names[peer_id] = manifest.node_name

        registry_manifest = (
            manifest
            if parse_result.status == "verified"
            else self._non_routable_manifest_for(stable_peer_id, manifest)
        )
        if parse_result.status == "legacy_unverifiable" and manifest.projection_supported:
            self._schedule_manifest_reannounce_retry(stable_peer_id)
        if parse_result.status == "verified":
            evidence = manifest.recipient_projection_evidence
            previous_manifest_revision = self._tooling_remote_authority_revisions.get(
                stable_peer_id, (0, 0)
            )[1]
            self._tooling_remote_authority_revisions[stable_peer_id] = (
                int(evidence.auth_grant_revision) if evidence is not None else 0,
                previous_manifest_revision + 1,
            )
            self._tooling_remote_authority_grants[stable_peer_id] = tuple(
                sorted(self._verified_manifest_grants(manifest, parse_result.status))
            )
        else:
            self._tooling_remote_authority_revisions.pop(stable_peer_id, None)
            self._tooling_remote_authority_grants.pop(stable_peer_id, None)

        # Update peer registry
        needs_initial_latency = True
        if self._peer_registry:
            existing_state = self._peer_registry.get_peer(stable_peer_id)
            existing_latency = getattr(existing_state, "latency_ms", float("inf"))
            needs_initial_latency = not isinstance(
                existing_latency, (int, float)
            ) or not math.isfinite(existing_latency)
            await self._peer_registry.register_peer(stable_peer_id, manifest.node_name)
            if self.peer_supports_capability(peer_id, CAP_PROVIDER_LEASE_V1):
                await self._peer_registry.require_provider_lease(stable_peer_id)
            await self._peer_registry.update_manifest(stable_peer_id, registry_manifest)

        # Send ACK
        if mesh_config:
            ack = generate_manifest_ack(registry_manifest, mesh_config)
            ack_msg = manifest_ack_to_dict(ack)
            if self.send_to_peer(stable_peer_id, json.dumps(ack_msg)):
                log_debug(f"RTCClient: Sent manifest ACK to peer {stable_peer_id}")

        if self._peer_bridge:
            self._peer_bridge.request_latency_sample(
                stable_peer_id,
                sample_count=3 if needs_initial_latency else 1,
                reset=needs_initial_latency,
            )

        protocol = select_tooling_protocol(manifest, manifest_status=parse_result.status)
        if self._manifest_shares_tooling(manifest) and self._local_shares_tooling(mesh_config):
            if self.peer_supports_capability(peer_id, CAP_PROVIDER_LEASE_V1):
                # Lease-aware providers open inbound calls only after this ACK
                # is accepted and an active provider lease is announced.
                self._tooling_projection_sync_after_lease.add(stable_peer_id)
            else:
                await self._request_tooling_projection_sync(
                    stable_peer_id,
                    reason=(
                        "peer_manifest_projection_ready" if protocol.supported else protocol.status
                    ),
                    mesh_config=mesh_config,
                )
        else:
            self._tooling_projection_sync_after_lease.discard(stable_peer_id)

    async def _on_manifest_ack(self, peer_id: str, data: dict) -> None:
        """Process an incoming manifest ACK from a peer.

        Stores compatibility data in the PeerRegistry for diagnostics
        and future routing optimization.

        Args:
            peer_id: Peer that sent the ACK
            data: Parsed manifest ACK message
        """
        from app.services.gateway.mesh.negotiation import parse_manifest_ack

        stable_peer_id = self._stable_peer_id_for_session(peer_id)
        ack = parse_manifest_ack(data)
        if not ack:
            return
        expected = self._manifest_ack_expectations.get(stable_peer_id)
        readiness_expectation = None
        if ack.services:
            current_structured_ack = self._manifest_ack_matches_current_expectation(
                stable_peer_id, ack, expected
            )
            if not current_structured_ack and expected is not None:
                log_warning(
                    f"RTCClient: Ignored stale structured manifest ACK from {stable_peer_id}"
                )
                return
            if current_structured_ack:
                readiness_expectation = self._readiness_expectation_from_ack(
                    stable_peer_id,
                    ack,
                    expected,
                )

        log_info(
            f"RTCClient: Manifest ACK from {stable_peer_id} — "
            f"compatible={ack.compatible_services}, "
            f"incompatible={ack.incompatible_services}, "
            f"unused={ack.unused_services}"
        )

        # Store compatibility report in peer registry
        if self._peer_registry:
            await self._peer_registry.update_manifest_ack(stable_peer_id, ack)
        if readiness_expectation is not None:
            opened = await self._open_local_provider_readiness(
                stable_peer_id, readiness_expectation
            )
            if opened:
                self._manifest_ack_expectations.pop(stable_peer_id, None)

    def _readiness_expectation_from_ack(
        self,
        stable_peer_id: str,
        ack: Any,
        expected: _ManifestAckExpectation | None,
    ) -> _ManifestAckExpectation | None:
        if not self._manifest_ack_matches_current_expectation(stable_peer_id, ack, expected):
            return None
        compatible_services = tuple(sorted(ack.compatible_services))
        if not compatible_services:
            return None
        return dataclass_replace(expected, compatible_services=compatible_services)

    def _manifest_ack_matches_current_expectation(
        self,
        stable_peer_id: str,
        ack: Any,
        expected: _ManifestAckExpectation | None,
    ) -> bool:
        if expected is None:
            return False
        if self._stable_peer_sessions.get(stable_peer_id) != expected.session_peer_id:
            return False
        if not self.peer_supports_capability(expected.session_peer_id, CAP_PROVIDER_LEASE_V1):
            return False
        compatible_services = tuple(sorted(ack.compatible_services))
        service_statuses = {service.service_id: service.status for service in ack.services}
        if set(service_statuses) != set(expected.advertised_services):
            return False
        if compatible_services != tuple(
            service_id
            for service_id, status in sorted(service_statuses.items())
            if status == "compatible"
        ):
            return False
        return (
            ack.active_protocol == expected.active_protocol
            and ack.active_version == expected.active_version
            and ack.active_tier == expected.active_tier
            and ack.protocol_revision == expected.protocol_revision
            and ack.registry_revision == expected.registry_revision
            and ack.export_policy_revision == expected.export_policy_revision
            and ack.auth_grant_revision == expected.auth_grant_revision
            and ack.projection_digest == expected.projection_digest
        )

    def _manifest_expectation_matches_projection(
        self,
        stable_peer_id: str,
        session_peer_id: str,
        expected: _ManifestAckExpectation | None,
        manifest: Any,
        advertised_services: tuple[str, ...],
    ) -> bool:
        if expected is None:
            return False
        if expected.session_peer_id != session_peer_id:
            return False
        if self._stable_peer_sessions.get(stable_peer_id) != session_peer_id:
            return False
        if not self.peer_supports_capability(session_peer_id, CAP_PROVIDER_LEASE_V1):
            return False
        evidence = getattr(manifest, "recipient_projection_evidence", None)
        if evidence is None:
            return False
        return (
            expected.projection_digest == evidence.projection_digest
            and expected.active_protocol == str(getattr(manifest, "active_protocol", "") or "")
            and expected.active_version == str(getattr(manifest, "active_version", "") or "")
            and expected.active_tier == str(getattr(manifest, "active_tier", "") or "")
            and expected.protocol_revision == str(getattr(manifest, "active_version", "") or "")
            and expected.registry_revision == evidence.registry_revision
            and expected.export_policy_revision == evidence.policy_revision
            and expected.auth_grant_revision == evidence.auth_grant_revision
            and expected.advertised_services == advertised_services
        )

    def _send_pong(self, peer_id: str, ping_data: dict) -> None:
        """Send a pong response to a peer's ping.

        Args:
            peer_id: Peer that sent the ping
            ping_data: The original ping message
        """
        msg = {
            "type": "pong",
            "id": ping_data.get("id", ""),
            "ts": ping_data.get("ts", 0),
        }
        self.send_to_peer(peer_id, json.dumps(msg))

    async def _on_capacity_update(self, peer_id: str, data: dict) -> None:
        """Handle an incoming capacity update from a peer.

        Updates the peer's active call count in the registry so the
        routing table can make informed decisions.

        Args:
            peer_id: Peer that sent the update
            data: Parsed capacity_update message with 'module', 'available', 'max_concurrent'
        """
        if not self._peer_registry:
            return

        module = data.get("module", "")
        available = data.get("available", 0)
        max_concurrent = data.get("max_concurrent", 0)
        log_debug(f"RTCClient: Capacity update from {peer_id}: {module} available={available}")

        # Derive active calls: active = max - available
        if max_concurrent > 0:
            active_calls = max(0, max_concurrent - available)
            await self._peer_registry.set_active_calls(peer_id, active_calls)

    async def _on_mesh_peer_standby(self, peer_id: str, data: dict) -> None:
        """Record a peer's announced, credential-keeping departure.

        The peer is not removed and not marked stale.  It said it was going
        away, so its silence means what it said, and it comes back on the
        credential it already holds.  A malformed announcement is ignored
        rather than acted on: an absence that cannot be parsed is not an
        announced one, and it falls back to the ordinary stale window.

        Args:
            peer_id: Peer that stood down
            data: Parsed ``mesh_peer_standby_v1`` frame
        """

        if not self._peer_registry:
            return
        try:
            frame = parse_mesh_peer_standby_frame(data)
        except PeerProtocolError as exc:
            self._record_diagnostic_error(
                "mesh_peer_standby_invalid",
                f"Invalid peer standby frame: {exc}",
                peer_id,
            )
            return
        if frame.peer_id != peer_id:
            self._record_diagnostic_error(
                "mesh_peer_standby_wrong_peer",
                "Peer standby frame did not match the authenticated session",
                peer_id,
            )
            return
        await self._peer_registry.mark_peer_standby(peer_id, frame.reason_code)

    def send_capacity_update(
        self, peer_id: str, module: str, available: int, max_concurrent: int
    ) -> bool:
        """Send a capacity update to a peer.

        Args:
            peer_id: Target peer
            module: Service module whose capacity changed
            available: Current available capacity
            max_concurrent: Total max concurrent calls

        Returns:
            True if sent, False if peer not connected
        """
        msg = {
            "type": "capacity_update",
            "module": module,
            "available": available,
            "max_concurrent": max_concurrent,
        }
        return self.send_to_peer(peer_id, json.dumps(msg))

    def broadcast_capacity_update(self, module: str, available: int, max_concurrent: int) -> None:
        """Broadcast a capacity update to ALL connected mesh peers.

        Called when local service capacity changes (call started or finished).

        Args:
            module: Service module whose capacity changed
            available: Current available capacity
            max_concurrent: Total max concurrent calls
        """
        if not self._mesh_enabled or not self._peer_registry:
            return
        for peer in self._peer_registry.get_negotiated_peers():
            self.send_capacity_update(peer.peer_id, module, available, max_concurrent)

    async def send_broadcast(self, event: str, data: dict | None = None) -> None:
        """Send an encrypted broadcast to all peers in the signaling room.

        Broadcasts go through the MQTT signaling layer, not DataChannels,
        so they reach even peers we haven't finished WebRTC setup with yet.

        Args:
            event: Event name (e.g., "peer_leaving", "manifest_changed")
            data: Additional data to include in the broadcast
        """
        if not self._adapter:
            return

        msg: dict = {
            "type": "mesh_event",
            "from": self._peer_id,
            "event": event,
            **(data or {}),
        }
        sealed = aead_seal(self._keys.k_sig, msg)
        await self._adapter.send("broadcast", sealed)

    async def reannounce_manifest(self) -> bool:
        """Re-send our manifest to all negotiated peers.

        Called periodically by MeshAnnouncer or when local contracts change.
        """
        if not self._mesh_enabled or not self._peer_registry:
            return False

        mesh_config, live_policy_snapshot = self._current_mesh_policy_pair()
        if not mesh_config:
            return False
        peers = self._peer_registry.get_negotiated_peers()
        all_sent = True
        for peer in peers:
            sent = await self._send_manifest(
                peer.peer_id,
                mesh_config=mesh_config,
                live_policy_snapshot=live_policy_snapshot,
                force_send=True,
            )
            all_sent = all_sent and sent

        if peers:
            log_debug(f"RTCClient: Re-announced manifest to {len(peers)} peers")
        return all_sent

    def _schedule_manifest_reannounce_retry(self, stable_peer_id: str) -> None:
        if stable_peer_id in self._manifest_reannounce_retry_tasks:
            task = self._manifest_reannounce_retry_tasks[stable_peer_id]
            if not task.done():
                return

        async def _retry() -> None:
            try:
                delay = 1.0
                for _attempt in range(_MANIFEST_REANNOUNCE_RETRY_ATTEMPTS):
                    await asyncio.sleep(delay)
                    if not self._can_reannounce_manifest_for_peer(stable_peer_id):
                        return
                    if self._rollout_metrics is not None:
                        self._rollout_metrics.record("manifest_retry", peer_id=stable_peer_id)
                    await self._audit(
                        "mesh.manifest_projection.retried",
                        details={
                            "peer_id": stable_peer_id,
                            "retry_count": _attempt + 1,
                            "secrets_redacted": True,
                        },
                    )
                    if await self.reannounce_manifest_for_peer(stable_peer_id, retry=False):
                        return
                    delay = min(delay * 2, _MANIFEST_REANNOUNCE_RETRY_MAX_DELAY_S)
                if self._rollout_metrics is not None:
                    self._rollout_metrics.record(
                        "manifest_retry_exhausted",
                        peer_id=stable_peer_id,
                        reason_code="projection_sync_failed",
                    )
            except asyncio.CancelledError:
                raise
            finally:
                if self._manifest_reannounce_retry_tasks.get(stable_peer_id) is task:
                    self._manifest_reannounce_retry_tasks.pop(stable_peer_id, None)

        task = asyncio.create_task(_retry(), name=f"manifest-reannounce:{stable_peer_id}")
        self._manifest_reannounce_retry_tasks[stable_peer_id] = task

    def _can_reannounce_manifest_for_peer(self, stable_peer_id: str) -> bool:
        if not self._mesh_enabled or not self._peer_registry or not stable_peer_id:
            return False
        if not self._has_authenticated_stable_peer(stable_peer_id):
            return False
        session_peer_id = self._stable_peer_sessions.get(stable_peer_id)
        return bool(session_peer_id and session_peer_id in self._peer_send_fns)

    async def reannounce_manifest_for_peer(
        self,
        stable_peer_id: str,
        *,
        retry: bool = True,
    ) -> bool:
        """Re-send the active recipient-specific manifest to one authenticated stable peer."""

        if not isinstance(stable_peer_id, str) or stable_peer_id != stable_peer_id.strip():
            return False
        if not self._can_reannounce_manifest_for_peer(stable_peer_id):
            return False
        mesh_config, live_policy_snapshot = self._current_mesh_policy_pair()
        if not mesh_config:
            return False
        sent = await self._send_manifest(
            stable_peer_id,
            mesh_config=mesh_config,
            live_policy_snapshot=live_policy_snapshot,
            force_send=True,
        )
        if sent:
            self._cancel_manifest_reannounce_retries(stable_peer_id)
            return True
        if retry:
            self._schedule_manifest_reannounce_retry(stable_peer_id)
        return False

    async def _handle_signaling_departure(self, peer: str, *, reason: str) -> None:
        """Stop stale negotiation without mistaking signaling loss for RTC loss.

        MQTT last-will presence can fire while a mobile WebView is suspended,
        even though its native WebRTC data channel remains open.  Once the
        data channel is established it is the authoritative liveness signal;
        its close callback performs the normal peer/provider cleanup.
        """
        reconnect_task = self._peer_reconnect_tasks.pop(peer, None)
        if reconnect_task and reconnect_task is not asyncio.current_task():
            reconnect_task.cancel()
            await asyncio.gather(reconnect_task, return_exceptions=True)
        self._cancel_negotiation_watchdog(peer)
        self._offer_in_progress.discard(peer)

        pc = self._pcs.get(peer)
        channel = self._peer_data_channels.get(peer)
        if pc is not None and getattr(channel, "readyState", None) == "open":
            log_info(
                f"RTCClient: Signaling peer {peer} departed ({reason}); "
                "preserving open data channel"
            )
            return
        if pc is not None:
            log_info(f"RTCClient: Signaling peer {peer} departed ({reason})")
            self._reconnect_suppressed_pcs.add(pc)
            stable_peer_id = self._stable_peer_id_for_session(peer)
            await self._send_local_provider_unavailable(
                stable_peer_id,
                reason_code="peer_departed",
                session_peer_id=peer,
            )
            self._invalidate_provider_export_peer(
                stable_peer_id,
                notify_provider_unavailable=False,
            )
            await self._close_peer_connection(pc)
            return

        stable_peer_id = self._stable_peer_id_for_session(peer)
        await self._send_local_provider_unavailable(
            stable_peer_id,
            reason_code="peer_departed",
            session_peer_id=peer,
        )
        self._clear_pairing_state(peer)
        self._peer_claimed_stable_ids.pop(peer, None)
        self._peer_claimed_names.pop(peer, None)
        self._peer_stable_ids.pop(peer, None)
        self._stable_peer_sessions.pop(stable_peer_id, None)
        self._peer_names.pop(peer, None)
        self._peer_names.pop(stable_peer_id, None)
        self._cancel_provider_lease_task(stable_peer_id)
        self._invalidate_provider_export_peer(
            stable_peer_id,
            notify_provider_unavailable=False,
        )
        if self._peer_registry:
            await self._peer_registry.remove_peer(stable_peer_id)

    async def _on_presence(self, payload: bytes) -> None:
        """Handle an incoming presence announcement from the signaling room.

        When a new peer announces itself, we initiate a WebRTC connection
        to it. To avoid a "glare" condition (both peers sending offers
        simultaneously), only the peer with the lexicographically lower
        ID initiates the connection. The other peer will receive the
        offer and reply with an answer.

        Presence messages are published as MQTT retained messages on
        per-peer subtopics (``presence/{peer_id}``), so late joiners
        automatically receive them upon subscribing.

        An empty payload indicates a peer has left (retained message cleared).
        """
        # Empty payload = peer left (retained message cleared on disconnect)
        if not payload or payload == b"":
            return

        # Try decryption first (encrypted presence)
        if self._settings.webrtc.encrypt_signaling:
            try:
                msg = aead_open(self._keys.k_sig, payload)
            except Exception:
                log_debug("RTCClient: Ignoring unauthenticated presence payload")
                return
        else:
            try:
                msg = json.loads(payload)
            except Exception:
                log_debug("RTCClient: Ignoring non-JSON presence payload (likely cleared retain)")
                return

        if not self._signaling_envelope_matches_room(
            msg,
            channel="presence",
            require_recipient=False,
        ):
            return

        if msg.get("type") == "presence_departed":
            departed_peer = str(msg.get("peer_id") or "")
            if departed_peer and departed_peer != self._peer_id:
                await self._handle_signaling_departure(
                    departed_peer,
                    reason="retained presence cleared",
                )
            return

        remote_peer = msg.get("peer_id")
        if not remote_peer or remote_peer == self._peer_id:
            return  # Ignore our own presence

        remote_stable_peer_id = (
            msg.get("stable_peer_id") or msg.get("mesh_peer_id") or msg.get("peer_stable_id")
        )
        remote_node_name = msg.get("node_name") or msg.get("mesh_node_name") or ""
        if remote_stable_peer_id == self._local_mesh_peer_id():
            log_debug(f"RTCClient: Ignoring stale self-presence from signaling peer {remote_peer}")
            return
        if remote_stable_peer_id:
            self._remember_claimed_peer_identity(
                remote_peer,
                remote_stable_peer_id,
                remote_node_name,
            )

        # Skip peers we already have a connection to
        if remote_peer in self._pcs:
            log_debug(f"RTCClient: Already connected to peer {remote_peer}, ignoring presence")
            return

        log_info(f"RTCClient: Discovered peer {remote_peer} in room")

        # Tie-breaker: lower peer ID initiates the offer to avoid glare
        if self._peer_id < remote_peer:
            log_info(f"RTCClient: Initiating WebRTC connection to peer {remote_peer}")
            try:
                await self.connect_to(remote_peer)
            except Exception:
                # connect_to records the exact failure and owns persistent retry.
                return
        else:
            log_info(f"RTCClient: Waiting for offer from peer {remote_peer} (tie-breaker)")

    def _ice_servers(self) -> list[RTCIceServer]:
        ice_servers = [RTCIceServer(urls=self._settings.webrtc.stun_servers)]
        if self._settings.webrtc.turn_servers:
            ice_servers.append(
                RTCIceServer(
                    urls=self._settings.webrtc.turn_servers,
                    username=self._settings.webrtc.turn_username,
                    credential=self._settings.webrtc.turn_password,
                )
            )
        return ice_servers

    # Message types that ANONYMOUS peers can always send
    _ANON_ALLOWED_TYPES = {
        "auth",
        "reauth",
        _MESH_AUTH_CHALLENGE_TYPE,
        _MESH_AUTH_PROOF_TYPE,
    }

    # RPC method prefixes that ANONYMOUS peers may call for pairing/auth
    _ANON_ALLOWED_RPC_PREFIXES = (
        AuthMethods.PAIRING_START,
        AuthMethods.PAIRING_CONNECT,
        AuthMethods.PAIRING_EXCHANGE,
        AuthMethods.LOGIN,
    )

    async def _rpc_call(
        self,
        peer: str,
        method: str,
        params: dict,
        timeout: float = 10.0,
    ) -> dict | None:
        """Send an outbound RPC call to a remote peer and await the response.

        Args:
            peer: Target peer identifier.
            method: RPC method name (e.g., ``"Auth.PairingStart"``).
            params: Call parameters.
            timeout: Max seconds to wait for a response.

        Returns:
            Result dict on success, ``None`` on timeout or error.
        """
        call_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict | None] = loop.create_future()
        self._pending_rpc[call_id] = future
        session_peer = self._session_for_peer_id(peer)
        self._pending_rpc_peers[call_id] = session_peer

        msg = {"type": "call", "id": call_id, "method": method, "params": params}
        send_fn = self._peer_send_fns.get(session_peer)
        if not send_fn:
            self._record_diagnostic_error(
                "datachannel_send_unavailable",
                "No DataChannel send function is available for peer",
                peer,
            )
            self._pending_rpc.pop(call_id, None)
            self._pending_rpc_peers.pop(call_id, None)
            return None
        try:
            send_fn(json.dumps(msg))
        except Exception as exc:
            self._pending_rpc.pop(call_id, None)
            self._pending_rpc_peers.pop(call_id, None)
            self._record_diagnostic_error(
                "rpc_send_failed",
                f"Failed to send RPC {method}",
                peer,
            )
            log_error(f"RTCClient: Failed to send RPC {method} to {peer}: {exc}")
            return None

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            self._record_diagnostic_error(
                "rpc_timeout",
                f"RPC {method} timed out",
                peer,
            )
            log_warning(f"RTCClient: RPC {method} to {peer} timed out")
            return None
        finally:
            self._pending_rpc.pop(call_id, None)
            self._pending_rpc_peers.pop(call_id, None)

    def _channel_binding_for_peer(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> str:
        """Derive the exact SDP/signaling binding for one active connection."""
        transport = self._pairing_transports.get(peer)
        if transport is None or transport.get("pc") is not pc:
            raise PairingProtocolError("Pairing transport does not match the active connection")
        return derive_channel_binding(
            app_id=str(self._settings.webrtc.app_id),
            room=str(self._settings.webrtc.room),
            offerer_signaling_id=str(transport.get("offerer_signaling_id") or ""),
            answerer_signaling_id=str(transport.get("answerer_signaling_id") or ""),
            offer_sdp=str(transport.get("offer_sdp") or ""),
            answer_sdp=str(transport.get("answer_sdp") or ""),
        )

    def _transport_identity_for_peer(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> tuple[str, str]:
        transport = self._pairing_transports.get(peer)
        if transport is None or transport.get("pc") is not pc:
            raise PairingProtocolError("Pairing transport does not match the active connection")
        stable_peer_id = str(transport.get("remote_stable_peer_id") or "")
        if not stable_peer_id:
            raise PairingProtocolError("Remote stable mesh identity is unavailable")
        if stable_peer_id == self._local_mesh_peer_id():
            raise PairingProtocolError(
                "Local and remote mesh identities are identical; copied instance configuration"
            )
        return stable_peer_id, str(transport.get("remote_node_name") or "")

    def _cleanup_reconnect_challenge_cache(self, now_ms: int | None = None) -> None:
        now = self._provider_lease_clock_ms() if now_ms is None else now_ms
        for challenge, expires_at_ms in list(self._used_peer_auth_challenges.items()):
            if expires_at_ms <= now:
                self._used_peer_auth_challenges.pop(challenge, None)

    def _reconnect_authority_rejects(self, stable_peer_id: str) -> bool:
        if not self._mesh_enabled:
            return False
        evidence = self._provider_export_recipient_evidence(stable_peer_id)
        return evidence.state != "active" or evidence.grants is None

    def _drop_reconnect_challenges_for_stable_peer(self, stable_peer_id: str) -> None:
        for peer, record in list(self._peer_auth_challenges.items()):
            if (
                record.claimant_peer_id == stable_peer_id
                or record.verifier_peer_id == stable_peer_id
            ):
                self._peer_auth_challenges.pop(peer, None)

    def _issue_reconnect_challenge_value(self, now_ms: int) -> str:
        self._cleanup_reconnect_challenge_cache(now_ms)
        active = {record.challenge for record in self._peer_auth_challenges.values()}
        for _ in range(8):
            challenge = secrets.token_hex(32)
            if (
                challenge not in active
                and self._used_peer_auth_challenges.get(challenge, 0) <= now_ms
            ):
                return challenge
        raise PairingProtocolError("Reconnect challenge generation collided")

    def _reconnect_record_matches(
        self,
        *,
        record: _ReconnectChallengeRecord,
        pc: RTCPeerConnection,
        message: dict[str, Any],
    ) -> bool:
        return (
            record.pc is pc
            and message.get("challenge") == record.challenge
            and message.get("channel_binding") == record.channel_binding
            and message.get("claimant_peer_id") == record.claimant_peer_id
            and message.get("verifier_peer_id") == record.verifier_peer_id
            and message.get("claimant_signaling_peer_id") == record.claimant_signaling_peer_id
            and message.get("verifier_signaling_peer_id") == record.verifier_signaling_peer_id
            and message.get("room_name") == record.room_name
        )

    def _send_reconnect_challenge(
        self,
        peer: str,
        pc: RTCPeerConnection,
        chan: Any,
    ) -> None:
        """Challenge the remote to prove a locally issued credential."""
        remote_stable_peer_id, _ = self._transport_identity_for_peer(peer, pc)
        now_ms = self._provider_lease_clock_ms()
        challenge = self._issue_reconnect_challenge_value(now_ms)
        channel_binding = self._channel_binding_for_peer(peer, pc)
        record = _ReconnectChallengeRecord(
            pc=pc,
            challenge=challenge,
            channel_binding=channel_binding,
            claimant_peer_id=remote_stable_peer_id,
            verifier_peer_id=self._local_mesh_peer_id(),
            claimant_signaling_peer_id=peer,
            verifier_signaling_peer_id=self._peer_id,
            room_name=str(self._settings.webrtc.room),
            issued_at_ms=now_ms,
            expires_at_ms=now_ms + _MESH_AUTH_CHALLENGE_TTL_MS,
        )
        self._peer_auth_challenges[peer] = record
        self._send_channel_text(
            chan,
            json.dumps(
                {
                    "type": _MESH_AUTH_CHALLENGE_TYPE,
                    "challenge": record.challenge,
                    "channel_binding": record.channel_binding,
                    "claimant_peer_id": record.claimant_peer_id,
                    "verifier_peer_id": record.verifier_peer_id,
                    "claimant_signaling_peer_id": record.claimant_signaling_peer_id,
                    "verifier_signaling_peer_id": record.verifier_signaling_peer_id,
                    "room_name": record.room_name,
                }
            ),
        )

    def _handle_reconnect_challenge(
        self,
        peer: str,
        pc: RTCPeerConnection,
        chan: Any,
        message: dict[str, Any],
    ) -> None:
        """Answer a fresh channel-bound challenge without exposing the bearer."""
        remote_stable_peer_id, _ = self._transport_identity_for_peer(peer, pc)
        channel_binding = self._channel_binding_for_peer(peer, pc)
        challenge = str(message.get("challenge") or "")
        identity_matches = (
            len(challenge) == 64
            and all(character in "0123456789abcdef" for character in challenge)
            and message.get("channel_binding") == channel_binding
            and message.get("claimant_peer_id") == self._local_mesh_peer_id()
            and message.get("verifier_peer_id") == remote_stable_peer_id
            and message.get("claimant_signaling_peer_id") == self._peer_id
            and message.get("verifier_signaling_peer_id") == peer
            and message.get("room_name") == str(self._settings.webrtc.room)
        )
        if not identity_matches:
            raise PairingProtocolError("Reconnect challenge does not match the active transport")

        credential = self._saved_auth_credential_for_peer(peer)
        if credential is None or not credential[1]:
            # Legacy rows have no public token selector.  They are deliberately
            # repaired through one SAS-approved pairing rather than leaking the
            # bearer in the old reconnect format.
            self._start_bilateral_pairing(
                peer,
                chan,
                pc,
                reason="no proof-capable saved credential",
            )
            return

        token, token_id = credential
        proof_message = build_mesh_reconnect_proof_message(
            token_id=token_id,
            challenge=challenge,
            channel_binding=channel_binding,
            claimant_peer_id=self._local_mesh_peer_id(),
            verifier_peer_id=remote_stable_peer_id,
            room_name=str(self._settings.webrtc.room),
        )
        proof_key = hashlib.sha256(token.encode("utf-8")).digest()
        proof = hmac.new(proof_key, proof_message, hashlib.sha256).hexdigest()
        self._send_channel_text(
            chan,
            json.dumps(
                {
                    "type": _MESH_AUTH_PROOF_TYPE,
                    "token_id": token_id,
                    "challenge": challenge,
                    "proof": proof,
                    "channel_binding": channel_binding,
                    "claimant_peer_id": self._local_mesh_peer_id(),
                    "verifier_peer_id": remote_stable_peer_id,
                    "claimant_signaling_peer_id": self._peer_id,
                    "verifier_signaling_peer_id": peer,
                    "room_name": str(self._settings.webrtc.room),
                }
            ),
        )

    async def _authenticate_peer(
        self,
        *,
        peer: str,
        token: Any,
        stable_peer_id: str,
        peer_name: str,
        clear_pairing_inbound: bool,
    ) -> None:
        identity = await self._auth_service.build_identity_from_token(
            token,
            source="webrtc_peer",
        )
        if identity is None:
            raise PairingProtocolError("Authenticated token did not resolve an identity")
        existing_session = self._stable_peer_sessions.get(stable_peer_id)
        if existing_session and existing_session != peer and existing_session in self._pcs:
            await self._retire_replaced_stable_session(
                stable_peer_id=stable_peer_id,
                replaced_session_peer_id=existing_session,
                replacement_session_peer_id=peer,
            )
        stable_peer_id = self._remember_stable_peer_id(peer, stable_peer_id, peer_name)
        self._peer_tokens[peer] = token
        self._peer_tokens[stable_peer_id] = token
        if self._mesh_enabled:
            zero_identity = self._zero_authority_identity(identity)
            self._peer_acl[peer] = zero_identity
            self._peer_acl[stable_peer_id] = zero_identity
            self._replace_peer_token_scopes(stable_peer_id, peer, ())
            refresh = self._authority_refresh_callback
            if callable(refresh):
                try:
                    refreshed = await refresh(stable_peer_id)
                except Exception:
                    self._mark_provider_export_authority_unknown(stable_peer_id)
                else:
                    if not refreshed:
                        self._mark_provider_export_authority_unknown(stable_peer_id)
            else:
                self._mark_provider_export_authority_unknown(stable_peer_id)
        else:
            self._peer_acl[peer] = identity
            self._peer_acl[stable_peer_id] = identity
        log_info(
            f"Peer {self._peer_label(stable_peer_id)} authenticated as {identity.principal_name}"
        )
        if clear_pairing_inbound:
            self._clear_pairing_direction(peer, "inbound")
        self._maybe_finish_peer_auth_timeout(peer)
        self._send_protocol_hello(peer)
        self._replay_pre_auth_protocol_hello(peer)
        await self._audit(
            "peer.authenticated",
            identity.principal_id,
            {
                "peer_id": peer,
                "stable_peer_id": stable_peer_id,
                "principal_name": identity.principal_name,
            },
        )

        if self._mesh_enabled and self._peer_registry:
            await self._peer_registry.register_peer(stable_peer_id, peer_name)
            manifest_sent = await self._send_manifest(stable_peer_id)
            # The first local approval can send a manifest while the other
            # endpoint is still anonymous. Requesting the remote manifest here
            # makes the later approval converge both sides immediately.
            if manifest_sent:
                self._request_manifest(stable_peer_id, reason="authentication")

    async def _retire_replaced_stable_session(
        self,
        *,
        stable_peer_id: str,
        replaced_session_peer_id: str,
        replacement_session_peer_id: str,
    ) -> None:
        """Retire an open signaling session after its successor proves identity.

        Signaling presence may disappear while a mobile native data channel is
        still healthy, so departure alone deliberately preserves that channel.
        Once another transport has cryptographically authenticated as the same
        stable peer, however, the preserved session is stale.  Removing it from
        ``_pcs`` before closing makes its delayed aiortc callback a no-op instead
        of allowing old-session cleanup to erase the authenticated replacement.
        Stable authority and saved credentials are intentionally preserved and
        refreshed by the caller on the successor session.
        """

        replaced_pc = self._pcs.get(replaced_session_peer_id)
        if replaced_pc is None:
            return

        log_info(
            "RTCClient: Replacing preserved session "
            f"{replaced_session_peer_id} for stable peer {stable_peer_id}"
        )
        self._reconnect_suppressed_pcs.add(replaced_pc)
        self._negotiation_retry_pcs.discard(replaced_pc)
        self._cancel_stale_stable_peer_session_tasks(
            stable_peer_id,
            replacement_session_peer_id,
        )
        self._cancel_negotiation_watchdog(replaced_session_peer_id, replaced_pc)
        self._offer_in_progress.discard(replaced_session_peer_id)
        self._resolve_peer_rpc_calls(replaced_session_peer_id)
        self._cancel_peer_rpc_work(replaced_session_peer_id)
        self._clear_pairing_state(replaced_session_peer_id, replaced_pc)
        self._discard_pending_ice_candidates(replaced_session_peer_id, replaced_pc)

        self._pcs.pop(replaced_session_peer_id, None)
        self._peer_acl.pop(replaced_session_peer_id, None)
        self._peer_tokens.pop(replaced_session_peer_id, None)
        self._rpc_handlers.pop(replaced_session_peer_id, None)
        self._peer_send_fns.pop(replaced_session_peer_id, None)
        self._peer_data_channels.pop(replaced_session_peer_id, None)
        self._cleanup_peer_protocol_state(replaced_session_peer_id, stable_peer_id)
        self._cancel_provider_lease_task(
            stable_peer_id,
            session_peer_id=replaced_session_peer_id,
        )
        self._peer_names.pop(replaced_session_peer_id, None)
        self._peer_claimed_stable_ids.pop(replaced_session_peer_id, None)
        self._peer_claimed_names.pop(replaced_session_peer_id, None)
        self._peer_auth_challenges.pop(replaced_session_peer_id, None)
        self._peer_stable_ids.pop(replaced_session_peer_id, None)

        try:
            with contextlib.suppress(Exception):
                await self._close_peer_connection(replaced_pc)
        finally:
            self._reconnect_suppressed_pcs.discard(replaced_pc)

    async def _handle_reconnect_proof(
        self,
        peer: str,
        pc: RTCPeerConnection,
        chan: Any,
        message: dict[str, Any],
    ) -> None:
        """Validate a one-time proof through Auth and promote the stable identity."""
        if self._pcs.get(peer) is not pc:
            raise PairingProtocolError(
                "Reconnect proof does not match the active challenge connection"
            )
        now_ms = self._provider_lease_clock_ms()
        self._cleanup_reconnect_challenge_cache(now_ms)
        challenge = str(message.get("challenge") or "")
        if self._used_peer_auth_challenges.get(challenge, 0) > now_ms:
            raise PairingProtocolError("Reconnect proof replayed an already used challenge")
        challenge_entry = self._peer_auth_challenges.get(peer)
        remote_stable_peer_id, remote_node_name = self._transport_identity_for_peer(peer, pc)
        channel_binding = self._channel_binding_for_peer(peer, pc)
        if challenge_entry is None or not self._reconnect_record_matches(
            record=challenge_entry,
            pc=pc,
            message=message,
        ):
            raise PairingProtocolError("Reconnect proof does not match the active challenge")
        if channel_binding != challenge_entry.channel_binding:
            raise PairingProtocolError("Reconnect proof does not match the active transport")
        if challenge_entry.expires_at_ms <= now_ms:
            self._peer_auth_challenges.pop(peer, None)
            raise PairingProtocolError("Reconnect proof challenge expired")
        if self._reconnect_authority_rejects(remote_stable_peer_id):
            self._peer_auth_challenges.pop(peer, None)
            raise PairingProtocolError("Reconnect proof authority is not trusted")

        self._peer_auth_challenges.pop(peer, None)
        self._used_peer_auth_challenges[challenge_entry.challenge] = challenge_entry.expires_at_ms
        try:
            token = await self._auth_service.verify_mesh_reconnect_proof(
                token_id=str(message.get("token_id") or ""),
                challenge=challenge_entry.challenge,
                proof=str(message.get("proof") or ""),
                channel_binding=channel_binding,
                claimant_peer_id=remote_stable_peer_id,
                verifier_peer_id=self._local_mesh_peer_id(),
                room_name=str(self._settings.webrtc.room),
            )
        except Exception:
            if self._pcs.get(peer) is not pc:
                return
            self._record_diagnostic_error(
                "reconnect_auth_unavailable",
                "Reconnect credential verification was unavailable",
                peer,
            )
            # An Auth outage is not a credential rejection. Keep the peer
            # anonymous, let the bounded auth watchdog close this exact PC,
            # and make that close eligible for deterministic reconnect.
            self._negotiation_retry_pcs.add(pc)
            return

        # Auth may wait on another service for longer than the initial peer
        # watchdog. A connection can be closed or replaced during that await;
        # its result must never mutate the replacement session.
        if self._pcs.get(peer) is not pc:
            return

        if token is None:
            log_warning(f"Peer {peer[:8]}… failed reconnect proof verification")
            self._record_diagnostic_error(
                "reconnect_auth_failed",
                "Peer failed reconnect proof verification",
                peer,
            )
            self._start_bilateral_pairing(
                peer,
                chan,
                pc,
                reason="saved credential proof was rejected",
            )
            return

        await self._authenticate_peer(
            peer=peer,
            token=token,
            stable_peer_id=remote_stable_peer_id,
            peer_name=remote_node_name,
            clear_pairing_inbound=False,
        )

    def _pairing_handshake_for(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> PairingSASHandshake:
        existing = self._pairing_handshakes.get(peer)
        if existing is not None:
            if existing[0] is pc:
                return existing[1]
            self._clear_pairing_state(peer)

        transport = self._pairing_transports.get(peer)
        if transport is None or transport.get("pc") is not pc:
            raise PairingProtocolError("Pairing transport does not match the active connection")

        offerer_id = str(transport.get("offerer_signaling_id") or "")
        answerer_id = str(transport.get("answerer_signaling_id") or "")
        if self._peer_id == offerer_id:
            local_role = "offerer"
            remote_role = "answerer"
        elif self._peer_id == answerer_id:
            local_role = "answerer"
            remote_role = "offerer"
        else:
            raise PairingProtocolError("Local signaling identity is absent from the transcript")

        remote_stable_peer_id = str(transport.get("remote_stable_peer_id") or "")
        if not remote_stable_peer_id:
            raise PairingProtocolError("Remote stable mesh identity is unavailable")
        remote_node_name = str(transport.get("remote_node_name") or "")

        channel_binding = self._channel_binding_for_peer(peer, pc)
        handshake = PairingSASHandshake(
            channel_binding_sha256=channel_binding,
            local_identity=pairing_identity(
                role=local_role,
                stable_peer_id=self._local_mesh_peer_id(),
                node_name=self._local_mesh_node_name(),
                signaling_peer_id=self._peer_id,
            ),
            expected_remote_identity=pairing_identity(
                role=remote_role,
                stable_peer_id=remote_stable_peer_id,
                node_name=remote_node_name,
                signaling_peer_id=peer,
            ),
        )
        future: asyncio.Future[PairingSAS] = asyncio.get_running_loop().create_future()
        self._pairing_handshakes[peer] = (pc, handshake)
        self._pairing_result_futures[peer] = (pc, future)
        return handshake

    def _send_pairing_commit(
        self,
        peer: str,
        pc: RTCPeerConnection,
        chan: Any,
    ) -> PairingSASHandshake:
        handshake = self._pairing_handshake_for(peer, pc)
        if peer not in self._pairing_commits_sent:
            self._send_channel_text(chan, json.dumps(handshake.commit_message()))
            self._pairing_commits_sent.add(peer)
            log_debug(f"Pairing v2 commitment sent to peer {peer[:8]}…")
        return handshake

    def _send_pairing_terminal(
        self,
        peer: str,
        chan: Any,
        *,
        status: str,
    ) -> None:
        """Notify the opposite direction that this approval session ended."""
        pairing = self._pairing_results.get(peer)
        if pairing is None:
            return
        self._send_channel_text(
            chan,
            json.dumps(
                {
                    "type": PAIRING_TERMINAL_TYPE,
                    "status": status,
                    "pairing_session_id": pairing.pairing_session_id,
                    "verification_code": pairing.verification_code,
                    "peer_id": self._local_mesh_peer_id(),
                    "signaling_peer_id": self._peer_id,
                }
            ),
        )

    def _handle_pairing_control_message(
        self,
        peer: str,
        pc: RTCPeerConnection,
        chan: Any,
        message: dict[str, Any],
    ) -> bool:
        """Consume commit/reveal messages before the anonymous RPC auth gate."""
        message_type = message.get("type")
        if message_type not in {
            PAIRING_COMMIT_TYPE,
            PAIRING_REVEAL_TYPE,
            PAIRING_TERMINAL_TYPE,
        }:
            return False

        try:
            if message_type == PAIRING_TERMINAL_TYPE:
                pairing = self._pairing_results.get(peer)
                status = str(message.get("status") or "")
                identity_matches = (
                    pairing is not None
                    and message.get("pairing_session_id") == pairing.pairing_session_id
                    and message.get("verification_code") == pairing.verification_code
                    and message.get("peer_id") == pairing.remote_stable_peer_id
                    and message.get("signaling_peer_id") == peer
                )
                if not identity_matches or status not in {
                    "denied",
                    "expired",
                    "superseded",
                    "failed",
                }:
                    raise PairingProtocolError("Invalid pairing terminal notification")
                self._clear_pairing_direction(peer, "inbound")
                if status == "denied":
                    self._reconnect_suppressed_pcs.add(pc)
                else:
                    self._negotiation_retry_pcs.add(pc)
                asyncio.create_task(self._close_peer_connection(pc))
                return True

            handshake = self._send_pairing_commit(peer, pc, chan)
            if message_type == PAIRING_COMMIT_TYPE:
                handshake.accept_commit(message)
                if not handshake.reveal_sent:
                    self._send_channel_text(chan, json.dumps(handshake.reveal_message()))
                    log_debug(f"Pairing v2 nonce reveal sent to peer {peer[:8]}…")
                if self._require_auth:
                    self._start_bilateral_pairing(
                        peer,
                        chan,
                        pc,
                        reason="remote endpoint requested the missing trust direction",
                    )
                return True

            result = handshake.accept_reveal(message)
            self._pairing_results[peer] = result
            future_entry = self._pairing_result_futures.get(peer)
            if future_entry is not None and future_entry[0] is pc and not future_entry[1].done():
                future_entry[1].set_result(result)
            log_info(
                f"Pairing v2 verification ready with peer {peer[:8]}… "
                f"(session={result.pairing_session_id[:12]}…)"
            )
        except PairingProtocolError as exc:
            self._record_diagnostic_error(
                "pairing_protocol_error",
                str(exc),
                peer,
            )
            log_warning(f"Pairing v2 protocol error with peer {peer[:8]}…: {exc}")
            asyncio.create_task(self._abort_pairing_protocol(peer, pc))
        return True

    async def _abort_pairing_protocol(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> None:
        if self._pcs.get(peer) is pc:
            self._reconnect_suppressed_pcs.add(pc)
            await self._close_peer_connection(pc)

    def _start_bilateral_pairing(
        self,
        peer: str,
        chan: Any,
        pc: RTCPeerConnection,
        *,
        reason: str,
    ) -> asyncio.Task[None]:
        """Start exactly one symmetric pairing task for an active transport.

        A peer that still has a valid credential may receive a commit from the
        other endpoint when only the reverse trust direction is missing. It
        must join that transcript too; otherwise only one Aurora receives a
        pending approval. The same helper lets a rejected legacy reconnect
        token fall back to a fresh SAS instead of closing into a retry loop.
        """
        existing = self._pairing_tasks.get(peer)
        if existing is not None and not existing.done():
            return existing

        log_info(f"Starting bilateral pairing with peer {peer[:8]}… ({reason})")
        task = asyncio.create_task(self._run_bilateral_pairing(peer, chan, pc))
        self._pairing_tasks[peer] = task
        return task

    async def _run_bilateral_pairing(
        self,
        peer: str,
        chan: Any,
        pc: RTCPeerConnection,
    ) -> None:
        """Derive one shared SAS, then create both directional requests in parallel."""
        current_task = asyncio.current_task()
        self._mark_pairing_direction(peer, "outbound")
        try:
            self._send_pairing_commit(peer, pc, chan)
            future_entry = self._pairing_result_futures.get(peer)
            if future_entry is None or future_entry[0] is not pc:
                raise PairingProtocolError("Pairing verification future is unavailable")
            await asyncio.wait_for(
                asyncio.shield(future_entry[1]),
                timeout=self._pairing_handshake_timeout,
            )
            await self._initiate_pairing(peer, chan, pc)
        except TimeoutError:
            self._record_diagnostic_error(
                "pairing_verification_timeout",
                "Timed out deriving the shared pairing verification code",
                peer,
            )
            log_warning(f"Pairing v2 verification timed out with peer {peer[:8]}…")
            if self._pcs.get(peer) is pc:
                self._negotiation_retry_pcs.add(pc)
                await self._close_peer_connection(pc)
        except PairingProtocolError as exc:
            self._record_diagnostic_error("pairing_protocol_error", str(exc), peer)
            log_warning(f"Pairing v2 aborted with peer {peer[:8]}…: {exc}")
            if self._pcs.get(peer) is pc:
                self._reconnect_suppressed_pcs.add(pc)
                await self._close_peer_connection(pc)
        except _PairingDeniedError:
            log_info(f"Bilateral pairing was denied by peer {peer[:8]}…")
            if self._pcs.get(peer) is pc:
                self._reconnect_suppressed_pcs.add(pc)
                await self._close_peer_connection(pc)
        except _PairingRetryRequiredError as exc:
            self._record_diagnostic_error("pairing_session_restart", str(exc), peer)
            log_info(f"Restarting bilateral pairing with peer {peer[:8]}…: {exc}")
            if self._pcs.get(peer) is pc:
                self._negotiation_retry_pcs.add(pc)
                await self._close_peer_connection(pc)
        except asyncio.CancelledError:
            log_debug(f"Pairing task cancelled for peer {peer}")
            raise
        except Exception as exc:
            self._record_diagnostic_error("pairing_flow_failed", "Pairing flow failed", peer)
            log_error(f"Pairing flow failed for peer {peer}: {exc}")
            if self._pcs.get(peer) is pc:
                self._negotiation_retry_pcs.add(pc)
                await self._close_peer_connection(pc)
        finally:
            self._clear_pairing_direction(peer, "outbound")
            if self._pairing_tasks.get(peer) is current_task:
                self._pairing_tasks.pop(peer, None)

    async def _initiate_pairing(
        self,
        peer: str,
        chan: Any,
        pc: RTCPeerConnection | None = None,
    ) -> None:
        """Request this node's credential on the remote endpoint.

        Both endpoints run this method concurrently after deriving the same
        commit/reveal transcript. The short verification code is never used as
        a bearer credential; status and exchange use the separate opaque handle.
        """
        pairing = self._pairing_results.get(peer)
        if pairing is None:
            raise PairingProtocolError("Shared pairing verification is not ready")

        device_name = self._local_mesh_node_name()
        start_payload = {
            "device_name": device_name,
            "remote_peer_id": self._local_mesh_peer_id(),
            "remote_node_name": device_name,
            "pairing_session_id": pairing.pairing_session_id,
            "verification_code": pairing.verification_code,
        }

        result: dict[str, Any] | None = None
        while peer in self._pcs and self._pairing_direction_active(peer, "outbound"):
            result = await self._rpc_call(peer, AuthMethods.PAIRING_START, start_payload)
            if result:
                break
            await asyncio.sleep(self._pairing_retry_delay)

        if result and result.get("status") == "denied":
            self._send_pairing_terminal(peer, chan, status="denied")
            raise _PairingDeniedError
        if not result or result.get("error") or not result.get("code"):
            self._record_diagnostic_error("pairing_start_failed", "Pairing initiation failed", peer)
            log_warning(f"Pairing initiation failed for peer {peer}: {result}")
            raise _PairingRetryRequiredError("remote pairing request could not be created")
        if (
            result.get("pairing_session_id") != pairing.pairing_session_id
            or result.get("verification_code") != pairing.verification_code
        ):
            raise PairingProtocolError("Remote PairingStart response does not match the SAS")
        if result.get("status") == "already_trusted":
            log_info(
                f"Peer {peer[:8]}… retained this node's existing credential; "
                "skipping duplicate credential exchange"
            )
            return

        pairing_handle = str(result["code"])
        if pairing_handle == pairing.verification_code:
            raise PairingProtocolError("Remote reused the display code as a pairing credential")
        log_info(
            f"Bilateral pairing request created on peer {peer[:8]}…; "
            "waiting for independent approval"
        )

        poll_interval = 3.0
        while peer in self._pcs and self._pairing_direction_active(peer, "outbound"):
            await asyncio.sleep(poll_interval)
            if peer not in self._pcs:
                return
            poll_result = await self._rpc_call(
                peer,
                AuthMethods.PAIRING_CONNECT,
                {
                    "code": pairing_handle,
                    "pairing_session_id": pairing.pairing_session_id,
                },
            )
            if not poll_result:
                continue
            if poll_result.get("error"):
                self._send_pairing_terminal(peer, chan, status="expired")
                raise _PairingRetryRequiredError("remote pairing request expired or was superseded")
            if poll_result.get("pairing_session_id") != pairing.pairing_session_id:
                raise PairingProtocolError("Remote pairing status belongs to another session")
            if poll_result.get("verification_code") != pairing.verification_code:
                raise PairingProtocolError("Remote pairing status changed the verification code")

            status = str(poll_result.get("status") or "")
            if status == "already_trusted":
                log_info(
                    f"Peer {peer[:8]}… retained this node's existing credential; "
                    "skipping duplicate credential exchange"
                )
                return
            if status == "approved":
                log_info(f"Pairing approved by peer {peer[:8]}… — exchanging credential")
                break
            if status == "pending":
                continue
            if status == "denied":
                self._send_pairing_terminal(peer, chan, status="denied")
                raise _PairingDeniedError
            if status in {"expired", "superseded"}:
                self._send_pairing_terminal(peer, chan, status=status)
                raise _PairingRetryRequiredError(f"remote pairing request became {status}")
            raise PairingProtocolError(f"Unexpected remote pairing status {status!r}")
        else:
            return

        exchange_result: dict[str, Any] | None = None
        while peer in self._pcs and self._pairing_direction_active(peer, "outbound"):
            exchange_result = await self._rpc_call(
                peer,
                AuthMethods.PAIRING_EXCHANGE,
                {
                    "code": pairing_handle,
                    "pairing_session_id": pairing.pairing_session_id,
                },
            )
            if exchange_result and exchange_result.get("error"):
                self._send_pairing_terminal(peer, chan, status="expired")
                raise _PairingRetryRequiredError(
                    "approved pairing exchange expired or was superseded"
                )
            if exchange_result and exchange_result.get("token"):
                break
            await asyncio.sleep(self._pairing_retry_delay)

        if not exchange_result or not exchange_result.get("token"):
            self._record_diagnostic_error(
                "pairing_exchange_failed",
                "Credential exchange failed",
                peer,
            )
            log_warning(f"Credential exchange failed for peer {peer[:8]}…")
            return

        claimed_remote_id = str(exchange_result.get("peer_id") or "")
        if claimed_remote_id and claimed_remote_id != pairing.remote_stable_peer_id:
            raise PairingProtocolError("Credential issuer identity does not match the SAS")
        claimed_remote_name = str(exchange_result.get("node_name") or "")
        if (
            claimed_remote_name
            and pairing.remote_node_name
            and claimed_remote_name != pairing.remote_node_name
        ):
            raise PairingProtocolError("Credential issuer node name does not match the SAS")

        token = str(exchange_result["token"])
        token_id = str(exchange_result.get("token_id") or "")
        if not token_id:
            raise PairingProtocolError("Credential exchange omitted its reconnect token id")
        remote_device_id = exchange_result.get("device_id")
        remote_user_id = exchange_result.get("user_id")
        remote_stable_id = pairing.remote_stable_peer_id
        remote_node_name = pairing.remote_node_name or claimed_remote_name
        remote_perms = list(exchange_result.get("permissions") or [])

        # This token is our credential on the remote endpoint. It grants no
        # authority to the remote caller locally. Local ACL is established only
        # after validating the separately issued token received in `auth`.
        credential = {"token": token, "token_id": token_id}
        if self._on_token_saved:
            try:
                callback_result = self._on_token_saved(
                    token,
                    token_id=token_id,
                    remote_device_id=remote_device_id,
                    remote_user_id=remote_user_id,
                    remote_peer_id=remote_stable_id,
                    remote_node_name=remote_node_name,
                    permissions=remote_perms,
                )
                if asyncio.iscoroutine(callback_result) or asyncio.isfuture(callback_result):
                    await callback_result
            except Exception as exc:
                self._saved_auth_tokens.pop(remote_stable_id, None)
                self._record_diagnostic_error(
                    "pairing_credential_persistence_failed",
                    "Pairing credential could not be saved durably",
                    peer,
                )
                log_error(f"Failed to persist pairing token: {exc}")
                self._send_pairing_terminal(peer, chan, status="failed")
                raise _PairingRetryRequiredError(
                    "received credential could not be saved durably"
                ) from exc

        # Do not authenticate with a newly issued credential until it is durable.
        # Otherwise this transport can appear paired but will fail immediately on
        # restart, leaving the two trust directions out of sync.
        self._saved_auth_tokens[remote_stable_id] = credential
        auth_msg = {
            "type": "auth",
            "peer_name": self._local_mesh_node_name(),
            "peer_id": self._local_mesh_peer_id(),
            "signaling_peer_id": self._peer_id,
            "pairing_session_id": pairing.pairing_session_id,
            "token": token,
        }
        self._send_channel_text(chan, json.dumps(auth_msg))

        log_info(
            f"Outbound pairing credential received from peer {peer[:8]}…; "
            "awaiting the peer's independently approved credential"
        )

    async def _ensure_pc(self, peer: str, is_offer_initiator: bool = False) -> RTCPeerConnection:
        if peer in self._pcs:
            return self._pcs[peer]

        log_debug(f"Creating new RTCPeerConnection for {peer}")
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=self._ice_servers()))
        self._pcs[peer] = pc
        retry_after_pairing_timeout = False
        terminal_state_handled = False

        # Default to ANONYMOUS until authenticated
        self._peer_acl.setdefault(peer, ANONYMOUS)

        # WebRTC has one negotiated RPC channel. The SDP offerer creates it;
        # the answerer accepts that exact remote channel. Creating one on both
        # ends produces two independent channels and duplicate pairing flows.
        channel = pc.createDataChannel("aurora-rpc") if is_offer_initiator else None

        def send_fn(text: str) -> None:
            protocol = self._peer_protocols.get(peer)
            if protocol and (
                protocol.supports(CAP_FRAGMENTATION_V1) or protocol.supports(CAP_BACKPRESSURE_V1)
            ):
                self._schedule_rpc_send(peer, text)
                return

            # Preserve the legacy/pre-negotiation synchronous send contract.
            # Once capabilities are negotiated, every RPC frame takes the
            # ordered async path so small frames cannot overtake fragments.
            active_channel = self._peer_data_channels.get(peer)
            if active_channel is None or not self._send_channel_text(active_channel, text):
                raise RuntimeError("canonical DataChannel is unavailable")

        # Store the send function for mesh P2P outbound messaging
        self._peer_send_fns[peer] = send_fn

        async def _rpc_audit(
            event: str, pid: str | None = None, details: dict | None = None
        ) -> None:
            await self._audit(event, pid, details)

        handler = RPCHandler(
            self._bus,
            self._registry,
            send_fn,
            lambda: self._peer_acl.get(peer, ANONYMOUS),
            audit_fn=_rpc_audit,
            mesh_config=self._mesh_config,
            peer_id=peer,
            stable_peer_id_provider=lambda peer=peer: self._peer_stable_ids.get(peer),
            capacity_notify_fn=lambda module, available, max_conc: (
                (self.broadcast_capacity_update(module, available, max_conc))
                if self._mesh_enabled
                else None
            ),
            pairing_notify_fn=lambda pid: self._mark_pairing_direction(peer, "inbound"),
            pairing_denied_fn=lambda pid: self._suppress_durably_denied_pairing(peer, pc),
            pairing_context_provider=lambda: self._pairing_context_for_peer(peer),
            policy_provider=self._mesh_policy_provider,
            active_projection_provider=lambda peer=peer: self._active_projection_for_session(peer),
            authenticated_peer_validator=lambda peer=peer: self._has_authenticated_stable_peer(
                self._peer_stable_ids.get(peer) or ""
            ),
            tooling_authority_revision_provider=lambda peer=peer: (
                self._provider_tooling_authority_revisions(peer)
            ),
            event_subscription_registry=self._event_subscriptions,
            peer_supports_capability=lambda capability, peer=peer: self.peer_supports_capability(
                peer, capability
            ),
            local_peer_role_provider=lambda: "hybrid",
            event_topic_authorizer=self._event_topic_authorizer,
            provider_readiness_provider=lambda service_id, peer=peer: (
                self._is_local_provider_ready_for_session(peer, service_id)
            ),
            provider_binding_state_provider=lambda peer=peer: (
                self._local_provider_binding_state_for_session(peer)
            ),
        )
        self._rpc_handlers[peer] = handler

        def setup_channel(chan: Any, is_initiator: bool = False) -> None:
            channel_close_handled = False
            existing_channel = self._peer_data_channels.get(peer)
            if existing_channel is not None:
                if existing_channel is not chan:
                    log_warning(
                        f"Rejecting duplicate DataChannel '{chan.label}' from peer {peer[:8]}…"
                    )
                    with contextlib.suppress(Exception):
                        chan.close()
                return

            # Store one canonical channel for both RPC and bilateral pairing.
            self._peer_data_channels[peer] = chan

            @chan.on("close")
            async def on_close() -> None:
                nonlocal channel_close_handled

                if channel_close_handled:
                    return
                channel_close_handled = True
                if self._peer_data_channels.get(peer) is not chan or self._pcs.get(peer) is not pc:
                    return
                log_info(
                    f"DataChannel '{chan.label}' closed with peer {peer}; "
                    "closing its peer connection"
                )
                if (
                    getattr(pc, "connectionState", None) not in ("failed", "closed")
                    and getattr(pc, "signalingState", None) != "closed"
                ):
                    # A DataChannel close is an explicit end to this signaling
                    # session. A genuinely returning peer will announce fresh
                    # presence; blindly reconnecting the old ephemeral session
                    # strands offers after browser refresh/navigation.
                    self._reconnect_suppressed_pcs.add(pc)
                    await self._close_peer_connection(pc)

            @chan.on("open")
            def on_open() -> None:
                if peer in self._pairing_bootstrapped:
                    log_debug(f"Ignoring duplicate DataChannel open event for peer {peer[:8]}…")
                    return
                self._pairing_bootstrapped.add(peer)
                self._cancel_negotiation_watchdog(peer, pc)
                log_info(f"DataChannel '{chan.label}' open with peer {peer}")

                # Audit: peer connected
                asyncio.create_task(self._audit("peer.connected", details={"peer_id": peer}))

                if self._require_auth:
                    # Challenge every peer.  A returning peer answers with an
                    # HMAC over this exact SDP-bound connection; a new/stale
                    # peer falls back to bilateral SAS pairing after receiving
                    # the opposite challenge.  Saved bearer tokens never cross
                    # an unauthenticated channel.
                    try:
                        self._send_reconnect_challenge(peer, pc, chan)
                    except PairingProtocolError as exc:
                        self._record_diagnostic_error(
                            "reconnect_challenge_failed",
                            str(exc),
                            peer,
                        )
                        asyncio.create_task(self._abort_pairing_protocol(peer, pc))

                    # Auth timeout with heartbeat-style pairing extension (Fix 5)
                    async def _auth_timeout_check() -> None:
                        nonlocal retry_after_pairing_timeout
                        current_task = asyncio.current_task()
                        try:
                            await self._auth_timeout_sleep(self._auth_timeout)
                            if self._pcs.get(peer) is not pc:
                                return  # Already disconnected

                            # Auth reconnect verification crosses the message
                            # bus and database and can outlive the short initial
                            # anonymous-peer window. Keep this exact transport
                            # alive while its owned validation is making bounded
                            # progress, but never extend a replacement PC.
                            elapsed = self._auth_timeout
                            proof_entry = self._reconnect_proof_tasks.get(peer)
                            while (
                                proof_entry is not None
                                and proof_entry[0] is pc
                                and not proof_entry[1].done()
                                and self._pcs.get(peer) is pc
                                and elapsed < self._pairing_timeout
                            ):
                                remaining = self._pairing_timeout - elapsed
                                heartbeat_interval = min(10.0, max(0.1, remaining))
                                log_debug(
                                    f"Peer {peer[:8]}… reconnect verification heartbeat "
                                    f"({elapsed:.0f}s / {self._pairing_timeout}s)"
                                )
                                await self._auth_timeout_sleep(heartbeat_interval)
                                elapsed += heartbeat_interval
                                proof_entry = self._reconnect_proof_tasks.get(peer)

                            if self._pcs.get(peer) is not pc:
                                return

                            if peer in self._peer_pairing_active:
                                # A valid inbound credential is only half of a
                                # bilateral pairing.  Continue bounding the
                                # still-pending outbound direction even after
                                # the remote caller becomes authenticated.
                                elapsed = self._auth_timeout
                                while (
                                    self._pcs.get(peer) is pc
                                    and peer in self._peer_pairing_active
                                    and elapsed < self._pairing_timeout
                                ):
                                    remaining = self._pairing_timeout - elapsed
                                    heartbeat_interval = min(10.0, max(0.1, remaining))
                                    log_debug(
                                        f"Peer {peer[:8]}… pairing heartbeat "
                                        f"({elapsed:.0f}s / {self._pairing_timeout}s)"
                                    )
                                    await self._auth_timeout_sleep(heartbeat_interval)
                                    elapsed += heartbeat_interval

                                if self._pcs.get(peer) is not pc:
                                    return
                                if peer not in self._peer_pairing_active:
                                    if self._peer_acl.get(peer, ANONYMOUS) != ANONYMOUS:
                                        return
                                    # The pairing task ended without authenticating
                                    # the caller; fall through to the auth timeout.
                                else:
                                    log_warning(
                                        f"Peer {peer[:8]}… bilateral pairing timeout expired "
                                        f"({self._pairing_timeout}s) — reconnecting"
                                    )
                                    self._record_diagnostic_error(
                                        "pairing_timeout",
                                        "Bilateral pairing timeout expired",
                                        peer,
                                    )
                                    await self._audit(
                                        "peer.pairing_timeout", details={"peer_id": peer}
                                    )
                                    retry_after_pairing_timeout = True
                                    if self._peer_timeout_tasks.get(peer) is current_task:
                                        self._peer_timeout_tasks.pop(peer, None)
                                    await self._close_peer_connection(pc)
                                    return

                            if self._peer_acl.get(peer, ANONYMOUS) != ANONYMOUS:
                                return
                            log_warning(
                                f"Peer {peer} did not authenticate within "
                                f"{self._auth_timeout}s — disconnecting"
                            )
                            self._record_diagnostic_error(
                                "auth_timeout",
                                "Peer did not authenticate within timeout",
                                peer,
                            )
                            await self._audit("peer.auth_timeout", details={"peer_id": peer})
                            if self._peer_timeout_tasks.get(peer) is current_task:
                                self._peer_timeout_tasks.pop(peer, None)
                            self._negotiation_retry_pcs.add(pc)
                            await self._close_peer_connection(pc)
                        finally:
                            if self._peer_timeout_tasks.get(peer) is current_task:
                                self._peer_timeout_tasks.pop(peer, None)

                    previous_timeout_task = self._peer_timeout_tasks.pop(peer, None)
                    if previous_timeout_task:
                        previous_timeout_task.cancel()
                    self._peer_timeout_tasks[peer] = asyncio.create_task(_auth_timeout_check())

                else:
                    # Auth disabled — grant open access immediately
                    self._peer_acl[peer] = OPEN_PEER
                    log_info(f"Peer {peer} granted open access (auth disabled)")
                    self._send_protocol_hello(peer)

                    # Mesh: Auto-register and exchange manifests
                    if self._mesh_enabled and self._peer_registry:
                        stable_peer_id = self._stable_peer_id_for_session(peer)
                        asyncio.create_task(self._peer_registry.register_peer(stable_peer_id, ""))
                        asyncio.create_task(self._send_manifest(stable_peer_id))

            @chan.on("message")
            def on_message(message: str | bytes | bytearray | memoryview) -> None:
                text = self._decode_datachannel_message(peer, message)
                if text is None:
                    return

                try:
                    obj = self._parse_datachannel_frame(peer, text)
                    if obj is None:
                        return
                    msg_type = obj.get("type")

                    # Intercept RPC responses for our outbound calls
                    # (e.g., pairing flow). Must run BEFORE the auth gate
                    # since our peer may still be ANONYMOUS during pairing.
                    if msg_type in ("result", "error"):
                        call_id = obj.get("id")
                        if call_id and call_id in self._pending_rpc:
                            if self._pending_rpc_peers.get(call_id) != peer:
                                self._record_diagnostic_error(
                                    "rpc_response_peer_mismatch",
                                    "Peer attempted to answer another peer's RPC call",
                                    peer,
                                )
                                return
                            future = self._pending_rpc.pop(call_id)
                            self._pending_rpc_peers.pop(call_id, None)
                            if not future.done():
                                if msg_type == "result":
                                    future.set_result(obj.get("result"))
                                else:
                                    future.set_result(None)
                            return

                    if self._handle_pairing_control_message(peer, pc, chan, obj):
                        return

                    # Auth messages are always allowed
                    if msg_type in self._ANON_ALLOWED_TYPES:
                        if msg_type == _MESH_AUTH_CHALLENGE_TYPE:
                            try:
                                self._handle_reconnect_challenge(peer, pc, chan, obj)
                            except PairingProtocolError as exc:
                                self._record_diagnostic_error(
                                    "reconnect_challenge_mismatch",
                                    str(exc),
                                    peer,
                                )
                                asyncio.create_task(self._abort_pairing_protocol(peer, pc))
                        elif msg_type == _MESH_AUTH_PROOF_TYPE:
                            existing_proof = self._reconnect_proof_tasks.get(peer)
                            if (
                                existing_proof is not None
                                and existing_proof[0] is pc
                                and not existing_proof[1].done()
                            ):
                                log_debug(
                                    f"Ignoring duplicate reconnect proof from peer {peer[:8]}…"
                                )
                                return

                            async def validate_reconnect_proof() -> None:
                                try:
                                    await self._handle_reconnect_proof(peer, pc, chan, obj)
                                except PairingProtocolError as exc:
                                    if self._pcs.get(peer) is not pc:
                                        return
                                    self._record_diagnostic_error(
                                        "reconnect_proof_mismatch",
                                        str(exc),
                                        peer,
                                    )
                                    await self._abort_pairing_protocol(peer, pc)

                            proof_task = asyncio.create_task(
                                validate_reconnect_proof(),
                                name=f"reconnect-proof:{peer}",
                            )
                            self._track_reconnect_proof_task(peer, pc, proof_task)
                        elif msg_type == "auth":
                            token_str = obj.get("token")
                            if not token_str:
                                log_warning(f"Peer {peer} sent auth without token")
                                return

                            pairing_result = self._pairing_results.get(peer)
                            is_fresh_pairing_auth = bool(obj.get("pairing_session_id"))
                            if self._mesh_enabled and not is_fresh_pairing_auth:
                                # Mesh reconnects must use the one-time proof.
                                # Accepting a raw legacy bearer here would keep
                                # superseded tokens useful after peer rotation.
                                self._record_diagnostic_error(
                                    "legacy_mesh_auth_rejected",
                                    "Raw bearer reconnect is disabled for mesh peers",
                                    peer,
                                )
                                return
                            if is_fresh_pairing_auth:
                                identity_matches = (
                                    pairing_result is not None
                                    and obj.get("pairing_session_id")
                                    == pairing_result.pairing_session_id
                                    and obj.get("peer_id") == pairing_result.remote_stable_peer_id
                                    and (
                                        not pairing_result.remote_node_name
                                        or obj.get("peer_name") == pairing_result.remote_node_name
                                    )
                                    and obj.get("signaling_peer_id") == peer
                                )
                                if not identity_matches:
                                    self._record_diagnostic_error(
                                        "pairing_auth_identity_mismatch",
                                        "Authenticated identity does not match the pairing transcript",
                                        peer,
                                    )
                                    log_warning(
                                        f"Peer {peer[:8]}… sent auth for a different "
                                        "pairing transcript or identity"
                                    )
                                    asyncio.create_task(self._abort_pairing_protocol(peer, pc))
                                    return

                            # DB-token auth (for paired devices / API tokens)
                            # Token must have been obtained via the pairing flow
                            # (Auth.PairingStart → approve → PairingExchange)
                            # or via Auth.Login.
                            async def validate_peer() -> None:
                                try:
                                    if is_fresh_pairing_auth:
                                        token = (
                                            await self._auth_service.validate_mesh_pairing_token(
                                                token_str=token_str,
                                                pairing_session_id=str(obj["pairing_session_id"]),
                                                claimant_peer_id=str(obj["peer_id"]),
                                                room_name=str(self._settings.webrtc.room),
                                            )
                                        )
                                    else:
                                        token = await self._auth_service.authenticate_token(
                                            token_str
                                        )
                                except Exception:
                                    if self._pcs.get(peer) is not pc:
                                        return
                                    self._record_diagnostic_error(
                                        "auth_service_unavailable",
                                        "Peer credential verification was unavailable",
                                        peer,
                                    )
                                    return
                                if self._pcs.get(peer) is not pc:
                                    return
                                if token:
                                    # A fresh v2 session uses only the identity
                                    # committed into the shared SAS. Returning
                                    # legacy credentials retain the existing
                                    # payload/presence compatibility path.
                                    peer_name = (
                                        pairing_result.remote_node_name
                                        if pairing_result is not None
                                        else obj.get("peer_name", "")
                                    )
                                    claimed_stable_peer_id = (
                                        pairing_result.remote_stable_peer_id
                                        if pairing_result is not None
                                        else peer
                                    )
                                    try:
                                        await self._authenticate_peer(
                                            peer=peer,
                                            token=token,
                                            stable_peer_id=str(claimed_stable_peer_id),
                                            peer_name=str(peer_name),
                                            clear_pairing_inbound=is_fresh_pairing_auth,
                                        )
                                    except PairingProtocolError as exc:
                                        self._record_diagnostic_error(
                                            "pairing_auth_identity_mismatch",
                                            str(exc),
                                            peer,
                                        )
                                        await self._abort_pairing_protocol(peer, pc)
                                else:
                                    log_warning(f"Peer {peer} failed token authentication")
                                    self._record_diagnostic_error(
                                        "auth_failed",
                                        "Peer failed token authentication",
                                        peer,
                                    )
                                    await self._audit(
                                        "peer.auth_failed",
                                        details={"peer_id": peer},
                                    )
                                    self._peer_acl[peer] = ANONYMOUS
                                    if not is_fresh_pairing_auth:
                                        # A stored reconnect credential can be
                                        # stale or revoked on only one side.
                                        # Repair both trust directions over a
                                        # fresh shared-SAS transcript instead
                                        # of closing into a reconnect loop.
                                        self._start_bilateral_pairing(
                                            peer,
                                            chan,
                                            pc,
                                            reason="saved credential was rejected",
                                        )
                                    else:
                                        # A credential minted inside the
                                        # current transcript must validate.
                                        # Replaying the approved exchange would
                                        # only return that same broken token.
                                        asyncio.create_task(self._abort_pairing_protocol(peer, pc))

                            asyncio.create_task(validate_peer())
                        elif msg_type == "reauth":
                            if self._mesh_enabled:
                                self._record_diagnostic_error(
                                    "legacy_mesh_reauth_rejected",
                                    "Raw bearer reauthentication is disabled for mesh peers",
                                    peer,
                                )
                                return
                            token_str = obj.get("token")
                            if not token_str:
                                return

                            async def reauth_peer() -> None:
                                await self._reauthenticate_legacy_peer(peer, token_str)

                            asyncio.create_task(reauth_peer())
                        return

                    # GATE: If auth is required, block non-auth messages from ANONYMOUS
                    # EXCEPT for RPC calls to auth/pairing endpoints (Enhancement C)
                    if self._require_auth:
                        identity = self._peer_acl.get(peer, ANONYMOUS)
                        if identity == ANONYMOUS:
                            if msg_type == "call":
                                method = obj.get("method", "")
                                if method.startswith(self._ANON_ALLOWED_RPC_PREFIXES):
                                    asyncio.create_task(handler.on_message(text))
                                    return
                            reconnect_proof = self._reconnect_proof_tasks.get(peer)
                            reconnect_proof_pending = bool(
                                reconnect_proof is not None
                                and reconnect_proof[0] is pc
                                and not reconnect_proof[1].done()
                            )
                            if self._mesh_enabled and (
                                peer in self._peer_pairing_active
                                or peer in self._peer_auth_challenges
                                or reconnect_proof_pending
                            ):
                                if msg_type == PROTOCOL_HELLO_TYPE:
                                    self._buffer_pre_auth_protocol_hello(peer, pc, obj)
                                    return
                                if msg_type in {"manifest", "manifest_request"}:
                                    log_debug(
                                        f"Peer {peer} sent expected early '{msg_type}' during "
                                        "bilateral authentication — dropping until authenticated"
                                    )
                                    return
                            log_warning(
                                f"Peer {peer} sent '{msg_type}' before authenticating — dropping"
                            )
                            self._record_diagnostic_error(
                                "preauth_message_dropped",
                                f"Peer sent {msg_type} before authenticating",
                                peer,
                            )
                            return

                    # Dispatch authenticated messages
                    if msg_type == PROTOCOL_HELLO_TYPE:
                        self._handle_protocol_hello(peer, obj)
                        return
                    if msg_type == FRAGMENT_FRAME_TYPE:
                        logical_text = self._handle_fragment_frame(peer, obj)
                        if logical_text is None:
                            return
                        logical_obj = self._parse_datachannel_frame(
                            peer,
                            logical_text,
                            diagnostic_code="fragment_reassembled_invalid",
                            parser_limits=self._logical_parser_limits(peer),
                        )
                        if logical_obj is None:
                            return
                        self._dispatch_authenticated_datachannel_message(
                            peer=peer, handler=handler, text=logical_text, obj=logical_obj
                        )
                        return
                    self._dispatch_authenticated_datachannel_message(
                        peer=peer, handler=handler, text=text, obj=obj
                    )
                except Exception as e:
                    self._record_diagnostic_error(
                        "message_handling_failed",
                        "Error handling DataChannel message",
                        peer,
                    )
                    log_error(f"Error handling message from {peer}: {e}")

            # aiortc can deliver the answerer's remote DataChannel after its
            # state has already advanced to ``open``. In that case the open
            # event cannot be observed by the callback registered above, so
            # bootstrap authentication explicitly after every handler exists.
            # The initiator registers its local channel before negotiation and
            # therefore still waits for the real open event.
            if not is_initiator and getattr(chan, "readyState", "") == "open":
                on_open()

        if channel is not None:
            setup_channel(channel, is_initiator=True)

        @pc.on("datachannel")
        def on_datachannel(chan: Any) -> None:
            log_debug(f"Received remote DataChannel '{chan.label}' from {peer}")
            if chan.label == "aurora-rpc":
                setup_channel(chan, is_initiator=False)

        @pc.on("icecandidate")
        async def on_icecandidate(event: Any) -> None:
            candidate = event.candidate
            if candidate is None or not self._adapter:
                return

            candidate_sdp = candidate.to_sdp()
            if not self._is_outbound_ice_candidate_allowed(candidate_sdp):
                return

            msg = {
                "type": "candidate",
                "app_id": self._settings.webrtc.app_id,
                "room": self._settings.webrtc.room,
                "from": self._peer_id,
                "to": peer,
                "candidate": candidate_sdp,
            }
            sealed = aead_seal(self._keys.k_sig, msg)
            await self._adapter.send("candidate", sealed, to_peer=peer)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            nonlocal terminal_state_handled

            log_debug(f"Connection state with {peer}: {pc.connectionState}")
            if pc.connectionState == "connected":
                self._cancel_negotiation_watchdog(peer, pc)
                return
            if pc.connectionState in ("failed", "closed"):
                # aiortc may report both failed and closed for the same transport.
                # Cleanup and reconnect must run once or the offer owner can send
                # duplicate offers for a single disconnect.
                if terminal_state_handled:
                    return
                terminal_state_handled = True

                # An early SDP failure may already have discarded this exact PC
                # and allowed a fresh offer to install its replacement. A delayed
                # close callback from the old transport must never pop that new PC.
                if self._pcs.get(peer) is not pc:
                    self._negotiation_retry_pcs.discard(pc)
                    self._reconnect_suppressed_pcs.discard(pc)
                    return

                pairing_was_active = peer in self._peer_pairing_active
                retry_requested = pc in self._negotiation_retry_pcs
                reconnect_suppressed = self._closing or pc in self._reconnect_suppressed_pcs
                self._cancel_negotiation_watchdog(peer, pc)
                self._offer_in_progress.discard(peer)
                self._negotiation_retry_pcs.discard(pc)
                self._reconnect_suppressed_pcs.discard(pc)
                stable_peer_id = self._stable_peer_id_for_session(peer)
                retry_stable_peer_id = self._claimed_stable_peer_id_for_session(peer)
                retry_node_name = self._peer_names.get(
                    stable_peer_id,
                    self._peer_claimed_names.get(peer, ""),
                )
                identity = self._peer_acl.get(peer, ANONYMOUS)
                was_authenticated = identity != ANONYMOUS
                await self._send_local_provider_unavailable(
                    stable_peer_id,
                    reason_code="peer_disconnected",
                    session_peer_id=peer,
                )
                # Cancel pending auth timeout task
                timeout_task = self._peer_timeout_tasks.pop(peer, None)
                if timeout_task and timeout_task is not asyncio.current_task():
                    timeout_task.cancel()
                # Cancel pending pairing task
                pairing_task = self._pairing_tasks.pop(peer, None)
                if pairing_task:
                    pairing_task.cancel()
                self._resolve_peer_rpc_calls(peer)
                self._cancel_peer_rpc_work(peer, stable_peer_id)
                self._clear_pairing_state(peer, pc)
                self._pcs.pop(peer, None)
                self._peer_acl.pop(peer, None)
                self._peer_acl.pop(stable_peer_id, None)
                self._peer_tokens.pop(peer, None)
                self._peer_tokens.pop(stable_peer_id, None)
                self._rpc_handlers.pop(peer, None)
                self._rpc_handlers.pop(stable_peer_id, None)
                self._peer_send_fns.pop(peer, None)
                self._peer_data_channels.pop(peer, None)
                self._discard_pending_ice_candidates(peer, pc)
                self._cleanup_peer_protocol_state(peer, stable_peer_id)
                self._cancel_provider_lease_task(stable_peer_id, session_peer_id=peer)
                self._peer_names.pop(peer, None)
                self._peer_names.pop(stable_peer_id, None)
                self._peer_claimed_stable_ids.pop(peer, None)
                self._peer_claimed_names.pop(peer, None)
                self._peer_auth_challenges.pop(peer, None)
                self._peer_stable_ids.pop(peer, None)
                self._stable_peer_sessions.pop(stable_peer_id, None)
                self._invalidate_provider_export_peer(
                    stable_peer_id,
                    notify_provider_unavailable=False,
                )
                # Remove from mesh peer registry
                if self._peer_registry:
                    await self._peer_registry.remove_peer(stable_peer_id)
                await self._audit(
                    "peer.disconnected",
                    identity.principal_id if identity != ANONYMOUS else None,
                    {
                        "peer_id": peer,
                        "stable_peer_id": stable_peer_id,
                        "reason": pc.connectionState,
                    },
                )
                should_retry = (
                    not reconnect_suppressed
                    and self._peer_id < peer
                    and (
                        was_authenticated
                        or retry_after_pairing_timeout
                        or retry_requested
                        or pairing_was_active
                        # An unauthenticated remote close can precede this
                        # endpoint's own timeout/retry marker. Unless an exact
                        # administrative/protocol/departure path suppressed the
                        # PC above, the deterministic offer owner must recover.
                        or identity == ANONYMOUS
                    )
                )
                if should_retry:
                    if retry_stable_peer_id != peer or retry_node_name:
                        self._remember_claimed_peer_identity(
                            peer,
                            retry_stable_peer_id,
                            retry_node_name,
                        )
                    retry_reason = (
                        "interrupted bilateral pairing"
                        if pairing_was_active or retry_after_pairing_timeout
                        else "unexpected authenticated transport loss"
                        if was_authenticated
                        else "transient negotiation or authentication failure"
                    )
                    self._schedule_peer_reconnect(peer, reason=retry_reason)

        return pc

    def _cancel_negotiation_watchdog(
        self,
        peer: str,
        pc: RTCPeerConnection | None = None,
    ) -> None:
        """Cancel the outbound-offer watchdog for ``peer`` and optionally ``pc``."""
        entry = self._negotiation_watchdogs.get(peer)
        if entry is None:
            return
        watched_pc, task = entry
        if pc is not None and watched_pc is not pc:
            return
        self._negotiation_watchdogs.pop(peer, None)
        if task is not asyncio.current_task() and not task.done():
            task.cancel()

    def _schedule_peer_reconnect(self, peer: str, *, reason: str) -> None:
        """Persistently retry the deterministic offer owner with bounded backoff."""
        if self._closing or not self._adapter or self._peer_id >= peer:
            return
        existing = self._peer_reconnect_tasks.get(peer)
        if existing is not None and not existing.done():
            return

        async def _retry() -> None:
            current_task = asyncio.current_task()
            delay = min(max(self._pairing_retry_delay, 0.0), 30.0)
            try:
                while not self._closing and self._adapter and peer not in self._pcs:
                    if delay:
                        await asyncio.sleep(delay)
                    if self._closing or not self._adapter or peer in self._pcs:
                        return
                    try:
                        log_info(f"RTCClient: Retrying connection to peer {peer} after {reason}")
                        await self.connect_to(peer)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        self._record_diagnostic_error(
                            "peer_reconnect_failed",
                            "Failed to reconnect to a known peer",
                            peer,
                        )
                        log_warning(f"RTCClient: Reconnect to peer {peer} failed: {exc}")
                        failed_pc = self._pcs.get(peer)
                        if failed_pc is not None:
                            self._negotiation_retry_pcs.add(failed_pc)
                            with contextlib.suppress(Exception):
                                await self._close_peer_connection(failed_pc)
                        delay = min(max(delay * 2, 1.0), 30.0)
                        continue

                    # A successful call is now bounded by its negotiation/auth
                    # watchdogs (or an already-running offer). If it fails
                    # later, terminal cleanup schedules the next attempt.
                    return
            finally:
                if self._peer_reconnect_tasks.get(peer) is current_task:
                    self._peer_reconnect_tasks.pop(peer, None)

        self._peer_reconnect_tasks[peer] = asyncio.create_task(_retry())

    def _start_negotiation_watchdog(self, peer: str, pc: RTCPeerConnection) -> None:
        """Close and retry an outbound offer that makes no signaling progress."""
        self._cancel_negotiation_watchdog(peer)

        async def _watch() -> None:
            try:
                await asyncio.sleep(self._offer_timeout)
            except asyncio.CancelledError:
                return

            entry = self._negotiation_watchdogs.get(peer)
            if entry is None or entry[0] is not pc or entry[1] is not asyncio.current_task():
                return

            if (
                self._closing
                or pc in self._reconnect_suppressed_pcs
                or self._pcs.get(peer) is not pc
            ):
                self._cancel_negotiation_watchdog(peer, pc)
                return

            channel = self._peer_data_channels.get(peer)
            if pc.connectionState == "connected" or getattr(channel, "readyState", "") == "open":
                self._cancel_negotiation_watchdog(peer, pc)
                return

            log_warning(
                f"RTCClient: Offer negotiation with peer {peer} made no progress "
                f"within {self._offer_timeout}s — reconnecting"
            )
            self._record_diagnostic_error(
                "negotiation_timeout",
                "Outbound WebRTC offer received no answer",
                peer,
            )
            with contextlib.suppress(Exception):
                await self._audit("peer.negotiation_timeout", details={"peer_id": peer})

            # The answer/open callbacks may have cancelled or replaced this
            # watchdog while the audit call yielded control.
            entry = self._negotiation_watchdogs.get(peer)
            if entry is None or entry[0] is not pc or entry[1] is not asyncio.current_task():
                return
            channel = self._peer_data_channels.get(peer)
            if (
                self._closing
                or pc in self._reconnect_suppressed_pcs
                or self._pcs.get(peer) is not pc
                or pc.connectionState == "connected"
                or getattr(channel, "readyState", "") == "open"
            ):
                self._cancel_negotiation_watchdog(peer, pc)
                return
            self._negotiation_watchdogs.pop(peer, None)

            # The terminal state callback owns cleanup and the deterministic
            # lower-ID retry. Mark this exact PC before closing it so the timeout
            # cannot be confused with an explicit local disconnect.
            self._negotiation_retry_pcs.add(pc)
            try:
                await self._close_peer_connection(pc)
            except Exception as exc:
                self._negotiation_retry_pcs.discard(pc)
                self._record_diagnostic_error(
                    "negotiation_close_failed",
                    "Failed to close stalled WebRTC negotiation",
                    peer,
                )
                log_warning(f"RTCClient: Failed to close stalled negotiation with {peer}: {exc}")

        task = asyncio.create_task(_watch())
        self._negotiation_watchdogs[peer] = (pc, task)

    def _is_outbound_ice_candidate_allowed(self, candidate_sdp: str) -> bool:
        """Return whether an ICE candidate may leave this signaling endpoint."""
        if self._outbound_ice_candidate_allowed is None:
            return True
        return bool(self._outbound_ice_candidate_allowed(candidate_sdp))

    def _filter_outbound_session_description(self, sdp: str) -> str:
        """Remove disallowed ICE candidate lines while preserving SDP formatting."""
        if self._outbound_ice_candidate_allowed is None:
            return sdp

        filtered_lines: list[str] = []
        for line in sdp.splitlines(keepends=True):
            candidate_line = line.rstrip("\r\n")
            if candidate_line.startswith(
                "a=candidate:"
            ) and not self._is_outbound_ice_candidate_allowed(candidate_line[2:]):
                continue
            filtered_lines.append(line)
        return "".join(filtered_lines)

    async def connect_to(self, peer: str) -> None:
        if not self._adapter or self._closing:
            return
        if peer in self._offer_in_progress:
            log_debug(f"RTCClient: Offer to peer {peer} is already in progress")
            return

        current_pc = self._pcs.get(peer)
        current_watchdog = self._negotiation_watchdogs.get(peer)
        if (
            current_pc is not None
            and current_watchdog is not None
            and current_watchdog[0] is current_pc
            and not current_watchdog[1].done()
        ):
            log_debug(f"RTCClient: Awaiting answer to existing offer for peer {peer}")
            return

        self._offer_in_progress.add(peer)
        pc: RTCPeerConnection | None = None
        try:
            pc = await self._ensure_pc(peer, is_offer_initiator=True)
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)

            if (
                self._closing
                or not self._adapter
                or self._pcs.get(peer) is not pc
                or pc in self._reconnect_suppressed_pcs
            ):
                return

            offer_sdp = self._filter_outbound_session_description(pc.localDescription.sdp)
            self._pairing_transports[peer] = {
                "pc": pc,
                "offerer_signaling_id": self._peer_id,
                "answerer_signaling_id": peer,
                "offer_sdp": offer_sdp,
                "answer_sdp": "",
                "remote_stable_peer_id": self._claimed_stable_peer_id_for_session(peer),
                "remote_node_name": self._peer_claimed_names.get(peer, ""),
            }
            msg = {
                "type": "offer",
                "app_id": self._settings.webrtc.app_id,
                "room": self._settings.webrtc.room,
                "from": self._peer_id,
                "to": peer,
                "sdp": offer_sdp,
                "stable_peer_id": self._local_mesh_peer_id(),
                "node_name": self._local_mesh_node_name(),
            }
            sealed = aead_seal(self._keys.k_sig, msg)
            await self._adapter.send("offer", sealed, to_peer=peer)

            if not self._closing and self._pcs.get(peer) is pc:
                self._start_negotiation_watchdog(peer, pc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._record_diagnostic_error(
                "negotiation_start_failed",
                "Failed to create or publish the initial WebRTC offer",
                peer,
            )
            log_warning(f"RTCClient: Initial offer to peer {peer} failed: {exc}")
            failed_pc = pc or self._pcs.get(peer)
            if failed_pc is not None:
                await self._discard_failed_negotiation_pc(peer, failed_pc)
            self._schedule_peer_reconnect(peer, reason="initial offer setup failed")
            raise
        finally:
            self._offer_in_progress.discard(peer)

    async def _on_offer(self, payload: bytes) -> None:
        if not self._adapter:
            return

        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal offer: {e}")
            return

        peer = msg.get("from")
        if not peer:
            return
        if not self._signaling_envelope_matches_room(msg, channel="offer"):
            return

        remote_stable_peer_id = str(msg.get("stable_peer_id") or "")
        remote_node_name = str(msg.get("node_name") or "")
        if remote_stable_peer_id:
            self._remember_claimed_peer_identity(peer, remote_stable_peer_id, remote_node_name)

        log_debug(f"Received offer from {peer}")
        pc: RTCPeerConnection | None = None
        try:
            offer_sdp = str(msg["sdp"])
            existing_pc = self._pcs.get(peer)
            existing_transport = self._pairing_transports.get(peer)
            existing_offer_sdp = (
                str(existing_transport.get("offer_sdp") or "")
                if existing_transport is not None and existing_transport.get("pc") is existing_pc
                else ""
            )
            local_offer_owns_glare = (
                existing_pc is not None
                and getattr(existing_pc, "signalingState", "") == "have-local-offer"
                and self._peer_id < peer
            )
            if local_offer_owns_glare:
                log_info(
                    f"RTCClient: Ignoring simultaneous offer from peer {peer}; "
                    "the lower signaling ID keeps the active offer"
                )
                return
            active_channel = self._peer_data_channels.get(peer)
            if existing_pc is not None and existing_offer_sdp and existing_offer_sdp != offer_sdp:
                if (
                    existing_pc.connectionState == "connected"
                    or getattr(active_channel, "readyState", "") == "open"
                ):
                    log_debug(f"RTCClient: Ignoring a fresh offer for active peer {peer}")
                    return
                await self._discard_failed_negotiation_pc(peer, existing_pc)

            pc = await self._ensure_pc(peer)
            self._pairing_transports[peer] = {
                "pc": pc,
                "offerer_signaling_id": peer,
                "answerer_signaling_id": self._peer_id,
                "offer_sdp": offer_sdp,
                "answer_sdp": "",
                "remote_stable_peer_id": remote_stable_peer_id,
                "remote_node_name": remote_node_name,
            }
            await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_sdp, type="offer"))
            await self._drain_pending_ice_candidates(peer, pc)

            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)

            answer_sdp = self._filter_outbound_session_description(pc.localDescription.sdp)
            self._pairing_transports[peer]["answer_sdp"] = answer_sdp
            out = {
                "type": "answer",
                "app_id": self._settings.webrtc.app_id,
                "room": self._settings.webrtc.room,
                "from": self._peer_id,
                "to": peer,
                "sdp": answer_sdp,
                "stable_peer_id": self._local_mesh_peer_id(),
                "node_name": self._local_mesh_node_name(),
            }
            sealed = aead_seal(self._keys.k_sig, out)
            await self._adapter.send("answer", sealed, to_peer=peer)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._record_diagnostic_error(
                "negotiation_response_failed",
                "Failed to accept or answer an inbound WebRTC offer",
                peer,
            )
            log_warning(f"RTCClient: Failed to answer offer from peer {peer}: {exc}")
            failed_pc = pc or self._pcs.get(peer)
            if failed_pc is not None:
                await self._discard_failed_negotiation_pc(peer, failed_pc)

    async def _on_answer(self, payload: bytes) -> None:
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal answer: {e}")
            return

        peer = msg.get("from")
        if not peer:
            return
        if not self._signaling_envelope_matches_room(msg, channel="answer"):
            return

        remote_stable_peer_id = str(msg.get("stable_peer_id") or "")
        remote_node_name = str(msg.get("node_name") or "")
        if remote_stable_peer_id:
            self._remember_claimed_peer_identity(peer, remote_stable_peer_id, remote_node_name)

        log_debug(f"Received answer from {peer}")
        if peer in self._pcs:
            pc = self._pcs[peer]
            answer_sdp = str(msg["sdp"])
            transport = self._pairing_transports.get(peer)
            if transport is None or transport.get("pc") is not pc:
                self._record_diagnostic_error(
                    "pairing_transcript_missing",
                    "Received an answer without the matching local offer transcript",
                    peer,
                )
                self._reconnect_suppressed_pcs.add(pc)
                await self._close_peer_connection(pc)
                return
            transport["answer_sdp"] = answer_sdp
            transport["remote_stable_peer_id"] = remote_stable_peer_id
            transport["remote_node_name"] = remote_node_name
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
            await self._drain_pending_ice_candidates(peer, pc)
            self._cancel_negotiation_watchdog(peer, pc)

    def _discard_pending_ice_candidates(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> None:
        """Discard queued candidates owned by one superseded negotiation."""
        pending = self._pending_ice_candidates.get(peer)
        if pending is None:
            return
        retained = [entry for entry in pending if entry[0] is not pc]
        if retained:
            self._pending_ice_candidates[peer] = retained
        else:
            self._pending_ice_candidates.pop(peer, None)

    async def _drain_pending_ice_candidates(
        self,
        peer: str,
        pc: RTCPeerConnection,
    ) -> None:
        """Apply candidates queued before the exact PC received remote SDP."""
        pending = self._pending_ice_candidates.get(peer, ())
        owned = [candidate for pending_pc, candidate in pending if pending_pc is pc]
        retained = [entry for entry in pending if entry[0] is not pc]
        if retained:
            self._pending_ice_candidates[peer] = retained
        else:
            self._pending_ice_candidates.pop(peer, None)
        if self._pcs.get(peer) is not pc:
            return
        for candidate in owned:
            try:
                await pc.addIceCandidate(candidate)
            except Exception as exc:
                # One stale or malformed trickled candidate must not prevent a
                # valid remote description from completing the negotiation.
                log_error(f"Error adding queued ICE candidate from {peer}: {exc}")

    async def _on_candidate(self, payload: bytes) -> None:
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_error(f"Failed to unseal candidate: {e}")
            return

        peer = msg.get("from")
        cand_sdp = msg.get("candidate")
        if not peer or not cand_sdp:
            return
        if not self._signaling_envelope_matches_room(msg, channel="candidate"):
            return

        try:
            candidate = candidate_from_sdp(cand_sdp)
            sdp_mid = msg.get("sdp_mid")
            sdp_mline_index = msg.get("sdp_mline_index")
            if isinstance(sdp_mid, str):
                candidate.sdpMid = sdp_mid
            if isinstance(sdp_mline_index, int):
                candidate.sdpMLineIndex = sdp_mline_index
            if peer in self._pcs:
                pc = self._pcs[peer]
                if getattr(pc, "remoteDescription", None) is None:
                    pending = self._pending_ice_candidates.setdefault(peer, [])
                    if len(pending) >= _MAX_PENDING_ICE_CANDIDATES_PER_PEER:
                        pending.pop(0)
                    pending.append((pc, candidate))
                    return
                await pc.addIceCandidate(candidate)
        except Exception as e:
            log_error(f"Error adding ICE candidate from {peer}: {e}")

    async def _on_broadcast(self, payload: bytes) -> None:
        """Handle a room-wide broadcast message from the signaling channel.

        Broadcasts are encrypted signaling-layer messages visible to all
        peers in the room.  Current use-cases:

        * ``mesh_event`` — a peer notifying all others of a state change
          (e.g. service going offline, config reload, graceful shutdown).

        Unknown broadcast types are logged and ignored so the protocol
        remains forward-compatible.
        """
        try:
            msg = aead_open(self._keys.k_sig, payload)
        except Exception as e:
            log_warning(f"RTCClient: Failed to unseal broadcast: {e}")
            return

        if not self._signaling_envelope_matches_room(
            msg,
            channel="broadcast",
            require_recipient=False,
        ):
            return

        btype = msg.get("type", "")
        from_peer = msg.get("from", "unknown")

        if from_peer == self._peer_id:
            return  # Ignore our own broadcasts

        log_debug(f"RTCClient: Broadcast received from {from_peer}, type={btype}")

        if btype == "mesh_event":
            event_name = msg.get("event", "")
            if event_name == "peer_leaving":
                leaving_peer = msg.get("peer_id", from_peer)
                if leaving_peer:
                    await self._handle_signaling_departure(
                        str(leaving_peer),
                        reason="graceful peer_leaving broadcast",
                    )
            elif event_name == "manifest_changed":
                # Peer's service manifest changed — request updated manifest
                if from_peer in self._pcs:
                    self._request_manifest(from_peer, reason="manifest_changed event")
            else:
                log_debug(f"RTCClient: Unknown mesh_event '{event_name}' from {from_peer}")
        else:
            log_debug(f"RTCClient: Unknown broadcast type '{btype}' from {from_peer}")

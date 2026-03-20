from __future__ import annotations

import secrets

from pydantic import BaseModel, Field

from app.helpers.aurora_logger import log_warning


class MeshServiceConfig(BaseModel):
    """Per-service mesh configuration (sharing + routing combined).

    Controls whether a local service is shared with remote peers,
    how many concurrent remote calls are allowed, which peers may
    use it, and how the MeshBus routes messages for this service.

    Event forwarding is controlled at the publish site via the
    ``mesh=True`` parameter on ``bus.publish()``, not here.

    Attributes:
        share: Whether to share this service with the network
        max_concurrent: Maximum concurrent remote calls to this service
        allowed_peers: Specific peer IDs allowed (None = all authenticated)
        prefer: Routing preference ("local" | "network" | "network_only" | "local_only")
        fallback: Fallback strategy ("local" | "network" | "error" | "none")
        min_version: Minimum required version (semver) for remote service
        required_capabilities: Capabilities the remote service must have
    """

    share: bool = False
    max_concurrent: int = 10
    allowed_peers: list[str] | None = None
    prefer: str = "local"
    fallback: str = "local"
    min_version: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)


# Backward-compatible aliases
ServiceSharingConfig = MeshServiceConfig
ServiceRoutingConfig = MeshServiceConfig


class MeshConfig(BaseModel):
    """Mesh network configuration.

    Controls the P2P mesh behaviour for this Aurora instance.
    When ``enabled`` is False (the default), the mesh layer is not
    instantiated and there is zero overhead.

    Attributes:
        enabled: Whether mesh networking is active
        node_name: Human-readable name for this node in the mesh
        services: Per-module mesh configuration (sharing + routing)
        version_policy: How strictly to enforce version matching
        peer_selection: Strategy for choosing among multiple peers
        ping_interval_s: How often to measure peer latency (seconds)
        registry_announce_interval_s: How often to re-announce manifest
        stale_peer_timeout_s: Mark peer stale after this many seconds without pong
    """

    enabled: bool = False
    node_name: str = ""
    services: dict[str, MeshServiceConfig] = Field(default_factory=dict)
    version_policy: str = "compatible"  # "exact" | "compatible" | "any"
    peer_selection: str = "lowest_latency"  # "lowest_latency" | "round_robin" | "random"
    ping_interval_s: float = 30.0
    registry_announce_interval_s: float = 60.0
    stale_peer_timeout_s: float = 120.0
    remote_timeout_s: float = 30.0


def _generate_token_secret() -> str:
    """Generate a random token secret for signing.

    This is used as the default so each Aurora instance gets a unique
    secret on first startup.  For persistence across restarts, set
    ``gateway.token_secret`` in config.json or the AURORA_TOKEN_SECRET
    environment variable.
    """
    return secrets.token_urlsafe(32)


class APISettings(BaseModel):
    enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8000
    request_timeout: float = 30.0
    cors_origins: list[str] = ["*"]
    cors_allow_credentials: bool = True
    docs: bool = True
    token_secret: str = Field(default_factory=_generate_token_secret)
    auth_enabled: bool = False
    api_keys: list[str] = Field(default_factory=list)

    @classmethod
    def from_gateway_dict(cls, gateway: dict) -> APISettings:
        """Create APISettings from gateway config dict."""
        cors = gateway.get("cors", {})
        auth = gateway.get("auth", {})
        auth_enabled = auth.get("enabled", False)
        explicit_secret = gateway.get("token_secret")

        if auth_enabled and not explicit_secret:
            log_warning(
                "Gateway auth is enabled but no token_secret is configured. "
                "Tokens will be invalidated on restart. Set AURORA_TOKEN_SECRET "
                "in .env to persist it."
            )

        return cls(
            enabled=gateway.get("enabled", True),
            host=gateway.get("host", "0.0.0.0"),
            port=gateway.get("port", 8000),
            request_timeout=gateway.get("request_timeout_s", 30.0),
            cors_origins=cors.get("origins", ["*"]),
            cors_allow_credentials=cors.get("allow_credentials", True),
            docs=gateway.get("docs", True),
            token_secret=explicit_secret or _generate_token_secret(),
            auth_enabled=auth_enabled,
            api_keys=auth.get("api_keys", []),
        )


class WebRTCSettings(BaseModel):
    enabled: bool = True
    strategy: str = "mqtt"
    app_id: str = "aurora"
    room: str = "default"
    password: str = ""
    encrypt_signaling: bool = True
    enable_app_layer_e2ee: bool = False
    stun_servers: list[str] = ["stun:stun.l.google.com:19302"]
    turn_servers: list[str] = Field(default_factory=list)
    turn_username: str | None = None
    turn_password: str | None = None


class MQTTSettings(BaseModel):
    brokers: list[str] = [
        "wss://broker.emqx.io:8084/mqtt",
        "wss://test.mosquitto.org:8081/mqtt",
    ]
    username: str | None = None
    password: str | None = None
    topic_root: str = "aurora"


class PermissionSettings(BaseModel):
    """Default permission settings for new principals."""

    default_device_permissions: list[str] = Field(default_factory=list)
    webrtc_auth_timeout_seconds: float = 10.0
    webrtc_pairing_timeout_seconds: float = 300.0


class Settings(BaseModel):
    api: APISettings = Field(default_factory=APISettings)
    webrtc: WebRTCSettings = Field(default_factory=WebRTCSettings)
    signaling_mqtt: MQTTSettings = Field(default_factory=MQTTSettings)
    permissions: PermissionSettings = Field(default_factory=PermissionSettings)
    mesh: MeshConfig = Field(default_factory=MeshConfig)

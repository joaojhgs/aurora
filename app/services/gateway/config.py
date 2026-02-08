from __future__ import annotations

from pydantic import BaseModel, Field


class APISettings(BaseModel):
    enabled: bool = True
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = ["*"]
    docs: bool = True
    token_secret: str = "change-me"
    auth_enabled: bool = False
    api_keys: list[str] = []


class WebRTCSettings(BaseModel):
    enabled: bool = True
    strategy: str = "mqtt"
    app_id: str = "aurora"
    room: str = "default"
    password: str = ""
    encrypt_signaling: bool = True
    enable_app_layer_e2ee: bool = False
    stun_servers: list[str] = ["stun:stun.l.google.com:19302"]
    turn_servers: list[str] = []
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

    default_device_permissions: list[str] = []
    webrtc_auth_timeout_seconds: float = 10.0


class Settings(BaseModel):
    api: APISettings = Field(default_factory=APISettings)
    webrtc: WebRTCSettings = Field(default_factory=WebRTCSettings)
    signaling_mqtt: MQTTSettings = Field(default_factory=MQTTSettings)
    permissions: PermissionSettings = Field(default_factory=PermissionSettings)

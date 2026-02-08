from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user_id: str
    username: str
    permissions: list[str]
    is_admin: bool
    expires_at: str | None = None


class PairingStartRequest(BaseModel):
    device_name: str


class PairingStartResponse(BaseModel):
    code: str
    expires_in_seconds: int


class PairingConnectRequest(BaseModel):
    code: str


class PairingConnectResponse(BaseModel):
    request_id: str
    device_name: str
    status: str


class PairingApproveRequest(BaseModel):
    code: str
    permissions: list[str] | None = None
    is_admin: bool = False


class PairingApproveResponse(BaseModel):
    success: bool


class PairingExchangeRequest(BaseModel):
    code: str


class PairingExchangeResponse(BaseModel):
    token: str
    device_id: str
    user_id: str
    permissions: list[str] = []


class PrincipalCreateRequest(BaseModel):
    username: str
    password: str | None = None
    permissions: list[str] | None = None
    is_admin: bool = False


class PrincipalResponse(BaseModel):
    id: str
    username: str
    permissions: list[str]
    is_admin: bool
    created_at: str | None = None


class PrincipalUpdateRequest(BaseModel):
    username: str | None = None
    password: str | None = None
    is_admin: bool | None = None


class PermissionSetRequest(BaseModel):
    permissions: list[str]


class PermissionPatchRequest(BaseModel):
    grant: list[str] | None = None
    revoke: list[str] | None = None


class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str


class TokenCreateRequest(BaseModel):
    principal_id: str
    device_id: str | None = None
    scopes: list[str] | None = None
    expires_in_days: int = 365


class TokenResponse(BaseModel):
    id: str
    prefix: str
    device_id: str | None = None
    user_id: str | None = None
    scopes: list[str]
    created_at: str | None = None
    expires_at: str | None = None


class TokenCreateResponse(BaseModel):
    token: str
    id: str
    prefix: str
    scopes: list[str]
    expires_at: str | None = None


class TokenScopeUpdateRequest(BaseModel):
    scopes: list[str]


class DeviceResponse(BaseModel):
    id: str
    user_id: str | None = None
    name: str
    is_trusted: bool
    created_at: str | None = None
    last_seen: str | None = None


class IdentityResponse(BaseModel):
    """Full identity information for the current authenticated principal."""

    principal_id: str
    principal_name: str
    device_id: str | None = None
    is_admin: bool
    permissions: list[str]
    effective_perms: list[str]
    source: str


class TokenRefreshResponse(BaseModel):
    """Response for token refresh."""

    token: str
    expires_at: str | None = None


class AuthError(BaseModel):
    error: str
    code: str

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    user_id: str
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


class PairingApproveResponse(BaseModel):
    success: bool


class PairingExchangeRequest(BaseModel):
    code: str


class PairingExchangeResponse(BaseModel):
    token: str
    device_id: str
    user_id: str


class AuthError(BaseModel):
    error: str
    code: str

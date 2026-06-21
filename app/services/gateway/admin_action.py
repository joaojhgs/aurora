"""AdminAction draft/confirm state for Gateway-generated admin routes."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException

from app.shared.contracts.models.gateway import (
    AdminActionConfirmRequest,
    AdminActionConfirmResponse,
    AdminActionDraftRequest,
    AdminActionDraftResponse,
)

ADMIN_ACTION_ID_HEADER = "X-Aurora-AdminAction-Id"
ADMIN_ACTION_TOKEN_HEADER = "X-Aurora-AdminAction-Token"
ADMIN_ACTION_DIGEST_HEADER = "X-Aurora-AdminAction-Digest"

ADMIN_ACTION_REQUIRED_HEADERS = (
    ADMIN_ACTION_ID_HEADER,
    ADMIN_ACTION_TOKEN_HEADER,
    ADMIN_ACTION_DIGEST_HEADER,
)

ADMIN_ACTION_TTL_SECONDS = 300
ADMIN_ACTION_REQUIRED_PHRASE = "CONFIRM"

_AFFECTED_RESOURCE_KEYS = (
    "user_id",
    "principal_id",
    "device_id",
    "token_id",
    "peer_id",
    "remote_peer_id",
    "key",
    "key_path",
    "plugin",
    "plugin_name",
    "service",
    "module",
)


@dataclass
class AdminActionReceipt:
    """Consumed confirmation details for an audited route execution."""

    action_id: str
    audit_receipt: str
    reason: str
    affected_resources: list[str]
    expires_at: datetime


@dataclass
class _PendingAdminAction:
    action_id: str
    nonce: str
    method_id: str
    principal_id: str | None
    digest: str
    affected_resources: list[str]
    expires_at: datetime
    confirmation_token: str | None = None
    confirmed_reason: str | None = None
    audit_receipt: str | None = None
    consumed: bool = False


def admin_action_digest(method_id: str, principal_id: str | None, payload: Any) -> str:
    """Return the stable digest for an AdminAction method/payload/principal tuple."""
    encoded = json.dumps(
        {
            "method_id": method_id,
            "principal_id": principal_id,
            "payload": payload or {},
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def infer_affected_resources(payload: dict[str, Any]) -> list[str]:
    """Infer compact affected-resource labels from common admin payload fields."""
    resources: list[str] = []
    for key in _AFFECTED_RESOURCE_KEYS:
        value = payload.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(value, list):
            resources.extend(f"{key}:{item}" for item in value)
        else:
            resources.append(f"{key}:{value}")
    return sorted(dict.fromkeys(resources))


class AdminActionManager:
    """Process-local short-lived AdminAction draft/confirmation store."""

    def __init__(self, ttl_seconds: int = ADMIN_ACTION_TTL_SECONDS):
        self._ttl_seconds = ttl_seconds
        self._pending: dict[str, _PendingAdminAction] = {}

    def draft(
        self,
        request: AdminActionDraftRequest,
        *,
        principal_id: str | None,
    ) -> AdminActionDraftResponse:
        """Create a draft nonce for a method/payload pair."""
        self._prune_expired()
        now = datetime.now(UTC)
        expires_at = now + timedelta(seconds=self._ttl_seconds)
        payload = dict(request.payload or {})
        digest = admin_action_digest(request.method_id, principal_id, payload)
        affected_resources = list(request.affected_resources) or infer_affected_resources(payload)
        action = _PendingAdminAction(
            action_id=f"aa_{secrets.token_urlsafe(18)}",
            nonce=secrets.token_urlsafe(24),
            method_id=request.method_id,
            principal_id=principal_id,
            digest=digest,
            affected_resources=affected_resources,
            expires_at=expires_at,
        )
        self._pending[action.action_id] = action
        return AdminActionDraftResponse(
            action_id=action.action_id,
            nonce=action.nonce,
            digest=action.digest,
            method_id=action.method_id,
            affected_resources=action.affected_resources,
            required_phrase=ADMIN_ACTION_REQUIRED_PHRASE,
            required_reason=True,
            required_reauth=True,
            expires_at=action.expires_at.isoformat(),
            expires_in_seconds=self._ttl_seconds,
        )

    def confirm(
        self,
        request: AdminActionConfirmRequest,
        *,
        principal_id: str | None,
    ) -> AdminActionConfirmResponse:
        """Confirm a draft and issue a single-use route submission token."""
        self._prune_expired()
        action = self._get_pending(request.action_id)
        self._validate_pending(action, principal_id=principal_id)

        if not hmac.compare_digest(request.nonce, action.nonce):
            raise _admin_action_error(
                409,
                "admin_action_nonce_mismatch",
                "AdminAction nonce does not match the draft",
            )
        if not hmac.compare_digest(request.digest, action.digest):
            raise _admin_action_error(
                409,
                "admin_action_digest_mismatch",
                "AdminAction digest does not match the draft",
            )
        if not request.reason.strip():
            raise _admin_action_error(
                428,
                "admin_action_reason_required",
                "AdminAction confirmation reason is required",
            )
        if not request.reauth_confirmed:
            raise _admin_action_error(
                428,
                "admin_action_reauth_required",
                "Recent admin reauthentication is required",
            )
        if request.phrase != ADMIN_ACTION_REQUIRED_PHRASE:
            raise _admin_action_error(
                428,
                "admin_action_phrase_required",
                "AdminAction confirmation phrase is required",
            )

        action.confirmation_token = secrets.token_urlsafe(32)
        action.confirmed_reason = request.reason.strip()
        action.audit_receipt = f"aar_{secrets.token_urlsafe(18)}"
        return AdminActionConfirmResponse(
            action_id=action.action_id,
            confirmation_token=action.confirmation_token,
            digest=action.digest,
            expires_at=action.expires_at.isoformat(),
            audit_receipt=action.audit_receipt,
        )

    def consume(
        self,
        *,
        action_id: str,
        confirmation_token: str,
        digest: str,
        method_id: str,
        principal_id: str | None,
        payload: dict[str, Any],
    ) -> AdminActionReceipt:
        """Consume a confirmed action for the exact generated route request."""
        self._prune_expired()
        action = self._get_pending(action_id)
        self._validate_pending(action, principal_id=principal_id)

        if action.consumed:
            raise _admin_action_error(
                409,
                "admin_action_already_consumed",
                "AdminAction confirmation has already been used",
            )
        if action.method_id != method_id:
            raise _admin_action_error(
                409,
                "admin_action_method_mismatch",
                "AdminAction method does not match the request route",
            )
        if not action.confirmation_token or not action.audit_receipt:
            raise _admin_action_error(
                428,
                "admin_action_not_confirmed",
                "AdminAction draft has not been confirmed",
            )
        if not hmac.compare_digest(confirmation_token, action.confirmation_token):
            raise _admin_action_error(
                409,
                "admin_action_token_mismatch",
                "AdminAction confirmation token is invalid",
            )
        expected_digest = admin_action_digest(method_id, principal_id, payload)
        if not hmac.compare_digest(digest, expected_digest) or not hmac.compare_digest(
            digest, action.digest
        ):
            raise _admin_action_error(
                409,
                "admin_action_digest_mismatch",
                "AdminAction digest does not match the request payload",
            )

        action.consumed = True
        self._pending.pop(action.action_id, None)
        return AdminActionReceipt(
            action_id=action.action_id,
            audit_receipt=action.audit_receipt,
            reason=action.confirmed_reason or "",
            affected_resources=action.affected_resources,
            expires_at=action.expires_at,
        )

    def _get_pending(self, action_id: str) -> _PendingAdminAction:
        action = self._pending.get(action_id)
        if not action:
            raise _admin_action_error(
                404,
                "admin_action_not_found",
                "AdminAction draft was not found or has expired",
            )
        return action

    def _validate_pending(
        self,
        action: _PendingAdminAction,
        *,
        principal_id: str | None,
    ) -> None:
        if action.expires_at <= datetime.now(UTC):
            self._pending.pop(action.action_id, None)
            raise _admin_action_error(
                410,
                "admin_action_expired",
                "AdminAction draft has expired",
            )
        if action.principal_id != principal_id:
            raise _admin_action_error(
                403,
                "admin_action_principal_mismatch",
                "AdminAction principal does not match the authenticated caller",
            )

    def _prune_expired(self) -> None:
        now = datetime.now(UTC)
        for action_id, action in list(self._pending.items()):
            if action.expires_at <= now or action.consumed:
                self._pending.pop(action_id, None)


def _admin_action_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
        },
    )

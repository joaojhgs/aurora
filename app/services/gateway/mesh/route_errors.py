"""Product-safe route failure wording with stable machine reason codes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class PublicRouteError:
    """Sanitized route failure for external surfaces."""

    reason_code: str
    message: str
    security_privacy: bool = False


class RouteDispatchError(RuntimeError):
    """Runtime route failure carrying a stable machine reason code."""

    def __init__(self, message: str, *, reason_code: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code


def public_route_error(
    route: Any = None,
    *,
    explicit_target: bool = False,
    fallback_reason_code: str = "route_unavailable",
) -> PublicRouteError:
    """Return sanitized failure text while preserving a stable reason code."""

    reason_code = _reason_code(route, fallback_reason_code=fallback_reason_code)
    classification_code = _classification_code(reason_code)
    return PublicRouteError(
        reason_code=reason_code,
        message=_message_for_reason(classification_code, explicit_target=explicit_target),
        security_privacy=_is_security_privacy_code(reason_code)
        or _is_security_privacy_code(classification_code),
    )


def public_message_for_reason(
    reason_code: str,
    *,
    explicit_target: bool = False,
) -> str:
    """Return only the sanitized route-failure message for a reason code."""

    return _message_for_reason(
        _classification_code(reason_code),
        explicit_target=explicit_target,
    )


def _reason_code(route: Any, *, fallback_reason_code: str) -> str:
    if route is None:
        return fallback_reason_code
    code = getattr(route, "error_code", None) or getattr(route, "reason_code", None)
    if isinstance(code, str) and code:
        return code
    target = getattr(route, "target", None)
    if target == "remote":
        return "remote_transport_unavailable"
    if target == "none":
        return "no_route"
    return fallback_reason_code


def _message_for_reason(reason_code: str, *, explicit_target: bool) -> str:
    if reason_code in {
        "permission_denied",
        "provider_not_allowed",
        "selector_peer_unauthorized",
        "selector_permission_denied",
    }:
        return (
            "The selected device is not allowed to handle this action."
            if explicit_target
            else "No allowed device can handle this action."
        )
    if reason_code == "selector_required":
        return "Choose a device for this action."
    if reason_code in {
        "selector_peer_not_found",
        "peer_not_found",
        "selector_peer_stale",
        "peer_stale",
        "provider_unavailable",
        "manifest_projection_stale",
        "lease_expired",
        "lease_missing",
        "remote_transport_unavailable",
        "capability_changed",
        "not_sent",
    }:
        return (
            "The selected device is unavailable."
            if explicit_target
            else "No available device can handle this action."
        )
    if reason_code in {"provider_at_capacity", "capacity_unavailable"}:
        return "The selected device is busy." if explicit_target else "Available devices are busy."
    if reason_code in {
        "speech_route_binding_unavailable",
        "speech_language_unavailable",
        "language_capability_unknown",
        "language_incompatible",
        "speech_voice_unavailable",
        "voice_unavailable",
    }:
        return (
            "The selected device cannot handle this voice request."
            if explicit_target
            else "No compatible device can handle this voice request."
        )
    if reason_code in {"no_route", "no_fallback_route"}:
        return (
            "The selected device cannot handle this action."
            if explicit_target
            else "No available device can handle this action."
        )
    return (
        "The selected device cannot handle this action."
        if explicit_target
        else "This action is unavailable."
    )


def _classification_code(reason_code: str) -> str:
    if not reason_code.startswith("selector_"):
        return reason_code
    unprefixed = reason_code.removeprefix("selector_")
    if unprefixed in {
        "language_capability_unknown",
        "language_incompatible",
        "voice_unavailable",
        "provider_at_capacity",
        "lease_missing",
        "provider_unavailable",
        "peer_not_found",
        "peer_stale",
        "permission_denied",
    }:
        return unprefixed
    return reason_code


def _is_security_privacy_code(reason_code: str) -> bool:
    return any(
        token in reason_code
        for token in (
            "unauthorized",
            "not_allowed",
            "peer_not_found",
            "selector_required",
            "selector_peer",
            "privacy",
            "consent",
            "permission",
        )
    )

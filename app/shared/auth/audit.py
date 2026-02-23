"""Audit logging helper for Aurora.

Records security-relevant events to the database via DatabaseManager.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from app.helpers.aurora_logger import log_debug, log_warning


async def audit_event(
    db_manager: Any,
    event: str,
    principal_id: str | None = None,
    details: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> None:
    """Record an audit event.

    Args:
        db_manager: DatabaseManager instance.
        event: Event name (e.g. ``"auth.login"``, ``"permission.grant"``).
        principal_id: Principal that triggered the event.
        details: Arbitrary event details (serialised as JSON).
        ip_address: Source IP address if available.
    """
    event_id = str(uuid.uuid4())
    details_str = json.dumps(details) if details else None
    try:
        await db_manager.store_audit_event(
            event_id=event_id,
            event=event,
            principal_id=principal_id,
            details=details_str,
            ip_address=ip_address,
        )
        log_debug(f"Audit: {event} by {principal_id}")
    except Exception:
        # Audit failures must not break the request flow
        log_warning(f"Audit: failed to record {event}")

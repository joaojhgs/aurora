"""Audit logging helper — re-exports from shared auth module.

New code should import from ``app.shared.auth.audit`` directly.
"""

from app.shared.auth.audit import audit_event  # noqa: F401

__all__ = ["audit_event"]

"""Permission matching engine for Aurora.

Pure functions — no dependencies on DB, HTTP, or any I/O.
Exports the ``Permission`` annotated type for use in Pydantic models.

Permissions use bus topic strings as the single namespace:
- ``"*"`` — superuser wildcard
- ``"Auth.*"`` — all Auth methods
- ``"Auth.use"`` / ``"Auth.manage"`` — type-based coarse access
- ``"Auth.PairingApprove"`` — granular per-method access
"""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, WithJsonSchema

# ---------------------------------------------------------------------------
# Well-known constant
# ---------------------------------------------------------------------------

PERM_ALL = "*"

# ---------------------------------------------------------------------------
# Auto-generated permission registry from *Methods classes
# ---------------------------------------------------------------------------
# Every service declares a *Methods class in app/shared/contracts/models/.
# We import them lazily (inside the builder function) to avoid circular
# imports: contracts/models/auth.py → permissions.py → contracts/models/auth.py
# ---------------------------------------------------------------------------


def _load_all_method_classes() -> tuple[type, ...]:
    """Lazy-import all *Methods classes to avoid circular imports."""
    from app.shared.contracts.models.audio import AudioInputMethods
    from app.shared.contracts.models.auth import AuthMethods
    from app.shared.contracts.models.config import ConfigMethods
    from app.shared.contracts.models.db import DBMethods
    from app.shared.contracts.models.gateway import GatewayMethods
    from app.shared.contracts.models.orchestrator import OrchestratorMethods
    from app.shared.contracts.models.scheduler import SchedulerMethods
    from app.shared.contracts.models.stt import (
        STTMethods,
        TranscriptionMethods,
        WakeWordMethods,
    )
    from app.shared.contracts.models.supervisor import SupervisorMethods
    from app.shared.contracts.models.tooling import ToolingMethods
    from app.shared.contracts.models.tts import TTSMethods

    return (
        AudioInputMethods,
        AuthMethods,
        ConfigMethods,
        DBMethods,
        GatewayMethods,
        OrchestratorMethods,
        SchedulerMethods,
        STTMethods,
        TranscriptionMethods,
        WakeWordMethods,
        SupervisorMethods,
        ToolingMethods,
        TTSMethods,
    )


def _collect_permissions(*method_classes: type) -> tuple[set[str], set[str]]:
    """Build KNOWN_PERMISSIONS and KNOWN_PERMISSION_PREFIXES from *Methods classes.

    Extracts every string constant of the form ``"Service.Action"`` from each
    class, then auto-generates:
    - Per-service wildcards: ``"Auth.*"``, ``"TTS.*"``, ...
    - Per-service type permissions: ``"Auth.use"``, ``"Auth.manage"``, ...
    - The superuser wildcard: ``"*"``

    Returns:
        ``(known_permissions, known_prefixes)``
    """
    permissions: set[str] = {PERM_ALL}
    prefixes: set[str] = set()

    for cls in method_classes:
        for attr in dir(cls):
            if attr.startswith("_"):
                continue
            val = getattr(cls, attr)
            if isinstance(val, str) and "." in val:
                permissions.add(val)
                prefixes.add(val.split(".")[0])

    # Auto-generate wildcard and type-based permissions per service prefix
    for prefix in prefixes:
        permissions.add(f"{prefix}.*")
        permissions.add(f"{prefix}.use")
        permissions.add(f"{prefix}.manage")

    return permissions, prefixes


# ---------------------------------------------------------------------------
# Lazy initialisation
# ---------------------------------------------------------------------------
# We cannot call _load_all_method_classes() at module level because of a
# circular import:  contracts/models/auth.py imports Permission from here,
# and _load_all_method_classes() imports AuthMethods from that same module.
# Instead we populate on first *runtime* access — validate_permission() is
# never called during import, only when Pydantic validates a value.
# The mutable containers below are referenced (not copied) by WithJsonSchema
# and by every function in this module, so in-place updates propagate.
# ---------------------------------------------------------------------------

KNOWN_PERMISSIONS: set[str] = set()
KNOWN_PERMISSION_PREFIXES: set[str] = set()
_permission_enum_list: list[str] = []  # mutable ref kept by WithJsonSchema
_initialized = False


def _ensure_initialized() -> None:
    """Populate permission sets on first use (breaks the circular import)."""
    global _initialized
    if _initialized:
        return
    try:
        perms, prefixes = _collect_permissions(*_load_all_method_classes())
    except Exception:
        return
    KNOWN_PERMISSIONS.update(perms)
    KNOWN_PERMISSION_PREFIXES.update(prefixes)
    _permission_enum_list.extend(sorted(KNOWN_PERMISSIONS))
    _initialized = True


def _normalize_prefix(raw: str) -> str | None:
    """Return the canonical prefix for *raw* via case-insensitive lookup.

    Returns ``None`` when no known prefix matches.
    """
    lower = raw.lower()
    for known in KNOWN_PERMISSION_PREFIXES:
        if known.lower() == lower:
            return known
    return None


def validate_permission(perm: str) -> str:
    """Validate a permission string, normalising case when possible.

    Returns the permission (with canonical prefix casing) if valid,
    raises ``ValueError`` otherwise.

    Accepts:
    - ``"*"`` (superuser wildcard)
    - Any exact match in ``KNOWN_PERMISSIONS`` (bus topic strings)
    - Any string whose dot-prefix matches a known prefix
      (case-insensitive — ``"tts"`` becomes ``"TTS"``,
      ``"tts.Request"`` becomes ``"TTS.Request"``)

    Args:
        perm: The permission string to validate (e.g. ``"Auth.Login"``,
              ``"TTS.use"``, ``"Config.*"``).

    Returns:
        The validated permission string with canonical prefix casing.

    Raises:
        ValueError: When the permission prefix is unknown.
    """
    _ensure_initialized()
    if perm == PERM_ALL:
        return perm
    if perm in KNOWN_PERMISSIONS:
        return perm

    parts = perm.split(".", 1)
    raw_prefix = parts[0]

    # Exact prefix hit (fast path)
    if raw_prefix in KNOWN_PERMISSION_PREFIXES:
        return perm

    # Case-insensitive prefix match — normalise to canonical casing
    canonical = _normalize_prefix(raw_prefix)
    if canonical is not None:
        normalised = f"{canonical}.{parts[1]}" if len(parts) > 1 else canonical
        if normalised in KNOWN_PERMISSIONS:
            return normalised
        return normalised

    raise ValueError(
        f"Unknown permission '{perm}'. Must start with a known service prefix: "
        f"{sorted(KNOWN_PERMISSION_PREFIXES)} or be a known permission."
    )


# ---------------------------------------------------------------------------
# Annotated type for Pydantic models — validates at runtime AND generates
# a proper ``enum`` list in JSON Schema / OpenAPI / Swagger UI.
# ---------------------------------------------------------------------------

Permission = Annotated[
    str,
    AfterValidator(validate_permission),
    WithJsonSchema({"type": "string", "enum": _permission_enum_list}),
]
"""A permission string validated against known permissions.

Use ``list[Permission]`` in Pydantic models so that Swagger UI shows a
typed enum dropdown instead of a bare ``string``.
"""


# ---------------------------------------------------------------------------
# Core matching
# ---------------------------------------------------------------------------


def has_permission(
    required: str,
    granted_perms: set[str],
    method_type: str | None = None,
) -> bool:
    """Check if a single *required* permission is satisfied by *granted_perms*.

    Matching rules (evaluated in order):
    1. ``"*"`` in granted_perms → always True  (superuser wildcard)
    2. Exact match ``required in granted_perms``
    3. Wildcard: ``"prefix.*"`` in granted_perms matches any permission
       that starts with ``"prefix."``. Supports multi-level wildcards
       (e.g. ``"Auth.*"`` matches ``"Auth.Login"``).
    4. Type-based: ``"Auth.use"`` in granted_perms matches ``"Auth.Login"``
       when that method has ``method_type="use"``.

    Args:
        required: The permission string that is needed (bus topic).
        granted_perms: The set of permissions the principal holds.
        method_type: The method_type of the required method (``"use"`` or
            ``"manage"``), if known. Enables type-based matching.

    Returns:
        True if *required* is satisfied by *granted_perms*.
    """
    # 1. Superuser wildcard
    if PERM_ALL in granted_perms:
        return True

    # 2. Exact match
    if required in granted_perms:
        return True

    # 3. Wildcard matching at any level
    if "." in required:
        required_parts = required.split(".")
        for perm in granted_perms:
            if perm.endswith(".*"):
                prefix_parts = perm[:-2].split(".")  # Strip ".*" then split
                if (
                    len(prefix_parts) < len(required_parts)
                    and required_parts[: len(prefix_parts)] == prefix_parts
                ):
                    return True

    # 4. Type-based matching: "Auth.use" matches "Auth.Login" if method_type="use"
    if method_type and "." in required:
        service_prefix = required.split(".")[0]
        type_perm = f"{service_prefix}.{method_type}"
        if type_perm in granted_perms:
            return True

    return False


def check_access(
    effective_perms: set[str],
    required_perms: list[str],
    method_type: str | None = None,
) -> bool:
    """Check that **all** *required_perms* are satisfied.

    Args:
        effective_perms: Resolved effective permissions for the principal.
        required_perms: List of permissions that must all be present.
        method_type: The method_type of the method being accessed, if known.

    Returns:
        True only if every required permission is matched.
    """
    return all(has_permission(r, effective_perms, method_type=method_type) for r in required_perms)


# ---------------------------------------------------------------------------
# Wildcard-aware intersection
# ---------------------------------------------------------------------------


def wildcard_intersection(user_perms: set[str], token_scopes: set[str]) -> set[str]:
    """Compute the wildcard-aware intersection of user permissions and token scopes.

    Both sides may contain wildcards (``"*"``, ``"TTS.*"``).

    Examples::

        wildcard_intersection({"TTS.*"}, {"TTS.Request"})
            → {"TTS.Request"}
        wildcard_intersection({"TTS.Request"}, {"TTS.*"})
            → {"TTS.Request"}
        wildcard_intersection({"TTS.*", "STT.*"}, {"TTS.Request", "DB.Get"})
            → {"TTS.Request"}

    Args:
        user_perms: Principal-level permissions.
        token_scopes: Token-level scope restrictions.

    Returns:
        Set of effective permissions (the intersection).
    """
    effective: set[str] = set()

    for scope in token_scopes:
        if has_permission(scope, user_perms):
            # The scope itself is covered by user perms — include it as-is.
            effective.add(scope)
        elif _is_wildcard(scope):
            # Token has a wildcard (e.g. "TTS.*") — pick user perms that fall under it.
            for up in user_perms:
                if has_permission(up, {scope}):
                    effective.add(up)

    return effective


# ---------------------------------------------------------------------------
# Effective permission resolution
# ---------------------------------------------------------------------------


def resolve_effective_permissions(
    user_permissions: list[str],
    user_is_admin: bool,
    token_scopes: list[str],
) -> set[str]:
    """Compute effective permissions for a request.

    Resolution rules:
    1. Admin shortcut → ``{"*"}``
    2. Token scopes contain ``"*"`` or ``"all"`` → inherit all user perms.
    3. Otherwise → ``wildcard_intersection(user_perms, token_scopes)``.

    Args:
        user_permissions: The principal's stored permission list.
        user_is_admin: Whether the principal has the admin flag.
        token_scopes: The scopes declared on the token.

    Returns:
        Resolved effective permission set.
    """
    if user_is_admin:
        return {PERM_ALL}

    user_perms = set(user_permissions)
    scopes = set(token_scopes)

    # Token with full access → inherit all user perms
    if PERM_ALL in scopes or "all" in scopes:
        return user_perms

    return wildcard_intersection(user_perms, scopes)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _is_wildcard(perm: str) -> bool:
    """Return True if *perm* is a wildcard permission."""
    return perm == PERM_ALL or perm.endswith(".*")

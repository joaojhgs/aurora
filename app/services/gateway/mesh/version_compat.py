"""Version compatibility checking for P2P mesh services.

Implements semantic versioning comparison with three policies:
- exact: versions must match exactly
- compatible: major version must match, remote >= local min_version
- any: any version is accepted

Also provides contract digest comparison for quick schema compatibility checks.
"""

from __future__ import annotations

import re

# Pre-compiled regex for semantic version parsing
_SEMVER_RE = re.compile(
    r"^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)"
    r"(?:-(?P<pre>[0-9A-Za-z\-.]+))?"
    r"(?:\+(?P<build>[0-9A-Za-z\-.]+))?$"
)


def parse_semver(version: str) -> tuple[int, int, int] | None:
    """Parse a semantic version string into (major, minor, patch).

    Pre-release and build metadata are ignored for comparison purposes.

    Args:
        version: Version string (e.g., "1.2.3", "1.0.0-beta.1")

    Returns:
        Tuple of (major, minor, patch), or None if parsing fails
    """
    m = _SEMVER_RE.match(version.strip())
    if not m:
        # Try simple x.y.z without pre-release/build
        parts = version.strip().split(".")
        try:
            if len(parts) == 3:
                return (int(parts[0]), int(parts[1]), int(parts[2]))
            elif len(parts) == 2:
                return (int(parts[0]), int(parts[1]), 0)
            elif len(parts) == 1:
                return (int(parts[0]), 0, 0)
        except ValueError:
            pass
        return None

    return (int(m.group("major")), int(m.group("minor")), int(m.group("patch")))


def is_compatible(
    local_version: str,
    remote_version: str,
    policy: str = "compatible",
    min_version: str | None = None,
) -> bool:
    """Check if a remote service version is compatible with local expectations.

    Policies:
    - "exact": versions must match exactly (major.minor.patch)
    - "compatible": major version must match, remote >= min_version (if set)
    - "any": any version is accepted

    Args:
        local_version: The version we require or are running locally
        remote_version: The version the remote peer offers
        policy: Matching policy ("exact", "compatible", "any")
        min_version: Optional minimum version constraint (overrides local_version
                     for the >= check in "compatible" mode)

    Returns:
        True if the versions are compatible under the given policy
    """
    if policy == "any":
        return True

    local = parse_semver(local_version)
    remote = parse_semver(remote_version)

    if local is None or remote is None:
        # If we can't parse either version, fall back to string comparison
        if policy == "exact":
            return local_version.strip() == remote_version.strip()
        # For compatible, accept if we can't parse
        return True

    if policy == "exact":
        return local == remote

    if policy == "compatible":
        # Major version must match
        if local[0] != remote[0]:
            return False

        # Check minimum version constraint
        if min_version:
            min_parsed = parse_semver(min_version)
            if min_parsed:
                return remote >= min_parsed

        # Default: remote must be >= local
        return remote >= local

    # Unknown policy — be permissive
    return True


def check_contract_compatibility(
    local_digest: str,
    remote_digest: str,
    strict: bool = False,
) -> bool:
    """Quick compatibility check via contract digest.

    If digests match, contracts are identical (same methods, schemas, etc.).
    In non-strict mode, mismatched digests are still considered compatible
    (the caller may decide to proceed with best-effort).

    Args:
        local_digest: SHA-256 of the local contract
        remote_digest: SHA-256 of the remote contract
        strict: If True, digests must match exactly for compatibility

    Returns:
        True if contracts are compatible
    """
    if not local_digest or not remote_digest:
        # Missing digest — can't verify, allow in non-strict mode
        return not strict

    if local_digest == remote_digest:
        return True

    # Digests differ — only fail in strict mode
    return not strict

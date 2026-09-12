"""Pure helpers for mesh service policy migration and compatibility mirrors."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import stat
import tempfile
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.shared.auth.permissions import validate_permission

MESH_SERVICE_PATHS: tuple[str, ...] = (
    "services.tts",
    "services.stt.coordinator",
    "services.stt.wakeword",
    "services.stt.transcription",
    "services.orchestrator",
    "services.db",
    "services.tooling",
    "services.scheduler",
)

LEGACY_TO_ROUTING: dict[str, str] = {
    "allowed_peers": "allowed_provider_peer_ids",
    "prefer": "prefer",
    "fallback": "fallback",
    "min_version": "min_version",
    "required_capabilities": "required_provider_capability_tags",
    "require_explicit_selector": "require_explicit_selector",
}

ROUTING_TO_LEGACY = {value: key for key, value in LEGACY_TO_ROUTING.items()}
NEW_ONLY_SHARING_DEFAULTS: dict[str, list[str]] = {
    "unshared_feature_ids": [],
    "unshared_method_ids": [],
}
NEW_ONLY_ROUTING_DEFAULTS: dict[str, list[str]] = {
    "required_provider_feature_ids": [],
}


@dataclass(slots=True)
class MeshPolicyMigrationResult:
    config: dict[str, Any]
    changed: bool
    migrated_services: list[str] = field(default_factory=list)
    conflict_count: int = 0
    rewritten_legacy_count: int = 0
    effective_paths: list[str] = field(default_factory=list)
    legacy_allowlist_evidence: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class MeshPolicyReverseResult:
    config: dict[str, Any]
    changed_services: list[str] = field(default_factory=list)
    refused_reasons: list[str] = field(default_factory=list)
    tooling_export_fail_closed: bool = False
    tooling_export_reasons: list[str] = field(default_factory=list)
    tooling_mesh_switches_must_disable: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ToolingDowngradePreflightResult:
    ok: bool
    reason: str
    receipt_path: str | None = None


def service_name(service_path: str) -> str:
    return service_path.removeprefix("services.")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def content_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def bytes_sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def migrate_mesh_service_policies(raw_config: dict[str, Any]) -> MeshPolicyMigrationResult:
    """Return a migrated config with v2 values taking precedence over legacy mirrors."""

    config = deepcopy(raw_config)
    migrated_services: list[str] = []
    conflict_count = 0
    rewritten_legacy_count = 0
    effective_paths: set[str] = set()
    legacy_allowlist_evidence: dict[str, Any] = {}

    for path in MESH_SERVICE_PATHS:
        service = _lookup(config, path)
        if not isinstance(service, dict):
            continue
        sharing = service.setdefault("mesh_sharing", {})
        routing = service.setdefault("mesh_routing", {})
        if not isinstance(sharing, dict) or not isinstance(routing, dict):
            continue

        before = deepcopy(service)
        if "allowed_peers" in sharing:
            legacy_allowlist_evidence[service_name(path)] = deepcopy(sharing["allowed_peers"])
        for key, default in NEW_ONLY_SHARING_DEFAULTS.items():
            if key not in sharing:
                sharing[key] = list(default)
        for key, default in NEW_ONLY_ROUTING_DEFAULTS.items():
            if key not in routing:
                routing[key] = list(default)

        for legacy_key, routing_key in LEGACY_TO_ROUTING.items():
            legacy_present = legacy_key in sharing
            routing_present = routing_key in routing
            if routing_present:
                if legacy_present and sharing[legacy_key] != routing[routing_key]:
                    conflict_count += 1
                    sharing[legacy_key] = deepcopy(routing[routing_key])
                    rewritten_legacy_count += 1
                    effective_paths.add(f"{path}.mesh_sharing.{legacy_key}")
                elif not legacy_present:
                    sharing[legacy_key] = deepcopy(routing[routing_key])
                    rewritten_legacy_count += 1
                    effective_paths.add(f"{path}.mesh_sharing.{legacy_key}")
            elif legacy_present:
                routing[routing_key] = deepcopy(sharing[legacy_key])
                effective_paths.add(f"{path}.mesh_routing.{routing_key}")

        if service != before:
            migrated_services.append(service_name(path))

    return MeshPolicyMigrationResult(
        config=config,
        changed=config != raw_config,
        migrated_services=migrated_services,
        conflict_count=conflict_count,
        rewritten_legacy_count=rewritten_legacy_count,
        effective_paths=sorted(effective_paths),
        legacy_allowlist_evidence=legacy_allowlist_evidence,
    )


def synchronize_legacy_mirrors(
    raw_config: dict[str, Any],
    changed_paths: list[str] | None = None,
) -> MeshPolicyMigrationResult:
    """Synchronize legacy and v2 mesh policy fields after arbitrary config writes.

    Supports leaf writes, block writes, service writes, the services root, update_section,
    and multi-change transactions. When both legacy and v2 fields are changed in the same
    transaction, the v2 value wins.
    """

    config = deepcopy(raw_config)
    changed_paths = changed_paths or []
    touched = set(changed_paths)
    migrated_services: list[str] = []
    conflict_count = 0
    rewritten_legacy_count = 0
    effective_paths: set[str] = set()

    for path in MESH_SERVICE_PATHS:
        service = _lookup(config, path)
        if not isinstance(service, dict):
            continue
        if not _path_touched(path, touched):
            continue
        sharing = _sync_block(service, "mesh_sharing")
        routing = _sync_block(service, "mesh_routing")
        if not isinstance(sharing, dict) or not isinstance(routing, dict):
            continue

        before = deepcopy(service)
        for key, default in NEW_ONLY_SHARING_DEFAULTS.items():
            sharing.setdefault(key, list(default))
        for key, default in NEW_ONLY_ROUTING_DEFAULTS.items():
            routing.setdefault(key, list(default))

        for legacy_key, routing_key in LEGACY_TO_ROUTING.items():
            legacy_path = f"{path}.mesh_sharing.{legacy_key}"
            routing_path = f"{path}.mesh_routing.{routing_key}"
            legacy_touched = _field_touched(path, "mesh_sharing", legacy_key, touched)
            routing_touched = _field_touched(path, "mesh_routing", routing_key, touched)

            if routing_touched and routing_key in routing:
                if legacy_key in sharing and sharing[legacy_key] != routing[routing_key]:
                    conflict_count += 1
                if before.get("mesh_sharing", {}).get(legacy_key) != routing[routing_key]:
                    rewritten_legacy_count += 1
                    effective_paths.add(legacy_path)
                sharing[legacy_key] = deepcopy(routing[routing_key])
            elif legacy_touched and legacy_key in sharing:
                if before.get("mesh_routing", {}).get(routing_key) != sharing[legacy_key]:
                    effective_paths.add(routing_path)
                routing[routing_key] = deepcopy(sharing[legacy_key])
            elif not legacy_touched and not routing_touched:
                continue
            elif routing_key in routing:
                if legacy_key in sharing and sharing[legacy_key] != routing[routing_key]:
                    conflict_count += 1
                if before.get("mesh_sharing", {}).get(legacy_key) != routing[routing_key]:
                    rewritten_legacy_count += 1
                    effective_paths.add(legacy_path)
                sharing[legacy_key] = deepcopy(routing[routing_key])

        if service != before:
            migrated_services.append(service_name(path))

    return MeshPolicyMigrationResult(
        config=config,
        changed=config != raw_config,
        migrated_services=migrated_services,
        conflict_count=conflict_count,
        rewritten_legacy_count=rewritten_legacy_count,
        effective_paths=sorted(effective_paths),
    )


def reverse_migrate_service_policy(
    raw_config: dict[str, Any],
    *,
    fail_closed_required_provider_features: bool = False,
    tooling_export_snapshot: dict[str, Any] | None = None,
) -> MeshPolicyReverseResult:
    """Return a legacy-compatible config, refusing unsafe unrepresentable routing by default."""

    config = deepcopy(raw_config)
    changed: list[str] = []
    refused: list[str] = []
    for path in MESH_SERVICE_PATHS:
        service = _lookup(config, path)
        if not isinstance(service, dict):
            continue
        sharing = service.setdefault("mesh_sharing", {})
        routing = service.get("mesh_routing", {})
        if not isinstance(sharing, dict) or not isinstance(routing, dict):
            continue
        before_service = deepcopy(service)
        for routing_key, legacy_key in ROUTING_TO_LEGACY.items():
            if routing_key in routing:
                sharing[legacy_key] = deepcopy(routing[routing_key])

        has_exclusions = bool(sharing.get("unshared_feature_ids")) or bool(
            sharing.get("unshared_method_ids")
        )
        if has_exclusions:
            sharing["share"] = False

        required_features = routing.get("required_provider_feature_ids") or []
        if required_features:
            if not fail_closed_required_provider_features:
                refused.append(
                    f"{service_name(path)} has required_provider_feature_ids that legacy routing cannot represent"
                )
            else:
                sharing["prefer"] = "local_only"
                sharing["fallback"] = "error"

        service.pop("mesh_routing", None)
        sharing.pop("unshared_feature_ids", None)
        sharing.pop("unshared_method_ids", None)

        if service != before_service:
            changed.append(service_name(path))
    tooling_fail_closed = False
    tooling_reasons: list[str] = []
    tooling_switches_to_disable: list[str] = []
    if tooling_export_snapshot is not None:
        tooling_fail_closed, reasons = _reverse_migrate_tooling_export_policy(
            config,
            tooling_export_snapshot,
        )
        if tooling_fail_closed:
            if "tooling" not in changed:
                changed.append("tooling")
            tooling_reasons = reasons
            tooling_switches_to_disable = [
                "provider_mesh_tooling_enabled",
                "consumer_mesh_tooling_enabled",
            ]

    return MeshPolicyReverseResult(
        config=config,
        changed_services=changed,
        refused_reasons=refused,
        tooling_export_fail_closed=tooling_fail_closed,
        tooling_export_reasons=tooling_reasons,
        tooling_mesh_switches_must_disable=tooling_switches_to_disable,
    )


def _reverse_migrate_tooling_export_policy(
    config: dict[str, Any],
    snapshot: dict[str, Any],
) -> tuple[bool, list[str]]:
    """Project durable Tooling export authority into the legacy policy conservatively.

    A legacy config can represent only an initialized global default with no granular
    rules and two enabled mesh switches. Any other state is deliberately collapsed to
    deny-all. The durable snapshot is read-only input and is never modified or deleted.
    """

    reasons = _tooling_export_unrepresentable_reasons(snapshot)
    tooling = _lookup(config, "services.tooling")
    if not isinstance(tooling, dict):
        services = config.setdefault("services", {})
        if not isinstance(services, dict):
            config["services"] = services = {}
        tooling = services.setdefault("tooling", {})
    sharing = tooling.setdefault("mesh_sharing", {})
    approval = tooling.setdefault("approval_policy", {})
    if not isinstance(sharing, dict):
        tooling["mesh_sharing"] = sharing = {}
        reasons.append("legacy Tooling mesh_sharing is not an object")
    if not isinstance(approval, dict):
        tooling["approval_policy"] = approval = {}
        reasons.append("legacy Tooling approval_policy is not an object")

    policy = snapshot.get("policy") if isinstance(snapshot, dict) else None
    default_state = policy.get("default_state") if isinstance(policy, dict) else None
    fail_closed = bool(reasons)
    shared = default_state == "shared" and not fail_closed
    sharing["share"] = shared
    approval["default_share"] = shared
    # A legacy per-tool allow can override ``default_share=False``. Normalize every
    # retained rule whenever the projected durable default denies export, including
    # the otherwise representable ``default_state=unshared`` case.
    if not shared:
        rules = approval.get("rules")
        if not isinstance(rules, list):
            rules = []
        normalized_rules: list[dict[str, Any]] = []
        for rule in rules:
            if isinstance(rule, dict):
                normalized_rule = deepcopy(rule)
                normalized_rule["share"] = False
                normalized_rules.append(normalized_rule)
        if not normalized_rules:
            normalized_rules.append(
                {
                    "rule_id": "downgrade-tooling-export-deny-all",
                    "share": False,
                    "approval_mode": "deny_all",
                }
            )
        approval["rules"] = normalized_rules
    return fail_closed, reasons


def _tooling_export_unrepresentable_reasons(snapshot: dict[str, Any]) -> list[str]:
    if not isinstance(snapshot, dict):
        return ["Tooling export snapshot is not an object"]
    reasons: list[str] = []
    if snapshot.get("secrets_redacted") is not True:
        reasons.append("Tooling export snapshot is not explicitly redacted")
    policy = snapshot.get("policy")
    if not isinstance(policy, dict):
        reasons.append("Tooling export policy is missing")
    else:
        if policy.get("initialized") is not True:
            reasons.append("Tooling export policy is uninitialized or ambiguous")
        if policy.get("default_state") not in {"shared", "unshared"}:
            reasons.append("Tooling export default state is unknown")
        if policy.get("review_required") or policy.get("review_status") not in {None, "resolved"}:
            reasons.append("Tooling export policy requires review")

    rules = snapshot.get("rules")
    if not isinstance(rules, list):
        reasons.append("Tooling export rules are missing or ambiguous")
    elif rules:
        reasons.append("granular Tooling export rules cannot be represented by legacy config")
    if snapshot.get("stale_tool_ids") or snapshot.get("stale_group_ids"):
        reasons.append("stale Tooling export identities require review")

    switches = snapshot.get("mesh_switches")
    if not isinstance(switches, dict):
        reasons.append("Tooling mesh switches are missing or ambiguous")
    elif (
        switches.get("provider_mesh_tooling_enabled") is not True
        or switches.get("consumer_mesh_tooling_enabled") is not True
    ):
        reasons.append("disabled or ambiguous Tooling mesh switch cannot be preserved")
    return reasons


def create_secure_migration_artifacts(
    *,
    original_config: dict[str, Any],
    migrated_config: dict[str, Any],
    config_file: str,
    migrated_services: list[str],
    conflict_count: int,
    original_bytes: bytes | None = None,
    actor: str = "startup",
) -> tuple[Path, Path]:
    """Create a full secure backup and a redacted receipt, reusing only matching artifacts."""

    config_path = Path(config_file).resolve()
    directory = config_path.parent
    backup_payload = (
        original_bytes if original_bytes is not None else _json_with_newline(original_config)
    )
    original_hash = bytes_sha256(backup_payload)
    migrated_hash = content_sha256(migrated_config)
    backup_path = directory / f"{config_path.name}.mesh-policy-v1.{original_hash[:16]}.backup.json"
    receipt_path = (
        directory
        / f"{config_path.name}.mesh-policy-v1.{original_hash}.{migrated_hash}.receipt.json"
    )
    receipt = {
        "version": 1,
        "kind": "mesh_service_policy_migration",
        "config_path": str(config_path),
        "backup_path": str(backup_path),
        "actor": actor,
        "original_sha256": original_hash,
        "migrated_sha256": migrated_hash,
        "service_count": len(migrated_services),
        "services": sorted(migrated_services),
        "conflict_count": conflict_count,
    }
    _secure_write_idempotent(backup_path, backup_payload, existing_must_match=True)
    _secure_write_idempotent(receipt_path, _json_with_newline(receipt), existing_must_match=True)
    return backup_path, receipt_path


def create_tooling_downgrade_receipt(
    *, output_config: dict[str, Any], output_file: str, tooling_export_snapshot: dict[str, Any]
) -> Path:
    """Write a secure receipt only after both durable mesh switches are disabled."""

    if tooling_export_snapshot.get("secrets_redacted") is not True:
        raise RuntimeError("downgrade snapshot must be explicitly redacted")
    switches = tooling_export_snapshot.get("mesh_switches")
    disabled = isinstance(switches, dict) and all(
        switches.get(name) is False
        for name in ("provider_mesh_tooling_enabled", "consumer_mesh_tooling_enabled")
    )
    if not disabled:
        raise RuntimeError("both Tooling mesh switches must be disabled before downgrade")
    tooling = _lookup(output_config, "services.tooling")
    sharing = tooling.get("mesh_sharing", {}) if isinstance(tooling, dict) else {}
    approval = tooling.get("approval_policy", {}) if isinstance(tooling, dict) else {}
    if sharing.get("share") is not False or approval.get("default_share") is not False:
        raise RuntimeError("downgrade config must coarsely deny Tooling export")
    config_path = Path(output_file).resolve()
    receipt_path = config_path.parent / f"{config_path.name}.mesh-tooling-downgrade.receipt.json"
    receipt = {
        "version": 1,
        "kind": "tooling_projection_downgrade",
        "config_path": str(config_path),
        "config_sha256": content_sha256(output_config),
        "snapshot_sha256": content_sha256(tooling_export_snapshot),
        "required_disabled_switches": {
            "provider_mesh_tooling_enabled": True,
            "consumer_mesh_tooling_enabled": True,
        },
    }
    _secure_write_idempotent(receipt_path, _json_with_newline(receipt), existing_must_match=True)
    return receipt_path


def preflight_tooling_downgrade_start(
    *,
    output_config: dict[str, Any],
    output_file: str,
    tooling_export_snapshot: dict[str, Any],
) -> ToolingDowngradePreflightResult:
    """Verify the explicit receipt required by a projection-incapable target."""

    path = (
        Path(output_file).resolve().parent
        / f"{Path(output_file).resolve().name}.mesh-tooling-downgrade.receipt.json"
    )
    protected = bool(
        (tooling_export_snapshot.get("policy") or {}).get("initialized")
        or tooling_export_snapshot.get("rules")
        or tooling_export_snapshot.get("stale_tool_ids")
        or tooling_export_snapshot.get("stale_group_ids")
        or tooling_export_snapshot.get("normalized_projection_present")
    )
    if not protected:
        return ToolingDowngradePreflightResult(ok=True, reason="no_projection_authority")
    if not path.exists():
        return ToolingDowngradePreflightResult(
            ok=False, reason="unsafe_downgrade_blocked", receipt_path=str(path)
        )
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("insecure receipt")
        receipt = json.loads(path.read_text())
        expected = {
            "provider_mesh_tooling_enabled": True,
            "consumer_mesh_tooling_enabled": True,
        }
        if (
            receipt.get("kind") != "tooling_projection_downgrade"
            or receipt.get("config_sha256") != content_sha256(output_config)
            or receipt.get("snapshot_sha256") != content_sha256(tooling_export_snapshot)
            or receipt.get("required_disabled_switches") != expected
        ):
            raise RuntimeError("receipt mismatch")
        switches = tooling_export_snapshot.get("mesh_switches") or {}
        if any(switches.get(name) is not False for name in expected):
            raise RuntimeError("switch remains enabled")
        tooling = _lookup(output_config, "services.tooling") or {}
        if (tooling.get("mesh_sharing") or {}).get("share") is not False or (
            tooling.get("approval_policy") or {}
        ).get("default_share") is not False:
            raise RuntimeError("coarse deny missing")
    except Exception:
        return ToolingDowngradePreflightResult(
            ok=False, reason="unsafe_downgrade_blocked", receipt_path=str(path)
        )
    return ToolingDowngradePreflightResult(
        ok=True, reason="downgrade_receipt_verified", receipt_path=str(path)
    )


def build_rbac_preflight_report(
    config: dict[str, Any],
    *,
    peers: list[Any] | None,
    inventory_complete: bool,
    legacy_allowlist_evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a redacted, non-mutating report for removed inbound allowlists."""

    evidence_snapshot = _json_safe(legacy_allowlist_evidence or {})
    services: list[dict[str, Any]] = []
    release_blocking = False
    peer_rows = [_peer_to_dict(peer) for peer in (peers or [])]
    for path in MESH_SERVICE_PATHS:
        service = _lookup(config, path)
        if not isinstance(service, dict):
            continue
        sharing = service.get("mesh_sharing", {})
        if not isinstance(sharing, dict):
            continue
        name = service_name(path)
        allowlist = (
            legacy_allowlist_evidence[name]
            if legacy_allowlist_evidence and name in legacy_allowlist_evidence
            else sharing.get("allowed_peers")
        )
        canonical = _CANONICAL_SERVICE_PERMISSIONS[name]
        shared = sharing.get("share") is True
        if allowlist is None:
            services.append(
                {
                    "service": name,
                    "permission_prefix": canonical,
                    "allowlist_state": "null",
                    "severity": "informational",
                    "shared": shared,
                    "blocking_peer_ids": [],
                    "incomplete": False,
                }
            )
            continue
        if not inventory_complete:
            severity = "release_blocking" if shared else "informational"
            release_blocking = release_blocking or shared
            services.append(
                {
                    "service": name,
                    "permission_prefix": canonical,
                    "allowlist_state": "empty" if allowlist == [] else "populated",
                    "severity": severity,
                    "shared": shared,
                    "blocking_peer_ids": [],
                    "incomplete": True,
                }
            )
            continue

        allowed = set(allowlist or [])
        blocking: list[str] = []
        if shared:
            for peer in peer_rows:
                if peer.get("outbound_status") != "approved":
                    continue
                peer_id = str(peer.get("peer_id") or "")
                if not peer_id:
                    continue
                perms = set(peer.get("outbound_permissions") or [])
                if not _service_permission_reaches(canonical, perms):
                    continue
                if allowlist == [] or peer_id not in allowed:
                    blocking.append(peer_id)
        severity = "release_blocking" if shared and blocking else "ok"
        if not shared:
            severity = "informational"
        release_blocking = release_blocking or (shared and bool(blocking))
        services.append(
            {
                "service": name,
                "permission_prefix": canonical,
                "allowlist_state": "empty" if allowlist == [] else "populated",
                "severity": severity,
                "shared": shared,
                "blocking_peer_ids": sorted(blocking),
                "incomplete": False,
            }
        )

    return {
        "version": 1,
        "kind": "mesh_service_policy_rbac_preflight",
        "inventory_complete": inventory_complete,
        "release_blocking": release_blocking,
        "reason": "peer_inventory_incomplete" if not inventory_complete else "allowlist_rbac_check",
        "legacy_allowlist_evidence": evidence_snapshot,
        "services": services,
    }


def persist_rbac_preflight_report(config_file: str, report: dict[str, Any]) -> Path:
    config_path = Path(config_file).resolve()
    path = config_path.parent / f"{config_path.name}.mesh-policy-rbac.json"
    _secure_replace(path, _json_with_newline(report))
    return path


def load_rbac_preflight_report(config_file: str) -> tuple[dict[str, Any] | None, Path]:
    config_path = Path(config_file).resolve()
    path = config_path.parent / f"{config_path.name}.mesh-policy-rbac.json"
    if not path.exists():
        return None, path
    stat_result = path.lstat()
    if not stat.S_ISREG(stat_result.st_mode) or stat.S_IMODE(stat_result.st_mode) != 0o600:
        raise RuntimeError(f"Refusing to read insecure RBAC preflight report: {path}")
    return json.loads(path.read_text()), path


def _service_permission_reaches(service: str, permissions: set[str]) -> bool:
    normalized_permissions = {_normalize_permission(permission) for permission in permissions}
    service_prefix = f"{service}."
    for permission in normalized_permissions:
        if permission == "*":
            return True
        if permission == service:
            return True
        if permission in {f"{service}.*", f"{service}.use", f"{service}.manage"}:
            return True
        if permission.startswith(service_prefix):
            return True
    return False


def _normalize_permission(permission: str) -> str:
    try:
        return validate_permission(permission)
    except ValueError:
        return permission


def _peer_to_dict(peer: Any) -> dict[str, Any]:
    if isinstance(peer, dict):
        return peer
    if hasattr(peer, "model_dump"):
        return peer.model_dump()
    return {
        key: getattr(peer, key)
        for key in (
            "peer_id",
            "outbound_status",
            "outbound_permissions",
        )
        if hasattr(peer, key)
    }


def _lookup(config: dict[str, Any], path: str) -> Any:
    value: Any = config
    try:
        for part in path.split("."):
            value = value[part]
        return value
    except (KeyError, TypeError):
        return None


def _path_touched(prefix: str, paths: set[str]) -> bool:
    return any(
        path == prefix or path.startswith(f"{prefix}.") or prefix.startswith(f"{path}.")
        for path in paths
    )


def _field_touched(service_path: str, block_name: str, field_name: str, paths: set[str]) -> bool:
    field_path = f"{service_path}.{block_name}.{field_name}"
    block_path = f"{service_path}.{block_name}"
    return any(
        path in (field_path, block_path, service_path, "services")
        or path.startswith(f"{field_path}.")
        for path in paths
    )


def _sync_block(service: dict[str, Any], block_name: str) -> Any:
    value = service.get(block_name)
    if value is None:
        service[block_name] = {}
        return service[block_name]
    return value


def _json_with_newline(value: Any) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True).encode() + b"\n"


def _json_safe(value: Any) -> Any:
    return json.loads(canonical_json_bytes(value).decode())


def _secure_write_idempotent(path: Path, payload: bytes, *, existing_must_match: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o600)
        try:
            os.link(tmp_path, path)
        except FileExistsError as exc:
            _validate_existing_artifact(
                path, payload, existing_must_match=existing_must_match, exc=exc
            )
        finally:
            with contextlib.suppress(OSError):
                tmp_path.unlink()
    except Exception:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise
    _fsync_dir(path.parent)


def _validate_existing_artifact(
    path: Path,
    payload: bytes,
    *,
    existing_must_match: bool,
    exc: BaseException,
) -> None:
    stat_result = path.lstat()
    mode = stat.S_IMODE(stat_result.st_mode)
    if not stat.S_ISREG(stat_result.st_mode) or mode != 0o600:
        raise RuntimeError(f"Refusing to reuse insecure migration artifact: {path}") from exc
    existing = path.read_bytes()
    if existing_must_match and existing == payload:
        return
    raise RuntimeError(f"Refusing to reuse non-matching migration artifact: {path}") from exc


def _secure_replace(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        stat_result = path.lstat()
        if not stat.S_ISREG(stat_result.st_mode) or stat.S_IMODE(stat_result.st_mode) != 0o600:
            raise RuntimeError(f"Refusing to replace insecure report: {path}")
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
    except Exception:
        with contextlib.suppress(OSError):
            tmp_path.unlink()
        raise
    _fsync_dir(path.parent)


def _fsync_dir(path: Path) -> None:
    dir_fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


_CANONICAL_SERVICE_PERMISSIONS: dict[str, str] = {
    "tts": "TTS",
    "stt.coordinator": "STT",
    "stt.wakeword": "WakeWord",
    "stt.transcription": "Transcription",
    "orchestrator": "Orchestrator",
    "db": "DB",
    "tooling": "Tooling",
    "scheduler": "Scheduler",
}

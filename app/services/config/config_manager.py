import contextlib
import hmac
import inspect
import json
import os
import secrets
import tempfile
import uuid
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from enum import Enum
from pathlib import Path
from threading import RLock
from typing import Any

from pydantic import BaseModel, ValidationError

from app.helpers.aurora_logger import log_error, log_info, log_warning
from app.services.config.env_config import ENV_CONFIG_MAP
from app.services.config.mesh_policy_migration import (
    MESH_SERVICE_PATHS,
    build_rbac_preflight_report,
    bytes_sha256,
    canonical_json_bytes,
    content_sha256,
    create_secure_migration_artifacts,
    load_rbac_preflight_report,
    migrate_mesh_service_policies,
    persist_rbac_preflight_report,
    synchronize_legacy_mirrors,
)
from app.shared.config.models import Model as AppConfig

_PREVIEW_TOKEN_TTL_SECONDS = 300
_MAX_PREVIEW_TOKENS = 128


class ConfigManager:
    """
    Thread-safe configuration manager that handles loading, saving, and runtime updates
    of application configuration from a JSON file.
    """

    _instance = None
    _lock = RLock()
    _schema = None

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not hasattr(self, "initialized"):
            # Optional override (e.g. tests); process-mode images bake config.json at /app (see Dockerfiles).
            self.config_file = os.environ.get("AURORA_CONFIG_FILE", "config.json")
            self.config_lock = RLock()
            self._config = {}
            self._observers = []
            self._version_history: list[dict[str, Any]] = []
            self._revision = 0
            self._preview_secret = secrets.token_bytes(32)
            self._preview_tokens: dict[str, dict[str, Any]] = {}
            self._migration_warning_emitted = False
            self.mesh_policy_rbac_report: dict[str, Any] | None = None
            self.mesh_policy_rbac_report_path: str | None = None
            self.mesh_policy_legacy_allowlist_evidence: dict[str, Any] | None = None
            self.mesh_policy_migration_audit: dict[str, Any] | None = None
            self._schema = self._get_config_schema()
            self.load_config()
            self.initialized = True

    def load_config(self):
        """Load configuration from JSON file, create default if not exists"""
        try:
            self._schema = self._get_config_schema()  # Ensure schema is loaded
            # Bind mounts sometimes expose `config.json` as a directory (wrong compose context);
            # fall back to image-baked path used by Dockerfiles.
            if os.path.isdir(self.config_file):
                log_warning(
                    "Config path %r is a directory, not a JSON file; using /app/config.json instead",
                    self.config_file,
                )
                self.config_file = "/app/config.json"
            # Use isfile — exists() is true for directories and would make open() fail.
            if os.path.isfile(self.config_file):
                original_bytes = Path(self.config_file).read_bytes()
                config_data = json.loads(original_bytes.decode())

                migration = migrate_mesh_service_policies(config_data)
                if migration.changed:
                    self.mesh_policy_legacy_allowlist_evidence = migration.legacy_allowlist_evidence
                    self._validate_config(migration.config)
                    self._validate_runtime_lifecycle_policy(migration.config)
                    backup_path, receipt_path = create_secure_migration_artifacts(
                        original_config=config_data,
                        migrated_config=migration.config,
                        config_file=self.config_file,
                        migrated_services=migration.migrated_services,
                        conflict_count=migration.conflict_count,
                        original_bytes=original_bytes,
                    )
                    self.mesh_policy_migration_audit = {
                        "migrated_service_count": len(migration.migrated_services),
                        "migrated_services": sorted(migration.migrated_services),
                        "conflict_count": migration.conflict_count,
                        "backup_created": True,
                        "backup_mode": "0600",
                        "backup_sha256_prefix": bytes_sha256(original_bytes)[:16],
                        "receipt_created": receipt_path.exists(),
                        "secrets_redacted": True,
                    }
                    report = build_rbac_preflight_report(
                        migration.config,
                        peers=None,
                        inventory_complete=False,
                        legacy_allowlist_evidence=migration.legacy_allowlist_evidence,
                    )
                    self.mesh_policy_rbac_report_path = str(
                        persist_rbac_preflight_report(self.config_file, report)
                    )
                    self.mesh_policy_rbac_report = report
                    self._write_candidate_atomic(migration.config)
                    if not self._migration_warning_emitted:
                        services = ", ".join(sorted(migration.migrated_services))
                        evidence_services = sorted(migration.legacy_allowlist_evidence.keys())
                        affected_services = sorted(
                            row["service"]
                            for row in report.get("services", [])
                            if row.get("severity") == "release_blocking"
                        )
                        log_warning(
                            "Migrated mesh service policy config for %s service(s): %s; original_allowlist_service_count=%s; original_allowlist_services=%s; affected_service_count=%s; affected_services=%s; conflicts=%s; rbac_report=%s; release_blocking=%s; reason=%s",
                            len(migration.migrated_services),
                            services,
                            len(evidence_services),
                            ", ".join(evidence_services),
                            len(affected_services),
                            ", ".join(affected_services),
                            migration.conflict_count,
                            self.mesh_policy_rbac_report_path,
                            report.get("release_blocking"),
                            report.get("reason"),
                        )
                        self._migration_warning_emitted = True
                    config_data = migration.config
                else:
                    report, report_path = load_rbac_preflight_report(self.config_file)
                    self.mesh_policy_rbac_report = report
                    self.mesh_policy_rbac_report_path = str(report_path)
                    if isinstance(report, dict):
                        evidence = report.get("legacy_allowlist_evidence")
                        if isinstance(evidence, dict):
                            self.mesh_policy_legacy_allowlist_evidence = deepcopy(evidence)

                # Validate the loaded configuration against AppConfig Pydantic model
                try:
                    self._config = self._normalize_config(config_data)
                    self._revision = 0
                    log_info(f"Configuration loaded and validated from {self.config_file}")
                except ValidationError as e:
                    log_error(f"Configuration validation failed: {e}")
                    raise RuntimeError(f"Configuration validation failed: {e}") from e
            else:
                self._config = self._get_default_config()
                self.save_config()
                log_info("Created default configuration file")
        except Exception as e:
            log_error(f"Error loading config: {e}")
            raise RuntimeError(f"Error loading config: {e}") from e

    def save_config(self):
        """Save current configuration to JSON file"""
        self._write_candidate_atomic(self._config)
        self._config = self._to_json_safe(self._config)
        log_info(f"Configuration saved to {self.config_file}")

    def _write_candidate_atomic(self, candidate: dict[str, Any]) -> None:
        """Patchable atomic write seam for already validated config candidates."""
        config_path = Path(self.config_file)
        old_bytes = config_path.read_bytes() if config_path.is_file() else None
        try:
            self._write_config_file(candidate)
        except Exception:
            if old_bytes is not None:
                self._restore_config_bytes(old_bytes)
            raise

    def _restore_config_bytes(self, payload: bytes) -> None:
        """Restore exact previous bytes after a failed candidate write."""
        config_path = os.path.abspath(self.config_file)
        config_dir = os.path.dirname(config_path) or "."
        os.makedirs(config_dir, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            prefix=f".{os.path.basename(config_path)}.restore.",
            suffix=".tmp",
            dir=config_dir,
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_path, config_path)
            dir_fd = os.open(config_dir, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
            raise

    def _write_config_file(self, config: dict[str, Any]) -> None:
        """Atomically write a JSON-safe config without mutating manager state."""
        tmp_path = None
        try:
            # Note: Don't acquire lock here as it might be called from within a locked context.
            safe_config = self._to_json_safe(config)
            serialized = json.dumps(safe_config, indent=2)

            config_path = os.path.abspath(self.config_file)
            config_dir = os.path.dirname(config_path) or "."
            os.makedirs(config_dir, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(
                prefix=f".{os.path.basename(config_path)}.",
                suffix=".tmp",
                dir=config_dir,
                text=True,
            )
            with os.fdopen(fd, "w") as f:
                f.write(serialized)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, config_path)
            dir_fd = os.open(config_dir, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except Exception as e:
            if tmp_path and os.path.exists(tmp_path):
                with contextlib.suppress(OSError):
                    os.unlink(tmp_path)
            log_error(f"Error saving config: {e}")
            raise RuntimeError(f"Error saving config: {e}") from e

    def _to_json_safe(self, value: Any) -> Any:
        """Convert Pydantic/runtime values to JSON-safe primitives."""
        if isinstance(value, BaseModel):
            return self._to_json_safe(value.model_dump(exclude_unset=False))
        if hasattr(value, "get_secret_value"):
            return value.get_secret_value()
        if isinstance(value, Enum):
            return value.value
        if isinstance(value, Path):
            return str(value)
        if isinstance(value, dict):
            return {str(k): self._to_json_safe(v) for k, v in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [self._to_json_safe(v) for v in value]
        if hasattr(value, "unicode_string"):
            return value.unicode_string()
        if isinstance(value, (str, int, float, bool)) or value is None:
            return value
        json.dumps(value)
        return value

    def _config_values_equal(self, current: Any, requested: Any) -> bool:
        """Compare config values using their persisted JSON representation."""
        try:
            return json.dumps(
                self._to_json_safe(current), sort_keys=True, separators=(",", ":")
            ) == json.dumps(self._to_json_safe(requested), sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return False

    def _is_value_set(self, value: Any) -> bool:
        """Return True if value is considered 'set' (non-empty, config override)."""
        if value is None:
            return False
        if isinstance(value, str):
            return value.strip() != ""
        if isinstance(value, (list, dict)):
            return len(value) > 0
        return True

    def _is_explicit_mesh_policy_list(self, key_path: str, value: Any) -> bool:
        mesh_list_fields = (
            ".allowed_peers",
            ".allowed_provider_peer_ids",
            ".required_capabilities",
            ".required_provider_capability_tags",
            ".required_provider_feature_ids",
            ".unshared_feature_ids",
            ".unshared_method_ids",
        )
        return isinstance(value, list) and key_path.endswith(mesh_list_fields)

    @property
    def config_revision(self) -> int:
        with self.config_lock:
            return self._revision

    def _normalize_config(self, config_data: dict[str, Any]) -> dict[str, Any]:
        """Validate known schema/model fields while preserving unknown raw keys."""
        validated = AppConfig.model_validate(config_data)
        defaults = self._to_json_safe(validated.model_dump(exclude_unset=False))
        normalized = self._deep_merge_preserving_unknown(defaults, self._to_json_safe(config_data))
        self._validate_json_schema(normalized)
        return normalized

    def _deep_merge_preserving_unknown(
        self, base: dict[str, Any], overlay: dict[str, Any]
    ) -> dict[str, Any]:
        result = deepcopy(base)
        for key, value in overlay.items():
            if key not in result:
                result[key] = deepcopy(value)
            elif isinstance(value, dict) and isinstance(result.get(key), dict):
                result[key] = self._deep_merge_preserving_unknown(result[key], value)
        return result

    def _normalize_change_list(self, changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not changes:
            raise ValueError("Configuration change set must not be empty")
        normalized: list[dict[str, Any]] = []
        seen: set[str] = set()
        for change in changes:
            key_path = str(change.get("key_path", ""))
            if (
                not key_path
                or not key_path.strip()
                or any(part == "" for part in key_path.split("."))
            ):
                raise ValueError("Configuration change key_path must not be blank")
            if key_path in seen:
                raise ValueError(f"Duplicate configuration change path: {key_path}")
            overlap_pair = next(
                (
                    self._ordered_overlap_paths(key_path, existing_path)
                    for existing_path in sorted(seen)
                    if self._paths_overlap(key_path, existing_path)
                ),
                None,
            )
            if overlap_pair is not None:
                ancestor, descendant = overlap_pair
                raise ValueError(
                    "Overlapping configuration change paths are not allowed: "
                    f"{ancestor} and {descendant}"
                )
            seen.add(key_path)
            normalized.append(
                {"key_path": key_path, "value": self._to_json_safe(change.get("value"))}
            )
        return normalized

    def _paths_overlap(self, left: str, right: str) -> bool:
        return left.startswith(f"{right}.") or right.startswith(f"{left}.")

    def _ordered_overlap_paths(self, left: str, right: str) -> tuple[str, str]:
        if left.startswith(f"{right}."):
            return right, left
        return left, right

    def _candidate_for_changes_locked(
        self,
        changes: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
        normalized_changes = self._normalize_change_list(changes)
        candidate = deepcopy(self._config)
        changed_paths: list[str] = []
        for change in normalized_changes:
            key_path = change["key_path"]
            value = change.get("value")
            self._set_path(candidate, key_path, value)
            changed_paths.append(key_path)
        mirrored = synchronize_legacy_mirrors(candidate, changed_paths)
        normalized_candidate = self._normalize_config(mirrored.config)
        broad_legacy_paths = self._changed_mesh_sharing_leaf_paths_for_broad_writes(
            self._config,
            normalized_candidate,
            changed_paths,
        )
        effective_paths = list(
            dict.fromkeys([*changed_paths, *broad_legacy_paths, *mirrored.effective_paths])
        )
        return normalized_candidate, normalized_changes, effective_paths

    def _changed_mesh_sharing_leaf_paths_for_broad_writes(
        self,
        old_config: dict[str, Any],
        new_config: dict[str, Any],
        changed_paths: list[str],
    ) -> list[str]:
        touched = set(changed_paths)
        leaf_paths: list[str] = []
        for service_path in MESH_SERVICE_PATHS:
            if not self._broad_mesh_sharing_touched(service_path, touched):
                continue
            old_sharing = self._lookup_path(old_config, f"{service_path}.mesh_sharing", {})
            new_sharing = self._lookup_path(new_config, f"{service_path}.mesh_sharing", {})
            if not isinstance(old_sharing, dict) or not isinstance(new_sharing, dict):
                continue
            self._collect_changed_leaf_paths(
                old_sharing,
                new_sharing,
                f"{service_path}.mesh_sharing",
                leaf_paths,
            )
        return leaf_paths

    def _broad_mesh_sharing_touched(self, service_path: str, touched: set[str]) -> bool:
        sharing_path = f"{service_path}.mesh_sharing"
        return any(
            path in {"services", service_path, sharing_path} or service_path.startswith(f"{path}.")
            for path in touched
        )

    def _collect_changed_leaf_paths(
        self,
        old_value: Any,
        new_value: Any,
        key_path: str,
        changed_leaf_paths: list[str],
    ) -> None:
        if isinstance(old_value, dict) and isinstance(new_value, dict):
            keys = sorted(set(old_value) | set(new_value))
            for key in keys:
                self._collect_changed_leaf_paths(
                    old_value.get(key),
                    new_value.get(key),
                    f"{key_path}.{key}",
                    changed_leaf_paths,
                )
            return
        if not self._config_values_equal(old_value, new_value):
            changed_leaf_paths.append(key_path)

    def _actual_changed_paths(
        self,
        old_config: dict[str, Any],
        new_config: dict[str, Any],
        candidate_paths: list[str],
    ) -> list[str]:
        return [
            path
            for path in candidate_paths
            if not self._config_values_equal(
                self._lookup_path(old_config, path),
                self._lookup_path(new_config, path),
            )
        ]

    def _apply_changes_locked(
        self,
        changes: list[dict[str, Any]],
        *,
        save: bool = True,
        transaction_kind: str = "change_set",
        actor: str = "internal",
    ) -> dict[str, Any]:
        old_config = deepcopy(self._config)
        candidate, normalized_changes, candidate_paths = self._candidate_for_changes_locked(changes)
        changed_paths = self._actual_changed_paths(old_config, candidate, candidate_paths)
        if self._config_values_equal(old_config, candidate) or not changed_paths:
            first = normalized_changes[0]
            key_path = first["key_path"]
            value = first.get("value")
            return {
                "key_path": key_path,
                "old_value": self._lookup_path(old_config, key_path),
                "new_value": value,
                "affected_sections": self._affected_sections_for_key(key_path),
                "changed_paths": [],
                "revision": self._revision,
            }

        try:
            normalized_candidate = self._normalize_config(candidate)
            self._validate_runtime_lifecycle_policy(normalized_candidate)
        except (ValidationError, ValueError) as e:
            raise ValueError(f"Configuration change rejected: {e}") from e

        if save:
            self._write_candidate_atomic(normalized_candidate)

        transaction_id = f"cfgtx_{uuid.uuid4().hex}"
        old_values = {path: self._lookup_path(old_config, path) for path in changed_paths}
        new_values = {path: self._lookup_path(normalized_candidate, path) for path in changed_paths}
        self._config = self._to_json_safe(normalized_candidate)
        self._revision += 1
        metadata = {
            "transaction_id": transaction_id,
            "config_revision": self._revision,
            "changed_paths": changed_paths,
            "affected_sections": self._affected_sections_for_paths(changed_paths),
            "transaction_kind": transaction_kind,
            "actor": actor,
        }
        self._record_version(
            changed_paths[0] if len(changed_paths) == 1 else ",".join(changed_paths),
            old_values if len(changed_paths) > 1 else old_values[changed_paths[0]],
            new_values if len(changed_paths) > 1 else new_values[changed_paths[0]],
            changed_paths=changed_paths,
            old_values=old_values,
            new_values=new_values,
            metadata=metadata,
        )
        self._notify_for_transaction(old_config, self._config, changed_paths, metadata)
        first_path = changed_paths[0]
        return {
            "key_path": first_path,
            "old_value": old_values[first_path],
            "new_value": new_values[first_path],
            "affected_sections": metadata["affected_sections"],
            "changed_paths": changed_paths,
            "transaction_id": transaction_id,
            "config_revision": self._revision,
            "revision": self._revision,
        }

    def _notify_for_transaction(
        self,
        old_config: dict[str, Any],
        new_config: dict[str, Any],
        changed_paths: list[str],
        metadata: dict[str, Any],
    ) -> None:
        if len(changed_paths) == 1:
            key_path = changed_paths[0]
            self._notify_observers(
                key_path,
                self._lookup_path(old_config, key_path),
                self._lookup_path(new_config, key_path),
                metadata,
            )
            return
        service_rows = sorted(
            {row for path in changed_paths if (row := self._service_row_for_path(path))}
        )
        notified = False
        for service_path in service_rows:
            row_paths = [
                path
                for path in changed_paths
                if path == service_path or path.startswith(f"{service_path}.")
            ]
            row_metadata = {**metadata, "changed_paths": row_paths}
            self._notify_observers(
                service_path,
                None,
                None,
                row_metadata,
            )
            notified = True
        non_service_paths = [path for path in changed_paths if not self._service_row_for_path(path)]
        for path in non_service_paths:
            self._notify_observers(
                path,
                self._lookup_path(old_config, path),
                self._lookup_path(new_config, path),
                {**metadata, "changed_paths": [path]},
            )
            notified = True
        if not notified:
            self._notify_observers(changed_paths[0], None, None, metadata)

    def _service_row_for_path(self, key_path: str) -> str | None:
        from app.services.config.mesh_policy_migration import MESH_SERVICE_PATHS

        return next(
            (
                service_path
                for service_path in sorted(MESH_SERVICE_PATHS, key=len, reverse=True)
                if key_path == service_path or key_path.startswith(f"{service_path}.")
            ),
            None,
        )

    def get(self, key_path: str, default: Any = None) -> Any:
        """
        Get configuration value using dot notation (e.g., 'ui.activate').

        Resolution order: config.json (if set) > .env > default.
        Config overrides allow runtime changes without reloading .env.
        Empty string / empty list / empty dict in config are treated as unset and
        fall through to env, then default.
        """
        keys = key_path.split(".")
        has_nested_env_fallbacks = any(path.startswith(f"{key_path}.") for path in ENV_CONFIG_MAP)
        config_copy: dict[str, Any] | None = None
        with self.config_lock:
            config_val = self._config
            try:
                for key in keys:
                    config_val = config_val[key]
            except (KeyError, TypeError):
                config_val = None
            if isinstance(config_val, dict) or has_nested_env_fallbacks:
                # Section reads must resolve nested secret fallbacks too. Returning
                # the raw section after secret migration leaves cleared values in
                # place and can make consumers generate replacement credentials.
                config_copy = json.loads(json.dumps(self._to_json_safe(self._config)))
            elif self._is_explicit_mesh_policy_list(key_path, config_val) or self._is_value_set(
                config_val
            ):
                return config_val

        if config_copy is not None:
            resolved_val: Any = self._resolve_env_fallbacks(config_copy)
            try:
                for key in keys:
                    resolved_val = resolved_val[key]
            except (KeyError, TypeError):
                resolved_val = None
            if self._is_explicit_mesh_policy_list(key_path, resolved_val):
                return resolved_val
            if self._is_value_set(resolved_val):
                return resolved_val

        env_info = ENV_CONFIG_MAP.get(key_path)
        if env_info:
            env_var, converter = env_info
            env_val = os.environ.get(env_var)
            if env_val is not None and env_val != "":
                try:
                    return converter(env_val)
                except (ValueError, TypeError):
                    pass
        return default

    def get_section(self, section_path: str, default: Any = None) -> Any:
        """
        Get an entire configuration section using dot notation.
        This is an alias for get() but provides clearer intent when retrieving sections.
        """
        return self.get(section_path, default)

    def set(self, key_path: str, value: Any, save: bool = True, actor: str = "internal"):
        """
        Set configuration value using dot notation and optionally save to file
        """
        with self.config_lock:
            self._normalize_change_list([{"key_path": key_path, "value": value}])
            old_value = self._lookup_path(self._config, key_path)
            if self._config_values_equal(old_value, value):
                return {
                    "key_path": key_path,
                    "old_value": old_value,
                    "new_value": value,
                    "affected_sections": self._affected_sections_for_key(key_path),
                }
            return self._apply_changes_locked(
                [{"key_path": key_path, "value": value}],
                save=save,
                transaction_kind="set",
                actor=actor,
            )

    def _affected_sections_for_key(self, key_path: str) -> list[str]:
        """Return parent sections plus the leaf key for a dot-delimited path."""
        if not key_path:
            return []
        parts = key_path.split(".")
        return [".".join(parts[: i + 1]) for i in range(len(parts))]

    def update_section(self, section: str, values: dict[str, Any], save: bool = True):
        """Update an entire configuration section using dot notation"""
        with self.config_lock:
            self._normalize_change_list([{"key_path": section, "value": values}])
            current = self._lookup_path(self._config, section, {})
            if not isinstance(current, dict):
                current = {}
            new_section = deepcopy(current)
            new_section.update(values)
            return self._apply_changes_locked(
                [{"key_path": section, "value": new_section}],
                save=save,
                transaction_kind="update_section",
            )

    def add_observer(self, callback: Callable[[str, Any, Any], None]):
        """Add an observer function that gets called when config changes"""
        self._observers.append(callback)

    def remove_observer(self, callback: Callable[[str, Any, Any], None]):
        """Remove an observer function"""
        if callback in self._observers:
            self._observers.remove(callback)

    def _notify_observers(
        self,
        key_path: str,
        old_value: Any,
        new_value: Any,
        metadata: dict[str, Any] | None = None,
    ):
        """Notify all observers of configuration changes"""
        for observer in self._observers:
            try:
                arity = len(
                    [
                        param
                        for param in inspect.signature(observer).parameters.values()
                        if param.kind in (param.POSITIONAL_ONLY, param.POSITIONAL_OR_KEYWORD)
                    ]
                )
                if metadata is None or arity < 4:
                    observer(key_path, old_value, new_value)
                else:
                    observer(key_path, old_value, new_value, metadata)
            except Exception as e:
                log_error(f"Error notifying observer: {e}")

    def _get_default_config(self) -> dict:
        """Return default configuration structure loaded from config_defaults.json"""
        defaults_path = os.path.join(os.path.dirname(__file__), "config_defaults.json")
        try:
            with open(defaults_path) as f:
                return json.load(f)
        except Exception as e:
            log_error(f"Failed to load default config from {defaults_path}: {e}")
            return self._to_json_safe(AppConfig().model_dump(exclude_unset=False))

    def clean_empty_strings(self, save: bool = True) -> int:
        """Remove empty string values from configuration and return count of cleaned fields"""

        def clean_dict(d: dict) -> int:
            cleaned = 0
            keys_to_remove = []

            for key, value in d.items():
                if isinstance(value, dict):
                    cleaned += clean_dict(value)
                elif isinstance(value, str) and value.strip() == "":
                    keys_to_remove.append(key)
                    cleaned += 1

            for key in keys_to_remove:
                del d[key]

            return cleaned

        with self.config_lock:
            cleaned_count = clean_dict(self._config)

            if cleaned_count > 0 and save:
                self.save_config()
                log_info(f"Cleaned {cleaned_count} empty string fields from configuration")

            return cleaned_count

    def migrate_secrets_to_env(self) -> bool:
        """One-time migration: move secrets from config.json to .env.

        Returns True if any migration occurred.
        """
        migrated = False
        env_path = ".env"
        try:
            from dotenv import set_key

            from app.services.config.env_config import ENV_CONFIG_MAP, SENSITIVE_KEYS

            if not os.path.exists(env_path):
                open(env_path, "a").close()
            for config_path in SENSITIVE_KEYS:
                if config_path not in ENV_CONFIG_MAP:
                    continue
                env_var, _ = ENV_CONFIG_MAP[config_path]
                keys = config_path.split(".")
                d = self._config
                try:
                    for key in keys:
                        d = d[key]
                except (KeyError, TypeError):
                    continue
                if not self._is_value_set(d):
                    continue
                env_value = ",".join(str(x) for x in d) if isinstance(d, list) else str(d)
                set_key(env_path, env_var, env_value)
                # dotenv writes do not mutate os.environ. Keep the value effective
                # for this process before clearing config.json; otherwise startup
                # sees an empty secret and immediately generates a replacement.
                os.environ[env_var] = env_value
                self.set(config_path, [] if isinstance(d, list) else "", save=False)
                migrated = True
                log_info(f"Migrated {config_path} from config.json to .env")
        except Exception as e:
            log_warning(f"Could not migrate secrets to .env: {e}")
        if migrated:
            self.save_config()
        return migrated

    def migrate_from_env(self):
        """One-time migration: move secrets from config.json to .env.

        Config and .env now live in parallel. No env→config migration.
        """
        self.migrate_secrets_to_env()

    def get_config_dict(self) -> dict[str, Any]:
        """Get a copy of the entire configuration dictionary with env fallbacks resolved."""
        with self.config_lock:
            config_copy = json.loads(json.dumps(self._to_json_safe(self._config)))
        return self._resolve_env_fallbacks(config_copy)

    def redact_external_config(
        self,
        config: dict[str, Any],
        *,
        root_path: str = "",
    ) -> dict[str, Any]:
        """Return a recursively redacted copy safe for external Config.Get."""

        def redact(value: Any, key_path: str) -> Any:
            if key_path and self._is_secret_path(key_path):
                return self._redact_value(value, True)
            if isinstance(value, dict):
                return {
                    key: redact(child, f"{key_path}.{key}" if key_path else key)
                    for key, child in value.items()
                }
            if isinstance(value, list):
                return [redact(child, key_path) for child in value]
            return deepcopy(value)

        return redact(config, root_path)

    def get_schema_metadata(
        self, section: str | None = None, include_values: bool = True
    ) -> list[dict[str, Any]]:
        """Return UI-readable schema metadata with source, secrecy, and impact flags."""
        self._schema = self._get_config_schema()
        fields = []
        metadata = self.get_field_metadata()
        defaults = self._get_default_config()

        for key_path in sorted(metadata):
            if section and key_path != section and not key_path.startswith(f"{section}."):
                continue
            raw_meta = metadata[key_path]
            secret = self._is_secret_path(key_path, raw_meta)
            impact = self.get_reload_impact([key_path])[0]
            default_value = self._lookup_path(defaults, key_path)
            current_value = self.get(key_path, default_value)
            field = {
                "key_path": key_path,
                "title": raw_meta.get("title"),
                "description": raw_meta.get("description", ""),
                "type": raw_meta.get("type", "string"),
                "default": self._redact_value(default_value, secret),
                "current_value": (
                    self._redact_value(current_value, secret) if include_values else None
                ),
                "source_layer": self._source_layer_for_path(key_path, default_value),
                "secret": secret,
                "reload_required": impact["reload_required"],
                "restart_required": impact["restart_required"],
                "affected_services": impact["affected_services"],
                "constraints": self._metadata_constraints(raw_meta),
                "choices": raw_meta.get("choices"),
            }
            fields.append(field)
        return fields

    def preview_diff(
        self, changes: list[dict[str, Any]], *, actor: str = "internal"
    ) -> dict[str, Any]:
        """Dry-run configuration changes and return a redacted diff plus validation errors."""
        return self._preview_diff(changes, actor=actor, issue_token=True)

    def _preview_diff(
        self,
        changes: list[dict[str, Any]],
        *,
        actor: str = "internal",
        issue_token: bool,
    ) -> dict[str, Any]:
        errors: list[str] = []
        diffs: list[dict[str, Any]] = []
        with self.config_lock:
            current = deepcopy(self._config)
            base_revision = self._revision
            candidate, normalized_changes, changed_paths = self._candidate_for_changes_locked(
                changes
            )

        for key_path in changed_paths:
            new_value = self._lookup_path(candidate, key_path)
            old_value = self._lookup_path(current, key_path)
            secret = self._is_secret_path(key_path)
            impact = self.get_reload_impact([key_path])[0]
            diffs.append(
                {
                    "key_path": key_path,
                    "old_value": self._redact_path_value(key_path, old_value),
                    "new_value": self._redact_path_value(key_path, new_value),
                    "changed": old_value != new_value,
                    "source_layer": self._source_layer_for_path(key_path, old_value),
                    "secret": secret,
                    "reload_required": impact["reload_required"],
                    "restart_required": impact["restart_required"],
                    "affected_services": impact["affected_services"],
                }
            )

        try:
            normalized_candidate = self._normalize_config(candidate)
            self._validate_runtime_lifecycle_policy(normalized_candidate)
        except (ValidationError, ValueError) as e:
            errors.append(str(e))

        token = None
        if not errors and issue_token:
            token = self._issue_preview_token(
                actor=actor,
                base_revision=base_revision,
                changes=normalized_changes,
                candidate=normalized_candidate,
            )
        return {
            "valid": not errors,
            "diffs": diffs,
            "errors": errors,
            "secrets_redacted": True,
            "base_revision": base_revision,
            "preview_token": token,
            "changed_paths": changed_paths,
        }

    def commit_change_set(
        self,
        changes: list[dict[str, Any]],
        *,
        base_revision: int,
        preview_token: str,
        actor: str = "internal",
    ) -> dict[str, Any]:
        """Commit a previewed change set with optimistic concurrency."""
        with self.config_lock:
            self._cleanup_preview_tokens()
            try:
                candidate, normalized_changes, changed_paths = self._candidate_for_changes_locked(
                    changes
                )
            except ValueError as e:
                return {
                    "success": False,
                    "error": str(e),
                    "error_code": "config_revision_conflict",
                    "revision": self._revision,
                    "changed_paths": [],
                    "diff": None,
                }
            token_record = self._preview_tokens.get(preview_token)
            expected = self._preview_token_payload(
                actor=actor,
                base_revision=base_revision,
                changes=normalized_changes,
                candidate=candidate,
            )
            if (
                token_record is None
                or token_record.get("consumed")
                or token_record.get("payload") != expected
                or token_record.get("actor") != actor
                or self._revision != base_revision
            ):
                return self._change_set_conflict_response(normalized_changes, actor=actor)
            if self._config_values_equal(self._config, candidate):
                token_record["consumed"] = True
                return {
                    "success": True,
                    "revision": self._revision,
                    "version_id": None,
                    "changed_paths": [],
                    "transaction_id": None,
                    "error": None,
                    "error_code": None,
                }
            try:
                metadata = self._apply_changes_locked(
                    normalized_changes,
                    save=True,
                    transaction_kind="commit_change_set",
                    actor=actor,
                )
            except Exception:
                raise
            token_record["consumed"] = True
            return {
                "success": True,
                "revision": self._revision,
                "version_id": self._version_history[-1]["version_id"]
                if self._version_history
                else None,
                "changed_paths": metadata.get("changed_paths", changed_paths),
                "transaction_id": metadata.get("transaction_id"),
                "error": None,
                "error_code": None,
            }

    def _change_set_conflict_response(
        self, changes: list[dict[str, Any]], *, actor: str
    ) -> dict[str, Any]:
        try:
            diff = self._preview_diff(changes, actor=actor, issue_token=False)
        except ValueError:
            diff = None
        return {
            "success": False,
            "error": "Config revision conflict",
            "error_code": "config_revision_conflict",
            "revision": self._revision,
            "changed_paths": [],
            "diff": diff,
        }

    def _issue_preview_token(
        self,
        *,
        actor: str,
        base_revision: int,
        changes: list[dict[str, Any]],
        candidate: dict[str, Any],
    ) -> str:
        self._cleanup_preview_tokens()
        payload = self._preview_token_payload(
            actor=actor,
            base_revision=base_revision,
            changes=changes,
            candidate=candidate,
        )
        digest = hmac.new(self._preview_secret, canonical_json_bytes(payload), "sha256").hexdigest()
        token = f"cfgprev_{secrets.token_urlsafe(24)}.{digest}"
        self._preview_tokens[token] = {
            "actor": actor,
            "payload": payload,
            "consumed": False,
            "expires_at": (
                datetime.now(UTC) + timedelta(seconds=_PREVIEW_TOKEN_TTL_SECONDS)
            ).isoformat(),
        }
        if len(self._preview_tokens) > _MAX_PREVIEW_TOKENS:
            for old_token in list(self._preview_tokens)[
                : len(self._preview_tokens) - _MAX_PREVIEW_TOKENS
            ]:
                self._preview_tokens.pop(old_token, None)
        return token

    def _cleanup_preview_tokens(self) -> None:
        now = datetime.now(UTC)
        for token, record in list(self._preview_tokens.items()):
            expires_at = record.get("expires_at")
            expired = False
            if isinstance(expires_at, str):
                with contextlib.suppress(ValueError):
                    expired = datetime.fromisoformat(expires_at) <= now
            if record.get("consumed") or expired:
                self._preview_tokens.pop(token, None)

    def _preview_token_payload(
        self,
        *,
        actor: str,
        base_revision: int,
        changes: list[dict[str, Any]],
        candidate: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "actor": actor,
            "base_revision": base_revision,
            "changes_sha256": content_sha256(changes),
            "candidate_sha256": content_sha256(candidate),
        }

    def get_version_history(
        self, key_path: str | None = None, limit: int = 20
    ) -> list[dict[str, Any]]:
        """Return recent redacted in-memory config version entries."""
        safe_limit = max(1, min(limit, 100))
        with self.config_lock:
            entries = list(reversed(self._version_history))
        if key_path:
            entries = [
                entry
                for entry in entries
                if key_path in (entry.get("changed_paths") or [entry["key_path"]])
            ]
        redacted = []
        for entry in entries[:safe_limit]:
            changed_paths = entry.get("changed_paths") or [entry["key_path"]]
            secret = any(self._is_secret_path(path) for path in changed_paths)
            redacted.append(
                {
                    "version_id": entry["version_id"],
                    "timestamp": entry["timestamp"],
                    "key_path": entry["key_path"],
                    "old_value": self._redact_version_value(entry, "old_values"),
                    "new_value": self._redact_version_value(entry, "new_values"),
                    "affected_sections": entry.get("affected_sections", []),
                    "secret": secret,
                    "changed_paths": changed_paths,
                    "transaction_kind": entry.get("transaction_kind"),
                    "actor": entry.get("actor"),
                }
            )
        return redacted

    def rollback(self, version_id: str, *, actor: str = "rollback") -> dict[str, Any]:
        """Rollback a config path to the previous value captured by a version entry."""
        with self.config_lock:
            version = next(
                (entry for entry in self._version_history if entry["version_id"] == version_id),
                None,
            )
            if version is None:
                raise ValueError(f"Unknown configuration version: {version_id}")
            changed_paths = version.get("changed_paths") or [version["key_path"]]
            old_values = version.get("old_values")
            if not isinstance(old_values, dict):
                old_values = {version["key_path"]: version.get("old_value")}
            changes = [
                {"key_path": path, "value": deepcopy(old_values.get(path))}
                for path in changed_paths
            ]
            metadata = self._apply_changes_locked(
                changes,
                save=True,
                transaction_kind="rollback",
                actor=actor,
            )
        return {
            "success": True,
            "version_id": version_id,
            "key_path": version["key_path"],
            "rolled_back_to": self._redact_version_value(version, "old_values"),
            "affected_sections": metadata.get("affected_sections", []),
            "secrets_redacted": True,
        }

    def get_reload_impact(self, key_paths: list[str]) -> list[dict[str, Any]]:
        """Return reload/restart impact metadata for configuration paths."""
        impacts = []
        for key_path in key_paths:
            affected_services = self._affected_services_for_key(key_path)
            restart_required = self._restart_required_for_key(key_path)
            impacts.append(
                {
                    "key_path": key_path,
                    "reload_required": True,
                    "restart_required": restart_required,
                    "affected_services": affected_services,
                    "reason": self._impact_reason(key_path, restart_required, affected_services),
                }
            )
        return impacts

    def _record_version(
        self,
        key_path: str,
        old_value: Any,
        new_value: Any,
        *,
        changed_paths: list[str],
        old_values: dict[str, Any],
        new_values: dict[str, Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._version_history.append(
            {
                "version_id": f"cfgv_{uuid.uuid4().hex}",
                "timestamp": datetime.now(UTC).isoformat(),
                "key_path": key_path,
                "old_value": deepcopy(old_value),
                "new_value": deepcopy(new_value),
                "changed_paths": list(changed_paths),
                "old_values": deepcopy(old_values),
                "new_values": deepcopy(new_values),
                "affected_sections": (metadata or {}).get("affected_sections")
                or self._affected_sections_for_paths(changed_paths),
                **(metadata or {}),
            }
        )
        self._version_history = self._version_history[-100:]

    def _redact_version_value(self, entry: dict[str, Any], values_key: str) -> Any:
        values = entry.get(values_key)
        changed_paths = entry.get("changed_paths") or [entry["key_path"]]
        if not isinstance(values, dict):
            return self._redact_path_value(entry["key_path"], values)
        redacted = {path: self._redact_path_value(path, values.get(path)) for path in changed_paths}
        if len(changed_paths) == 1:
            return redacted.get(changed_paths[0])
        return redacted

    def _redact_path_value(self, key_path: str, value: Any) -> Any:
        if self._is_secret_path(key_path):
            return self._redact_value(value, True)
        if isinstance(value, dict):
            return self.redact_external_config(value, root_path=key_path)
        if isinstance(value, list):
            return [
                self._redact_path_value(f"{key_path}.{index}", item)
                for index, item in enumerate(value)
            ]
        return value

    def _lookup_path(self, config: dict[str, Any], key_path: str, default: Any = None) -> Any:
        value: Any = config
        try:
            for key in key_path.split("."):
                value = value[key]
            return deepcopy(value)
        except (KeyError, TypeError):
            return default

    def _set_path(self, config: dict[str, Any], key_path: str, value: Any) -> None:
        ref = config
        keys = key_path.split(".")
        for key in keys[:-1]:
            ref = ref.setdefault(key, {})
        ref[keys[-1]] = value

    def _metadata_constraints(self, meta: dict[str, Any]) -> dict[str, Any]:
        constraint_keys = (
            "min",
            "max",
            "minimum",
            "maximum",
            "pattern",
            "format",
            "minLength",
            "maxLength",
        )
        return {key: meta[key] for key in constraint_keys if key in meta}

    def _is_secret_path(self, key_path: str, meta: dict[str, Any] | None = None) -> bool:
        from app.services.config.env_config import SENSITIVE_KEYS

        if key_path in SENSITIVE_KEYS:
            return True
        if meta and (meta.get("secret") is True or meta.get("sensitive") is True):
            return True
        metadata = self.get_field_metadata() if not meta else {}
        path_meta = metadata.get(key_path, {})
        if path_meta.get("secret") is True or path_meta.get("sensitive") is True:
            return True
        name = key_path.rsplit(".", 1)[-1].lower()
        precise_secret_names = {
            "secret",
            "token",
            "password",
            "api_key",
            "access_token",
            "refresh_token",
            "private_key",
            "credential",
            "credentials",
            "token_secret",
        }
        return name in precise_secret_names or name.endswith(("_secret", "_token", "_password"))

    def _redact_value(self, value: Any, secret: bool) -> Any:
        if not secret:
            return value
        if value in (None, "", [], {}):
            return None
        return "[REDACTED]"

    def _source_layer_for_path(self, key_path: str, default_value: Any = None) -> str:
        with self.config_lock:
            configured = self._lookup_path(self._config, key_path)
        if self._is_value_set(configured):
            return "config"
        env_info = ENV_CONFIG_MAP.get(key_path)
        if env_info:
            env_var, _ = env_info
            if os.environ.get(env_var):
                return "env"
        return "default" if default_value is not None else "unset"

    def _affected_services_for_key(self, key_path: str) -> list[str]:
        parts = key_path.split(".")
        if len(parts) >= 2 and parts[0] == "services":
            return [parts[1]]
        if parts and parts[0] in {"ui", "system", "gateway"}:
            return [parts[0]]
        return [parts[0]] if parts else []

    def _affected_sections_for_paths(self, key_paths: list[str]) -> list[str]:
        sections: list[str] = []
        for key_path in key_paths:
            for section in self._affected_sections_for_key(key_path):
                if section not in sections:
                    sections.append(section)
        return sections

    def _restart_required_for_key(self, key_path: str) -> bool:
        restart_suffixes = (".enabled", ".host", ".port", ".token_secret", ".app_id")
        restart_prefixes = (
            "services.gateway.api",
            "services.gateway.webrtc",
            "services.gateway.mqtt",
        )
        return key_path.endswith(restart_suffixes) or key_path.startswith(restart_prefixes)

    def _impact_reason(
        self, key_path: str, restart_required: bool, affected_services: list[str]
    ) -> str:
        service_text = ", ".join(affected_services) if affected_services else "dependent services"
        if restart_required:
            return f"{key_path} changes startup or transport behavior for {service_text}"
        return (
            f"{key_path} can be applied through Config.Updated reload handling for {service_text}"
        )

    def _resolve_env_fallbacks(self, config: dict[str, Any]) -> dict[str, Any]:
        """Merge env fallback values into config (config overrides env)."""
        for config_path, (env_var, converter) in ENV_CONFIG_MAP.items():
            keys = config_path.split(".")
            d = config
            try:
                val = d
                for key in keys:
                    val = val[key]
                if self._is_value_set(val):
                    continue
            except (KeyError, TypeError):
                pass
            env_val = os.environ.get(env_var)
            if env_val is None or env_val == "":
                continue
            try:
                resolved = converter(env_val)
            except (ValueError, TypeError):
                continue
            d = config
            for key in keys[:-1]:
                d = d.setdefault(key, {})
            d[keys[-1]] = resolved
        return config

    def _get_config_schema(self) -> dict[str, Any]:
        """Return the JSON schema for configuration validation with UI metadata"""
        # Load schema from external file "config_schema.json" in the same directory
        schema_path = os.path.join(os.path.dirname(__file__), "config_schema.json")
        try:
            with open(schema_path) as f:
                return json.load(f)

        except Exception as e:
            log_error(f"Failed to load config schema from {schema_path}: {e}")
            return {}

    def get_field_metadata(self) -> dict[str, dict[str, Any]]:
        """Extract field metadata from the configuration schema for UI generation"""
        metadata = {}
        self._schema = self._get_config_schema()  # Ensure schema is loaded

        def extract_metadata(schema: dict, path: str = ""):
            """Recursively extract metadata from schema"""
            # If 'properties' is present, iterate through them
            if "properties" in schema:
                for key, prop in schema["properties"].items():
                    current_path = f"{path}.{key}" if path else key

                    # Start with a copy of all properties (excluding nested dicts)
                    field_meta = {k: v for k, v in prop.items() if not isinstance(v, dict)}

                    # Determine UI type - prioritize ui_type over JSON schema type mapping
                    if "ui_type" in prop:
                        # Use explicit ui_type when specified
                        field_meta["type"] = prop["ui_type"]
                    else:
                        # Map JSON schema types to UI types
                        json_type = prop.get("type", "string")
                        if json_type == "boolean":
                            field_meta["type"] = "bool"
                        elif json_type == "integer":
                            field_meta["type"] = "int"
                        elif json_type == "number":
                            field_meta["type"] = "float"
                        elif json_type == "string":
                            if "enum" in prop or "ui_choices" in prop:
                                field_meta["type"] = "choice"
                                # Use ui_choices if available, otherwise use enum
                                field_meta["choices"] = prop.get("ui_choices", prop.get("enum", []))
                            else:
                                field_meta["type"] = "string"
                        elif json_type == "object":
                            field_meta["type"] = "dict"
                        elif json_type == "array":
                            field_meta["type"] = "list"
                        else:
                            field_meta["type"] = "string"

                    # Handle choices for choice type fields (in case ui_type="choice" is used)
                    if field_meta["type"] == "choice" and "choices" not in field_meta:
                        field_meta["choices"] = prop.get("ui_choices", prop.get("enum", []))

                    # Extract constraints with consistent naming
                    if "minimum" in prop:
                        field_meta["min"] = prop["minimum"]
                    if "maximum" in prop:
                        field_meta["max"] = prop["maximum"]

                    # Handle file filter for file type fields
                    if field_meta["type"] == "file" and "ui_file_filter" in prop:
                        field_meta["file_filter"] = prop["ui_file_filter"]

                    # Store metadata for this field
                    metadata[current_path] = field_meta

                    # Recursively process nested objects
                    json_type = prop.get("type", "string")
                    if json_type == "object" and "properties" in prop:
                        extract_metadata(prop, current_path)

        # Extract metadata from the schema
        extract_metadata(self._schema)

        # Add some special cases that aren't directly in the schema
        metadata.update(
            {
                # Dictionaries that should NOT be expanded (treat as single JSON fields)
                "services.tooling.plugins.jira.env": {
                    "expand_dict": False,
                    "type": "dict",
                    "description": "Environment variables for Jira plugin",
                }
            }
        )

        return metadata

    def _validate_config(self, config_data: dict[str, Any]) -> None:
        """Validate configuration data against the Pydantic model and JSON Schema.

        Pydantic validation is strict (raises on failure).
        JSON Schema validation is advisory (logs warnings for constraint
        violations like patternProperties that Pydantic codegen cannot model).
        """
        AppConfig.model_validate(config_data)
        self._validate_json_schema(config_data)

    def _validate_runtime_lifecycle_policy(self, config_data: dict[str, Any]) -> None:
        """Validate runtime lifecycle rules that schema shape cannot express."""
        services = config_data.get("services", {})
        config_service = services.get("config", {})
        if config_service.get("enabled") is False:
            raise ValueError(
                "services.config.enabled=false is not supported at runtime; "
                "ConfigService must remain active as the config source of truth"
            )

    def _validate_json_schema(self, config_data: dict[str, Any]) -> None:
        """Run JSON Schema validation and log constraint violations as warnings."""
        if not self._schema:
            return
        try:
            import jsonschema

            validator = jsonschema.Draft7Validator(self._schema)
            for error in validator.iter_errors(config_data):
                path = ".".join(str(p) for p in error.absolute_path) or "(root)"
                log_warning("JSON Schema constraint violation at %s: %s", path, error.message)
        except Exception as e:
            log_warning("JSON Schema validation could not run: %s", e)

    def validate_current_config(self) -> list[str]:
        """Validate current configuration and return list of validation errors"""
        errors = []

        try:
            self._validate_config(self._config)
        except ValidationError as e:
            errors.append(str(e))

        # Additional semantic validation
        semantic_errors = self.validate_config()
        errors.extend(semantic_errors)

        return errors

    def validate_config(self) -> list[str]:
        """Validate configuration and return list of validation errors"""
        errors = []

        # Validate LLM configuration (canonical paths under services.orchestrator.llm.*)
        provider = self.get("services.orchestrator.llm.provider")
        if not provider:
            errors.append("No LLM provider specified")
        else:
            if provider == "openai":
                if not self.get("services.orchestrator.llm.third_party.openai.options.model"):
                    errors.append("OpenAI model not specified")
            elif provider == "huggingface_endpoint":
                if not self.get(
                    "services.orchestrator.llm.third_party.huggingface_endpoint.options.endpoint_url"
                ):
                    errors.append("HuggingFace endpoint URL not specified")
                if not self.get(
                    "services.orchestrator.llm.third_party.huggingface_endpoint.options.access_token"
                ):
                    errors.append("HuggingFace access token not specified")
            elif provider == "huggingface_pipeline":
                if not self.get(
                    "services.orchestrator.llm.local.huggingface_pipeline.options.model"
                ):
                    errors.append("HuggingFace Pipeline model not specified")
            elif provider == "llama_cpp":
                model_path = self.get(
                    "services.orchestrator.llm.local.llama_cpp.options.model_path"
                )
                if not model_path:
                    errors.append("Llama.cpp model path not specified")
                elif not os.path.exists(model_path):
                    errors.append(f"Llama.cpp model file not found: {model_path}")

        # Validate TTS model paths exist
        tts_model = self.get("services.tts.model_file_path")
        if tts_model and not os.path.exists(tts_model.lstrip("/")):
            errors.append(f"TTS model file not found: {tts_model}")

        hw_accel_paths = [
            "services.tts.hardware_acceleration",
            "services.stt.hardware_acceleration",
            "services.orchestrator.hardware_acceleration",
        ]
        for path in hw_accel_paths:
            value = self.get(path)
            if value is not None and not isinstance(value, bool):
                errors.append(
                    f"Hardware acceleration setting {path} must be boolean, got {type(value)}"
                )

        return errors


_lazy_global_config_manager: ConfigManager | None = None


def get_config_manager() -> ConfigManager:
    """Return the process-wide ConfigManager singleton (lazy).

    Avoid eager ``ConfigManager()`` at import time so non-config processes
    that accidentally import this module do not create ``config.json``.
    """
    global _lazy_global_config_manager
    if _lazy_global_config_manager is None:
        _lazy_global_config_manager = ConfigManager()
    return _lazy_global_config_manager


def __getattr__(name: str) -> Any:
    """Backward-compatible ``from app.services.config.config_manager import config_manager``."""
    if name == "config_manager":
        return get_config_manager()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

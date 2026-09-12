"""Recipient-specific provider export projection for mesh providers.

The pure evaluator originated as the G006 shadow gate and is now the active
projection-v1 authority used by manifest negotiation, routing, and inbound RPC.
It remains side-effect free so one immutable result can feed every consumer.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Literal

from pydantic import ValidationError

from app.shared.auth.permissions import check_access
from app.shared.contracts.mesh_surface import (
    PUBLIC_INFRASTRUCTURE_TOPICS,
    validate_callable_method_surface,
)
from app.shared.contracts.models.speech import SpeechMethodConstraints

LEGACY_MANIFEST_PROTOCOL = "legacy-unfiltered-v0"
ACTIVE_MANIFEST_PROTOCOL = "projection-v1"
SUPPORTED_SHADOW_PROTOCOL = ACTIVE_MANIFEST_PROTOCOL
SUPPORTED_PROTOCOLS = (LEGACY_MANIFEST_PROTOCOL, ACTIVE_MANIFEST_PROTOCOL)

EXPOSURES = frozenset({"internal", "external", "both"})
EXPORTABLE_EXPOSURES = frozenset({"external", "both"})
METHOD_TYPES = frozenset({"use", "manage"})

MethodPermissions = tuple[str, ...] | None
AuthorityState = Literal["unknown", "pending", "active", "revoked"]
ReadinessState = Literal["unknown", "pending", "ready", "revoked"]
ReasonCode = Literal[
    "service_not_shared",
    "exposure_not_exportable",
    "feature_unshared",
    "method_unshared",
    "public_infrastructure_excluded",
    "permissions_unknown",
    "permissions_empty",
    "authority_unknown",
    "authority_pending",
    "authority_revoked",
    "permissions_denied",
]


class ProviderExportError(ValueError):
    """Base error for invalid provider export snapshots."""


class AuthorityRevisionError(ProviderExportError):
    """Base error for monotonic authority cache violations."""


class StaleAuthorityRevisionError(AuthorityRevisionError):
    """Raised when a lower authority revision is presented to the cache."""


class ConflictingAuthorityRevisionError(AuthorityRevisionError):
    """Raised when equal authority revisions carry different evidence."""


def _require_text(value: str, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProviderExportError(f"{field_name} must be a non-empty stable string")
    if value != value.strip():
        raise ProviderExportError(f"{field_name} must not contain leading/trailing whitespace")
    return value


def _require_digest(value: str | None, field_name: str) -> str | None:
    if value is None:
        return None
    return _require_text(value, field_name)


def _require_bool(value: bool, field_name: str) -> bool:
    if type(value) is not bool:
        raise ProviderExportError(f"{field_name} must be a bool")
    return value


def _require_revision(value: int, field_name: str) -> int:
    if type(value) is not int or value < 0:
        raise ProviderExportError(f"{field_name} must be a nonnegative integer")
    return value


def _require_optional_capacity(value: int | None, field_name: str) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise ProviderExportError(f"{field_name} must be a nonnegative integer or None")
    return value


def _validated_sorted_unique(values: Iterable[str], field_name: str) -> tuple[str, ...]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = _require_text(raw, field_name)
        if value in seen:
            raise ProviderExportError(f"{field_name} contains duplicate value {value!r}")
        seen.add(value)
        normalized.append(value)
    return tuple(sorted(normalized))


def _mapping_proxy(mapping: Mapping[str, Any] | None) -> Mapping[str, Any]:
    if mapping is None:
        return MappingProxyType({})
    return MappingProxyType(
        {str(key): _freeze_json(value) for key, value in sorted(mapping.items())}
    )


def _freeze_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType(
            {str(key): _freeze_json(item) for key, item in sorted(value.items())}
        )
    if isinstance(value, list | tuple):
        return tuple(_freeze_json(item) for item in value)
    return value


def _to_plain(value: Any) -> Any:
    if hasattr(value, "to_canonical"):
        return value.to_canonical()
    if isinstance(value, Mapping):
        return {str(key): _to_plain(item) for key, item in sorted(value.items())}
    if isinstance(value, tuple | list):
        return [_to_plain(item) for item in value]
    return value


def canonical_bytes(value: Any) -> bytes:
    """Return deterministic UTF-8 JSON bytes for normalized values."""
    return json.dumps(
        _to_plain(value),
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def canonical_digest(value: Any) -> str:
    """Return a deterministic SHA-256 hex digest for normalized values."""
    return sha256(canonical_bytes(value)).hexdigest()


def _schema_hash(schema: Mapping[str, Any] | None, explicit_hash: str | None) -> str | None:
    expected = canonical_digest(schema) if schema is not None else None
    supplied = _require_digest(explicit_hash, "schema_hash")
    if schema is not None and supplied is not None and supplied != expected:
        raise ProviderExportError("supplied schema hash does not match canonical schema digest")
    return supplied or expected


def _speech_constraints_mapping(value: Any | None) -> Mapping[str, Any] | None:
    if value is None:
        return None
    try:
        if isinstance(value, SpeechMethodConstraints):
            constraints = value
        elif hasattr(value, "model_dump"):
            constraints = SpeechMethodConstraints.model_validate(value.model_dump(mode="json"))
        else:
            constraints = SpeechMethodConstraints.model_validate(value)
    except ValidationError as exc:
        raise ProviderExportError(f"invalid speech_constraints: {exc}") from exc
    return _mapping_proxy(constraints.model_dump(mode="json"))


@dataclass(frozen=True, slots=True)
class NormalizedMethodSnapshot:
    """Normalized immutable method metadata relevant to shadow provider export."""

    topic: str
    exposure: str
    method_type: str
    required_permissions: MethodPermissions
    summary: str = ""
    input_model: str | None = None
    output_model: str | None = None
    input_schema: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    output_schema: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    input_schema_hash: str | None = None
    output_schema_hash: str | None = None
    feature_ids: tuple[str, ...] = ()
    public_infrastructure: bool = False
    speech_constraints: Mapping[str, Any] | SpeechMethodConstraints | None = field(
        default=None, repr=False, compare=False
    )
    input_schema_present: bool = field(default=False, init=False)
    output_schema_present: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        topic = _require_text(self.topic, "method topic")
        if "." not in topic:
            raise ProviderExportError("method topic must be fully qualified")
        summary = self.summary
        if not isinstance(summary, str):
            raise ProviderExportError("method summary must be a string")
        if self.exposure not in EXPOSURES:
            raise ProviderExportError(f"invalid method exposure {self.exposure!r}")
        if self.method_type not in METHOD_TYPES:
            raise ProviderExportError(f"invalid method_type {self.method_type!r}")
        permissions = self.required_permissions
        if permissions is not None:
            permissions = _validated_sorted_unique(permissions, "required_permissions")
        object.__setattr__(self, "topic", topic)
        object.__setattr__(self, "summary", summary)
        object.__setattr__(self, "required_permissions", permissions)
        object.__setattr__(
            self, "feature_ids", _validated_sorted_unique(self.feature_ids, "feature_ids")
        )
        object.__setattr__(
            self,
            "public_infrastructure",
            _require_bool(self.public_infrastructure, "public_infrastructure"),
        )
        object.__setattr__(
            self,
            "speech_constraints",
            _speech_constraints_mapping(self.speech_constraints),
        )
        raw_input_schema = self.input_schema
        raw_output_schema = self.output_schema
        object.__setattr__(self, "input_schema_present", raw_input_schema is not None)
        object.__setattr__(self, "output_schema_present", raw_output_schema is not None)
        object.__setattr__(self, "input_schema", _mapping_proxy(raw_input_schema))
        object.__setattr__(self, "output_schema", _mapping_proxy(raw_output_schema))
        object.__setattr__(
            self,
            "input_schema_hash",
            _schema_hash(raw_input_schema, self.input_schema_hash),
        )
        object.__setattr__(
            self,
            "output_schema_hash",
            _schema_hash(raw_output_schema, self.output_schema_hash),
        )

    @property
    def service_prefix(self) -> str:
        return self.topic.split(".", 1)[0]

    def to_canonical(self) -> dict[str, Any]:
        return {
            "exposure": self.exposure,
            "features": list(self.feature_ids),
            "input_model": self.input_model,
            "input_schema_digest": canonical_digest(self.input_schema)
            if self.input_schema_present
            else None,
            "input_schema_hash": self.input_schema_hash,
            "input_schema_present": self.input_schema_present,
            "method_type": self.method_type,
            "output_model": self.output_model,
            "output_schema_digest": canonical_digest(self.output_schema)
            if self.output_schema_present
            else None,
            "output_schema_hash": self.output_schema_hash,
            "output_schema_present": self.output_schema_present,
            "permissions": None
            if self.required_permissions is None
            else list(self.required_permissions),
            "public_infrastructure": self.public_infrastructure,
            "speech_constraints": _to_plain(self.speech_constraints)
            if self.speech_constraints is not None
            else None,
            "summary": self.summary,
            "topic": self.topic,
        }


@dataclass(frozen=True, slots=True)
class NormalizedServiceSnapshot:
    """Normalized immutable service metadata relevant to shadow provider export."""

    service_id: str
    version: str
    methods: tuple[NormalizedMethodSnapshot, ...]
    tags: tuple[str, ...] = ()
    capacity: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    feature_members: Mapping[str, tuple[str, ...]] | None = None
    capacity_present: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        service_id = _require_text(self.service_id, "service_id")
        version = _require_text(self.version, "service version")
        raw_capacity = self.capacity
        topics: set[str] = set()
        for method in self.methods:
            if method.topic in topics:
                raise ProviderExportError(f"duplicate method topic {method.topic!r}")
            topics.add(method.topic)
            if method.service_prefix != service_id:
                raise ProviderExportError(
                    f"method topic {method.topic!r} does not belong to service {service_id!r}"
                )
            _validate_public_infrastructure_method(service_id, method)

        members = _validate_feature_members(
            service_id=service_id,
            methods=self.methods,
            feature_members=self.feature_members or {},
        )
        object.__setattr__(self, "service_id", service_id)
        object.__setattr__(self, "version", version)
        object.__setattr__(
            self,
            "methods",
            tuple(sorted(self.methods, key=lambda item: item.topic)),
        )
        object.__setattr__(self, "tags", _validated_sorted_unique(self.tags, "tags"))
        object.__setattr__(self, "capacity_present", raw_capacity is not None)
        object.__setattr__(self, "capacity", _mapping_proxy(raw_capacity))
        object.__setattr__(self, "feature_members", MappingProxyType(members))

    def to_canonical(self) -> dict[str, Any]:
        return {
            "capacity": _to_plain(self.capacity),
            "capacity_present": self.capacity_present,
            "feature_members": _to_plain(self.feature_members),
            "methods": [method.to_canonical() for method in self.methods],
            "service_id": self.service_id,
            "tags": list(self.tags),
            "version": self.version,
        }


@dataclass(frozen=True, slots=True)
class RegistrySnapshot:
    """Normalized registry snapshot used as an explicit export input."""

    revision: str
    services: tuple[NormalizedServiceSnapshot, ...]
    digest: str | None = None

    def __post_init__(self) -> None:
        _require_text(self.revision, "registry revision")
        _require_digest(self.digest, "registry digest")
        service_ids: set[str] = set()
        topics: set[str] = set()
        for service in self.services:
            if service.service_id in service_ids:
                raise ProviderExportError(f"duplicate service_id {service.service_id!r}")
            service_ids.add(service.service_id)
            for method in service.methods:
                if method.topic in topics:
                    raise ProviderExportError(f"duplicate method topic {method.topic!r}")
                topics.add(method.topic)
        object.__setattr__(
            self,
            "services",
            tuple(sorted(self.services, key=lambda item: item.service_id)),
        )
        if self.digest is None:
            payload = {
                "revision": self.revision,
                "services": [service.to_canonical() for service in self.services],
            }
            object.__setattr__(self, "digest", canonical_digest(payload))

    def to_canonical(self) -> dict[str, Any]:
        return {
            "digest": self.digest,
            "revision": self.revision,
            "services": [service.to_canonical() for service in self.services],
        }


@dataclass(frozen=True, slots=True)
class ServiceExportPolicy:
    """Normalized service export policy for shadow projection filtering."""

    service_id: str
    share: bool
    unshared_feature_ids: tuple[str, ...] = ()
    unshared_method_ids: tuple[str, ...] = ()
    max_concurrent: int | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "service_id", _require_text(self.service_id, "policy service_id"))
        object.__setattr__(self, "share", _require_bool(self.share, "share"))
        object.__setattr__(
            self,
            "unshared_feature_ids",
            _validated_sorted_unique(self.unshared_feature_ids, "unshared_feature_ids"),
        )
        object.__setattr__(
            self,
            "unshared_method_ids",
            _validated_sorted_unique(self.unshared_method_ids, "unshared_method_ids"),
        )
        object.__setattr__(
            self,
            "max_concurrent",
            _require_optional_capacity(self.max_concurrent, "max_concurrent"),
        )

    def to_canonical(self) -> dict[str, Any]:
        return {
            "max_concurrent": self.max_concurrent,
            "service_id": self.service_id,
            "share": self.share,
            "unshared_feature_ids": list(self.unshared_feature_ids),
            "unshared_method_ids": list(self.unshared_method_ids),
        }


@dataclass(frozen=True, slots=True)
class PolicySnapshot:
    """Normalized export policy snapshot."""

    revision: str
    services: tuple[ServiceExportPolicy, ...]
    digest: str | None = None

    def __post_init__(self) -> None:
        _require_text(self.revision, "policy revision")
        _require_digest(self.digest, "policy digest")
        service_ids: set[str] = set()
        for service in self.services:
            if service.service_id in service_ids:
                raise ProviderExportError(f"duplicate policy service_id {service.service_id!r}")
            service_ids.add(service.service_id)
        object.__setattr__(
            self,
            "services",
            tuple(sorted(self.services, key=lambda item: item.service_id)),
        )
        if self.digest is None:
            payload = {
                "revision": self.revision,
                "services": [service.to_canonical() for service in self.services],
            }
            object.__setattr__(self, "digest", canonical_digest(payload))

    def service_policy(self, service_id: str) -> ServiceExportPolicy:
        policies = {policy.service_id: policy for policy in self.services}
        return policies.get(service_id, ServiceExportPolicy(service_id=service_id, share=False))

    def to_canonical(self) -> dict[str, Any]:
        return {
            "digest": self.digest,
            "revision": self.revision,
            "services": [service.to_canonical() for service in self.services],
        }


@dataclass(frozen=True, slots=True)
class GrantEvidence:
    """Canonical recipient grant evidence."""

    permission: str
    source: str = "effective"

    def __post_init__(self) -> None:
        object.__setattr__(self, "permission", _require_text(self.permission, "grant permission"))
        object.__setattr__(self, "source", _require_text(self.source, "grant source"))

    def to_canonical(self) -> dict[str, Any]:
        return {"permission": self.permission, "source": self.source}


@dataclass(frozen=True, slots=True)
class RecipientEvidence:
    """Recipient-specific authorization evidence for a shadow projection."""

    peer_id: str
    revision: int
    grants: tuple[GrantEvidence, ...] | None = None
    digest: str | None = None
    state: AuthorityState = "active"

    def __post_init__(self) -> None:
        object.__setattr__(self, "peer_id", _require_text(self.peer_id, "recipient peer_id"))
        object.__setattr__(self, "revision", _require_revision(self.revision, "authority revision"))
        _require_digest(self.digest, "authority digest")
        if self.state not in {"unknown", "pending", "active", "revoked"}:
            raise ProviderExportError(f"invalid authority state {self.state!r}")
        if self.grants is None:
            grants = None
        else:
            seen: set[str] = set()
            normalized: list[GrantEvidence] = []
            for grant in self.grants:
                if grant.permission in seen:
                    raise ProviderExportError(f"duplicate grant {grant.permission!r}")
                seen.add(grant.permission)
                normalized.append(grant)
            grants = tuple(sorted(normalized, key=lambda item: (item.permission, item.source)))
        object.__setattr__(self, "grants", grants)
        if self.digest is None:
            object.__setattr__(
                self,
                "digest",
                canonical_digest(self.to_canonical(include_digest=False)),
            )

    @property
    def readiness(self) -> ReadinessState:
        if self.state == "unknown":
            return "unknown"
        if self.state == "pending":
            return "pending"
        if self.state == "revoked":
            return "revoked"
        if self.grants is None:
            return "unknown"
        return "ready"

    @property
    def effective_permissions(self) -> set[str] | None:
        if self.grants is None or self.state != "active":
            return None
        return {grant.permission for grant in self.grants}

    def to_canonical(self, *, include_digest: bool = True) -> dict[str, Any]:
        payload = {
            "grants": None
            if self.grants is None
            else [grant.to_canonical() for grant in self.grants],
            "peer_id": self.peer_id,
            "readiness": self.readiness,
            "revision": self.revision,
            "state": self.state,
        }
        if include_digest:
            payload["digest"] = self.digest
        return payload


@dataclass(frozen=True, slots=True)
class ProtocolEvidence:
    """Protocol evidence for active recipient-filtered projection keys."""

    active_protocol: str = ACTIVE_MANIFEST_PROTOCOL
    active_version: str = "v1"
    active_tier: str = "projection"
    supported_protocols: tuple[str, ...] = SUPPORTED_PROTOCOLS
    shadow_protocol: str = SUPPORTED_SHADOW_PROTOCOL
    evidence_state: Literal["shadow", "refreshed", "active"] = "active"
    evidence_revision: int = 0
    projection_supported: bool = True
    projection_active: bool = True

    def __post_init__(self) -> None:
        if self.active_protocol != ACTIVE_MANIFEST_PROTOCOL:
            raise ProviderExportError("active manifest protocol must be projection-v1")
        if self.active_version != "v1":
            raise ProviderExportError("active manifest version must be v1")
        if self.active_tier != "projection":
            raise ProviderExportError("active manifest tier must be projection")
        if self.shadow_protocol != SUPPORTED_SHADOW_PROTOCOL:
            raise ProviderExportError("projection protocol must be projection-v1")
        protocols = _validated_sorted_unique(self.supported_protocols, "supported_protocols")
        if protocols != SUPPORTED_PROTOCOLS:
            raise ProviderExportError(
                "supported protocols must be legacy-unfiltered-v0 and projection-v1"
            )
        if self.evidence_state not in {"shadow", "refreshed", "active"}:
            raise ProviderExportError("invalid protocol evidence_state")
        object.__setattr__(
            self,
            "evidence_revision",
            _require_revision(self.evidence_revision, "protocol evidence revision"),
        )
        if self.projection_supported is not True:
            raise ProviderExportError("projection-v1 support must be true")
        if self.projection_active is not True:
            raise ProviderExportError("projection-v1 must be active")
        object.__setattr__(self, "supported_protocols", protocols)

    def to_canonical(self) -> dict[str, Any]:
        return {
            "active_protocol": self.active_protocol,
            "active_tier": self.active_tier,
            "active_version": self.active_version,
            "evidence_revision": self.evidence_revision,
            "evidence_state": self.evidence_state,
            "projection_active": self.projection_active,
            "projection_supported": self.projection_supported,
            "shadow_protocol": self.shadow_protocol,
            "supported_protocols": list(self.supported_protocols),
        }


@dataclass(frozen=True, slots=True)
class ExportedMethod:
    """Projected method metadata authorized for one recipient."""

    topic: str
    exposure: str
    method_type: str
    required_permissions: MethodPermissions
    summary: str
    input_model: str | None
    output_model: str | None
    input_schema_hash: str | None
    output_schema_hash: str | None
    input_schema: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    output_schema: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    feature_ids: tuple[str, ...] = ()
    public_infrastructure: bool = False
    speech_constraints: Mapping[str, Any] | SpeechMethodConstraints | None = field(
        default=None, repr=False, compare=False
    )
    input_schema_present: bool = field(default=False, init=False)
    output_schema_present: bool = field(default=False, init=False)

    @classmethod
    def from_snapshot(cls, method: NormalizedMethodSnapshot) -> ExportedMethod:
        return cls(
            topic=method.topic,
            exposure=method.exposure,
            method_type=method.method_type,
            required_permissions=method.required_permissions,
            summary=method.summary,
            input_model=method.input_model,
            output_model=method.output_model,
            input_schema=method.input_schema if method.input_schema_present else None,
            output_schema=method.output_schema if method.output_schema_present else None,
            input_schema_hash=method.input_schema_hash,
            output_schema_hash=method.output_schema_hash,
            feature_ids=method.feature_ids,
            public_infrastructure=method.public_infrastructure,
            speech_constraints=method.speech_constraints,
        )

    def __post_init__(self) -> None:
        permissions = self.required_permissions
        if permissions is not None:
            permissions = _validated_sorted_unique(permissions, "export required_permissions")
        if not isinstance(self.summary, str):
            raise ProviderExportError("export summary must be a string")
        object.__setattr__(self, "summary", self.summary)
        object.__setattr__(self, "required_permissions", permissions)
        object.__setattr__(
            self, "feature_ids", _validated_sorted_unique(self.feature_ids, "export feature_ids")
        )
        raw_input_schema = self.input_schema
        raw_output_schema = self.output_schema
        object.__setattr__(self, "input_schema_present", raw_input_schema is not None)
        object.__setattr__(self, "output_schema_present", raw_output_schema is not None)
        object.__setattr__(self, "input_schema", _mapping_proxy(raw_input_schema))
        object.__setattr__(self, "output_schema", _mapping_proxy(raw_output_schema))
        object.__setattr__(
            self,
            "public_infrastructure",
            _require_bool(self.public_infrastructure, "export public_infrastructure"),
        )
        object.__setattr__(
            self,
            "speech_constraints",
            _speech_constraints_mapping(self.speech_constraints),
        )

    def to_canonical(self) -> dict[str, Any]:
        return {
            "exposure": self.exposure,
            "feature_ids": list(self.feature_ids),
            "input_model": self.input_model,
            "input_schema": _to_plain(self.input_schema) if self.input_schema_present else None,
            "input_schema_hash": self.input_schema_hash,
            "input_schema_present": self.input_schema_present,
            "method_type": self.method_type,
            "output_model": self.output_model,
            "output_schema": _to_plain(self.output_schema) if self.output_schema_present else None,
            "output_schema_hash": self.output_schema_hash,
            "output_schema_present": self.output_schema_present,
            "public_infrastructure": self.public_infrastructure,
            "required_permissions": None
            if self.required_permissions is None
            else list(self.required_permissions),
            "speech_constraints": _to_plain(self.speech_constraints)
            if self.speech_constraints is not None
            else None,
            "summary": self.summary,
            "topic": self.topic,
        }


@dataclass(frozen=True, slots=True)
class ExportedService:
    """Projected service metadata without zero-method services."""

    service_id: str
    version: str
    methods: tuple[ExportedMethod, ...]
    tags: tuple[str, ...] = ()
    capacity: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    feature_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "methods",
            tuple(sorted(self.methods, key=lambda item: item.topic)),
        )
        object.__setattr__(self, "tags", _validated_sorted_unique(self.tags, "export tags"))
        object.__setattr__(self, "capacity", _mapping_proxy(self.capacity))
        object.__setattr__(
            self, "feature_ids", _validated_sorted_unique(self.feature_ids, "export feature_ids")
        )

    def to_canonical(self) -> dict[str, Any]:
        return {
            "capacity": _to_plain(self.capacity),
            "feature_ids": list(self.feature_ids),
            "methods": [method.to_canonical() for method in self.methods],
            "service_id": self.service_id,
            "tags": list(self.tags),
            "version": self.version,
        }


@dataclass(frozen=True, slots=True)
class _ProjectionEvent:
    """Private event with identifiers used only to compute redacted digests."""

    service_id: str
    reason: ReasonCode
    topic: str | None = None

    def to_canonical(self) -> dict[str, Any]:
        return {"reason": self.reason, "service": self.service_id, "topic": self.topic}


@dataclass(frozen=True, slots=True)
class ReasonCount:
    """Public redacted reason aggregate."""

    reason: ReasonCode
    count: int

    def to_canonical(self) -> dict[str, Any]:
        return {"count": self.count, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class ProjectionDiff:
    """Public redacted structured diff.

    This object exposes counts, fixed reason-code counts, and deterministic
    digests only. It does not expose removed service IDs, removed topic names,
    included IDs, raw permissions, raw grants, schemas, payloads, or free text.
    """

    excluded_count: int
    included_service_count: int
    included_method_count: int
    reason_counts: tuple[ReasonCount, ...]
    excluded_digest: str
    included_digest: str

    @classmethod
    def from_projection(
        cls,
        *,
        excluded: tuple[_ProjectionEvent, ...],
        included_services: tuple[ExportedService, ...],
    ) -> ProjectionDiff:
        reason_counter = Counter(event.reason for event in excluded)
        included_methods = tuple(
            method.topic for service in included_services for method in service.methods
        )
        return cls(
            excluded_count=len(excluded),
            included_service_count=len(included_services),
            included_method_count=len(included_methods),
            reason_counts=tuple(
                ReasonCount(reason=reason, count=reason_counter[reason])
                for reason in sorted(reason_counter)
            ),
            excluded_digest=canonical_digest(tuple(sorted(excluded, key=_event_key))),
            included_digest=canonical_digest(
                {
                    "methods": sorted(included_methods),
                    "services": sorted(service.service_id for service in included_services),
                }
            ),
        )

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "reason_counts",
            tuple(sorted(self.reason_counts, key=lambda item: item.reason)),
        )
        _require_digest(self.excluded_digest, "excluded diff digest")
        _require_digest(self.included_digest, "included diff digest")

    def to_canonical(self) -> dict[str, Any]:
        return {
            "excluded_count": self.excluded_count,
            "excluded_digest": self.excluded_digest,
            "included_digest": self.included_digest,
            "included_method_count": self.included_method_count,
            "included_service_count": self.included_service_count,
            "reason_counts": [count.to_canonical() for count in self.reason_counts],
        }


@dataclass(frozen=True, slots=True)
class ProviderExportCacheKey:
    """Complete provider/recipient-specific cache key for a shadow projection."""

    provider_peer_id: str
    recipient_peer_id: str
    protocol: ProtocolEvidence
    registry_revision: str
    registry_digest: str
    policy_revision: str
    policy_digest: str
    authority_revision: int
    authority_digest: str
    grants_digest: str
    registry_content_digest: str
    policy_content_digest: str
    authority_content_digest: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "provider_peer_id", _require_text(self.provider_peer_id, "provider_peer_id")
        )
        object.__setattr__(
            self, "recipient_peer_id", _require_text(self.recipient_peer_id, "recipient_peer_id")
        )

    def to_canonical(self) -> dict[str, Any]:
        return {
            "authority_content_digest": self.authority_content_digest,
            "authority_digest": self.authority_digest,
            "authority_revision": self.authority_revision,
            "grants_digest": self.grants_digest,
            "policy_content_digest": self.policy_content_digest,
            "policy_digest": self.policy_digest,
            "policy_revision": self.policy_revision,
            "protocol": self.protocol.to_canonical(),
            "provider_peer_id": self.provider_peer_id,
            "recipient_peer_id": self.recipient_peer_id,
            "registry_content_digest": self.registry_content_digest,
            "registry_digest": self.registry_digest,
            "registry_revision": self.registry_revision,
        }

    @property
    def digest(self) -> str:
        return canonical_digest(self)


@dataclass(frozen=True, slots=True)
class ProjectionResult:
    """Provider export projection result for one authenticated recipient."""

    cache_key: ProviderExportCacheKey
    services: tuple[ExportedService, ...]
    diff: ProjectionDiff
    canonical: bytes
    digest: str
    readiness: ReadinessState
    grants: tuple[GrantEvidence, ...] | None = None
    effective_manifest_protocol: str = ACTIVE_MANIFEST_PROTOCOL
    shadow_protocol: str = SUPPORTED_SHADOW_PROTOCOL
    routable: bool = False

    def to_canonical(self) -> dict[str, Any]:
        return {
            "diff": self.diff.to_canonical(),
            "effective_manifest_protocol": self.effective_manifest_protocol,
            "readiness": self.readiness,
            "routable": self.routable,
            "grants": None
            if self.grants is None
            else [grant.to_canonical() for grant in self.grants],
            "services": [service.to_canonical() for service in self.services],
            "shadow_protocol": self.shadow_protocol,
        }


@dataclass(frozen=True, slots=True)
class _AuthorityTracker:
    revision: int
    authority_digest: str
    grants_digest: str
    authority_content_digest: str


@dataclass(slots=True)
class PeerProviderExportCache:
    """Provider/recipient-isolated in-memory state for shadow projections."""

    _entries: dict[str, dict[str, dict[str, ProjectionResult]]] = field(default_factory=dict)
    _authority: dict[tuple[str, str], _AuthorityTracker] = field(default_factory=dict)

    def project(
        self,
        *,
        provider_peer_id: str,
        registry: RegistrySnapshot,
        policy: PolicySnapshot,
        recipient: RecipientEvidence,
        protocol: ProtocolEvidence | None = None,
    ) -> ProjectionResult:
        provider_peer_id = _require_text(provider_peer_id, "provider_peer_id")
        protocol = protocol or ProtocolEvidence()
        key = build_cache_key(
            provider_peer_id=provider_peer_id,
            registry=registry,
            policy=policy,
            recipient=recipient,
            protocol=protocol,
        )
        self._accept_authority_or_raise(key)
        provider_cache = self._entries.setdefault(provider_peer_id, {})
        recipient_cache = provider_cache.setdefault(recipient.peer_id, {})
        if key.digest not in recipient_cache:
            recipient_cache[key.digest] = project_provider_export(
                provider_peer_id=provider_peer_id,
                registry=registry,
                policy=policy,
                recipient=recipient,
                protocol=protocol,
                cache_key=key,
            )
        return recipient_cache[key.digest]

    def invalidate_peer(
        self, recipient_peer_id: str, *, provider_peer_id: str | None = None
    ) -> int:
        """Invalidate one recipient's projection entries only."""
        recipient_peer_id = _require_text(recipient_peer_id, "recipient_peer_id")
        removed = 0
        if provider_peer_id is not None:
            provider_peer_id = _require_text(provider_peer_id, "provider_peer_id")
            removed += len(self._entries.get(provider_peer_id, {}).pop(recipient_peer_id, {}))
            return removed
        for recipient_entries in self._entries.values():
            removed += len(recipient_entries.pop(recipient_peer_id, {}))
        return removed

    def invalidate_all(self) -> int:
        """Clear all cached projection entries only."""
        removed = self.total_entry_count()
        self._entries.clear()
        return removed

    def trusted_reset_authority_peer(
        self, recipient_peer_id: str, *, provider_peer_id: str | None = None
    ) -> int:
        """Clear trusted authority watermarks for durable-authority reloads."""
        recipient_peer_id = _require_text(recipient_peer_id, "recipient_peer_id")
        if provider_peer_id is not None:
            provider_peer_id = _require_text(provider_peer_id, "provider_peer_id")
            return int(self._authority.pop((provider_peer_id, recipient_peer_id), None) is not None)
        removed = 0
        for tracker_key in tuple(self._authority):
            if tracker_key[1] == recipient_peer_id:
                self._authority.pop(tracker_key, None)
                removed += 1
        return removed

    def trusted_reset_all_authority(self) -> int:
        """Clear all trusted authority watermarks for durable-authority reloads."""
        removed = len(self._authority)
        self._authority.clear()
        return removed

    def peer_entry_count(
        self, recipient_peer_id: str, *, provider_peer_id: str | None = None
    ) -> int:
        if provider_peer_id is not None:
            return len(self._entries.get(provider_peer_id, {}).get(recipient_peer_id, {}))
        return sum(
            len(recipient_entries.get(recipient_peer_id, {}))
            for recipient_entries in self._entries.values()
        )

    def total_entry_count(self) -> int:
        return sum(
            len(entries)
            for recipient_entries in self._entries.values()
            for entries in recipient_entries.values()
        )

    def _accept_authority_or_raise(self, key: ProviderExportCacheKey) -> None:
        tracker_key = (key.provider_peer_id, key.recipient_peer_id)
        next_tracker = _AuthorityTracker(
            revision=key.authority_revision,
            authority_digest=key.authority_digest,
            grants_digest=key.grants_digest,
            authority_content_digest=key.authority_content_digest,
        )
        current = self._authority.get(tracker_key)
        if current is None:
            self._authority[tracker_key] = next_tracker
            return
        if key.authority_revision < current.revision:
            raise StaleAuthorityRevisionError("stale authority revision")
        if key.authority_revision == current.revision:
            if next_tracker != current:
                raise ConflictingAuthorityRevisionError(
                    "conflicting authority evidence at same revision"
                )
            return
        self._entries.setdefault(key.provider_peer_id, {}).pop(key.recipient_peer_id, None)
        self._authority[tracker_key] = next_tracker


def build_cache_key(
    *,
    provider_peer_id: str,
    registry: RegistrySnapshot,
    policy: PolicySnapshot,
    recipient: RecipientEvidence,
    protocol: ProtocolEvidence,
) -> ProviderExportCacheKey:
    """Build a complete key from provider, recipient, revisions, grants, and content."""
    authority_content = recipient.to_canonical(include_digest=False)
    return ProviderExportCacheKey(
        provider_peer_id=provider_peer_id,
        recipient_peer_id=recipient.peer_id,
        protocol=protocol,
        registry_revision=registry.revision,
        registry_digest=registry.digest or "",
        policy_revision=policy.revision,
        policy_digest=policy.digest or "",
        authority_revision=recipient.revision,
        authority_digest=recipient.digest or "",
        grants_digest=canonical_digest(
            {
                "grants": None
                if recipient.grants is None
                else [grant.to_canonical() for grant in recipient.grants]
            }
        ),
        registry_content_digest=canonical_digest(registry),
        policy_content_digest=canonical_digest(policy),
        authority_content_digest=canonical_digest(authority_content),
    )


def project_provider_export(
    *,
    provider_peer_id: str,
    registry: RegistrySnapshot,
    policy: PolicySnapshot,
    recipient: RecipientEvidence,
    protocol: ProtocolEvidence | None = None,
    cache_key: ProviderExportCacheKey | None = None,
) -> ProjectionResult:
    """Project a recipient-filtered shadow provider export.

    The fixed gate order is: service share, exportable exposure, unshared
    feature IDs, exact unshared method IDs, public-infrastructure exclusion,
    then recipient RBAC.
    """
    provider_peer_id = _require_text(provider_peer_id, "provider_peer_id")
    protocol = protocol or ProtocolEvidence()
    expected_cache_key = build_cache_key(
        provider_peer_id=provider_peer_id,
        registry=registry,
        policy=policy,
        recipient=recipient,
        protocol=protocol,
    )
    if cache_key is None:
        cache_key = expected_cache_key
    elif cache_key.to_canonical() != expected_cache_key.to_canonical():
        raise ProviderExportError("supplied provider export cache key does not match inputs")
    exported_services: list[ExportedService] = []
    excluded: list[_ProjectionEvent] = []

    for service in registry.services:
        service_policy = policy.service_policy(service.service_id)
        if not service_policy.share:
            excluded.append(
                _ProjectionEvent(service_id=service.service_id, reason="service_not_shared")
            )
            continue

        unshared_features = set(service_policy.unshared_feature_ids)
        unshared_methods = set(service_policy.unshared_method_ids)
        surviving_methods: list[NormalizedMethodSnapshot] = []

        for method in service.methods:
            reason = _method_exclusion_reason(
                method=method,
                unshared_features=unshared_features,
                unshared_methods=unshared_methods,
                recipient=recipient,
            )
            if reason is None:
                surviving_methods.append(method)
            else:
                excluded.append(
                    _ProjectionEvent(
                        service_id=service.service_id,
                        topic=method.topic,
                        reason=reason,
                    )
                )

        if not surviving_methods:
            continue

        surviving_topics = {method.topic for method in surviving_methods}
        available_features = tuple(
            feature_id
            for feature_id, members in service.feature_members.items()
            if feature_id not in unshared_features and set(members).issubset(surviving_topics)
        )
        exported_services.append(
            ExportedService(
                service_id=service.service_id,
                version=service.version,
                methods=tuple(ExportedMethod.from_snapshot(method) for method in surviving_methods),
                tags=service.tags,
                capacity=_project_service_capacity(service, service_policy),
                feature_ids=available_features,
            )
        )

    services = tuple(sorted(exported_services, key=lambda item: item.service_id))
    diff = ProjectionDiff.from_projection(excluded=tuple(excluded), included_services=services)
    projection_payload = {
        "diff": diff,
        "effective_manifest_protocol": ACTIVE_MANIFEST_PROTOCOL,
        "readiness": recipient.readiness,
        "routable": recipient.readiness == "ready",
        "grants": recipient.grants,
        "services": services,
        "shadow_protocol": SUPPORTED_SHADOW_PROTOCOL,
    }
    projection_bytes = canonical_bytes(projection_payload)
    authority_bound_digest = canonical_digest(
        {
            "cache_key": cache_key,
            "projection_payload_digest": sha256(projection_bytes).hexdigest(),
        }
    )
    return ProjectionResult(
        cache_key=cache_key,
        services=services,
        diff=diff,
        canonical=projection_bytes,
        digest=authority_bound_digest,
        readiness=recipient.readiness,
        grants=recipient.grants,
        routable=recipient.readiness == "ready",
    )


def _project_service_capacity(
    service: NormalizedServiceSnapshot,
    service_policy: ServiceExportPolicy,
) -> Mapping[str, Any] | None:
    capacity = dict(service.capacity)
    if service_policy.max_concurrent is not None:
        capacity["max_concurrent"] = service_policy.max_concurrent
    if capacity:
        return capacity
    return {} if service.capacity_present or service_policy.max_concurrent is not None else None


def _method_exclusion_reason(
    *,
    method: NormalizedMethodSnapshot,
    unshared_features: set[str],
    unshared_methods: set[str],
    recipient: RecipientEvidence,
) -> ReasonCode | None:
    if method.exposure not in EXPORTABLE_EXPOSURES:
        return "exposure_not_exportable"
    if unshared_features.intersection(method.feature_ids):
        return "feature_unshared"
    if method.topic in unshared_methods:
        return "method_unshared"
    if method.public_infrastructure:
        return "public_infrastructure_excluded"
    if method.required_permissions is None:
        return "permissions_unknown"
    if not method.required_permissions:
        return "permissions_empty"
    if recipient.state == "pending":
        return "authority_pending"
    if recipient.state == "revoked":
        return "authority_revoked"
    if recipient.grants is None or recipient.state == "unknown":
        return "authority_unknown"
    if not recipient.grants:
        return "permissions_denied"
    effective_permissions = recipient.effective_permissions
    if effective_permissions is None:
        return "authority_unknown"
    allowed = check_access(
        effective_permissions,
        list(method.required_permissions),
        method_type=method.method_type,
    )
    if not allowed:
        return "permissions_denied"
    return None


def _validate_public_infrastructure_method(
    service_id: str,
    method: NormalizedMethodSnapshot,
) -> None:
    if not method.public_infrastructure and method.topic not in PUBLIC_INFRASTRUCTURE_TOPICS:
        return
    wire_method = _WireMethod(
        module=service_id,
        name=method.topic.split(".", 1)[1],
        bus_topic=method.topic,
        exposure=method.exposure,
        required_perms=[]
        if method.required_permissions is None
        else list(method.required_permissions),
        callable_feature_ids=list(method.feature_ids),
        callable_features=[],
        public_infrastructure=method.public_infrastructure,
    )
    violations = validate_callable_method_surface(wire_method, module=service_id)
    if violations:
        raise ProviderExportError("; ".join(violations))
    if method.public_infrastructure and method.required_permissions != ():
        raise ProviderExportError("public infrastructure must use known empty required permissions")
    if method.topic in PUBLIC_INFRASTRUCTURE_TOPICS and not method.public_infrastructure:
        raise ProviderExportError(f"{method.topic} missing public_infrastructure marker")


def _validate_feature_members(
    *,
    service_id: str,
    methods: tuple[NormalizedMethodSnapshot, ...],
    feature_members: Mapping[str, tuple[str, ...]],
) -> dict[str, tuple[str, ...]]:
    by_topic = {method.topic: method for method in methods}
    normalized: dict[str, tuple[str, ...]] = {}
    for feature_id, raw_members in sorted(feature_members.items()):
        feature = _require_text(feature_id, "feature_id")
        if feature in normalized:
            raise ProviderExportError(f"duplicate feature_id {feature!r}")
        members = _validated_sorted_unique(raw_members, f"feature_members[{feature}]")
        if not members:
            raise ProviderExportError(f"feature_members[{feature}] must not be empty")
        for topic in members:
            if not topic.startswith(f"{service_id}."):
                raise ProviderExportError(f"feature member {topic!r} crosses service boundary")
            method = by_topic.get(topic)
            if method is None:
                raise ProviderExportError(f"feature member {topic!r} is unknown")
            if feature not in method.feature_ids:
                raise ProviderExportError(
                    f"method {topic!r} does not declare canonical feature {feature!r}"
                )
        normalized[feature] = members

    for method in methods:
        for feature in method.feature_ids:
            if feature not in normalized:
                raise ProviderExportError(
                    f"method {method.topic!r} declares unknown feature {feature!r}"
                )
            if method.topic not in normalized[feature]:
                raise ProviderExportError(
                    f"method {method.topic!r} feature membership is inconsistent for {feature!r}"
                )
    return dict(sorted(normalized.items()))


def _event_key(event: _ProjectionEvent) -> tuple[str, str, str]:
    return (event.service_id, event.topic or "", event.reason)


@dataclass(frozen=True, slots=True)
class _WireMethod:
    module: str
    name: str
    bus_topic: str
    exposure: str
    required_perms: list[str]
    callable_feature_ids: list[str]
    callable_features: list[Any]
    public_infrastructure: bool

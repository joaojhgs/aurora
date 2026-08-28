"""Negotiation protocol for P2P mesh manifest exchange.

Handles:
- Generating local manifests from the contract registry filtered by sharing config
- Processing incoming peer manifests
- Generating manifest acknowledgments with compatibility reports
"""

from __future__ import annotations

import contextlib
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Literal

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.services.gateway.mesh.policy_store import MeshPolicySnapshot
from app.services.gateway.mesh.provider_eligibility import (
    OutboundProviderSnapshot,
    OutboundRouteRequirements,
    evaluate_outbound_provider,
)
from app.services.gateway.mesh.provider_export import (
    ACTIVE_MANIFEST_PROTOCOL,
    LEGACY_MANIFEST_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    SUPPORTED_SHADOW_PROTOCOL,
    ExportedMethod,
    GrantEvidence,
    NormalizedMethodSnapshot,
    NormalizedServiceSnapshot,
    ProjectionResult,
    RecipientEvidence,
    RegistrySnapshot,
    canonical_digest,
)
from app.shared.contracts.mesh_surface import (
    MESH_CAPABLE_MODULES,
    feature_contracts_for_module,
    feature_contracts_for_topic,
    validate_callable_method_surface,
)
from app.shared.contracts.models.gateway import MethodInfo
from app.shared.contracts.registry import validate_canonical_taxonomy

from .models import (
    ManifestAck,
    ManifestGrantEvidence,
    ManifestServiceCompatibility,
    PeerManifest,
    PeerServiceInfo,
    RecipientProjectionEvidence,
)

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig
    from app.services.gateway.registry_aggregator import RegistryAggregator


ParseStatus = Literal[
    "legacy_unverifiable",
    "verified",
    "permissions_unknown",
    "invalid",
    "unsupported",
]


@dataclass(frozen=True, slots=True)
class ManifestParseResult:
    """Evidence-aware manifest parse result used before mesh side effects."""

    manifest: PeerManifest | None
    status: ParseStatus
    usable: bool
    reason_code: str

    @property
    def ok(self) -> bool:
        return self.usable

    @property
    def reason(self) -> str:
        return self.reason_code


def generate_manifest(
    peer_id: str,
    mesh_config: MeshConfig,
    registry: RegistryAggregator | None = None,
    granted_permissions: list[str] | None = None,
) -> PeerManifest:
    """Generate the local capability manifest for sharing with peers.

    Reads the contract registry and filters by the mesh sharing configuration,
    only including services that are explicitly marked as ``share: true``.

    Args:
        peer_id: This node's peer ID
        mesh_config: Mesh configuration with sharing rules
        registry: Optional registry aggregator (for process mode).
                  If None, uses the global in-process registry.

    Returns:
        PeerManifest describing the services this node is willing to share
    """
    from app.shared.contracts.registry import _get_package_version, list_modules

    validate_canonical_taxonomy()

    shared_services: list[PeerServiceInfo] = []

    # In process mode the RegistryAggregator holds announcements from all
    # services (received via the bus).  In thread mode every service lives
    # in the same process, so the in-memory list_modules() is authoritative.
    if registry is not None:
        shared_services = _build_services_from_aggregator(registry, mesh_config)
    else:
        modules = list_modules()
        shared_services = _build_services_from_local(modules, mesh_config)

    aurora_version = _get_package_version()

    del granted_permissions
    manifest = PeerManifest(
        peer_id=peer_id,
        node_name=mesh_config.node_name,
        aurora_version=aurora_version,
        shared_services=shared_services,
        granted_permissions=None,
        active_protocol=LEGACY_MANIFEST_PROTOCOL,
        active_version="v0",
        active_tier="legacy",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=False,
        recipient_projection_evidence=None,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )

    log_info(
        f"Mesh: Generated manifest with {len(shared_services)} shared services: "
        f"{[s.module for s in shared_services]}"
    )
    return manifest


# ── Helpers for manifest generation ──────────────────────────────────────


def _build_services_from_local(
    modules: dict,
    mesh_config: MeshConfig,
) -> list[PeerServiceInfo]:
    """Build shared service list from the in-process contract registry.

    Used in **thread mode** where all services live in the same process.
    """
    shared: list[PeerServiceInfo] = []

    for module_name, module_contract in modules.items():
        sharing_config = mesh_config.services.get(module_name)
        if not sharing_config or not sharing_config.export.share:
            continue

        from app.shared.contracts.mesh_surface import callable_method_advertisable

        methods: list[MethodInfo] = []
        for mc in module_contract.methods:
            if not callable_method_advertisable(mc):
                raise ValueError(f"Invalid callable method in {module_name} registry: {mc.name}")
            if mc.exposure in ("external", "both"):
                input_schema = None
                output_schema = None
                if mc.input_model is not None:
                    with contextlib.suppress(Exception):
                        input_schema = mc.input_model.model_json_schema()
                if mc.output_model is not None:
                    with contextlib.suppress(Exception):
                        output_schema = mc.output_model.model_json_schema()
                methods.append(
                    MethodInfo(
                        name=mc.name,
                        summary=mc.summary,
                        bus_topic=mc.bus_topic or f"{module_name}.{mc.name}",
                        exposure=mc.exposure,
                        required_perms=mc.required_perms,
                        input_model=mc.input_model.__name__ if mc.input_model else None,
                        output_model=mc.output_model.__name__ if mc.output_model else None,
                        method_type=mc.method_type,
                        callable_feature_ids=mc.callable_feature_ids,
                        callable_features=list(getattr(mc, "callable_features", []) or []),
                        public_infrastructure=bool(getattr(mc, "public_infrastructure", False)),
                        speech_constraints=getattr(mc, "speech_constraints", None),
                        input_schema=input_schema,
                        output_schema=output_schema,
                    )
                )

        module_features = list(getattr(module_contract, "callable_features", []) or [])
        _validate_service_feature_objects(
            module=module_name,
            callable_features=module_features,
            methods=methods,
        )
        service = PeerServiceInfo(
            module=module_name,
            version=module_contract.version,
            capabilities=module_contract.capabilities,
            callable_features=module_features,
            available_feature_ids=sorted(feature.feature_id for feature in module_features),
            methods=methods,
            max_concurrent=sharing_config.export.max_concurrent,
        )
        service.digest = _compute_service_digest(service)
        shared.append(service)

    return shared


def registry_snapshot_from_local_contracts(revision: str = "local") -> RegistrySnapshot:
    """Build the normalized provider-export registry snapshot for thread mode."""

    from app.shared.contracts.registry import list_modules

    services: list[NormalizedServiceSnapshot] = []
    for module_name, module_contract in sorted(list_modules().items()):
        methods: list[NormalizedMethodSnapshot] = []
        raw_methods = list(module_contract.methods)
        method_topics = {str(mc.bus_topic or f"{module_name}.{mc.name}") for mc in raw_methods}
        feature_members: dict[str, tuple[str, ...]] = {}
        for feature in getattr(module_contract, "callable_features", []) or []:
            members = tuple(str(item) for item in feature.method_ids if str(item) in method_topics)
            if members:
                feature_members[str(feature.feature_id)] = members
        for mc in raw_methods:
            input_schema = None
            output_schema = None
            if getattr(mc, "input_model", None) is not None:
                with contextlib.suppress(Exception):
                    input_schema = mc.input_model.model_json_schema()
            if getattr(mc, "output_model", None) is not None:
                with contextlib.suppress(Exception):
                    output_schema = mc.output_model.model_json_schema()
            methods.append(
                NormalizedMethodSnapshot(
                    topic=mc.bus_topic or f"{module_name}.{mc.name}",
                    exposure=mc.exposure,
                    method_type=mc.method_type,
                    required_permissions=tuple(mc.required_perms)
                    if mc.required_perms is not None
                    else None,
                    summary=mc.summary,
                    input_model=mc.input_model.__name__ if mc.input_model else None,
                    output_model=mc.output_model.__name__ if mc.output_model else None,
                    input_schema=input_schema,
                    output_schema=output_schema,
                    feature_ids=tuple(mc.callable_feature_ids or ()),
                    public_infrastructure=bool(getattr(mc, "public_infrastructure", False)),
                    speech_constraints=getattr(mc, "speech_constraints", None),
                )
            )
        services.append(
            NormalizedServiceSnapshot(
                service_id=module_name,
                version=module_contract.version,
                tags=tuple(module_contract.capabilities),
                methods=tuple(methods),
                feature_members=feature_members,
            )
        )
    return RegistrySnapshot(revision=revision, services=tuple(services))


def _build_services_from_aggregator(
    registry: RegistryAggregator,
    mesh_config: MeshConfig,
) -> list[PeerServiceInfo]:
    """Build shared service list from the RegistryAggregator.

    Used in **process mode** where services run as separate processes and
    announce themselves via the bus.  The aggregator holds the latest
    ``ServiceAnnouncement`` from each service.
    """
    snapshot_reader = getattr(registry, "snapshot_registry", None)
    if callable(snapshot_reader):
        return _build_services_from_registry_snapshot(snapshot_reader(), mesh_config)

    shared: list[PeerServiceInfo] = []
    services_snapshot: dict = registry.snapshot_services()
    from app.shared.contracts.mesh_surface import callable_method_advertisable

    for module_name, announcement in services_snapshot.items():
        sharing_config = mesh_config.services.get(module_name)
        if not sharing_config or not sharing_config.export.share:
            continue

        methods: list[MethodInfo] = []
        for m in announcement.methods:
            if not callable_method_advertisable(m, module=module_name):
                raise ValueError(f"Invalid callable method in {module_name} announcement: {m.name}")
            if m.exposure in ("external", "both"):
                methods.append(m)

        _validate_service_feature_objects(
            module=module_name,
            callable_features=announcement.callable_features,
            methods=methods,
        )
        service = PeerServiceInfo(
            module=module_name,
            version=announcement.version,
            capabilities=announcement.capabilities,
            callable_features=announcement.callable_features,
            available_feature_ids=sorted(
                feature.feature_id for feature in announcement.callable_features
            ),
            methods=methods,
            max_concurrent=sharing_config.export.max_concurrent,
        )
        service.digest = _compute_service_digest(service)
        shared.append(service)

    return shared


def _build_services_from_registry_snapshot(
    snapshot: RegistrySnapshot,
    mesh_config: MeshConfig,
) -> list[PeerServiceInfo]:
    shared: list[PeerServiceInfo] = []
    for service_snapshot in snapshot.services:
        sharing_config = mesh_config.services.get(service_snapshot.service_id)
        if not sharing_config or not sharing_config.export.share:
            continue
        methods = [
            _method_info_from_snapshot(service_snapshot.service_id, method)
            for method in service_snapshot.methods
            if method.exposure in ("external", "both")
        ]
        callable_features = list(feature_contracts_for_module(service_snapshot.service_id))
        _validate_service_feature_objects(
            module=service_snapshot.service_id,
            callable_features=callable_features,
            methods=methods,
        )
        service = PeerServiceInfo(
            module=service_snapshot.service_id,
            version=service_snapshot.version,
            capabilities=list(service_snapshot.tags),
            callable_features=callable_features,
            available_feature_ids=sorted(service_snapshot.feature_members.keys()),
            methods=methods,
            max_concurrent=sharing_config.export.max_concurrent,
        )
        service.digest = _compute_service_digest(service)
        shared.append(service)
    return shared


def _method_info_from_snapshot(
    module_name: str,
    method: NormalizedMethodSnapshot,
) -> MethodInfo:
    return MethodInfo(
        name=method.topic.split(".", 1)[1],
        summary=method.summary,
        bus_topic=method.topic,
        exposure=method.exposure,
        input_model=method.input_model,
        output_model=method.output_model,
        required_perms=[]
        if method.required_permissions is None
        else list(method.required_permissions),
        callable_feature_ids=list(method.feature_ids),
        callable_features=list(feature_contracts_for_topic(method.topic)),
        public_infrastructure=method.public_infrastructure,
        method_type=method.method_type,
        speech_constraints=_plain_mapping(method.speech_constraints)
        if method.speech_constraints is not None
        else None,
        input_schema=_plain_mapping(method.input_schema) if method.input_schema_present else None,
        output_schema=_plain_mapping(method.output_schema)
        if method.output_schema_present
        else None,
    )


def manifest_from_projection(
    *,
    projection: ProjectionResult,
    node_name: str,
    aurora_version: str,
    timestamp: str | None = None,
) -> PeerManifest:
    """Build a recipient-filtered projection-v1 manifest from one immutable result."""

    services = [
        _peer_service_from_projection_service(service)
        for service in projection.services
        if projection.routable and projection.readiness == "ready"
    ]
    evidence = _recipient_projection_evidence_from_projection(projection)
    return PeerManifest(
        peer_id=projection.cache_key.provider_peer_id,
        node_name=node_name,
        aurora_version=aurora_version,
        shared_services=services,
        granted_permissions=None,
        active_protocol=ACTIVE_MANIFEST_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
        recipient_projection_evidence=evidence,
        timestamp=timestamp or datetime.now(timezone.utc).isoformat(),
    )


def _peer_service_from_projection_service(service: Any) -> PeerServiceInfo:
    methods = sorted(
        [
            _method_info_from_exported_method(
                service.service_id,
                method,
            )
            for method in service.methods
        ],
        key=lambda method: str(method.bus_topic),
    )
    referenced_feature_ids = {
        feature_id for method in methods for feature_id in method.callable_feature_ids
    }
    peer_service = PeerServiceInfo(
        module=service.service_id,
        version=service.version,
        capabilities=sorted(service.tags),
        callable_features=sorted(
            _feature_contracts_for_ids(service.service_id, referenced_feature_ids),
            key=lambda feature: feature.feature_id,
        ),
        available_feature_ids=sorted(service.feature_ids),
        methods=methods,
        max_concurrent=int(dict(service.capacity or {}).get("max_concurrent", 10)),
    )
    peer_service.digest = _compute_service_digest(peer_service)
    return peer_service


def _method_info_from_exported_method(
    module_name: str,
    method: ExportedMethod,
) -> MethodInfo:
    if method.required_permissions is None:
        raise ValueError(f"Projection method {method.topic} has unknown required permissions")
    method_feature_ids = list(method.feature_ids)
    return MethodInfo(
        name=method.topic.split(".", 1)[1],
        summary=method.summary,
        bus_topic=method.topic,
        exposure=method.exposure,
        input_model=method.input_model,
        output_model=method.output_model,
        required_perms=list(method.required_permissions),
        callable_feature_ids=method_feature_ids,
        callable_features=_feature_contracts_for_ids(module_name, set(method_feature_ids)),
        public_infrastructure=method.public_infrastructure,
        method_type=method.method_type,
        speech_constraints=_plain_mapping(method.speech_constraints)
        if method.speech_constraints is not None
        else None,
        input_schema=_plain_mapping(method.input_schema) if method.input_schema_present else None,
        output_schema=_plain_mapping(method.output_schema)
        if method.output_schema_present
        else None,
    )


def _feature_contracts_for_ids(module_name: str, feature_ids: set[str]) -> list[Any]:
    if not feature_ids:
        return []
    return [
        feature.model_copy(update={"method_ids": tuple(sorted(feature.method_ids))})
        for feature in feature_contracts_for_module(module_name)
        if feature.feature_id in feature_ids
    ]


def _recipient_projection_evidence_from_projection(
    projection: ProjectionResult,
) -> RecipientProjectionEvidence:
    key = projection.cache_key
    grants = [
        ManifestGrantEvidence(permission=grant.permission, source=grant.source)
        for grant in (projection.grants or ())
    ]
    raw = {
        "provider_peer_id": key.provider_peer_id,
        "recipient_peer_id": key.recipient_peer_id,
        "registry_revision": key.registry_revision,
        "registry_digest": key.registry_digest,
        "policy_revision": key.policy_revision,
        "policy_digest": key.policy_digest,
        "auth_grant_revision": key.authority_revision,
        "auth_grant_state": "active" if projection.readiness == "ready" else projection.readiness,
        "auth_grant_digest": key.authority_digest,
        "grants_digest": key.grants_digest,
        "protocol_tier": projection.effective_manifest_protocol,
        "projection_digest": "",
        "evidence_digest": "",
        "grants": grants,
    }
    manifest = PeerManifest(
        peer_id=key.provider_peer_id,
        shared_services=[
            _peer_service_from_projection_service(service)
            for service in projection.services
            if projection.routable and projection.readiness == "ready"
        ],
    )
    raw["projection_digest"] = manifest_projection_digest(manifest)
    prepared = RecipientProjectionEvidence.model_validate(raw)
    raw["evidence_digest"] = recipient_projection_evidence_digest(prepared)
    return RecipientProjectionEvidence.model_validate(raw)


def _plain_mapping(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _plain_mapping(item) for key, item in value.items()}
    if hasattr(value, "items"):
        return {str(key): _plain_mapping(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_plain_mapping(item) for item in value]
    return value


def _normalize_manifest_json_numbers(value: Any) -> Any:
    """Normalize JSON numbers to the representation browsers can reproduce.

    JSON.parse does not preserve the lexical distinction between an integral
    float such as ``0.0`` and the integer ``0``. Projection evidence must hash
    the same value that a browser receives, so normalize those values before
    both hashing and transmission.
    """

    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("manifest JSON contains a non-finite number")
        return int(value) if value.is_integer() else value
    if isinstance(value, dict):
        return {str(key): _normalize_manifest_json_numbers(item) for key, item in value.items()}
    if isinstance(value, tuple | list):
        return [_normalize_manifest_json_numbers(item) for item in value]
    return value


def _compute_service_digest(service: PeerServiceInfo) -> str:
    payload = service.model_dump(mode="json", exclude={"digest"})
    return canonical_digest(_normalize_manifest_json_numbers(payload))


def generate_manifest_ack(
    remote_manifest: PeerManifest,
    mesh_config: MeshConfig,
) -> ManifestAck:
    """Generate an acknowledgment for a received peer manifest.

    Compares the remote manifest against local routing configuration
    to determine which services are compatible, incompatible, or unused.

    Args:
        remote_manifest: The manifest received from a peer
        mesh_config: Local mesh configuration with routing preferences

    Returns:
        ManifestAck with compatibility report
    """
    compatible: list[str] = []
    incompatible: list[str] = []
    unused: list[str] = []
    services: list[ManifestServiceCompatibility] = []
    evidence = remote_manifest.recipient_projection_evidence
    policy_snapshot = MeshPolicySnapshot(
        revision=0,
        source_revision=None,
        mesh_config=mesh_config,
    )

    for svc in sorted(remote_manifest.shared_services, key=lambda item: item.module):
        # Check if we have routing config that wants this service from the network
        routing_config = mesh_config.services.get(svc.module)

        if not routing_config or routing_config.routing.prefer == "local_only":
            # We don't want this service from the network
            unused.append(svc.module)
            services.append(
                ManifestServiceCompatibility(
                    service_id=svc.module,
                    status="unused",
                    reason_codes=[],
                    reason="",
                )
            )
            continue

        decisions = _service_ack_decisions(
            remote_manifest=remote_manifest,
            service=svc,
            routing_config=routing_config,
            policy_snapshot=policy_snapshot,
        )
        eligible = any(decision.eligible for decision in decisions)
        reason_codes = sorted({decision.reason_code for decision in decisions})
        if eligible:
            compatible.append(svc.module)
            services.append(
                ManifestServiceCompatibility(
                    service_id=svc.module,
                    status="compatible",
                    reason_codes=[],
                    reason="",
                )
            )
        else:
            incompatible.append(svc.module)
            services.append(
                ManifestServiceCompatibility(
                    service_id=svc.module,
                    status="incompatible",
                    reason_codes=reason_codes or ["method_not_advertised"],
                    reason="",
                )
            )

    ack = ManifestAck(
        compatible_services=sorted(compatible),
        incompatible_services=sorted(incompatible),
        unused_services=sorted(unused),
        active_protocol=remote_manifest.active_protocol,
        active_version=remote_manifest.active_version,
        active_tier=remote_manifest.active_tier,
        protocol_revision=remote_manifest.active_version,
        registry_revision=evidence.registry_revision if evidence else None,
        export_policy_revision=evidence.policy_revision if evidence else None,
        auth_grant_revision=evidence.auth_grant_revision if evidence else None,
        projection_digest=evidence.projection_digest if evidence else None,
        services=sorted(services, key=lambda item: item.service_id),
    )

    log_debug(
        f"Mesh: Manifest ACK — compatible={compatible}, "
        f"incompatible={incompatible}, unused={unused}"
    )
    return ack


def _service_ack_decisions(
    *,
    remote_manifest: PeerManifest,
    service: PeerServiceInfo,
    routing_config: Any,
    policy_snapshot: MeshPolicySnapshot,
) -> list[Any]:
    """Reuse exact-topic G008 eligibility for deterministic ACK service summaries."""

    evidence = remote_manifest.recipient_projection_evidence
    grants = (
        frozenset(grant.permission for grant in evidence.grants)
        if evidence is not None and evidence.grants is not None
        else None
    )
    provider = OutboundProviderSnapshot(
        peer_id=remote_manifest.peer_id,
        status="negotiated",
        latency_ms=0.0,
        last_ping=0.0,
        last_manifest=0.0,
        service=service,
        projection_protocol=remote_manifest.active_protocol,
        projection_active=remote_manifest.projection_active is True,
        projection_tier=remote_manifest.active_tier,
        projection_digest=evidence.projection_digest if evidence else "",
        registry_revision=evidence.registry_revision if evidence else "",
        policy_revision=evidence.policy_revision if evidence else "",
        auth_grant_revision=evidence.auth_grant_revision if evidence else 0,
        auth_grant_state=evidence.auth_grant_state if evidence else "unknown",
        grants=grants,
    )
    return [
        evaluate_outbound_provider(
            OutboundRouteRequirements(
                topic=method.bus_topic or f"{service.module}.{method.name}",
                module=service.module,
                policy_snapshot=policy_snapshot,
                routing=routing_config.routing,
                local_peer_id=(evidence.recipient_peer_id if evidence else None),
                stale_peer_timeout_s=0.0,
                version_policy=policy_snapshot.mesh_config.version_policy,
            ),
            provider,
        )
        for method in sorted(service.methods, key=lambda item: item.bus_topic or item.name)
        if method.bus_topic
    ]


def manifest_to_dict(manifest: PeerManifest) -> dict:
    """Serialize a manifest for DataChannel transmission.

    Args:
        manifest: PeerManifest to serialize

    Returns:
        Dictionary suitable for JSON encoding and sending via DataChannel
    """
    return _normalize_manifest_json_numbers(
        {
            "type": "manifest",
            **manifest.model_dump(mode="json"),
        }
    )


def manifest_ack_to_dict(ack: ManifestAck) -> dict:
    """Serialize a manifest ACK for DataChannel transmission.

    Args:
        ack: ManifestAck to serialize

    Returns:
        Dictionary suitable for JSON encoding and sending via DataChannel
    """
    return {
        "type": "manifest_ack",
        **ack.model_dump(mode="json"),
    }


def parse_manifest(data: dict) -> PeerManifest | None:
    """Parse a manifest from a received DataChannel message.

    Args:
        data: Parsed JSON message with type="manifest"

    Returns:
        PeerManifest, or None if parsing fails
    """
    result = parse_manifest_with_evidence(data)
    if result.usable:
        return result.manifest
    log_warning(f"Mesh: Failed to parse manifest: {result.reason_code}")
    return None


def parse_manifest_with_evidence(
    data: dict,
    expected_provider_peer_id: str | None = None,
    expected_recipient_peer_id: str | None = None,
) -> ManifestParseResult:
    """Parse and classify a manifest without activating projection routing."""

    try:
        if not isinstance(data, dict):
            return _parse_result(None, "invalid", False, "not_object")
        if data.get("type", "manifest") != "manifest":
            return _parse_result(None, "invalid", False, "wrong_type")
        raw_protocol = data.get("active_protocol")
        if raw_protocol is not None:
            if not isinstance(raw_protocol, str) or not raw_protocol.strip():
                return _parse_result(None, "invalid", False, "invalid_protocol")
            if raw_protocol not in {LEGACY_MANIFEST_PROTOCOL, ACTIVE_MANIFEST_PROTOCOL}:
                return _parse_result(None, "unsupported", False, "unsupported_protocol")

        if raw_protocol is None and _has_protocol_metadata_without_protocol(data):
            return _parse_result(None, "invalid", False, "protocol_metadata_without_protocol")

        unknown = set(data) - _ALLOWED_MANIFEST_FIELDS
        if unknown:
            return _parse_result(None, "invalid", False, "unknown_field")
        shape_error = _manifest_wire_shape_error(data, allow_extension_fields=False)
        if shape_error:
            return _parse_result(None, "invalid", False, shape_error)
        has_projection_evidence = data.get("recipient_projection_evidence") is not None
        has_legacy_grants = data.get("granted_permissions") is not None
        raw_evidence = data.get("recipient_projection_evidence")
        has_grants_field = isinstance(raw_evidence, dict) and "grants" in raw_evidence
        if raw_protocol == SUPPORTED_SHADOW_PROTOCOL:
            evidence_error = _projection_raw_evidence_error(raw_evidence)
            if evidence_error:
                return _parse_result(None, "permissions_unknown", False, evidence_error)
        manifest_data = _known_manifest_data(data)

        manifest = PeerManifest.model_validate(manifest_data)
        try:
            _validate_peer_manifest(manifest)
            _validate_manifest_structure(manifest)
        except ValueError:
            return _parse_result(manifest, "invalid", False, "manifest_structure_invalid")

        if raw_protocol is None:
            if has_projection_evidence or has_legacy_grants:
                return _parse_result(manifest, "invalid", False, "legacy_smuggled_evidence")
            return _parse_result(manifest, "legacy_unverifiable", True, "legacy_missing_protocol")

        if raw_protocol == LEGACY_MANIFEST_PROTOCOL:
            if not _explicit_legacy_protocol_complete(manifest):
                return _parse_result(manifest, "invalid", False, "legacy_protocol_incomplete")
            if has_projection_evidence or has_legacy_grants:
                return _parse_result(manifest, "invalid", False, "legacy_smuggled_evidence")
            return _parse_result(manifest, "legacy_unverifiable", True, "legacy_explicit")

        return _classify_projection_manifest(
            manifest,
            has_grants_field=has_grants_field,
            expected_provider_peer_id=expected_provider_peer_id,
            expected_recipient_peer_id=expected_recipient_peer_id,
        )
    except Exception as e:
        log_warning(f"Mesh: Failed to parse manifest with evidence: {e}")
        return _parse_result(None, "invalid", False, "parse_error")


_ALLOWED_MANIFEST_FIELDS = {
    "type",
    "peer_id",
    "node_name",
    "aurora_version",
    "shared_services",
    "granted_permissions",
    "active_protocol",
    "active_version",
    "active_tier",
    "supported_protocols",
    "projection_supported",
    "projection_active",
    "recipient_projection_evidence",
    "timestamp",
}

_ALLOWED_SERVICE_FIELDS = {
    "module",
    "version",
    "capabilities",
    "callable_features",
    "available_feature_ids",
    "methods",
    "max_concurrent",
    "digest",
}

_ALLOWED_METHOD_FIELDS = {
    "name",
    "summary",
    "bus_topic",
    "exposure",
    "input_model",
    "output_model",
    "required_perms",
    "callable_feature_ids",
    "callable_features",
    "public_infrastructure",
    "method_type",
    "speech_constraints",
    "input_schema",
    "output_schema",
}

_ALLOWED_FEATURE_FIELDS = {
    "feature_id",
    "module",
    "label",
    "summary",
    "method_ids",
}

_ALLOWED_EVIDENCE_FIELDS = {
    "provider_peer_id",
    "recipient_peer_id",
    "registry_revision",
    "registry_digest",
    "policy_revision",
    "policy_digest",
    "auth_grant_revision",
    "auth_grant_state",
    "auth_grant_digest",
    "grants_digest",
    "protocol_tier",
    "projection_digest",
    "evidence_digest",
    "grants",
}

_ALLOWED_GRANT_FIELDS = {"permission", "source"}


def _known_manifest_data(data: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in data.items() if k != "type" and k in _ALLOWED_MANIFEST_FIELDS}


def _has_protocol_metadata_without_protocol(data: dict[str, Any]) -> bool:
    return any(
        field in data and data.get(field) is not None
        for field in (
            "active_version",
            "active_tier",
            "supported_protocols",
            "projection_supported",
            "projection_active",
            "recipient_projection_evidence",
            "granted_permissions",
        )
    )


def _manifest_wire_shape_error(data: dict[str, Any], *, allow_extension_fields: bool) -> str | None:
    try:
        _validate_manifest_wire_shape(data, allow_extension_fields=allow_extension_fields)
    except ValueError as exc:
        message = str(exc)
        if "unknown" in message:
            return "projection_unknown_nested_field"
        return "parse_error"
    return None


def _projection_raw_evidence_error(raw_evidence: Any) -> str | None:
    if raw_evidence is None:
        return "projection_evidence_missing"
    if not isinstance(raw_evidence, dict):
        return "authority_evidence_missing"
    required = {
        "recipient_peer_id",
        "auth_grant_revision",
        "auth_grant_state",
        "auth_grant_digest",
        "grants_digest",
        "protocol_tier",
        "grants",
    }
    if any(field not in raw_evidence or raw_evidence[field] is None for field in required):
        return "authority_evidence_missing"
    return None


def _validate_manifest_wire_shape(
    data: dict[str, Any],
    *,
    allow_extension_fields: bool,
) -> None:
    unknown = set(data) - _ALLOWED_MANIFEST_FIELDS
    if unknown and not allow_extension_fields:
        raise ValueError("unknown manifest field")
    services = data.get("shared_services", [])
    if not isinstance(services, list):
        raise ValueError("shared_services must be a list")
    for service in services:
        if not isinstance(service, dict):
            raise ValueError("shared_services entries must be objects")
        unknown_service = set(service) - _ALLOWED_SERVICE_FIELDS
        if unknown_service and not allow_extension_fields:
            raise ValueError("unknown service field")
        for feature in service.get("callable_features", []) or []:
            _validate_feature_wire_shape(feature)
        for method in service.get("methods", []) or []:
            if not isinstance(method, dict):
                raise ValueError("methods entries must be objects")
            unknown_method = set(method) - _ALLOWED_METHOD_FIELDS
            if unknown_method and not allow_extension_fields:
                raise ValueError("unknown method field")
            for feature in method.get("callable_features", []) or []:
                _validate_feature_wire_shape(feature)
    evidence = data.get("recipient_projection_evidence")
    if evidence is not None:
        if not isinstance(evidence, dict):
            raise ValueError("recipient_projection_evidence must be an object")
        unknown_evidence = set(evidence) - _ALLOWED_EVIDENCE_FIELDS
        if unknown_evidence and not allow_extension_fields:
            raise ValueError("unknown evidence field")
        grants = evidence.get("grants", [])
        if grants is not None and not isinstance(grants, list):
            raise ValueError("grants must be a list")
        for grant in grants or []:
            if not isinstance(grant, dict):
                raise ValueError("grants entries must be objects")
            unknown_grant = set(grant) - _ALLOWED_GRANT_FIELDS
            if unknown_grant and not allow_extension_fields:
                raise ValueError("unknown grant field")


def _validate_feature_wire_shape(feature: Any) -> None:
    if not isinstance(feature, dict):
        raise ValueError("callable feature entries must be objects")
    unknown_feature = set(feature) - _ALLOWED_FEATURE_FIELDS
    if unknown_feature:
        raise ValueError("unknown callable feature field")


def _parse_result(
    manifest: PeerManifest | None,
    status: ParseStatus,
    usable: bool,
    reason_code: str,
) -> ManifestParseResult:
    return ManifestParseResult(
        manifest=manifest,
        status=status,
        usable=usable,
        reason_code=reason_code,
    )


def _explicit_legacy_protocol_complete(manifest: PeerManifest) -> bool:
    return (
        manifest.active_protocol == LEGACY_MANIFEST_PROTOCOL
        and manifest.active_version == "v0"
        and manifest.active_tier == "legacy"
        and manifest.supported_protocols == list(SUPPORTED_PROTOCOLS)
        and manifest.projection_supported is True
        and manifest.projection_active is False
    )


def _explicit_projection_protocol_complete(manifest: PeerManifest) -> bool:
    return (
        manifest.active_protocol == SUPPORTED_SHADOW_PROTOCOL
        and manifest.active_version == "v1"
        and manifest.active_tier == "projection"
        and manifest.supported_protocols == list(SUPPORTED_PROTOCOLS)
        and manifest.projection_supported is True
        and manifest.projection_active is True
    )


def _classify_projection_manifest(
    manifest: PeerManifest,
    *,
    has_grants_field: bool,
    expected_provider_peer_id: str | None,
    expected_recipient_peer_id: str | None,
) -> ManifestParseResult:
    if not _explicit_projection_protocol_complete(manifest):
        return _parse_result(manifest, "invalid", False, "projection_protocol_incomplete")
    try:
        _validate_projection_canonical_order(manifest)
    except ValueError as exc:
        if str(exc) in {"service_digest_missing", "service_digest_mismatch"}:
            return _parse_result(manifest, "invalid", False, str(exc))
        return _parse_result(manifest, "invalid", False, "projection_not_canonical")
    if manifest.granted_permissions is not None:
        return _parse_result(manifest, "invalid", False, "projection_legacy_grants_smuggled")
    evidence = manifest.recipient_projection_evidence
    if evidence is None:
        return _parse_result(manifest, "permissions_unknown", False, "projection_evidence_missing")
    if not has_grants_field:
        return _parse_result(manifest, "permissions_unknown", False, "projection_grants_missing")
    if (
        expected_provider_peer_id is not None
        and evidence.provider_peer_id != expected_provider_peer_id
    ):
        return _parse_result(manifest, "invalid", False, "provider_peer_id_mismatch")
    if (
        expected_recipient_peer_id is not None
        and evidence.recipient_peer_id != expected_recipient_peer_id
    ):
        return _parse_result(manifest, "invalid", False, "recipient_peer_id_mismatch")
    if evidence.provider_peer_id != manifest.peer_id:
        return _parse_result(manifest, "invalid", False, "manifest_provider_mismatch")
    if evidence.auth_grant_state != "active":
        return _parse_result(manifest, "permissions_unknown", False, "authority_not_active")
    if evidence.protocol_tier != ACTIVE_MANIFEST_PROTOCOL:
        return _parse_result(manifest, "invalid", False, "protocol_tier_mismatch")
    if evidence.auth_grant_revision < 1:
        return _parse_result(manifest, "permissions_unknown", False, "authority_revision_unknown")
    if evidence.grants is None:
        return _parse_result(manifest, "permissions_unknown", False, "projection_grants_missing")
    if not _is_canonical_grants(evidence.grants):
        return _parse_result(manifest, "invalid", False, "grants_not_canonical")
    grant_payload = [grant.model_dump(mode="json") for grant in evidence.grants]
    expected_grants_digest = canonical_digest({"grants": grant_payload})
    if evidence.grants_digest != expected_grants_digest:
        return _parse_result(manifest, "invalid", False, "grants_digest_mismatch")
    expected_auth_digest = RecipientEvidence(
        peer_id=evidence.recipient_peer_id,
        revision=evidence.auth_grant_revision,
        grants=tuple(
            GrantEvidence(permission=grant.permission, source=grant.source)
            for grant in evidence.grants
        ),
        state=evidence.auth_grant_state,
    )
    if evidence.auth_grant_digest != expected_auth_digest.digest:
        return _parse_result(manifest, "invalid", False, "authority_digest_mismatch")
    if evidence.projection_digest != manifest_projection_digest(manifest):
        return _parse_result(manifest, "invalid", False, "projection_digest_mismatch")
    if evidence.evidence_digest != recipient_projection_evidence_digest(evidence):
        return _parse_result(manifest, "invalid", False, "evidence_digest_mismatch")
    return _parse_result(manifest, "verified", True, "projection_verified")


def _validate_manifest_structure(manifest: PeerManifest) -> None:
    service_modules = [service.module for service in manifest.shared_services]
    _require_unique(service_modules, "shared_services")
    for service in manifest.shared_services:
        _require_unique(service.capabilities, "capabilities")
        _require_unique(service.available_feature_ids, "available_feature_ids")
        _validate_feature_arrays(service.callable_features, canonical=False)
        topics = [
            str(method.bus_topic or f"{service.module}.{method.name}") for method in service.methods
        ]
        _require_unique(topics, "methods")
        for method, topic in zip(service.methods, topics, strict=True):
            if not topic.startswith(f"{service.module}."):
                raise ValueError("method topic crosses service boundary")
            _require_unique(method.callable_feature_ids, "callable_feature_ids")
            _require_unique(method.required_perms, "required_perms")
            _validate_feature_arrays(method.callable_features, canonical=False)
    if manifest.supported_protocols is not None:
        _require_unique(manifest.supported_protocols, "supported_protocols")


def _validate_projection_canonical_order(manifest: PeerManifest) -> None:
    _require_canonical_unique(
        [service.module for service in manifest.shared_services],
        "shared_services",
    )
    for service in manifest.shared_services:
        _require_canonical_unique(service.capabilities, "capabilities")
        _require_canonical_unique(service.available_feature_ids, "available_feature_ids")
        _validate_feature_arrays(service.callable_features, canonical=True)
        if any(
            method.bus_topic is None or not method.bus_topic.strip() for method in service.methods
        ):
            raise ValueError("projection method topic missing")
        topics = [str(method.bus_topic) for method in service.methods]
        _require_canonical_unique(topics, "methods")
        for method in service.methods:
            _require_canonical_unique(method.callable_feature_ids, "callable_feature_ids")
            _require_canonical_unique(method.required_perms, "required_perms")
            _validate_feature_arrays(method.callable_features, canonical=True)
        if not service.digest:
            raise ValueError("service_digest_missing")
        if service.digest != _compute_service_digest(service):
            raise ValueError("service_digest_mismatch")
    if manifest.supported_protocols is not None:
        _require_canonical_unique(manifest.supported_protocols, "supported_protocols")


def _validate_feature_arrays(callable_features: list, *, canonical: bool) -> None:
    feature_ids = [str(feature.feature_id) for feature in callable_features]
    if canonical:
        _require_canonical_unique(feature_ids, "callable_features")
    else:
        _require_unique(feature_ids, "callable_features")
    for feature in callable_features:
        method_ids = list(feature.method_ids)
        if canonical:
            _require_canonical_unique(method_ids, "callable_features.method_ids")
        else:
            _require_unique(method_ids, "callable_features.method_ids")


def _require_unique(values: list[str], field_name: str) -> None:
    if len(values) != len(set(values)):
        raise ValueError(f"{field_name} contains duplicates")


def _require_canonical_unique(values: list[str], field_name: str) -> None:
    _require_unique(values, field_name)
    if values != sorted(values):
        raise ValueError(f"{field_name} is not canonical")


def _is_canonical_grants(grants: list[ManifestGrantEvidence]) -> bool:
    keys = [(grant.permission, grant.source) for grant in grants]
    permissions = [grant.permission for grant in grants]
    return len(permissions) == len(set(permissions)) and keys == sorted(keys)


def manifest_projection_digest(manifest: PeerManifest) -> str:
    """Return the canonical digest for recipient projection service evidence."""

    return canonical_digest(
        _normalize_manifest_json_numbers(
            {
                "provider_peer_id": manifest.peer_id,
                "services": [
                    service.model_dump(mode="json", exclude={"digest"})
                    for service in manifest.shared_services
                ],
            }
        )
    )


def recipient_projection_evidence_digest(evidence: RecipientProjectionEvidence) -> str:
    """Return the canonical evidence digest excluding the digest field itself."""

    payload = evidence.model_dump(mode="json", exclude={"evidence_digest"})
    return canonical_digest(payload)


def finalize_recipient_projection_evidence(
    evidence: RecipientProjectionEvidence | dict[str, Any],
) -> RecipientProjectionEvidence:
    """Fill canonical grants/evidence digests for tests and future senders."""

    raw = (
        evidence.model_dump(mode="json")
        if isinstance(evidence, RecipientProjectionEvidence)
        else dict(evidence)
    )
    if "grants" not in raw or raw["grants"] is None:
        raise ValueError("projection evidence requires explicit grants")
    grants = [ManifestGrantEvidence.model_validate(grant) for grant in raw["grants"]]
    recipient = RecipientEvidence(
        peer_id=raw.get("recipient_peer_id"),
        revision=raw.get("auth_grant_revision"),
        grants=tuple(GrantEvidence(grant.permission, grant.source) for grant in grants),
        state=raw.get("auth_grant_state"),
    )
    raw["grants"] = [grant.to_canonical() for grant in recipient.grants or ()]
    raw["grants_digest"] = canonical_digest({"grants": raw["grants"]})
    raw["auth_grant_digest"] = recipient.digest
    raw.setdefault("protocol_tier", ACTIVE_MANIFEST_PROTOCOL)
    raw["evidence_digest"] = ""
    prepared = RecipientProjectionEvidence.model_validate(raw)
    raw["evidence_digest"] = recipient_projection_evidence_digest(prepared)
    return RecipientProjectionEvidence.model_validate(raw)


def parse_manifest_ack(data: dict) -> ManifestAck | None:
    """Parse a manifest ACK from a received DataChannel message.

    Args:
        data: Parsed JSON message with type="manifest_ack"

    Returns:
        ManifestAck, or None if parsing fails
    """
    try:
        ack_data = {k: v for k, v in data.items() if k != "type"}
        return ManifestAck.model_validate(ack_data)
    except Exception as e:
        log_warning(f"Mesh: Failed to parse manifest ACK: {e}")
        return None


def _validate_peer_manifest(manifest: PeerManifest) -> None:
    validate_canonical_taxonomy()
    for service in manifest.shared_services:
        _validate_service_feature_objects(
            module=service.module,
            callable_features=service.callable_features,
            methods=service.methods,
            allow_service_only=False,
            allow_legacy=True,
        )


def _validate_service_feature_objects(
    *,
    module: str,
    callable_features: list,
    methods: list[MethodInfo],
    allow_service_only: bool = True,
    allow_legacy: bool = False,
) -> None:
    if module not in MESH_CAPABLE_MODULES:
        return
    if allow_legacy and _is_wholly_legacy_service(
        callable_features=callable_features,
        methods=methods,
    ):
        return
    expected_features = {
        feature.feature_id: _comparable_feature_payload(feature)
        for feature in feature_contracts_for_module(module)
    }
    actual_features = [_comparable_feature_payload(feature) for feature in callable_features]
    if not actual_features and expected_features and not allow_legacy:
        raise ValueError(
            f"{module} callable features mismatch: expected={list(expected_features.values())} "
            f"actual={actual_features}"
        )
    expected_subset = [
        expected_features.get(feature.get("feature_id")) for feature in actual_features
    ]
    if any(feature is None for feature in expected_subset) or actual_features != expected_subset:
        raise ValueError(
            f"{module} callable features mismatch: expected={list(expected_features.values())} "
            f"actual={actual_features}"
        )
    if not allow_service_only and actual_features and not methods:
        raise ValueError(f"{module} callable feature objects require callable methods")
    violations: list[str] = []
    for method in methods:
        violations.extend(_validate_callable_method_surface_for_wire(method, module=module))
    if violations:
        raise ValueError(f"{module} callable methods invalid: {'; '.join(violations)}")


def _validate_callable_method_surface_for_wire(method: Any, module: str) -> list[str]:
    violations = validate_callable_method_surface(method, module=module)
    if not violations:
        return []

    topic = str(getattr(method, "bus_topic", "") or "")
    if not topic:
        name = str(getattr(method, "name", "") or "")
        topic = f"{module}.{name}" if name else ""
    object_mismatch = f"{topic} callable feature objects mismatch:"
    remaining = [violation for violation in violations if object_mismatch not in violation]
    if remaining:
        return violations

    expected = [
        _comparable_feature_payload(feature) for feature in feature_contracts_for_topic(topic)
    ]
    actual = [
        _comparable_feature_payload(feature)
        for feature in list(getattr(method, "callable_features", None) or [])
    ]
    if actual == expected:
        return []
    return violations


def _is_wholly_legacy_service(*, callable_features: list, methods: list[MethodInfo]) -> bool:
    if callable_features:
        return False
    return all(
        not getattr(method, "callable_feature_ids", None)
        and not getattr(method, "callable_features", None)
        for method in methods
    )


def _canonical_feature_payload(feature: Any) -> dict[str, Any]:
    payload = feature.model_dump(mode="json") if hasattr(feature, "model_dump") else dict(feature)
    payload["method_ids"] = sorted(str(item) for item in payload.get("method_ids", []) or [])
    return payload


# `label` and `summary` are display copy. Comparing them made the taxonomy
# lockstep across the whole mesh: editing one feature's summary rejected every
# peer still on the previous wording as `manifest_structure_invalid`, with no
# version negotiation available to soften it. Identity and membership still
# have to match exactly.
_FEATURE_IDENTITY_FIELDS = ("feature_id", "module", "method_ids")


def _comparable_feature_payload(feature: Any) -> dict[str, Any]:
    """Return the load-bearing part of a feature payload for peer comparison."""

    payload = _canonical_feature_payload(feature)
    return {field: payload.get(field) for field in _FEATURE_IDENTITY_FIELDS}

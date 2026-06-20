"""Product-facing capability catalog and route explanation projections."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from app.shared.contracts.models.gateway import (
    CapabilityActionInfo,
    CapabilityCatalogRequest,
    CapabilityCatalogResourceInfo,
    CapabilityCatalogResponse,
    CapabilityFreshnessInfo,
    CapabilityMethodInfo,
    CapabilityPolicyDecisionInfo,
    CapabilityPolicyInfo,
    CapabilityProviderInfo,
    CapabilityResourceInfo,
    CapabilityServiceInfo,
    RouteBlockerInfo,
    RouteCandidateDecision,
    RouteExplainRequest,
    RouteExplainResponse,
    ServiceAnnouncement,
)
from app.shared.contracts.models.mesh import MeshAddressSelector

from .capability_graph import build_capability_graph

_REDACTED_SCHEMA_KEYS = {
    "api_key",
    "apikey",
    "credential",
    "embedding",
    "file_path",
    "password",
    "path",
    "private_key",
    "secret",
    "token",
}


def build_capability_catalog(
    *,
    request: CapabilityCatalogRequest,
    mesh_config: Any,
    local_services: dict[str, ServiceAnnouncement] | None = None,
    peers: list[Any] | None = None,
    local_peer_id: str | None = None,
) -> CapabilityCatalogResponse:
    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services,
        peers=peers,
        local_peer_id=local_peer_id,
    )
    module_filter = set(request.modules or [])
    providers: list[CapabilityProviderInfo] = []
    actions: list[CapabilityActionInfo] = []
    resources: list[CapabilityCatalogResourceInfo] = []
    provider_index: dict[str, list[str]] = {}
    action_index: dict[str, list[str]] = {}

    for service in graph.services:
        if module_filter and service.module not in module_filter:
            continue
        if not request.include_unavailable and not service.routable:
            continue
        provider = _provider_from_service(service)
        providers.append(provider)
        provider_index.setdefault(service.module, []).append(provider.provider_id)
        for method in service.methods:
            if not request.include_internal and method.exposure not in ("external", "both"):
                continue
            action = _action_from_method(
                method=method,
                service=service,
                include_schemas=request.include_schemas,
            )
            actions.append(action)
            action_index.setdefault(service.module, []).append(action.action_id)

    for resource in graph.resources:
        if module_filter and resource.address.module not in module_filter:
            continue
        resources.append(_resource_from_graph(resource))

    return CapabilityCatalogResponse(
        generated_at=datetime.now(UTC).isoformat(),
        local_peer_id=graph.local_peer_id,
        local_node_name=graph.local_node_name,
        providers=sorted(providers, key=lambda item: item.provider_id),
        actions=sorted(actions, key=lambda item: item.action_id),
        resources=sorted(resources, key=lambda item: item.resource_id),
        provider_index={key: sorted(value) for key, value in sorted(provider_index.items())},
        action_index={key: sorted(value) for key, value in sorted(action_index.items())},
        secrets_redacted=True,
    )


def explain_route(
    *,
    request: RouteExplainRequest,
    mesh_config: Any,
    local_services: dict[str, ServiceAnnouncement] | None = None,
    registry: Any = None,
    routing_table: Any = None,
    local_peer_id: str | None = None,
) -> RouteExplainResponse:
    topic = _topic_from_request(request)
    module = topic.split(".", 1)[0]
    method_name = topic.split(".", 1)[1] if "." in topic else None
    config = mesh_config.services.get(module)
    graph = build_capability_graph(
        mesh_config=mesh_config,
        local_services=local_services or {},
        peers=registry.get_all_peers() if registry else [],
        local_peer_id=local_peer_id,
    )
    graph_services = {service.service_instance_id: service for service in graph.services}
    route = (
        routing_table.resolve(topic, routing_config=config, selector=request.selector)
        if routing_table
        else None
    )
    candidates: list[RouteCandidateDecision] = []
    local_candidate = _local_candidate(
        module=module,
        local_services=local_services or {},
        local_peer_id=local_peer_id,
        method_name=method_name,
        graph_services=graph_services,
        route_target=route.target if route else "local",
    )
    if local_candidate:
        candidates.append(local_candidate)

    if registry and request.include_candidates:
        for candidate in registry.get_provider_candidates(
            module=module,
            routing_config=config,
            version_policy=mesh_config.version_policy,
            selector=request.selector,
            include_ineligible=True,
        ):
            candidates.append(
                _remote_candidate_from_registry(
                    candidate,
                    method_name=method_name,
                    graph_services=graph_services,
                    selected_peer_id=route.peer_id if route else None,
                    selected_target=route.target if route else "local",
                )
            )

    blockers: list[RouteBlockerInfo] = []
    selector_valid = True
    selector_code = ""
    selector_message = ""
    if route and route.target == "error":
        selector_code = route.error_code or "route_error"
        selector_message = route.error_message or "route resolution failed"
        selector_valid = not selector_code.startswith("selector_")
        blockers.append(
            RouteBlockerInfo(
                code=selector_code,
                message=selector_message,
                security_privacy=_is_security_privacy_blocker(selector_code),
            )
        )
    for candidate in candidates:
        blockers.extend(candidate.blockers)

    selected_service_instance_id = None
    selected_provider_id = None
    for candidate in candidates:
        if candidate.selected:
            selected_service_instance_id = candidate.service_instance_id
            selected_provider_id = candidate.provider_id
            break

    return RouteExplainResponse(
        topic=topic,
        module=module,
        selected_target=route.target if route else "local",
        selected_peer_id=route.peer_id if route else None,
        selected_service_instance_id=selected_service_instance_id,
        selected_provider_id=selected_provider_id,
        selector_valid=selector_valid,
        selector_validation_code=selector_code,
        selector_validation_message=selector_message,
        fallback_behavior=_fallback_behavior(config, route.target if route else "local"),
        candidates=sorted(candidates, key=lambda item: item.provider_id),
        blockers=blockers,
        security_privacy_blockers=[b for b in blockers if b.security_privacy],
        secrets_redacted=True,
    )


def _provider_from_service(service: CapabilityServiceInfo) -> CapabilityProviderInfo:
    return CapabilityProviderInfo(
        provider_id=service.service_instance_id,
        peer_id=service.peer_id,
        provider_kind=service.provider_kind,
        status="local" if service.provider_kind == "local" else _status_from_blockers(service),
        service_instance_id=service.service_instance_id,
        module=service.module,
        version=service.version,
        latency_ms=_finite_float(service.latency_ms),
        max_concurrent=service.max_concurrent,
        active_calls=service.active_calls,
        available_capacity=service.available_capacity,
        eligible=service.routable,
        reason_code="" if service.routable else _first_blocker(service.route_blockers),
        reason="" if service.routable else "; ".join(service.route_blockers),
        policy=_policy_decision(service.policy, service.route_blockers),
        freshness=_freshness(service),
    )


def _action_from_method(
    *,
    method: CapabilityMethodInfo,
    service: CapabilityServiceInfo,
    include_schemas: bool,
) -> CapabilityActionInfo:
    policy = _policy_decision(method.policy, service.route_blockers)
    selector = MeshAddressSelector(
        peer_id=service.peer_id,
        provider_id=service.service_instance_id,
        service_instance_id=service.service_instance_id,
    )
    return CapabilityActionInfo(
        action_id=method.method_id,
        module=method.module,
        method=method.name,
        topic=method.bus_topic,
        provider_id=service.service_instance_id,
        peer_id=service.peer_id,
        provider_kind=service.provider_kind,
        service_instance_id=service.service_instance_id,
        selector=selector,
        bindability=_bindability(policy=policy, service=service),
        sdk_operation_kind=policy.operation_class or "bus_method",
        route_hints=_route_hints(service, policy),
        route_blockers=list(service.route_blockers),
        summary=method.summary,
        input_schema=_redact_schema(method.input_model, method.input_schema)
        if include_schemas
        else None,
        output_schema=_redact_schema(method.output_model, method.output_schema)
        if include_schemas
        else None,
        policy=policy,
        freshness=_freshness(service),
    )


def _resource_from_graph(resource: CapabilityResourceInfo) -> CapabilityCatalogResourceInfo:
    return CapabilityCatalogResourceInfo(
        resource_id=resource.resource_id,
        resource_type=resource.resource_type,
        owner_peer_id=resource.owner_peer_id,
        service_instance_id=resource.service_instance_id,
        namespace=resource.namespace,
        display_name=resource.display_name,
        capabilities=list(resource.capabilities),
        selector=MeshAddressSelector(
            peer_id=resource.address.peer_id,
            service_instance_id=resource.address.service_instance_id,
            resource_namespace=resource.namespace,
            data_scope=resource.address.namespace,
        ),
        policy=_policy_decision(resource.policy, []),
        freshness=_freshness_from_parts(
            source=resource.provenance.source,
            manifest_time=resource.provenance.manifest_timestamp,
            registry_digest=resource.provenance.registry_digest,
        ),
    )


def _policy_decision(
    policy: CapabilityPolicyInfo,
    denial_reasons: list[str],
) -> CapabilityPolicyDecisionInfo:
    return CapabilityPolicyDecisionInfo(
        required_permissions=list(policy.required_perms),
        trust_tier=policy.trust_tier,
        safety_class=policy.safety_class,
        explicit_selector_required=policy.explicit_selector_required,
        consent_required=policy.consent_required,
        privacy_indicator_required=policy.privacy_indicator_required,
        bandwidth_check_required=policy.bandwidth_check_required,
        approval_required=policy.confirmation_required,
        selector_required=policy.explicit_selector_required,
        mesh_visible=policy.mesh_visible,
        local_only=policy.local_only,
        allowed_peers=list(policy.allowed_peers) if policy.allowed_peers is not None else None,
        operation_class=policy.operation_class,
        resource_scope=policy.resource_scope,
        denial_reasons=list(denial_reasons),
    )


def _freshness(service: CapabilityServiceInfo) -> CapabilityFreshnessInfo:
    return _freshness_from_parts(
        source=service.provenance.source,
        manifest_time=service.provenance.manifest_timestamp,
        registry_digest=service.provenance.registry_digest or service.digest,
        stale=any(blocker.startswith("peer_status:stale") for blocker in service.route_blockers),
    )


def _freshness_from_parts(
    *,
    source: str,
    manifest_time: str | None,
    registry_digest: str,
    stale: bool = False,
) -> CapabilityFreshnessInfo:
    return CapabilityFreshnessInfo(
        source=source,
        manifest_time=manifest_time,
        stale=stale,
        registry_digest=registry_digest,
    )


def _local_candidate(
    *,
    module: str,
    local_services: dict[str, ServiceAnnouncement],
    local_peer_id: str | None,
    method_name: str | None,
    graph_services: dict[str, CapabilityServiceInfo],
    route_target: str,
) -> RouteCandidateDecision | None:
    announcement = local_services.get(module)
    if not announcement:
        return None
    peer_id = local_peer_id or "local"
    service_instance_id = f"local:{peer_id}:{module}"
    service = graph_services.get(service_instance_id)
    policy = _candidate_policy(service=service, method_name=method_name, denial_reasons=[])
    return RouteCandidateDecision(
        provider_id=service_instance_id,
        peer_id=peer_id,
        provider_kind="local",
        service_instance_id=service_instance_id,
        module=module,
        version=announcement.version,
        included=True,
        selected=route_target == "local",
        reason_code="local_available",
        reason="local service is available",
        latency_ms=0.0,
        active_calls=0,
        max_concurrent=service.max_concurrent if service else 0,
        available_capacity=service.available_capacity if service else None,
        policy=policy,
        freshness=_freshness(service) if service else CapabilityFreshnessInfo(source="local_registry"),
        auth_rbac_state=_auth_rbac_state(policy=policy, blockers=[], included=True),
        transport="local_bus",
        privacy_class=_privacy_class(policy),
    )


def _remote_candidate_from_registry(
    candidate: Any,
    *,
    method_name: str | None,
    graph_services: dict[str, CapabilityServiceInfo],
    selected_peer_id: str | None,
    selected_target: str,
) -> RouteCandidateDecision:
    peer = candidate.peer
    service = candidate.service
    service_instance_id = f"remote:{peer.peer_id}:{service.module}"
    available_capacity = None
    if service.max_concurrent > 0:
        available_capacity = max(service.max_concurrent - peer.active_calls, 0)
    blockers = []
    if not candidate.eligible:
        blockers.append(
            RouteBlockerInfo(
                code=candidate.reason_code or "provider_ineligible",
                message=candidate.reason or "provider is not eligible",
                provider_id=service_instance_id,
                peer_id=peer.peer_id,
                security_privacy=_is_security_privacy_blocker(candidate.reason_code),
            )
        )
    graph_service = graph_services.get(service_instance_id)
    denial_reasons = [candidate.reason_code] if candidate.reason_code != "eligible" else []
    policy = _candidate_policy(
        service=graph_service,
        method_name=method_name,
        denial_reasons=[reason for reason in denial_reasons if reason],
    )
    return RouteCandidateDecision(
        provider_id=service_instance_id,
        peer_id=peer.peer_id,
        provider_kind="remote",
        service_instance_id=service_instance_id,
        module=service.module,
        version=service.version,
        included=candidate.eligible,
        selected=selected_target == "remote" and selected_peer_id == peer.peer_id,
        reason_code=candidate.reason_code,
        reason=candidate.reason,
        latency_ms=_finite_float(peer.latency_ms),
        active_calls=peer.active_calls,
        max_concurrent=service.max_concurrent,
        available_capacity=available_capacity,
        policy=policy,
        freshness=_freshness(graph_service)
        if graph_service
        else _freshness_from_parts(
            source="remote_manifest",
            manifest_time=peer.manifest.timestamp if peer.manifest else None,
            registry_digest=service.digest,
            stale=peer.status == "stale",
        ),
        auth_rbac_state=_auth_rbac_state(
            policy=policy,
            blockers=blockers,
            included=candidate.eligible,
        ),
        transport="mesh_webrtc",
        privacy_class=_privacy_class(policy),
        blockers=blockers,
    )


def _candidate_policy(
    *,
    service: CapabilityServiceInfo | None,
    method_name: str | None,
    denial_reasons: list[str],
) -> CapabilityPolicyDecisionInfo:
    if not service:
        return CapabilityPolicyDecisionInfo(denial_reasons=denial_reasons)
    if method_name:
        for method in service.methods:
            if method.name == method_name:
                return _policy_decision(method.policy, denial_reasons)
    return _policy_decision(service.policy, denial_reasons)


def _auth_rbac_state(
    *,
    policy: CapabilityPolicyDecisionInfo,
    blockers: list[RouteBlockerInfo],
    included: bool,
) -> str:
    if any(blocker.security_privacy for blocker in blockers):
        return "blocked"
    if policy.required_permissions:
        return "permission_required"
    if included:
        return "allowed"
    return "unknown"


def _privacy_class(policy: CapabilityPolicyDecisionInfo) -> str:
    if policy.safety_class == "admin":
        return "admin-critical"
    if policy.resource_scope == "audio" or policy.consent_required:
        return "raw-audio"
    if policy.safety_class == "data":
        return "sensitive"
    if policy.safety_class == "delegated_action":
        return "personal"
    return "public"


def _topic_from_request(request: RouteExplainRequest) -> str:
    if request.topic:
        return request.topic
    if request.module and request.method:
        return f"{request.module}.{request.method}"
    if request.module:
        return f"{request.module}.Diagnostic"
    return "Gateway.Diagnostic"


def _fallback_behavior(config: Any | None, selected_target: str) -> str:
    if config is None:
        return "local_default"
    if selected_target == "remote":
        return f"remote_selected; fallback={config.fallback}"
    if selected_target == "local":
        return f"local_selected; fallback={config.fallback}"
    if selected_target == "none":
        return "no_route"
    if selected_target == "error":
        return f"hard_error; fallback={config.fallback}"
    return selected_target


def _bindability(
    *,
    policy: CapabilityPolicyDecisionInfo,
    service: CapabilityServiceInfo,
) -> str:
    if not service.routable:
        return "unavailable"
    if policy.approval_required or policy.consent_required:
        return "approval-required"
    if policy.explicit_selector_required or policy.privacy_indicator_required:
        return "ui-only"
    return "model-bindable"


def _route_hints(
    service: CapabilityServiceInfo,
    policy: CapabilityPolicyDecisionInfo,
) -> list[str]:
    hints = [service.provider_kind]
    if policy.explicit_selector_required:
        hints.append("explicit_selector_required")
    if policy.approval_required:
        hints.append("approval_required")
    if service.routable:
        hints.append("routable")
    return hints


def _status_from_blockers(service: CapabilityServiceInfo) -> str:
    for blocker in service.route_blockers:
        if blocker.startswith("peer_status:"):
            return blocker.split(":", 1)[1]
    return "blocked" if service.route_blockers else "negotiated"


def _first_blocker(blockers: list[str]) -> str:
    return blockers[0].split(":", 1)[0] if blockers else ""


def _redact_schema(model_name: str | None, schema: dict[str, Any] | None) -> dict[str, Any] | None:
    if schema is None:
        return None
    if model_name and _is_sensitive_key(model_name):
        return {"type": "object", "description": "redacted"}
    redacted = _redact_schema_node(schema)
    return redacted if isinstance(redacted, dict) else {"type": "object", "description": "redacted"}


def _redact_schema_node(value: Any, key: str = "") -> Any:
    if _is_sensitive_key(key):
        return {"type": "string", "description": "redacted", "writeOnly": True}
    if isinstance(value, dict):
        return {
            child_key: _redact_schema_node(child_value, child_key)
            for child_key, child_value in value.items()
            if child_key != "examples"
        }
    if isinstance(value, list):
        return [_redact_schema_node(item, key) for item in value]
    if isinstance(value, str) and _looks_sensitive_value(value):
        return "redacted"
    return value


def _is_sensitive_key(key: str | None) -> bool:
    if not key:
        return False
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _REDACTED_SCHEMA_KEYS)


def _looks_sensitive_value(value: str) -> bool:
    lowered = value.lower()
    return any(part in lowered for part in ("secret", "token", "password", "api_key"))


def _is_security_privacy_blocker(code: str | None) -> bool:
    if not code:
        return False
    return any(
        token in code
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


def _finite_float(value: float | None) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return float(value)

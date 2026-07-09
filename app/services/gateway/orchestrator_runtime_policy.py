"""Gateway policy for Orchestrator runtime data-movement overrides."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.shared.contracts.models.mesh import MeshAddressSelector
from app.shared.contracts.models.orchestrator import OrchestratorMethods

_REMOTE_DISPATCH_PERMS = {
    "*",
    "Orchestrator.manage",
    "Orchestrator.RemoteDispatch",
    "Orchestrator.remote_dispatch",
}
_REMOTE_INFERENCE_PERMS = {
    "*",
    "Orchestrator.manage",
    "Orchestrator.RemoteInference",
    "Orchestrator.remote_inference",
}


def selector_from_mapping(value: Any) -> MeshAddressSelector | None:
    """Return a non-empty mesh selector from model/dict values."""

    if isinstance(value, MeshAddressSelector):
        return value if value.has_routing_target() else None
    if not isinstance(value, Mapping):
        return None
    selector = MeshAddressSelector(
        peer_id=value.get("peer_id") or value.get("peerId"),
        provider_id=value.get("provider_id") or value.get("providerId"),
        service_instance_id=value.get("service_instance_id") or value.get("serviceInstanceId"),
        resource_namespace=value.get("resource_namespace") or value.get("resourceNamespace"),
    )
    return selector if selector.has_routing_target() else None


def runtime_dispatch_selector_present(topic: str, payload: Any) -> bool:
    """Return True when ExternalUserInput explicitly routes dispatch to a mesh target."""

    payload = _payload_mapping(payload)
    if topic != OrchestratorMethods.EXTERNAL_USER_INPUT or payload is None:
        return False
    return any(
        selector_from_mapping(payload.get(key)) is not None
        for key in ("dispatch_selector", "mesh_selector", "selector")
    )


def runtime_inference_selector_present(topic: str, payload: Any) -> bool:
    """Return True when a request explicitly selects inference routing/provider/model."""

    payload = _payload_mapping(payload)
    if payload is None:
        return False

    if topic == OrchestratorMethods.EXTERNAL_USER_INPUT:
        return (
            selector_from_mapping(payload.get("inference_selector")) is not None
            or _non_empty(payload.get("inference_provider_id"))
            or _non_empty(payload.get("inference_model_id"))
            or _non_empty(payload.get("provider_id"))
            or _non_empty(payload.get("model_id"))
        )

    if topic in {OrchestratorMethods.INFER_CHAT, OrchestratorMethods.STREAM_INFER_CHAT}:
        return (
            selector_from_mapping(payload.get("mesh_selector")) is not None
            or selector_from_mapping(payload.get("selector")) is not None
            or _non_empty(payload.get("provider_id"))
            or _non_empty(payload.get("model_id"))
        )

    return False


def remote_data_movement_denial_reason(
    topic: str,
    payload: Any,
    effective_perms: list[str] | frozenset[str] | set[str] | tuple[str, ...] | None,
) -> str | None:
    """Return a denial reason when runtime data movement lacks its specific permission."""

    permissions = set(effective_perms or [])
    if runtime_dispatch_selector_present(topic, payload) and not permissions.intersection(
        _REMOTE_DISPATCH_PERMS
    ):
        return "Runtime remote dispatch selection requires Orchestrator.RemoteDispatch permission"
    if runtime_inference_selector_present(topic, payload) and not permissions.intersection(
        _REMOTE_INFERENCE_PERMS
    ):
        return "Runtime remote inference selection requires Orchestrator.RemoteInference permission"
    return None


def _payload_mapping(payload: Any) -> Mapping[str, Any] | None:
    if isinstance(payload, Mapping):
        return payload
    if hasattr(payload, "model_dump"):
        dumped = payload.model_dump(exclude_unset=True)
        return dumped if isinstance(dumped, Mapping) else None
    return None


def _non_empty(value: Any) -> bool:
    return value is not None and str(value).strip() != ""

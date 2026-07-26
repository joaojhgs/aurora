from __future__ import annotations

from app.services.gateway.config import (
    MeshServiceExportPolicy,
    MeshServicePolicy,
    MeshServiceRoutingPolicy,
)


def mesh_policy(
    *,
    share: bool = False,
    max_concurrent: int = 10,
    allowed_peers: list[str] | None = None,
    prefer: str = "local",
    fallback: str = "local",
    min_version: str | None = None,
    required_capabilities: list[str] | None = None,
    require_explicit_selector: bool = False,
    unshared_feature_ids: list[str] | None = None,
    unshared_method_ids: list[str] | None = None,
    allowed_provider_peer_ids: list[str] | None = None,
    required_provider_feature_ids: list[str] | None = None,
    required_provider_capability_tags: list[str] | None = None,
) -> MeshServicePolicy:
    provider_ids = allowed_peers if allowed_provider_peer_ids is None else allowed_provider_peer_ids
    capability_tags = (
        required_capabilities
        if required_provider_capability_tags is None
        else required_provider_capability_tags
    )
    return MeshServicePolicy(
        export=MeshServiceExportPolicy(
            share=share,
            max_concurrent=max_concurrent,
            unshared_feature_ids=tuple(unshared_feature_ids or ()),
            unshared_method_ids=tuple(unshared_method_ids or ()),
        ),
        routing=MeshServiceRoutingPolicy(
            allowed_provider_peer_ids=None
            if provider_ids is None
            else tuple(str(peer_id) for peer_id in provider_ids),
            prefer=prefer,
            fallback=fallback,
            min_version=min_version,
            required_provider_feature_ids=tuple(required_provider_feature_ids or ()),
            required_provider_capability_tags=tuple(capability_tags or ()),
            require_explicit_selector=require_explicit_selector,
        ),
        legacy_inbound_allowed_peer_ids=None
        if allowed_peers is None
        else tuple(str(peer_id) for peer_id in allowed_peers),
    )

from app.services.gateway.mesh.models import PeerManifest, PeerServiceInfo
from app.services.gateway.mesh.negotiation import (
    _compute_service_digest,
    finalize_recipient_projection_evidence,
    manifest_projection_digest,
)
from app.services.gateway.mesh.provider_export import ACTIVE_MANIFEST_PROTOCOL, SUPPORTED_PROTOCOLS


def verified_peer_manifest(
    peer_id: str,
    services: list[PeerServiceInfo],
    *,
    node_name: str | None = None,
    recipient_peer_id: str = "local-peer",
    timestamp: str = "",
) -> PeerManifest:
    services = [
        service
        if service.digest
        else service.model_copy(update={"digest": _compute_service_digest(service)})
        for service in services
    ]
    manifest = PeerManifest(
        peer_id=peer_id,
        node_name=node_name or f"node-{peer_id}",
        shared_services=services,
        timestamp=timestamp,
        active_protocol=ACTIVE_MANIFEST_PROTOCOL,
        active_version="v1",
        active_tier="projection",
        supported_protocols=list(SUPPORTED_PROTOCOLS),
        projection_supported=True,
        projection_active=True,
    )
    evidence = finalize_recipient_projection_evidence(
        {
            "provider_peer_id": peer_id,
            "recipient_peer_id": recipient_peer_id,
            "registry_revision": "registry-1",
            "registry_digest": "registry-digest",
            "policy_revision": "policy-1",
            "policy_digest": "policy-digest",
            "auth_grant_revision": 1,
            "auth_grant_state": "active",
            "auth_grant_digest": "",
            "grants_digest": "",
            "protocol_tier": ACTIVE_MANIFEST_PROTOCOL,
            "projection_digest": manifest_projection_digest(manifest),
            "evidence_digest": "",
            "grants": [{"permission": "*", "source": "effective"}],
        }
    )
    return manifest.model_copy(update={"recipient_projection_evidence": evidence})

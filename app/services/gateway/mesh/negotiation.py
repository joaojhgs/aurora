"""Negotiation protocol for P2P mesh manifest exchange.

Handles:
- Generating local manifests from the contract registry filtered by sharing config
- Processing incoming peer manifests
- Generating manifest acknowledgments with compatibility reports
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, datetime, timezone
from typing import TYPE_CHECKING

from app.helpers.aurora_logger import log_debug, log_info, log_warning
from app.shared.contracts.models.gateway import MethodInfo

from .models import ManifestAck, PeerManifest, PeerServiceInfo
from .version_compat import is_compatible

if TYPE_CHECKING:
    from app.services.gateway.config import MeshConfig, ServiceRoutingConfig
    from app.services.gateway.registry_aggregator import RegistryAggregator


def generate_manifest(
    peer_id: str,
    mesh_config: MeshConfig,
    registry: RegistryAggregator | None = None,
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

    shared_services: list[PeerServiceInfo] = []

    # Get all registered modules from the in-process registry
    modules = list_modules()

    for module_name, module_contract in modules.items():
        # Check if this module is configured for sharing
        sharing_config = mesh_config.sharing.get(module_name)
        if not sharing_config or not sharing_config.share:
            continue

        # Build method info list (only externally-exposed methods)
        methods: list[MethodInfo] = []
        for mc in module_contract.methods:
            if mc.exposure in ("external", "both"):
                methods.append(
                    MethodInfo(
                        name=mc.name,
                        summary=mc.summary,
                        bus_topic=mc.bus_topic or f"{module_name}.{mc.name}",
                        exposure=mc.exposure,
                        required_perms=mc.required_perms,
                        input_model=mc.input_model.__name__ if mc.input_model else None,
                        output_model=mc.output_model.__name__ if mc.output_model else None,
                    )
                )

        # Compute digest for this module's contract
        digest_data = {
            "module": module_name,
            "version": module_contract.version,
            "methods": [
                {"name": m.name, "input_model": m.input_model, "output_model": m.output_model}
                for m in methods
            ],
        }
        stable_json = json.dumps(digest_data, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(stable_json.encode()).hexdigest()

        shared_services.append(
            PeerServiceInfo(
                module=module_name,
                version=module_contract.version,
                capabilities=module_contract.capabilities,
                methods=methods,
                max_concurrent=sharing_config.max_concurrent,
                digest=digest,
            )
        )

    aurora_version = _get_package_version()

    manifest = PeerManifest(
        peer_id=peer_id,
        node_name=mesh_config.node_name,
        aurora_version=aurora_version,
        shared_services=shared_services,
        timestamp=datetime.now(UTC).isoformat(),
    )

    log_info(
        f"Mesh: Generated manifest with {len(shared_services)} shared services: "
        f"{[s.module for s in shared_services]}"
    )
    return manifest


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

    for svc in remote_manifest.shared_services:
        # Check if we have routing config that wants this service from the network
        routing_config = mesh_config.routing.get(svc.module)

        if not routing_config or routing_config.prefer in ("local_only", "local"):
            # We don't want this service from the network
            unused.append(svc.module)
            continue

        # We want this service — check compatibility
        is_compat = True

        # Version check
        if routing_config.min_version and not is_compatible(
            routing_config.min_version,
            svc.version,
            mesh_config.version_policy,
            routing_config.min_version,
        ):
            is_compat = False

        # Capability check
        if routing_config.required_capabilities and not all(
            cap in svc.capabilities for cap in routing_config.required_capabilities
        ):
            is_compat = False

        if is_compat:
            compatible.append(svc.module)
        else:
            incompatible.append(svc.module)

    ack = ManifestAck(
        compatible_services=compatible,
        incompatible_services=incompatible,
        unused_services=unused,
    )

    log_info(
        f"Mesh: Manifest ACK — compatible={compatible}, "
        f"incompatible={incompatible}, unused={unused}"
    )
    return ack


def manifest_to_dict(manifest: PeerManifest) -> dict:
    """Serialize a manifest for DataChannel transmission.

    Args:
        manifest: PeerManifest to serialize

    Returns:
        Dictionary suitable for JSON encoding and sending via DataChannel
    """
    return {
        "type": "manifest",
        **manifest.model_dump(mode="json"),
    }


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
    try:
        # Remove the 'type' field before parsing
        manifest_data = {k: v for k, v in data.items() if k != "type"}
        return PeerManifest.model_validate(manifest_data)
    except Exception as e:
        log_warning(f"Mesh: Failed to parse manifest: {e}")
        return None


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

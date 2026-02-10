"""P2P Mesh Network for Aurora.

This package implements transparent peer-to-peer mesh networking,
allowing Aurora instances to share and consume services across the network.

Key components:
- models: Pydantic models for peer state, manifests, and routing
- peer_registry: Tracks connected peers and their capabilities
- routing_table: Resolves bus topics to local or remote targets
- peer_bridge: Sends outbound RPC calls to remote peers
- negotiation: Manifest exchange and compatibility verification
- version_compat: Semantic version compatibility checking
- latency: Periodic ping/pong latency measurement
"""

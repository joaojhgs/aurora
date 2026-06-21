# PER-135 Ultragoal Checkpoints

## G001 - Plan

Status: complete

Evidence:
- Read Multica issue PER-135, metadata, and comments.
- Read repo and subsystem AGENTS guidance for messaging, shared/contracts, gateway mesh, and tests.
- Confirmed referenced `.omx` mesh task/spec files are absent on this branch.
- Created `.omx/plans/PER-135-hybrid-addressing-primitives.md`.

## G002 - Implementation

Status: complete

Evidence:
- Added `MeshAddressSelector` and route error metadata.
- Added optional `mesh_selector` fields to Tooling and DB/RAG payloads.
- Added `require_explicit_selector` mesh service policy.
- Updated `RoutingTable` and `MeshBus` so explicit peer/provider/service selectors override transparent routing and do not silently fall back.
- Documented hybrid transparent vs explicit categories in `docs/PEER_PAIRING_FLOW.md`.

## G003 - Verification

Status: complete

Evidence:
- `~/.local/bin/uv run --extra test-integration pytest tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_mesh_bus.py tests/integration/test_mesh_routing.py -q` -> 49 passed, 5 warnings.
- `~/.local/bin/uv run --extra dev ruff check app/shared/contracts/models/mesh.py app/shared/contracts/models/tooling.py app/shared/contracts/models/db.py app/services/gateway/config.py app/services/gateway/mesh/models.py app/services/gateway/mesh/routing_table.py app/messaging/mesh_bus.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_mesh_bus.py` -> passed.
- `git diff --check` -> passed.
- First broader suite attempt without gateway extra failed during collection because `aiortc` was missing.
- `~/.local/bin/uv run --extra test-integration --extra gateway pytest tests/unit/gateway/test_negotiation.py tests/unit/gateway/test_routing_table.py tests/unit/gateway/test_peer_bridge.py tests/unit/gateway/test_rpc.py tests/unit/gateway/test_rtc_auth_enforcement.py tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_failover.py -q` -> 93 passed, 13 warnings.

## Stop Condition

Implementation can hand off when code, tests, docs, branch/PR, and QA comment are complete, with explicit note about missing referenced `.omx` specs.

## Objective
Support remote scheduling without creating ambiguous ownership or bypassing tool policy. Jobs that run on a peer or invoke remote tools must carry namespace, owner, target peer, and delegated permission context.

## Context
This task is part of the Aurora mesh-polishing roadmap derived from `.omx/specs/deep-interview-mesh-distributed-integration.md`.

Current confirmed baseline:
- Targeted mesh/gateway tests previously passed: `88 passed, 13 warnings`.
- `MeshBus` already routes commands and mesh events through routing/peer bridge paths.
- WebRTC pairing, manifest exchange, service negotiation, and service sharing are implemented to a working baseline.
- Orchestrator already uses the bus for Tooling discovery/execution, and Tooling exposes `GetTools`/`ExecuteTool` as mesh-shareable methods.

Roadmap constraints:
- Preserve Aurora's privacy-first, message-bus-first microservice architecture.
- Use pragmatic security tiers across home LAN/VPN, Docker/process clusters, and internet-crossing peers.
- Use hybrid addressing: transparent routing is allowed for low-risk service dependencies, but explicit peer/resource addressing is required for tools, DB/data, hardware, scheduler ownership, remote playback, and safety-sensitive actions.
- Prefer existing contracts/utilities and typed topic constants; avoid exposing raw internal/admin capabilities by default.

Current baseline:
- Scheduler exposes schedule/cancel/list as `both` for mesh-advertisable access.
- Scheduled actions may eventually invoke tools, making policy delegation important.

Relevant code anchors:
- `app/services/scheduler/service.py`
- `app/services/scheduler/scheduler_manager.py`
- `app/services/db/scheduler_db_service.py`
- Tooling policy tasks `[MESH][P3-T01]` through `[MESH][P3-T03]`.

## Initial implementation plan
1. Define scheduler namespaces and ownership model for local vs remote jobs.
2. Add explicit target peer/resource selectors for jobs that execute on a remote peer.
3. Add delegated action policy for jobs that call tools or orchestrator flows later.
4. Ensure cancellation/listing respects owner namespace and permissions.
5. Add audit logs for remote schedule creation, execution, cancellation, and denial.

## Acceptance criteria
- Remote jobs are namespace-aware.
- A peer cannot cancel or list jobs outside authorized scopes.
- Tool-invoking jobs preserve delegated permission context.
- Audit events show who scheduled what, where, and under which policy.

## Suggested verification
- Unit tests for scheduler namespace authorization.
- Integration tests for remote schedule/list/cancel through mesh mocks.

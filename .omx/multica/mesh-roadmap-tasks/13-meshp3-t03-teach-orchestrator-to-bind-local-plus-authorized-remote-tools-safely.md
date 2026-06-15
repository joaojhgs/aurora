## Objective
Let Aurora orchestrators see and use tools across peers without hiding provenance or bypassing safety policy. The orchestrator should understand which tools are local, which are remote, which require confirmation, and which are unavailable due to policy.

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
- `app/services/orchestrator/agents/chatbot.py` calls `Tooling.GetTools`.
- `app/services/orchestrator/graph.py` calls `Tooling.ExecuteTool`.
- This can become mesh-aware once Tooling discovery/execution models carry provider and policy metadata.

Relevant code anchors:
- `app/services/orchestrator/agents/chatbot.py`
- `app/services/orchestrator/graph.py`
- `app/services/tooling/service.py`
- `app/shared/messaging/models/tooling_models.py`

## Initial implementation plan
1. Update tool binding logic to preserve provider/source metadata in tool names or hidden execution metadata.
2. Decide how LLM-visible names should encode provenance without becoming unwieldy.
3. Add filtering so only authorized and safe-to-advertise remote tools are provided to the model.
4. Add confirmation hooks or blocked placeholders for high-risk tools when policy requires human approval.
5. Ensure execution uses explicit provider/tool ID rather than ambiguous display name.

## Acceptance criteria
- Orchestrator can bind tools from multiple peers in one planning context.
- Tool provenance is retained through model selection and execution.
- Colliding names are resolved deterministically.
- High-risk tools can require confirmation or be hidden based on policy.
- Existing local-only orchestrator behavior still works.

## Suggested verification
- Unit tests for tool binding with local and remote tools.
- End-to-end mocked graph test where the model selects a remote tool and execution routes to the intended peer.

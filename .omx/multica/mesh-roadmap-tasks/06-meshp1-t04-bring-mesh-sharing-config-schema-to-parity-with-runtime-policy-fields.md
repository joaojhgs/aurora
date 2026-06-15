## Objective
Fix the mismatch between runtime `MeshServiceConfig` and generated config schema/defaults. Operators need supported config knobs for peer allowlists, version requirements, and required capabilities if those fields are part of the intended policy model.

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

Observed facts:
- Runtime config supports `allowed_peers`, `min_version`, and `required_capabilities`.
- Generated schema currently exposes only `share`, `max_concurrent`, `prefer`, and `fallback`.

Relevant code anchors:
- `app/services/gateway/config.py`
- `app/services/config/config_schema.json`
- `app/services/config/config_defaults.json`
- `app/shared/config/models.py`
- `app/shared/config/keys.py`
- `docs/CONFIG_SERVICE_PATTERN.md`

## Initial implementation plan
1. Decide which runtime fields are officially supported for the next mesh phase.
2. Add supported fields to `config_schema.json` with safe defaults and descriptions.
3. Run config generation (`make generate-config`) so models, keys, and defaults stay schema-first.
4. Update docs with examples for home, process-cluster, and internet-crossing trust tiers.
5. Add tests or validation checks for schema/model parity.

## Acceptance criteria
- Runtime mesh config and generated schema/defaults agree.
- Unsupported fields are removed or documented as intentionally internal.
- Config examples cover `allowed_peers`, version policy, and required capabilities if supported.
- `make generate-config` outputs are included when schema changes.

## Suggested verification
- `make generate-config`
- Targeted config validation tests.
- `make lint` and relevant unit tests.

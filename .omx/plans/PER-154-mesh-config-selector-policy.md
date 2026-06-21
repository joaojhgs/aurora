# PER-154 Mesh Config Selector Policy Plan

## Requirements Summary

- Source of truth: Multica issue PER-154 / MESH-GAP-002 and `.omx/multica/mesh-production-gap-tasks/02-mesh-gap-002-mesh-gap-p1-complete-mesh-config-parity-and-explicit-selector-enforcement-policy.md`.
- Branch policy: implement from `origin/feat/mesh-full-services-integrations` on a dedicated branch targeting `feat/mesh-full-services-integrations`.
- Context: `.omx/plans/mesh-production-e2e-integration-gap-plan.md` and `.omx/specs/deep-interview-mesh-distributed-integration.md` require hybrid addressing: transparent routing remains for low-risk dependencies, but sensitive categories need explicit peer/resource selectors.
- Runtime anchor: `app/services/gateway/config.py` defines `MeshServiceConfig.require_explicit_selector`, but generated config artifacts currently omit that field.
- Existing implementation already covers several operation-level selector requirements in `app/services/gateway/mesh/routing_table.py` for tooling policy and audio/STT/TTS sensitive topics.

## Acceptance Criteria

- `app/services/config/config_schema.json` exposes every `MeshServiceConfig` policy field, including `require_explicit_selector`, under `$defs.mesh_sharing`.
- Generated artifacts include `require_explicit_selector` in `app/services/config/config_defaults.json`, `app/shared/config/models.py`, and `app/shared/config/keys.py` for STT coordinator, WakeWord, Transcription, DB, TTS, Tooling, Scheduler, and Orchestrator.
- `GatewayService._get_gateway_config()` keeps the generated `MeshSharing` value intact when validating into runtime `MeshServiceConfig`; unsupported enum values continue to be rejected by schema/generated-model validation.
- Selector-required failures remain structured with `target="error"` and `error_code="selector_required"`.
- Defaults stay privacy-first: `share=false`, `prefer=local`, `fallback=local`, and `require_explicit_selector=false`.

## Implementation Steps

1. Add `require_explicit_selector` to `$defs.mesh_sharing` in `app/services/config/config_schema.json` with default `false`.
2. Run `make generate-config` to regenerate defaults, models, and keys from the schema.
3. Strengthen `tests/unit/app/config/test_mesh_sharing_schema.py` to compare the generated artifacts against the complete runtime policy field set and every mesh-shareable service path.
4. Add/extend gateway tests proving `MeshSharing -> MeshServiceConfig` preserves `require_explicit_selector` and invalid generated-model values are rejected before runtime config is accepted.
5. Run focused config and routing tests plus `make check-config-generated`.

## Risks and Mitigations

- Generated artifacts may produce broad diffs. Mitigation: inspect generated changes and keep only schema-driven updates.
- Adding `require_explicit_selector` could accidentally make existing services selector-only by default. Mitigation: default remains `false`; routing tests preserve transparent TTS synthesize and batch transcription behavior.
- Operation-level policy could exceed this issue. Mitigation: limit implementation to existing routing-table operation checks and add tests only for the acceptance paths named by PER-154.

## Verification

- `make generate-config`
- `make check-config-generated`
- `uv run pytest tests/unit/app/config/test_mesh_sharing_schema.py tests/unit/gateway/test_routing_table.py -q`

## Stop Condition

PER-154 is ready for QA when generated config parity is proven, selector-required routing behavior is covered, local verification passes or any skipped command is documented, changes are committed, a PR exists against `feat/mesh-full-services-integrations`, and the issue is handed to QA.

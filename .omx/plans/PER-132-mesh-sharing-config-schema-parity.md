# PER-132 Mesh Sharing Config Schema Parity Plan

## Requirements Summary

- Source of truth: Multica issue PER-132, plus available repo guidance in `AGENTS.md`, `app/services/AGENTS.md`, `app/services/gateway/AGENTS.md`, `app/shared/AGENTS.md`, `tests/AGENTS.md`, and `docs/CONFIG_SERVICE_PATTERN.md`.
- Missing context: the issue references `.omx/specs/deep-interview-mesh-distributed-integration.md` and `.omx/multica/mesh-roadmap-tasks/`, but this checkout of `feat/migration-to-modular-services-architecture` does not contain those paths.
- Runtime anchor: `app/services/gateway/config.py` has `MeshServiceConfig.allowed_peers`, `min_version`, and `required_capabilities`.
- Schema anchor: `app/services/config/config_schema.json` currently defines `mesh_sharing` with only `share`, `max_concurrent`, `prefer`, and `fallback`.
- Acceptance target: runtime config, schema, generated defaults, generated config models, generated keys, docs, and validation tests agree.

## Implementation Steps

1. Treat `allowed_peers`, `min_version`, and `required_capabilities` as supported operator-facing fields because they already exist in runtime policy and mesh negotiation/routing tests.
2. Add these fields to `$defs.mesh_sharing` in `app/services/config/config_schema.json` with safe defaults:
   - `allowed_peers`: `null` or string array, default `null`, meaning any authenticated peer may use a shared service.
   - `min_version`: `null` or string, default `null`, deferring to global mesh version policy unless set.
   - `required_capabilities`: string array, default `[]`, meaning no extra capability requirement.
3. Run `make generate-config` so `app/shared/config/models.py`, `app/shared/config/keys.py`, and `app/services/config/config_defaults.json` are generated from the schema.
4. Add a focused config test asserting runtime `MeshServiceConfig` fields are present in the schema, generated model, generated keys, and defaults.
5. Update `docs/CONFIG_SERVICE_PATTERN.md` with concise examples for home LAN, process-cluster, and internet-crossing trust tiers.

## Verification

- `make generate-config`
- `uv run pytest tests/unit/app/config/test_mesh_sharing_schema.py -q`
- `make check-config-generated`
- A targeted gateway mesh/config test if affected by generated models.

## Risks

- Generated artifacts may reorder or format unrelated config code. Mitigation: inspect diff and keep schema edits minimal.
- Defaults could accidentally broaden exposure. Mitigation: preserve `share: false`; new lists are empty and allowlist is `null` only meaningful after explicit sharing.

## Stop Condition

- PER-132 is ready for QA when schema/runtime parity is tested, docs are updated, generated files are clean, a commit is pushed, and a PR is opened.

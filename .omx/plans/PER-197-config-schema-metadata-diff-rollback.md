# PER-197 / BE-010 Plan: Config Metadata, Diff, Rollback, Reload Impact

## Requirements Summary

- Source issue: PER-197 / BE-010, backend/config lane, `admin.config.edit`.
- Scope is backend contract support only. No production UI wiring.
- Source docs read: root/service/gateway/auth/messaging/shared/contracts/tests AGENTS, `docs/CONFIG_SERVICE_PATTERN.md`, UI refinement specs, backend gap crosswalk, and BE-010 task file.
- Code paths: `app/shared/contracts/models/config.py`, `app/services/config/service.py`, `app/services/config/config_manager.py`, targeted config/gateway tests.
- Invariants: ConfigService owns ConfigManager and config file writes; all external access uses typed bus methods; manage methods are exposed with PascalCase permissions and remain AdminAction/audit gated by generated Gateway routes.

## Acceptance Criteria

- Add typed Config methods and IO models for schema metadata, diff preview, version history, rollback, and reload-impact preview.
- Metadata includes description, source layer, secret flag, reload/restart classification, and redacted current/default values where applicable.
- Diff and history never expose secret values; rollback creates a version entry and publishes normal config update behavior.
- Manage methods use `method_type="manage"` and explicit PascalCase permissions.
- Registry/OpenAPI can expose the new Config methods through existing generated routes.
- Tests prove redaction, impact classification, version retention/rollback, and AdminAction gating for new manage routes.

## Implementation Steps

1. Extend Config contract models with new `ConfigMethods` constants and IO models.
2. Add ConfigManager helpers for schema metadata extraction, source resolution, redaction, diff preview, history retention, and rollback.
3. Register ConfigService handlers with `@method_contract`, using read-only `use` methods for schema/history/impact/diff preview and `manage` for rollback.
4. Add unit tests for ConfigManager/ConfigService behavior and a Gateway generated-route test for AdminAction on rollback.
5. Run targeted pytest, py_compile or ruff where available, and `git diff --check`.

## Verification

- `uv run pytest tests/unit/services/test_config_admin_contracts.py tests/unit/gateway/test_route_generator_adminaction.py -q`
- `uv run python -m py_compile app/shared/contracts/models/config.py app/services/config/config_manager.py app/services/config/messages.py app/services/config/service.py`
- `git diff --check`

## Risks

- Secret leakage: redact by schema metadata and known secret path names before returning metadata/diffs/history.
- Process-mode ownership: keep all ConfigManager access inside ConfigService and tests only.
- Admin mutation bypass: expose rollback as manage so generated Gateway requires AdminAction before bus forwarding.

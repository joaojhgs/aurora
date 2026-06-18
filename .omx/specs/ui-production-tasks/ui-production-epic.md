# [UI][EPIC] Multi-platform UI production implementation after mesh integration

## Branch and sequencing policy

- **Target branch:** `feat/ui-multi-platform-integration`.
- Do not start this UI implementation epic until all mesh production gap tasks are complete through `MESH-GAP-011` and `MESH-GAP-012` refreshes UI/SDK specs against the final backend contracts.
- Create `feat/ui-multi-platform-integration` from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks are pushed now only to preserve ordering and planning context; they must remain blocked until the mesh sequence is accepted.

## Source documents

- `.omx/specs/ui-production-tasks/index.md`
- `.omx/specs/ui-production-tasks/manifest.md`
- `.omx/specs/ui-production-tasks/backend-gap-crosswalk.md`
- `.omx/specs/ui-refinement/`
- `modules/ui-mock-reference/`

## Mesh gate

Required completed prerequisites before unblocking:

- `PER-152` / `MESH-GAP-EPIC` accepted.
- `PER-163` / `MESH-GAP-011` production two-peer E2E harness accepted.
- `PER-164` / `MESH-GAP-012` UI/SDK spec refresh accepted.

# BE-018 — Add scheduler management exposure and AdminAction contract

## Execution metadata

- **Phase:** P2 — Backend contract and gateway/API gaps
- **Lane:** backend/scheduler
- **Depends on:** P0-002, BE-004
- **Parallelizable with:** ADM-012
- **Coverage matrix rows:** admin.scheduler
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Make scheduler job management exposure explicit so the admin UI can safely list, schedule, cancel, pause, and resume jobs or honestly disable unsupported actions.

## User-visible outcome

Operators can manage scheduled jobs only through typed, permissioned, audited backend contracts.

## Backend/API implementation details

- Inventory current `SchedulerMethods` contracts and exposure levels, especially `PAUSE` and `RESUME` currently internal.
- Decide which operations are public/admin-manage: list, schedule, cancel, pause, resume, run-now if added, and job history/status.
- All mutating operations must require AdminAction confirmation/audit and scheduler-specific permissions.
- Return explicit unsupported/degraded states for pause/resume if CronService cannot guarantee safe resume semantics.
- Include next-run, last-run, owner/principal, source, timezone, failure count, and privacy class where available.

## SDK integration details

- Add scheduler method descriptors and normalized SDK helpers for list/schedule/cancel/pause/resume/degraded states.
- Capability graph must allow ADM-012 to disable pause/resume while leaving list/read-only views available.

## Tauri/native integration details

- No direct native work; desktop/mobile admin surfaces consume SDK only. Notifications for job status may be future work through event stream.

## UI/UX implementation details

- `ADM-012` depends on this task for production mutations. UI must show internal-only/unsupported controls as disabled with explanation until this lands.

## Code references to inspect first

- `app/services/scheduler/service.py` method contracts and exposure levels
- `app/shared/contracts/models/scheduler.py`
- `app/shared/messaging/models/scheduler_models.py`
- `app/services/tooling/` if jobs trigger tool actions
- `tests/unit/services/scheduler` or nearest scheduler tests

## Mock/component references

- `modules/ui-mock-reference/components/aurora/admin/secondary-surface.tsx`
- `modules/ui-mock-reference/components/aurora/admin/services-view.tsx`
- `modules/ui-mock-reference/app/(cockpit)/admin/page.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants, Pydantic/IOModel payloads, registered method contracts, and PascalCase permissions.
- Treat personal memory, schedules, job payloads, RAG namespaces, and tool arguments as sensitive unless explicitly public.
- Mutations require AdminAction/audit when method type is manage/admin-critical.

## Acceptance criteria

- Scheduler list/read methods and each mutation have explicit exposure, permission, and audit behavior.
- Pause/resume are either fully implemented and tested or capability-gated as unsupported.
- ADM-012 can wire all visible job actions through SDK without direct gateway fetches or fake success.

## Verification commands / evidence

- Targeted scheduler service tests.
- Gateway/registry inventory verifies scheduler exposure and method_type.
- AdminAction/audit tests for schedule/cancel/pause/resume where enabled.

## Risks and guardrails

- Do not make internal-only methods public without permission/audit review.
- Do not fake UI support by silently ignoring unsupported backend actions.
- Do not leak personal data, job arguments, model paths, embeddings, or peer-owned records.

## Handoff notes

- Added by full coverage review after Critic rejection identified this backend contract as implicit/weak.

# PER-143 Mesh Scheduler Delegation Policy Plan

## Requirements Summary
- Add namespace-aware scheduler ownership for mesh-advertisable `Scheduler.Schedule`, `Scheduler.Cancel`, and `Scheduler.ListJobs`.
- Preserve message-bus-first boundaries and avoid raw cross-peer scheduler DB access.
- Carry delegated action context for future tool/orchestrator execution from schedule creation through job firing.
- Audit remote schedule creation, listing, cancellation, execution, and denials with redacted policy context.

## Acceptance Criteria
- Remote jobs have explicit namespace, owner peer/principal, target peer/resource selector, and delegated permission context.
- List and cancel only expose/modify jobs in the caller's authorized namespace/owner scope.
- Tool-like scheduled actions preserve delegated caller peer/principal, target peer, policy decision, correlation ID, and permissions.
- Tests cover namespace filtering, unauthorized cancellation denial, delegated context persistence, and execution audit context.

## Implementation Steps
1. Extend scheduler contract models in `app/shared/contracts/models/scheduler.py` with `MeshAddressSelector`, delegated action context, ownership filters, and metadata on job/event responses.
2. Update `app/services/scheduler/service.py` to normalize ownership, store scheduler context in cron callback args, filter list results, guard cancel ownership, and audit allow/deny/execute events via `Auth.StoreAuditEvent`.
3. Keep scheduler runtime persistence migration-free by using existing `CronJob.callback_args` JSON storage and local `_jobs` tracking.
4. Add unit tests under `tests/unit/app/scheduler/` for schedule/list/cancel policy behavior and callback execution context.
5. Update `docs/SERVICE_METHODS_REFERENCE.md` to describe the new scheduler ownership/delegation fields.

## Risks and Mitigations
- Existing clients may not send ownership fields. Mitigation: default namespace to `local` and owner to local/system so current local calls remain compatible.
- Mesh caller identity injection is still upstream-dependent. Mitigation: expose `caller_peer_id` and `caller_principal_id` fields now and enforce scope when present.
- DB migration would increase blast radius. Mitigation: store metadata in existing callback args, which already survives serialization.

## Verification
- `uv run pytest tests/unit/app/scheduler/test_scheduler_remote_policy.py -q`
- `uv run pytest tests/unit/app/scheduler/test_scheduler_manager.py tests/unit/app/scheduler/test_scheduler_models.py -q`
- Optional broader scheduler integration tests if targeted unit verification passes quickly.

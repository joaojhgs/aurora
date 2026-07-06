# Tooling Page UI Production Execution Ultragoal Brief

Execute `.omx/plans/TOOLING_PAGE_UI_EXECUTION_PLAN.md` fully, using `.omx/plans/TOOLING_PAGE_UI_DESCRIPTION.md` as the UX source of truth.

Global constraints:
- Preserve Aurora architecture: UI through SDK/Gateway/Tauri boundaries only; services communicate through the bus; typed topic constants and Pydantic IO models; `@method_contract`; structured logging; no literal bus topics.
- All UI platform behavior must use `packages/aurora-ui/src/platform-surface.ts` / `getAuroraSurfaceProfile`.
- Do not store durable policy truth only in frontend state. Backend/SDK read models are source of truth.
- Tool policy, grants, approvals, mesh catalogs, scheduled tool actions, onboarding, and audit/history must be integrated, tested, and documented.
- Keep changes reviewable and use existing patterns/primitives before new abstractions.

Goals:

1. Backend contract/read-model gap closure
   - Inspect current Tooling/Scheduler/Orchestrator contracts and implement any missing typed backend methods/read models required by the plan: policy summary, source list/detail, source/tool policy overrides, grants, pending approvals, policy audit/history, MCP/plugin onboarding/test where supported, mesh catalog status, scheduler dependencies.
   - Add/adjust config schema/defaults only when backend policy state requires it and regenerate config models/keys/defaults.
   - Add backend tests for redaction, policy precedence, grants, pending approvals, mesh catalog lifecycle/staleness, scheduler dependencies, and audit mutations.

2. SDK Tooling management API
   - Add typed SDK models and client methods for the backend read/write surfaces above.
   - Update descriptors, fixtures, mock client, normalizers, package exports, and SDK tests.
   - Ensure request paths are Gateway-compatible and redaction metadata is preserved.

3. `/tools` UI architecture and source-first page
   - Replace/split `packages/aurora-ui/src/tool-approval-panel.tsx` into a production source-first tooling console under `packages/aurora-ui/src/tooling/` as described in the plan.
   - Build responsive dark UI using existing Aurora/shadcn primitives and platform-surface truth.
   - Include source rail, summary/status, detail panel, on-demand tool expansion, empty/offline/error/loading states, and mock/demo labels.

4. Policy, grants, approvals, onboarding, mesh, scheduler, and audit UX
   - Implement global policy controls, source/package/tool trust controls, per-tool overrides, future-tool inheritance warnings, grant lifecycle, pending runtime approval queue, MCP/plugin onboarding wizard stubs/flows backed by real SDK methods, mesh catalog/staleness/re-announcement views, scheduled tool action grant dependencies, and policy audit/history timeline.
   - Preserve assistant inline approval separation: `/tools` manages catalog policy/grants; assistant inline approval handles one exact runtime tool call with approve once/session/until-expiry/always and deny once/always.

5. Docs, verification, and final quality gate
   - Update docs/operator guidance for the real Tooling page behavior and platform limits.
   - Run targeted backend, SDK, UI, and route tests. Add/adjust tests so previous placeholder/flat Tooling UI and missing policy surfaces would fail.
   - Run final cleanup/no-op cleanup if appropriate, independent code review, architect invariant audit, and checkpoint final evidence.

Definition of done:
- `/tools` is a production, source-first, responsive policy/tooling console, not a flat approval-card placeholder.
- Backend and SDK expose typed, tested read/write surfaces needed by the UI.
- Core/MCP/plugin/mesh/unknown/blocked sources, grants, policy overrides, pending approvals, scheduled action dependencies, and audit/history are represented truthfully.
- Mesh tool catalogs come from negotiated cached state and show staleness/re-announcement state; no prompt-time peer fanout is required for the page.
- No secrets/tokens/raw sensitive payloads leak in UI, logs, support output, or SDK normalizers.
- Verification commands from `.omx/plans/TOOLING_PAGE_UI_EXECUTION_PLAN.md` pass or environment blockers are documented with evidence.

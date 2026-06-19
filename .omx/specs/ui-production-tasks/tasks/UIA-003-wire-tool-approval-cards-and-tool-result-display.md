# UIA-003 — Wire tool approval cards and tool-result display


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P7 — Assistant UI production wiring
- **Lane:** assistant-tools
- **Depends on:** UIA-001, SDK-013, BE-011
- **Parallelizable with:** None
- **Coverage matrix rows:** assistant.tool.approval
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Make tool execution transparent and permission/privacy aware.

## User-visible outcome

User sees tool risk, inputs, data-egress, approval/deny reason, progress, result, and audit receipt.

## Backend/API implementation details

- Consume existing/new backend only through SDK; keep unsupported backend features disabled with capability explanation.

## SDK integration details

- Use `AuroraClient` APIs and capability graph; no direct fetch/invoke in screen components.

## Tauri/native integration details

- No Tauri/native work is expected in this task. Native capabilities must be consumed through the SDK/native manifest produced by the relevant `TAURI-*`, `AND-*`, or `IOS-*` task.

## UI/UX implementation details

- Use SDK tool metadata/risk taxonomy.
- Approval calls route through AdminAction when tool is mutating/external/admin; lower-risk approvals still emit audit/decision event if backend requires.
- Validate arguments against tool schema and show read-only diff/result.

## Code references to inspect first

- Future production UI package/routes/components
- Reference mock component files listed below.

## Mock/component references

- `components/aurora/assistant/tool-call-card.tsx`
- `components/aurora/admin-confirm-dialog.tsx`
- `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`

## Data, permissions, and privacy contract

- Use route/privacy/availability badges and AdminAction controller consistently.
- Include loading, empty, denied, degraded, unavailable, optimistic, and rollback/error states.

## Acceptance criteria

- Screen is responsive desktop/tablet/mobile.
- Feature visibility and buttons are capability-driven.
- All mutations use AdminAction if method_type manage/admin-critical.
- Component tests cover state matrix and SDK errors.

## Verification commands / evidence

- `pnpm --filter <ui-package> typecheck`
- `pnpm --filter <ui-package> test`
- `pnpm --filter <ui-package> build`
- Playwright/visual regression for primary happy/error states.

## Risks and guardrails

- Do not ship mock fixture data in production screens.
- Do not hide unsupported features without explaining repair/fallback.

## Handoff notes

- No additional handoff notes at planning time.

<!-- MESH-PRODUCTION-GAP-ADDENDUM -->
## Mesh production gap addendum

This UI must support the production approval harness from `MESH-GAP-005` and the aggregate tool catalog from `MESH-GAP-004`. It is not only for mesh tools: internal/local tools can require the same approval flow.

Additional requirements:

- Render orchestrator approval interrupts with payload type `tool_approval_request` as first-class tool cards. Required fields are `approval_request_id`, `correlation_id`, `policy_decision_id`, `global_tool_id`, `provider_peer_id`, `provider_service_instance_id`, `mesh_selector`, `arguments`, `args_schema`, `approval_mode`, `expires_at`, `safety_class`, `execution_location`, `reason_code`, and `reason`.
- Approval cards must call SDK methods only:
  - request/preflight state through `client.tools.prepareExecution()` or the orchestrator-provided interrupt payload,
  - approval through `client.tools.requestApproval()` when the card is created outside orchestrator,
  - admin/user decision through `client.tools.confirmExecution()`,
  - final execution through `client.tools.execute()` with the returned approval token.
- Subscribe to the SDK event stream for `tool.approval.requested`, `tool.approval.approved`, `tool.approval.denied`, `tool.execution.executed`, and `tool.execution.failed`; events must be correlated by `correlation_id` and `approval_request_id`.
- Show provider choice when a tool exists locally and on one or more peers. Default selection must follow route/privacy policy and explicit selector requirements.
- Render approval cards for local/internal tools, remote mesh tools, MCP/plugin tools, and cloud/external tools using one visual grammar.
- Show risk class, data egress, mutating/admin flags, peer/provider, trust tier, transport, args diff/hash, dry-run preview, requested approval scope, TTL, and audit destination.
- Support deny, approve once, approve until expiry, approve all for session, approve all for peer, approve all local safe tools, dry-run, and policy-managed disabled states.
- Approval card submission must call the SDK approval controller/AdminAction composition, not direct backend endpoints.
- Tool result cards must include provider, correlation ID, audit receipt, route path, duration, redaction status, and retry/fallback eligibility.
- If approval is blocked because explicit selector is missing, show a provider selector instead of an approve button.

Additional mock/component references:

- `modules/ui-mock-reference/components/aurora/assistant/tool-call-card.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/route-sheet.tsx`
- `modules/ui-mock-reference/components/aurora/admin-confirm-dialog.tsx`
- `modules/ui-mock-reference/app/(cockpit)/tools/page.tsx`

Additional acceptance criteria:

- Component tests cover local dangerous tool, remote dangerous tool, duplicated local+remote tool, approve-all session, approve-all peer, dry-run-only, denied, expired approval, replay rejection, and service unavailable.
- Component tests verify orchestrator `tool_approval_request` payloads render without a direct backend fetch and preserve hidden provider metadata for the follow-up SDK calls.

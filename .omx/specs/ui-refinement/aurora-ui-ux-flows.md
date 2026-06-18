# Aurora UI UX Flows

## General Interaction Rules

- Display peer/provider/resource identity anywhere a remote action can occur.
- Keep local vs remote provider explicit; do not hide fallback behind a generic success message.
- Show pending, denied, degraded, stale, privacy-blocked, and deferred states with backend reason text when available.
- Disable irreversible or safety-sensitive actions until required selector, consent, confirmation, and permission evidence exists.
- Surface correlation IDs in expandable diagnostics or copyable metadata, not as permanent visual noise.

## Mesh Overview Flow

1. Load `Gateway.GetMeshStatus`.
2. Render local mesh status, stable peer ID, node name, shared modules, routed modules, and redaction status.
3. Render peers grouped by lifecycle: connected/authenticated, negotiated, stale, denied, disconnected.
4. For each routed module, show local/remote/none/error decision, provider peer, fallback, and provider eligibility reason codes.
5. Offer a diagnostics details panel for compatibility failures, capacity, active calls, latency, manifest age, and last ping age.

Accessibility:
- Peer and route status must have text labels and ARIA status/live-region behavior for updates.
- Keyboard focus should move into details only when the user opens them, then return to the triggering row/button.

## Peer Trust And Pairing Flow

1. Read Auth mesh peer state for stable peer identity, outbound status, inbound status, permissions, and connection state.
2. Show bilateral state clearly: what this node grants to the peer and what the peer grants back.
3. Pending approval must stay pending until Auth reports approved or denied.
4. Denied peers remain visible as denied with a re-approval path only when backend peer-admin permissions allow it.
5. Reconnect should show saved peer-scoped credential reuse only as a backend-proven state after auth succeeds.

Blocked claims:
- Do not present presence as pairing success.
- Do not present a saved legacy/default token as peer-specific trust until the backend resolves a stable peer identity.

## Capability Explorer Flow

1. Load `Gateway.GetCapabilityGraph`.
2. Render provider peers, service instances, methods, and resources with policy flags.
3. Show candidate providers separately from currently routable providers so degraded and blocked services are inspectable.
4. Use policy flags to explain required selectors, confirmation, consent, privacy indicators, bandwidth checks, and local-only status.
5. For methods/resources with `explicit_selector_required=true`, expose selector construction as a preflight step before any execution UI.

## Remote Tool Flow

1. Discover tools through `Tooling.GetTools`.
2. Show provider peer, service instance, display name, stable global tool ID, source, safety class, required permissions, and confirmation requirement.
3. Standard remote tools may be made available to Orchestrator when backend metadata marks them safe and authorized.
4. Sensitive/dangerous/confirmation-required tools require a preflight screen with target peer/resource, argument summary, confirmation, and expected audit trail.
5. Execute with explicit selector/resource fields when required.
6. Display `success`, `denied`, `not_found`, `failed`, or `dry_run` from `ToolingExecuteToolResponse` with correlation ID.

## Data And Memory Flow

Current UI may support:
- Remote-query-only views for backend-exposed query methods.
- Export/import planning language where future contracts explicitly exist.
- Policy explanations for why raw SQL and replication are unavailable.

Current UI must block/defer:
- Raw cross-peer SQL.
- Bidirectional RAG/chat/scheduler replication.
- Delete/forget propagation claims.
- Trust-table, credential, token, or mesh secret replication.

## Audio Flow

- Batch `TTS.Synthesize` and `Transcription.Transcribe` can be shown as shareable when mesh config and route diagnostics prove an eligible provider.
- Remote playback/control requires explicit peer/device target and confirmation.
- Live microphone, wakeword, and streaming transcription require explicit target, consent, visible privacy indicators, and bandwidth/capacity checks.
- UI must not claim a peer is listening, speaking, muted, or streaming unless backend audio/service events prove it.

## Scheduler Delegation Flow

1. Show namespace, owner peer/principal, target selector, delegated permissions, policy decision, and correlation.
2. Remote-created jobs should be listed only in the backend-authorized caller scope.
3. Cancellation must explain denied ownership/policy failures.
4. Job firing/completion should preserve delegated context in visible diagnostics.

## Failure And Recovery Flow

Use failure-mode expectations from PER-146:

- Transparent routing may fall back when policy allows it; the UI should label the fallback used.
- Explicit selector failures are hard failures and must not be displayed as fallback success.
- Stale, denied, unauthorized, or at-capacity providers are not selectable for execution.
- Network-only services without eligible providers show no-route/error.
- Forwarded events should not appear as repeated looped events.

# TAURI-007 — Map legacy PyQt UIBridge to Tauri/SDK migration contract


<!-- UI-BRANCH-POLICY -->
## UI branch and sequencing policy

- **Target implementation branch:** `feat/ui-multi-platform-integration`.
- Do not start production UI implementation from these tasks until the mesh-gap sequence is complete through `MESH-GAP-011` and `MESH-GAP-012` has refreshed UI/SDK tasks against the finalized mesh contracts.
- The UI branch should be created from the accepted `feat/mesh-full-services-integrations` result, not from stale `main` or the old migration branch.
- UI tasks may only be used as planning/reference before that gate; production wiring waits for final capability catalog, route explain, aggregate tooling, approval protocol, data/RAG, audio, scheduler, audit, and diagnostics contracts.

## Execution metadata

- **Phase:** P3 — Tauri desktop/native shell foundation
- **Lane:** tauri-desktop
- **Depends on:** TAURI-004, UIA-001, UIA-004
- **Parallelizable with:** ADM-013, UI-004
- **Coverage matrix rows:** legacy.ui_bridge_migration, assistant.voice.mode_matrix, sdk.transport.client
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Ensure the current PyQt `UIBridge` behavior is either preserved through the new SDK/Tauri event model or intentionally deprecated with a tested compatibility note.

## User-visible outcome

The Tauri migration does not silently drop existing local desktop flows for orchestrator input, STT transcription events, TTS playback state, status updates, or conversation history fetches.

## Backend/API implementation details

- No new backend route is required by default. Inventory the bus topics and request/response semantics currently used by `UIBridge` and map each to an SDK/event-stream task.
- Any missing backend capability discovered here must be linked to `BE-003`, `BE-008`, `BE-009`, voice tasks, or a new backend task before production migration.

## SDK integration details

- Add a compatibility mapping table from PyQt signals/callbacks to `AuroraClient` methods/events.
- Ensure event stream abstractions cover `transcription_received`, `llm_response`, `tts_started`, `tts_stopped`, STT session started, and UI status transitions.

## Tauri/native integration details

- Tauri commands/native events replace Qt signals only inside SDK/native adapters; screens remain SDK-only.
- Document whether PyQt UI remains dev-only, is removed, or stays as a fallback during migration.

## UI/UX implementation details

- Assistant text/voice/history screens must cover every user-visible behavior currently available in PyQt or state an accepted deprecation.
- Settings/about page should expose migration/build channel information if both UI stacks coexist during transition.

## Code references to inspect first

- `app/ui/bridge_service.py` (`UIBridge`, Qt signals, bus topics)
- `app/ui/__init__.py` legacy exported surface
- `app/shared/contracts/models/orchestrator.py`
- `app/shared/contracts/models/stt.py`
- `app/shared/contracts/models/tts.py`
- `app/shared/contracts/models/db.py` or DB history request models used by UIBridge

## Mock/component references

- `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`
- `modules/ui-mock-reference/components/aurora/assistant/assistant-view.tsx`
- `modules/ui-mock-reference/components/aurora/activity-rail.tsx`
- `modules/ui-mock-reference/app/(cockpit)/settings/page.tsx`

## Data, permissions, and privacy contract

- Use typed topic constants and registered method contracts for any backend additions.
- Sanitize deployment topology, peer topology, Redis URLs, tokens, local filesystem paths, and diagnostics before exposing them to UI.
- Use capability graph and AdminAction for any mutation or privileged detail; read-only degraded states still require permission checks when topology could leak sensitive infrastructure.

## Acceptance criteria

- A checked mapping exists for every PyQt signal/callback/topic used by `UIBridge`.
- Any unsupported legacy behavior is explicitly deprecated with rationale and production UI alternative.
- SDK/event stream tests cover the mapped events before PyQt can be removed from release packaging.

## Verification commands / evidence

- Static mapping test or snapshot over `app/ui/bridge_service.py` topic usage.
- SDK event-stream tests from `SDK-011` include legacy-equivalent STT/TTS/orchestrator flows.
- Desktop smoke verifies Tauri local mode can perform the same chat/voice/status basics as PyQt.

## Risks and guardrails

- Do not bypass the bus or SDK boundaries to make UI state easier.
- Do not leak Redis URLs, host paths, peer secrets, tokens, or private model paths.
- Do not treat mock transport, emulator-only, or single-mode smoke as production parity.

## Handoff notes

- Added by full coverage review to make previously implicit process-mode, deployment-topology, and legacy UI migration coverage explicit.

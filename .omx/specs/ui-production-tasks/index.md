# Aurora UI Production Task Index

## Sequencing Rule

Future UI production work should start from backend-proven surfaces and preserve issue isolation. Mesh-dependent UI must not simulate backend state or implement speculative controls for missing contracts.

## Recommended Task Order

1. **UI SDK shell and typed adapters**
   - Build a thin SDK over Gateway/Auth/service APIs.
   - Normalize `GetMeshStatus`, `GetCapabilityGraph`, Auth peer state, Tooling discovery/execution, scheduler ownership, and audit references.
   - Verification: contract fixture tests with redaction and reason-code coverage.

2. **Mesh diagnostics/status surface**
   - Render local status, peers, routes, compatibility, provider candidates, stale/degraded states, and redacted diagnostics.
   - Verification: UI tests from mocked backend responses plus integration check against real Gateway when available.

3. **Peer trust administration**
   - Show bilateral pending/approved/denied state and local peer-admin actions.
   - Verification: Auth contract-backed tests; no broad Auth sharing assumptions.

4. **Capability explorer**
   - Render service/method/resource graph, provider indexes, policy flags, selector requirements, and blockers.
   - Verification: graph fixture coverage for local, remote, stale, denied, privacy-blocked, and degraded states.

5. **Remote action preflight**
   - Add reusable confirmation/selector/resource flow for Tooling, scheduler, playback, and data-sensitive actions.
   - Verification: focus management, keyboard flow, denial/error states, and correlation ID display.

6. **Remote Tooling and Orchestrator controls**
   - Bind standard authorized remote tools and gate sensitive/dangerous tools behind preflight.
   - Verification: hidden unsafe tools, explicit selector execution, audit/correlation display.

7. **Data/memory policy views**
   - Show remote-query-only and export/import planning states; keep replication/raw SQL blocked.
   - Verification: policy fixtures and disabled/deferred states.

8. **Audio capability controls**
   - Show batch synthesize/transcribe routes first; add playback/streaming only with explicit backend consent/state.
   - Verification: privacy indicators, consent/focus behavior, selector and capacity handling.

9. **Future Tauri client**
   - Introduce official Tauri v2 shell only when backend/SDK surfaces are ready.
   - Verification: Tauri WebDriver/native E2E on supported desktop platforms with real backend processes and isolated profiles.

## Non-Goals For Initial UI Production

- No raw cross-peer SQL UI.
- No DB/RAG/chat bidirectional sync UI.
- No transparent remote Auth/Config admin UI.
- No remote microphone/listening UI without backend consent/event contracts.
- No claim that browser-only Playwright proves Tauri IPC/native/backend behavior.

# PER-269 Tauri/UI Production Readiness Report

Date: 2026-06-30
Branch: `feat/ui-multi-platform-integration`
PR: https://github.com/joaojhgs/aurora/pull/156
Latest report update: current docs-only PR head for this refresh
Latest code-reviewed integration commit: `2833d29c4a9c851c0819032d6ea8e1c3c8579075`

## Executive Verdict

Aurora's UI integration branch is buildable and substantially more complete than the original 2026-06-27 report. The two highest-risk gaps from that report were addressed after it was written:

- PER-270 / PR #157 made `Aurora.EventStream` production-ready for HTTP and assistant streaming.
- PER-271 / PR #158 implemented the Tauri local EventStream bridge and added desktop smoke evidence.

The current answer to "is Tauri + UI working properly yet?" is:

- **Working for the covered production slice:** SDK request/response flows, HTTP EventStream defaults, assistant request-then-subscribe streaming, production React UI package, web smoke, Tauri frontend build/test paths, Tauri local subscription bridge, and CI platform smokes all pass at PR #156 head.
- **Not yet production-grade for every service, mesh, native, package, and device flow:** voice/audio/native runtime readiness, all-surface live-backend contract hardening, real event-flow parity across every mode, and non-signing operator/package preflight remain separate open follow-up work.

This report intentionally does not claim release signing, app-store/play-store readiness, full physical device-lab coverage, or exhaustive every-flow service validation. Those remain outside the current PER-269 merge-conflict/report scope and are represented by later gap tasks.

## Current PR And CI State

Verified with GitHub for PR #156:

- Head branch: `feat/ui-multi-platform-integration`
- Base branch: `main`
- Head SHA after this report update: current docs-only PR head
- Merge state immediately after the report update: `BLOCKED` only because GitHub checks restarted for the docs-only commit.
- Draft: `false`
- Reviews: none recorded
- Previous integration-code head `2833d29c4a9c851c0819032d6ea8e1c3c8579075` had these passing checks before the report refresh:
  - `lint (3.11)`
  - `unit_integration_test (ubuntu-latest, 3.11.11)`
  - `Python mesh and multi-mode matrix`
  - `SDK, UI, and web smoke`
  - `Generate inventory and validate SDK contract fixtures`
  - `QA-006 release packaging evidence`
  - `Android APK build and emulator smoke`
  - `Linux Tauri check and smoke launch`
  - `macOS Xcode Tauri iOS init and build`
  - `iOS manifest and UI policy`
  - `Test Process Mode`
- Skipped by workflow design:
  - `macOS Xcode iOS gate`

The report-only commit does not change code or build inputs, but PR #156 should still wait for the restarted GitHub check rollup before final merge-gate approval.

## Completed Since The Original Report

### EventStream HTTP Path And Backend Contract

The old report said the SDK defaulted to `/api/events` while the backend exposed `/api/events/stream`. That is now fixed.

Current evidence:

- `packages/aurora-sdk/src/http.ts` defaults `eventStreamPath` to `/api/events/stream`.
- `packages/aurora-sdk/tests/client.test.ts` expects `/api/events/stream` for HTTP SSE and WebSocket stream URLs.
- `app/services/gateway/fastapi_app.py` exposes `GET /api/events/stream`.
- `tests/unit/gateway/test_event_stream_route.py` covers route auth, OpenAPI presence, backfill/filter behavior, and stream output.

### Assistant Streaming Trigger And Correlation

The old report said `client.assistant.streamMessage()` subscribed to events but did not itself trigger `Orchestrator.ExternalUserInput`. That is now fixed.

Current evidence:

- `packages/aurora-sdk/src/client.ts` sends `Orchestrator.ExternalUserInput` through `routePath('Orchestrator', 'ExternalUserInput')` before consuming the assistant event stream.
- The SDK uses a request/correlation ID for the command and filters assistant events by that correlation.
- `packages/aurora-sdk/tests/client.test.ts` covers prompt submission, stream URL filtering, fallback behavior, cancellation, and normalized final responses.
- Backend changes in `app/services/gateway/service.py`, `app/services/gateway/fastapi_app.py`, and `app/services/orchestrator/service.py` preserve stream correlation through `Aurora.EventStream`.

The chosen architecture is the request-then-subscribe model from the earlier recommendation. Command execution stays on typed bus methods, and `Aurora.EventStream` remains the event projection rather than a second command path.

### Tauri Local Event Subscription Bridge

The old report said `aurora_subscribe` returned `unsupported_feature`. That is now fixed.

Current evidence:

- `apps/aurora-tauri/src-tauri/src/lib.rs` implements:
  - `aurora_subscribe`
  - `aurora_activate_subscription`
  - `aurora_unsubscribe`
  - SSE frame draining from local Gateway `/api/events/stream`
  - Tauri event emission on `aurora://events/<subscription_id>`
  - close/error events on `aurora://events/<subscription_id>/closed`
  - subscription cleanup on app shutdown
- `packages/aurora-sdk/src/tauri.ts` turns those Tauri events into SDK `AuroraEventSubscription` objects and calls unsubscribe on close.
- `apps/aurora-tauri/src/aurora-client.ts` configures the local client to use `/api/events/stream`.
- `apps/aurora-tauri/scripts/eventstream-smoke.mjs` and `apps/aurora-tauri/src/eventstream-smoke.tsx` provide a Tauri-local EventStream smoke path.
- `.github/workflows/tauri-desktop.yml` includes the EventStream bridge smoke step.

This is still a Gateway-proxy local bridge, not direct Rust access to Python LocalBus/BullMQBus/MeshBus internals. That is acceptable for Aurora's production boundary because Gateway/Auth remain the backend truth and the Tauri shell does not become a second service bus authority.

### Event Filtering, Backfill, And Scoped Authorization

The old report said query filtering, replay/backfill, and per-topic authorization were not backend-enforced. That is now materially improved.

Current evidence:

- `app/services/gateway/fastapi_app.py` accepts `topic`, `kind`, `last_event_id`, `replay_from`, `backfill`, and `correlation_id`.
- Broad event streams require `Gateway.manage`.
- Correlated assistant streams may be authorized with `Orchestrator.use` when limited to safe assistant topics/kinds.
- `_stream_backfill_events` requests recent Gateway events through `Gateway.ListEvents`.
- `_event_matches_stream_request` filters live events by topic, category/kind, and correlation ID.
- `app/services/gateway/service.py` filters stored events by topic, category, kind, action, status, correlation, provider/tool/route/policy, and peer.

This is enough to retire the old "P0 event stream correctness" gap from the report. Deeper production parity across every deployment mode remains a QA gate, not an absence of the core EventStream contract.

## What Is Working Now

### SDK And UI Architecture

- Production UI screens use `AuroraClient` surfaces instead of importing Python service objects.
- `@aurora/client` includes typed transports for HTTP and Tauri local execution.
- Assistant streaming, health/config watches, and general event subscriptions use the SDK event abstraction.
- The UI keeps backend-derived states visible rather than claiming local-only truth for service, mesh, route, policy, or native status.

### Gateway And Bus Projection

- Backend services continue publishing typed bus topics through LocalBus, BullMQBus, or MeshBus.
- Gateway captures permitted events and publishes normalized `Aurora.EventStream` events.
- HTTP and Tauri transports consume the Gateway EventStream projection.
- Mesh-visible claims remain governed by mesh policy and provenance; this branch does not broaden Auth, Config, raw DB writes, hardware, or raw audio sharing by default.

### Tauri Local

- Tauri local request/response calls remain Gateway-backed and authenticated.
- Tauri local event subscription now proxies `/api/events/stream` into webview events.
- The bridge has explicit subscribe/activate/unsubscribe lifecycle methods.
- CI includes a Linux Tauri check/smoke launch and EventStream bridge smoke.

### Build And Check Evidence

Earlier local validation on this branch passed:

- `pnpm install --frozen-lockfile`
- `pnpm --filter @aurora/client typecheck`
- `pnpm --filter @aurora/client test -- --runInBand`
- `pnpm --filter @aurora/client build`
- `pnpm --filter @aurora/client test:qa005`
- `pnpm --filter @aurora/ui build`
- `pnpm --filter @aurora/ui test:qa004`
- `pnpm --filter @aurora/tauri-ui typecheck`
- `pnpm --filter @aurora/tauri-ui test`
- `pnpm --filter @aurora/tauri-ui build`
- `uv run --extra dev ruff check app tests scripts`
- `uv run --extra dev ruff format --check app tests scripts`
- Focused release-gate Python tests

The local environment previously could not run `cargo test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml` because system `glib-2.0`/`gobject-2.0` pkg-config packages were missing. GitHub CI now provides the relevant Linux Tauri check/smoke evidence.

## What Is Still Missing For Production Grade

The remaining gaps are no longer the original EventStream/Tauri bridge gaps. They are the broader production-readiness items tracked by the follow-up gap tasks.

### PER-272: Voice, Audio, And Native Runtime Event Readiness

Still needed:

- Partial transcription streaming proof.
- Final transcription session/correlation mapping across supported transports.
- STT/TTS lifecycle events with reason and correlation parity.
- Remote microphone, wakeword, live audio, and playback consent/target policy.
- Peer disconnect and policy denial states in live voice/audio UI.
- Android assistant-role evidence beyond emulator/static checks.
- iOS App Intents/TestFlight/device evidence before claiming production mobile invocation.

The current branch can model these states, but it should not claim all voice/audio/native runtime behavior is production-proven.

### PER-273: All Production UI Surfaces Against Live Backend Contracts

Still needed:

- Audit every production UI surface against live SDK/backend contracts.
- Confirm no production surface uses fixtures as runtime truth.
- Confirm unsupported/internal-only backend actions are disabled with precise reasons.
- Harden AdminAction, permissions, capability graph, config, memory/RAG, scheduler, tooling, diagnostics, and mesh screens against real contract inventory.
- Refresh stale planning docs where they still describe old task status or missing mock/reference modules.

The current branch is correctly routed through SDK abstractions, but that is not the same as full all-surface production contract proof.

### PER-274: Real Event-Flow Parity Gate

Still needed:

- A real parity gate across LocalBus/thread mode, BullMQ/process mode, HTTP thin, Tauri local, and mesh/WebRTC.
- Evidence rows for assistant event flow, config/service events, and mesh provenance events.
- Rejection of mock-only evidence for production EventStream parity.
- Explicit skip-with-rationale rows only where a physical lab/platform constraint truly prevents coverage.

Current CI proves many build and smoke paths. It does not yet prove every required real event-flow row across every deployment mode.

### PER-275: Non-Signing Release And Operator Preflight

Still needed:

- Non-signing release preflight for UI/Tauri/sidecar readiness.
- Sidecar/process-mode readiness checks.
- Operator diagnostics for Gateway auth, Redis/process mode, mesh pairing recovery, logs, support bundles, and redaction.
- Runbooks for install/update/rollback/failure recovery.

This remains intentionally separate from final package signing and app-store/play-store release.

## Mesh And Privacy Posture

The branch remains aligned with the mesh roadmap decisions:

- Transparent routing is acceptable only for low-risk local-like dependencies.
- Tools, DB/data, hardware, scheduler ownership, remote playback, privacy-sensitive actions, Auth, and Config remain explicit-target or local/admin gated.
- UI display must preserve peer/provider/source/target/correlation provenance.
- Raw cross-peer SQL, credential replication, broad remote Auth/Config mutation, and raw microphone/audio sharing are not enabled as broad defaults.

The EventStream work projects backend truth into UI transports; it does not create a new unrestricted mesh event bus.

## Gap Task State

Current follow-up task state for the production-readiness gaps:

- PER-270: done. EventStream HTTP and assistant streaming core.
- PER-271: done. Tauri local EventStream subscription bridge.
- PER-272: todo. Voice, audio, and native runtime event readiness.
- PER-273: todo. All production UI surfaces against live backend contracts.
- PER-274: backlog. Real event-flow parity gate across thread, process, HTTP, Tauri, and mesh.
- PER-275: backlog. Non-signing release and operator preflight.

PER-274 and PER-275 correctly remain downstream of the active PER-272/PER-273 work.

## Final Answer

Yes, Aurora should use the current universal bus/topics/auth model for Tauri and UI event listening. The completed `Aurora.EventStream` path is the correct UI-facing projection of that model.

As of integration commit `2833d29c4a9c851c0819032d6ea8e1c3c8579075`, the original report's EventStream P0 blockers have been resolved: HTTP uses `/api/events/stream`, assistant streaming triggers `Orchestrator.ExternalUserInput` and listens by correlation, and Tauri local mode has a real subscribe/unsubscribe bridge with CI smoke evidence.

No, this does not mean the whole UI is production-grade across all services and mesh yet. The remaining production-grade work is now correctly narrowed to voice/audio/native runtime readiness, all-surface live-contract hardening, real multi-mode event parity, and non-signing operator/package preflight.

# PER-269 Tauri/UI Production Readiness Report

Date: 2026-06-27
Branch: `feat/ui-multi-platform-integration`
PR: https://github.com/joaojhgs/aurora/pull/156
Latest reviewed commit: `f78e028b25e5f92d351ec155bda8e65af0fb3a32`

## Executive Verdict

Aurora's UI integration branch is buildable and much closer than the older planning artifacts imply, but it is not yet production-grade for "UI working with all services and mesh" in the strict sense.

What is working:

- The SDK, production React UI package, web smoke, and Tauri frontend build/test paths are wired and passing local validation.
- PR #156 GitHub checks are now green except the intentionally skipped macOS Xcode iOS release gate job.
- BE-003, SDK-011, TAURI-004, UIA-002, and QA-008 are live Multica issues marked `done` with merged PRs.
- The backend now has a product-level `Aurora.EventStream` typed topic and an authenticated SSE route at `/api/events/stream`.
- The assistant UI uses `AuroraClient` and calls the SDK streaming surface, not direct service objects.

What is not production-grade yet:

- Tauri local event subscription is still a stub. `aurora_subscribe` returns `unsupported_feature`, so Tauri local mode cannot receive live SDK events through the native bridge.
- The SDK HTTP event stream default path is `/api/events`, but the backend route is `/api/events/stream`.
- The SDK assistant streaming path subscribes to events but does not itself trigger `Orchestrator.ExternalUserInput`; the backend SSE route streams events only and ignores the SDK stream payload as a command trigger.
- The current Tauri local command bridge proxies request/response calls to the Gateway HTTP API. It is not a direct in-process LocalBus subscription bridge.
- Existing release gates prove builds/smokes and mode matrices, but not every real-service, real-mesh, real-device user flow at production depth.

The correct answer to "is Tauri + UI working properly yet?" is: Tauri + UI builds and request/response SDK flows are working, but live event-driven Tauri local mode and real assistant streaming are not yet production-complete.

## Correction To The Earlier BE-003 Statement

The previous issue comment said: "event subscription in the Tauri bridge is deferred pending the BE-003 unified event stream contract."

That wording was stale and misleading.

Live Multica state says:

- BE-003 is PER-190 / `f8bdc73f-5c32-4030-8f87-fbeabc5747b7`.
- PER-190 status is `done`.
- PER-190 metadata records PR #69 and merge commit `ec1d63a5057a70b761e67d84662c77a00f134026`.

The committed `.omx/specs/ui-production-tasks/index.md` status table still lists BE-003 as blocked, but that table is stale. The live board metadata is newer and authoritative.

The real current problem is not "BE-003 is missing." The real problem is that the downstream Tauri/SDK/UI integration did not fully consume the completed BE-003 contract.

## What The Unified Event Stream Contract Actually Is

Aurora already has a universal bus model:

- Services publish typed bus topics through LocalBus, BullMQBus, or MeshBus.
- MeshBus wraps the inner bus and forwards events with `mesh=True` when service sharing policy allows it.
- Topics are typed constants from `app/shared/contracts/models/*`.
- Auth, permissions, and Gateway exposure are contract-driven.

BE-003 added a UI-facing normalized event envelope on top of that bus model:

- `app/shared/contracts/models/aurora.py` defines `AuroraMethods.EVENT_STREAM = "Aurora.EventStream"`.
- `AuroraEventStreamEvent` is the redacted, normalized event visible to SDK/UI event subscribers.
- `app/services/gateway/service.py` captures bus envelopes, redacts/normalizes them, stores recent diagnostics, and republishes them on `Aurora.EventStream`.
- `app/services/gateway/fastapi_app.py` exposes `/api/events/stream` as an authenticated SSE route that subscribes to `Aurora.EventStream`.

This should not replace the existing bus. It should be the UI-facing event projection of the existing bus, with the same topic/provenance/audit discipline.

The intended production model should be:

1. Backend services continue to publish typed LocalBus/BullMQBus/MeshBus events.
2. Gateway normalizes permitted events into `Aurora.EventStream`.
3. HTTP thin clients subscribe to `/api/events/stream`.
4. Tauri local clients subscribe through the Tauri bridge, which either proxies the local Gateway SSE stream or exposes an equivalent native event channel.
5. Mesh-visible events are still governed by mesh policy and explicit sharing; UI display must show target/source/provenance rather than pretending every event is local.

## Evidence: Backend Event Stream Exists

Code evidence:

- `app/shared/contracts/models/aurora.py`
  - Defines `AuroraMethods.EVENT_STREAM`.
  - Defines `AuroraEventStreamEvent`.
- `app/services/gateway/fastapi_app.py`
  - Defines `GET /api/events/stream`.
  - Uses `Security(create_scoped_auth_check(method_type="manage"), scopes=["Gateway.manage"])`.
  - Subscribes to `AuroraMethods.EVENT_STREAM`.
  - Streams SSE frames with `text/event-stream`.
- `app/services/gateway/service.py`
  - Captures bus events.
  - Skips recursive `Aurora.EventStream` events.
  - Publishes normalized `Aurora.EventStream` with `event=True` and `mesh=False`.
- `tests/unit/gateway/test_event_stream_route.py`
  - Verifies the route is auth-gated.
  - Verifies OpenAPI documents `/api/events/stream`.
- `tests/unit/gateway/test_mesh_observability.py`
  - Verifies captured bus events republish normalized `Aurora.EventStream`.

This is real backend implementation, not only a plan.

## Evidence: SDK/UI Event Surfaces Exist

Code evidence:

- `packages/aurora-sdk/src/events.ts`
  - Defines `EventStreamClient`.
  - Provides `subscribe`, `streamAssistant`, `watchHealth`, and `watchConfig`.
  - Supports reconnect/backfill fields at the SDK abstraction level.
- `packages/aurora-sdk/src/http.ts`
  - Implements SSE and WebSocket event adapters.
- `packages/aurora-sdk/src/tauri.ts`
  - Implements a `subscribe` method on `TauriLocalTransport`.
  - Calls the Tauri command named `aurora_subscribe`.
- `packages/aurora-sdk/src/client.ts`
  - `client.assistant.streamMessage()` consumes `client.events.streamAssistant(...)`.
  - Falls back to non-streaming `sendMessage()` if streaming fails before any event is seen.
- `packages/aurora-ui/src/assistant-view.tsx`
  - Uses `client.assistant.streamMessage(...)`.
  - Handles `fallback`, `transport_lost`, `completed`, `failed`, and cancel states.

This means production screens are pointed at the SDK event abstraction. The problem is at runtime behavior and transport completion, not at screen architecture.

## Critical Gap 1: Tauri `aurora_subscribe` Is Still Unsupported

Current code in `apps/aurora-tauri/src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn aurora_subscribe(
    request: AuroraSubscribeRequest,
) -> Result<Vec<Value>, AuroraCommandError> {
    let topics = request.topics.join(",");
    let stream = request.stream.unwrap_or_else(|| "event".to_string());
    Err(AuroraCommandError::UnsupportedFeature(
        format!(
            "aurora_subscribe is deferred until BE-003 provides a unified event stream contract; stream={stream}, topics={topics}"
        ),
    ))
}
```

That error message is now stale because BE-003 is complete, but the behavior is still a real blocker.

Impact:

- In Tauri local mode, `TauriLocalTransport.subscribe()` calls `aurora_subscribe`.
- `aurora_subscribe` returns `unsupported_feature`.
- Assistant live streaming, health watch, config watch, pairing events, mesh status updates, audit/activity rail, and other event-driven views cannot use the Tauri local bridge yet.
- Assistant chat may fall back to request/response if the stream fails before any event is seen, so a basic response can still work. That is not the same as production live event support.

Production fix:

- Replace the stub with a real subscription bridge.
- Prefer a Tauri-native subscription lifecycle:
  - command returns a subscription ID;
  - Rust starts a task that consumes local Gateway SSE at `/api/events/stream` or another approved local event source;
  - Rust emits events to the webview using a scoped Tauri event/channel name;
  - SDK `TauriLocalTransport.subscribe()` turns those callbacks into `AuroraEventSubscription`;
  - close/unsubscribe tears down the Rust task.
- Preserve auth and sidecar hardening:
  - use the existing sidecar token/origin loopback checks;
  - do not expose arbitrary filesystem/network permissions;
  - redact errors and payloads consistently.

## Critical Gap 2: HTTP Event Stream Path Mismatch

Backend route:

- `/api/events/stream`

SDK default:

- `HttpGatewayTransport` defaults `eventStreamPath` to `/api/events`.

Evidence:

- `app/services/gateway/fastapi_app.py` registers `/api/events/stream`.
- `packages/aurora-sdk/src/http.ts` sets `this.eventStreamPath = options.eventStreamPath ?? '/api/events'`.
- `packages/aurora-sdk/tests/client.test.ts` currently expects URLs containing `/api/events?stream=...`, so the SDK tests align with the SDK default, not the backend route.

Impact:

- A default HTTP client subscribing to events will target the wrong path unless the caller overrides `eventStreamPath` or passes a subscribe `path`.
- `apps/aurora-tauri/src/aurora-client.ts` constructs `HttpGatewayTransport` without overriding `eventStreamPath` in desktop-thin fallback mode.

Production fix:

- Change the SDK default to `/api/events/stream`.
- Update SDK tests to expect `/api/events/stream`.
- Add an integration test that creates an HTTP SDK subscription against the FastAPI app route, not only a mocked EventSource URL.
- Confirm OpenAPI/fixture metadata exposes the same path used by SDK defaults.

## Critical Gap 3: Assistant Streaming Does Not Trigger The Backend Request

Current SDK flow:

- `client.assistant.streamMessage(input)` creates an `OrchestratorProcessRequest` payload.
- It passes that payload to `client.events.streamAssistant(...)`.
- The HTTP SSE adapter builds a URL with query params for stream/topics/kinds.
- The backend `/api/events/stream` route only subscribes to already-published `Aurora.EventStream` events.
- The backend route does not consume the SDK payload to start an assistant request.

Impact:

- A stream subscription can listen for events, but it does not by itself cause the assistant to process the user's prompt.
- If the stream transport fails immediately, the SDK falls back to normal `sendMessage()`, so users may still receive a final answer.
- If the stream opens successfully but no matching event is produced, the UI can wait for events that never start from that call.
- True "send prompt and stream tokens/events" is not proven end to end.

Production fix options:

1. Request-then-subscribe model:
   - SDK sends `Orchestrator.ExternalUserInput` first with a correlation/request ID and streaming preference.
   - SDK subscribes to `Aurora.EventStream` filtered by that correlation/request ID.
   - Backend publishes deltas/final/error/tool progress events with matching IDs.

2. Stream endpoint starts work:
   - Backend accepts a POST/WebSocket handshake that includes the assistant payload.
   - It starts processing and emits events on the same stream.
   - SSE GET cannot safely carry full assistant payloads, so this would likely require WebSocket or a POST-created stream session.

The first option fits Aurora's bus-first architecture best because it keeps command execution on typed bus methods and uses `Aurora.EventStream` only as the event projection.

## Critical Gap 4: Tauri Local Is Gateway-Proxy Local, Not Direct Universal Bus

Current Tauri command flow:

- `TauriLocalTransport.request()` calls Tauri `aurora_request`.
- Rust `aurora_request` calls `aurora_command`.
- Rust `aurora_command` builds an HTTP request to the configured Gateway URL, defaulting to `http://127.0.0.1:8000`.

This preserves the SDK boundary and is acceptable as a local sidecar bridge, but it is not a direct LocalBus/BullMQBus/MeshBus subscription bridge from Rust. The universal bus is still behind Gateway and Python services.

Production implication:

- Tauri local can be production-grade through local Gateway if the sidecar is hardened and event subscription proxies `/api/events/stream`.
- It does not need to embed Python bus objects in Rust.
- It must not bypass Gateway/Auth unless a new typed, audited local bus bridge is deliberately designed.

## Critical Gap 5: Event Filtering, Backfill, And Replay Are Not Fully Backend-Enforced

The SDK has fields for:

- `topics`
- `kinds`
- `lastEventId`
- `replayFrom`
- `backfill`
- reconnect options

The backend SSE route currently subscribes to `Aurora.EventStream` and streams events from the live queue. The inspected route does not implement query filtering, replay, backfill, per-topic authorization, or last-event resume semantics.

Impact:

- UI can represent replay/backfill states, but backend enforcement is incomplete.
- Long-running admin/mesh views may not recover cleanly from disconnects.
- A production-grade event stream should not rely only on client-side filtering where events may include sensitive diagnostics.

Production fix:

- Parse and enforce `topic`, `kind`, `last_event_id`, `replay_from`, and `backfill`.
- Apply permission checks per event category/topic, not only one broad `Gateway.manage` gate for every event consumer.
- Persist or buffer enough recent redacted events for bounded replay.
- Add tests for denied event categories, replay cursor behavior, queue overflow, and redaction.

## Critical Gap 6: Voice, Audio, And Remote Mesh Live Streams Are Not Fully Production-Proven

The UI and tasks model voice/audio states, but production proof is not complete for:

- partial transcription streaming;
- final transcription with session/correlation mapping across transports;
- remote microphone/wakeword/live audio consent;
- remote playback target and consent;
- TTS started/stopped reason/correlation parity;
- peer disconnect and policy denial handling in live UI;
- Android assistant role on physical/OEM devices;
- iOS App Intents/TestFlight/device evidence.

This is consistent with the planning docs:

- `docs/UIBRIDGE_TAURI_MIGRATION.md` says PyQt remains a fallback until SDK event stream and Tauri local transport cover the listed event flows with tests.
- UIA-004 voice UX rows still rely on event stream behavior for partial/final/cancel/remote-denied states.
- Release gates distinguish emulator/mock/static evidence from real device and signing evidence.

## Current Build And CI Evidence

Local validation already completed for PR #156:

- `pnpm install --frozen-lockfile` passed.
- `pnpm --filter @aurora/client typecheck` passed.
- `pnpm --filter @aurora/client test -- --runInBand` passed.
- `pnpm --filter @aurora/client build` passed.
- `pnpm --filter @aurora/client test:qa005` passed.
- `pnpm --filter @aurora/ui build` passed.
- `pnpm --filter @aurora/ui test:qa004` passed.
- `pnpm --filter @aurora/tauri-ui typecheck` passed.
- `pnpm --filter @aurora/tauri-ui test` passed.
- `pnpm --filter @aurora/tauri-ui build` passed.
- `uv run --extra dev ruff check app tests scripts` passed.
- `uv run --extra dev ruff format --check app tests scripts` passed.
- Focused release-gate Python tests passed.

Local blocker:

- `cargo test --manifest-path apps/aurora-tauri/src-tauri/Cargo.toml` could not run in this local environment because system `glib-2.0`/`gobject-2.0` pkg-config packages are missing.

Fresh PR #156 GitHub check snapshot after the latest push:

- Passing: lint, SDK backend contract conformance, QA-006 release packaging evidence, macOS Xcode Tauri iOS init/build, SDK/UI/web smoke, Python mesh and multi-mode matrix, Android APK build/emulator smoke, Linux Tauri check/smoke launch, iOS manifest/UI policy, process mode, unit/integration.
- Skipped by workflow design: macOS Xcode iOS gate.

This proves the branch is buildable in CI. It does not prove the missing live event semantics described above.

## What Is Actually Missing For Production-Grade UI With All Services And Mesh

### P0: Make Event Streaming Real Across Transports

Required work:

- Fix HTTP SDK default event path to `/api/events/stream`.
- Implement Tauri local `aurora_subscribe`.
- Decide and implement assistant stream trigger semantics.
- Add backend filtering/replay/backfill/authorization for event stream queries.
- Add end-to-end tests that start a prompt, observe streamed assistant events, recover from disconnect, and prove fallback behavior.

Acceptance evidence:

- HTTP thin mode: `client.assistant.streamMessage()` starts work and receives correlated assistant events.
- Tauri local mode: same SDK test passes through Tauri bridge and sidecar/Gateway.
- Mesh mode: route/provenance fields show local/remote peer and policy decision correctly.
- Negative tests: unauthorized event topics/categories are denied or redacted.

### P0: Close Tauri Local Runtime Gaps

Required work:

- Replace stale `aurora_subscribe` unsupported message.
- Implement subscription lifecycle and teardown.
- Ensure sidecar local Gateway URL, sidecar token, and loopback constraints are applied to event streams.
- Add `cargo test`/`cargo check` coverage for the Tauri subscribe path where feasible.
- Add Playwright/WebDriver or Tauri-driver smoke that verifies the UI receives a live event in desktop local mode.

Acceptance evidence:

- Tauri desktop local launches.
- Sidecar starts or connects.
- Assistant event stream and service/config health watches update in the UI from backend events.
- Closing a view or aborting an assistant turn unsubscribes cleanly.

### P0: Align Task/Plan Metadata With Reality

Required work:

- Refresh `.omx/specs/ui-production-tasks/index.md` status table. It still lists many tasks, including BE-003, as blocked even though live Multica issues are done/merged.
- Refresh any stale references to missing `modules/ui-mock-reference/`; the branch contains it.
- Create follow-up tasks for the discovered event-stream integration gaps rather than treating completed BE-003/SDK-011/TAURI-004/UIA-002 as proof that runtime semantics are complete.

Acceptance evidence:

- Planning docs match live Multica metadata.
- New tasks identify concrete code gaps, not generic "finish UI" language.

### P1: Prove Service Surfaces Through Real Backend Contracts

Required work:

- For each UI surface, verify the visible controls map to current backend capability graph, method exposure, permissions, and AdminAction requirements.
- Ensure production screens never import fixtures as runtime truth.
- Expand conformance tests for Auth, Config, DB/RAG, Scheduler, Tooling, Gateway diagnostics, mesh peers, route policy, backup/restore, models, and device/native status.

Acceptance evidence:

- A generated contract inventory can be compared to SDK descriptors and UI route controls.
- Unsupported/internal-only actions are visibly disabled with precise reasons.
- Mutating admin actions include confirmation/audit evidence.

### P1: Mesh Production Proof

Required work:

- Run or extend a two-peer mesh harness that proves:
  - peer capability discovery;
  - route explain;
  - local plus remote provider aggregation;
  - remote tool approval/execution;
  - policy denial;
  - audit/correlation propagation;
  - event stream visibility with source/target peer provenance.
- Do not accept mock mesh or single-node tests as final mesh proof.

Acceptance evidence:

- Same SDK/UI flows pass in local, HTTP thin, Tauri local, process/BullMQ, and mesh rows.
- Explicit peer/resource addressing is preserved for high-risk operations.
- Raw SQL, credentials, raw audio, Auth/Config mutation, and hardware operations remain blocked or explicit-policy gated.

### P1: Native/Mobile Release Evidence

Required work:

- Android:
  - physical/OEM assistant role evidence;
  - signed APK/AAB path;
  - fallback entrypoints smoke;
  - local-light inference status if claimed.
- iOS:
  - simulator build is passing in CI, but production release still needs signing/TestFlight/App Store dry-run evidence;
  - App Intents must be concrete before claiming Siri-adjacent invocation support;
  - do not claim default assistant replacement on iOS.

Acceptance evidence:

- Release-gate artifacts include signed package outputs or documented skipped-with-rationale rows.
- Device-only features are not marked production-ready from emulator/mock evidence alone.

### P2: Packaging And Operator Readiness

Required work:

- Confirm Tauri desktop bundles for target OSes with signing/updater policy.
- Confirm Python sidecar packaging and process-mode Docker/Redis operational runbooks.
- Confirm logs/support bundles redact tokens, paths, Redis URLs, peer secrets, model paths, and private diagnostics.

Acceptance evidence:

- Release candidate can build/install/launch on the target platform matrix.
- Operator runbook covers install, update, rollback, sidecar failure, Gateway auth, Redis/process mode, and mesh pairing recovery.

## Proposed Follow-Up Tasks

### EVENT-TAURI-001: Implement Tauri Event Subscription Bridge

Owner lane: Tauri/frontend with backend review.

Scope:

- Replace `aurora_subscribe` stub.
- Bridge local Gateway SSE `/api/events/stream` or approved local event source into SDK `AuroraEventSubscription`.
- Preserve sidecar token, loopback, redaction, unsubscribe, and error normalization.

Minimum verification:

- `pnpm --filter @aurora/client test`
- `pnpm --filter @aurora/tauri-ui test`
- `pnpm --filter @aurora/tauri-ui build`
- Tauri Rust check/test on a host with Linux Tauri deps.
- Desktop local smoke that receives one backend-published event.

### EVENT-HTTP-001: Align SDK HTTP Event Path And Backend Stream Contract

Owner lane: SDK/backend.

Scope:

- Change SDK default event stream path to `/api/events/stream`.
- Add SDK/FastAPI integration test for real route.
- Add route query filtering tests.

Minimum verification:

- SDK event tests prove URL uses `/api/events/stream`.
- Gateway route tests prove auth and SSE output.
- Integration test proves one published `Aurora.EventStream` event reaches SDK.

### ASSISTANT-STREAM-001: Implement Real Assistant Stream Trigger And Correlation

Owner lane: backend + SDK + UI.

Scope:

- Decide request-then-subscribe or WebSocket/stream-session model.
- Ensure prompt submission triggers `Orchestrator.ExternalUserInput`.
- Publish assistant delta/completed/failed/tool events with correlation ID.
- Ensure UI replay uses last event ID only for the current request/session.

Minimum verification:

- One test sends a prompt and observes stream events without falling back.
- One test disconnects and recovers or reports `transport_lost` with a usable repair path.
- One test proves unauthorized stream access is denied/redacted.

### PARITY-REAL-001: Extend Transport Parity From Gate Artifacts To Real UI Event Flows

Owner lane: QA/release.

Scope:

- Extend QA-008 matrix to require a real assistant stream event, config/service event, and mesh provenance event in supported rows.
- Record skipped-with-rationale rows only for unavailable physical platform labs.

Minimum verification:

- Thread mode, process mode, HTTP thin, Tauri local, and mesh rows include event-stream evidence.
- Mock-only evidence cannot pass the event-stream row.

## Final Answer To The User's Question

Yes, Aurora should use the current universal bus/topics/auth model for Tauri and UI event listening. The completed BE-003 contract is the correct UI-facing projection of that model.

No, the current branch does not yet make Tauri local event listening production-grade. The backend contract exists, the SDK abstraction exists, and the UI calls it, but the Tauri Rust command is still unsupported, the HTTP default stream path is mismatched, and the assistant streaming call path does not yet prove "send prompt and receive live correlated events" without fallback.

The next production-grade step is not to invent another event system. It is to wire the completed `Aurora.EventStream` contract through HTTP and Tauri local transports correctly, then prove it across LocalBus, BullMQBus/process mode, Gateway HTTP, Tauri local, and Mesh/WebRTC with real event evidence.

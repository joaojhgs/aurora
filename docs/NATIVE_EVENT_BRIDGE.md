# Native event bridge extension guide

**Status:** Partial feature. The native bridge exists in the integration source. PER-281 now uses bounded queues plus explicit recovery instead of producer-blocking delivery; live acceptance remains pending for the integrated native bridge and for replacing the current assistant background result recovery drain.

This guide is for adding Rust-origin observations that the UI can consume through the shared Aurora event contract. Use it for native assistant, voice, mesh, device, and similar native surface state where Rust owns the observation and TypeScript renders or reconciles it.

The bridge is for observations. It must not become a second command path, permission engine, mesh authority evaluator, or hidden transport state cache in React. Commands stay on their existing typed command surfaces. Rust-owned authority decisions stay in Rust. The SDK normalizes events, and UI hooks project those events into local view state or invalidate scoped queries.

## Current bridge shape

The end-to-end path is:

1. Rust publishes a `NativeEventDraft` into `NativeEventHub`.
2. The Tauri `aurora_subscribe` command routes `source: "native"` subscriptions to the native hub.
3. The SDK `TauriLocalTransport` receives Tauri events and normalizes them into `AuroraEvent` envelopes.
4. UI code subscribes through `client.events` and usually consumes the stream with `useAuroraEvents`.
5. A feature-specific adapter, such as native assistant events, translates the normalized event into local product state.

Relevant current implementation anchors:

- `apps/aurora-tauri/src-tauri/src/native_event_hub.rs` defines the replay window, subscriber queue sizes, event envelope, audit/redaction metadata, subject snapshots, native cursor parsing, gap events, and profile-scope reset behavior.
- `apps/aurora-tauri/src-tauri/src/lib.rs` routes `aurora_subscribe` with `source: "native"` to `subscribe_native_events`, exposes `aurora_native_event_snapshot`, and registers both commands with Tauri.
- `packages/aurora-sdk/src/native-events.ts` prepares native subscription requests, carries `lastSequenceId`, normalizes native IDs to `native:<sequence>`, and normalizes hub-emitted `native.events.gap` events for recovery.
- `packages/aurora-sdk/src/tauri.ts` maps `eventSubscribe`, `eventSnapshot`, `eventActivateSubscription`, and `eventUnsubscribe` to Tauri commands and converts bridge snapshots into SDK snapshots.
- `packages/aurora-ui/src/use-aurora-events.ts` owns React lifecycle, scoped subscription setup, bootstrap snapshot recovery, gap recovery, dedupe, and cleanup.
- `packages/aurora-ui/src/native-assistant-events.ts` shows a feature adapter layered on top of `useAuroraEvents`.

The native event hub currently has constants for assistant deltas, assistant tools, assistant completion/failure, mesh peer state, and native gap events. Its event envelope carries `sequence`, `id`, `kind`, optional `topic`, optional method/bus topic, `payload`, `audit`, `redaction`, `receivedAt`, `subjects`, and `delivery`.

## Add a native topic

Add a topic in the smallest complete vertical slice. Avoid adding UI-only strings first; the Rust event kind and SDK/UI subscription filters should name the same domain concept.

1. Choose the event kind, topic, and subject model.

   Use stable, domain-scoped event kinds such as `voice.turn.started`, `assistant.completed`, or `mesh.peer.state_changed`. Use a topic when the event maps to an existing service or product lane, such as `Voice.Turn`. Use subjects for per-turn, per-peer, or per-resource recovery. A subscriber should be able to ask for only the subjects it owns.

2. Add or reuse a Rust event builder.

   Build events with `NativeEventDraft::new(kind, payload)` in Rust and attach metadata with the draft methods for `topic`, `method`, `bus_topic`, `correlation_id`, peer IDs, status, redaction, and subjects. If the observation has recoverable state, publish a `NativeEventSubjectSnapshot` with `publish_observation_if_epoch` so profile changes cannot leak stale async observations into the next scope.

   The current voice adapter is the model: `native_voice_events.rs` installs a native voice observation sink, captures the native hub epoch at installation time, publishes turn observations into the hub, assigns all phases of one generation to `voice:<generation>`, sets `topic("Voice.Turn")`, and supplies a subject snapshot for recovery.

3. Register command exposure only once.

   Native event delivery should continue through `aurora_subscribe` with `source: "native"` and `aurora_native_event_snapshot`. Do not add a parallel Tauri command for a stream unless the data is not an Aurora event. If a command already exists for an action, keep using it for the action and publish observations separately.

4. Normalize through the SDK.

   Extend typed SDK helpers only when the new payload needs a domain-specific shape. The base event should still normalize through `normalizeNativeAuroraEvent`, which preserves the native transport, event ID, audit receipt, redaction metadata, and native sequence cursor. If the UI needs a product model, add a pure converter beside the feature adapter rather than parsing raw payloads inside a view.

5. Subscribe in the UI through `client.events`.

   Use `useAuroraEvents` for React consumers. Pass `source: "native"`, `kinds`, optional `topics`, optional `subjects`, `backfill`, and a lifecycle scope key tied to the active auth/peer/profile scope. Feature hooks should keep native transport status and transient UI state local; do not store raw native transport state in the Query cache.

6. Reconcile through snapshots.

   If the feature must survive missed events, reloads, or app backgrounding, implement `onSnapshot`. The snapshot handler should apply `snapshot.subjects` or replayed events to feature-local state and return a recovery decision. Native assistant events use this pattern: they subscribe to assistant and voice turn kinds, enable bootstrap snapshots, and convert subject snapshots into synthetic `AuroraEvent` objects before adapting them to assistant stream updates.

7. Add tests at each boundary.

   Add Rust tests for hub filtering, replay, subject snapshots, stale epoch rejection, subscriber overflow, and profile resets. Add SDK tests for native event normalization, cursor conversion, Tauri snapshot normalization, one-event IPC ack enforcement, protocol-fault cleanup, ready/close behavior, and abort cleanup. Add UI hook tests for stale callbacks, scope changes, hub gap recovery, snapshot application, dedupe, and cleanup. Add feature tests that prove the adapter maps payloads into product state without exposing secrets.

## Filtering, cursors, snapshots, and recovery

Native subscriptions accept filters for `kinds`, `topics`, `subjects`, and an `after_sequence` cursor. The Tauri command adapter derives `after_sequence` from `lastSequenceId`, `lastEventId`, or `replayFrom`. If `backfill` is explicitly false and no cursor is supplied, Rust starts after the current native sequence so the subscriber receives only future events.

`NativeEventHub` keeps bounded replay and bounded subscriber queues. A new subscriber gets matching replay events when the cursor is still in the window. If the requested cursor is older than the replay window, the hub emits `native.events.gap` with `resumeAfterSequence`, `firstMissingSequence`, `nextAvailableSequence`, and a reason such as `replay_window_expired`. If a hub subscriber queue overflows for lifecycle or terminal events, the hub reports a gap and closes that subscription so the UI can recover from an authoritative snapshot. Lossy progress events may be coalesced or dropped within the configured bounds. The SDK Tauri bridge uses a one-event native IPC ack window; if the IPC protocol delivers another native event before the previous one is acknowledged, the SDK treats that as `transport_loss`, closes the subscription, and relies on the caller to restart from a known cursor or snapshot rather than synthesizing a gap event.

Use snapshots for recovery, not for hiding missed-event bugs. `aurora_native_event_snapshot` returns matching replay events, `lastSequenceId`, `replayComplete`, and subject snapshots. `useAuroraEvents` can bootstrap from a snapshot before subscribing, and on a hub-emitted `native.events.gap` it requests a snapshot, applies `onSnapshot`, then resubscribes with the recovered `lastEventId`/`lastSequenceId` when recovery succeeds. It also recovers typed native `transport_loss` from subscription readiness or iterator reads through a scoped snapshot and resubscription, within the finite budget shared with gap recovery (one attempt by default). A feature-specific `onSnapshot` should decide whether it recovered enough state to skip replaying snapshot events, replay them, or resume from a cursor. Background voice persistence must expose persisted or persistence-failed state through snapshots so a stalled, absent, or disconnected UI cannot block saving and can still reconcile the terminal result later. Errors from event or snapshot callbacks, permission/privacy denials, and unknown or other protocol errors remain terminal; they do not start transport recovery, even when an error carries the `transport_loss` code.

Events are hints for live projection. A durable server or native state snapshot remains authoritative after reconnect, profile changes, denied access, and app restarts. Voice capture, assistant generation, and persistence paths must not wait on WebView/UI consumption; they publish into bounded native queues and rely on gap plus snapshot recovery when a consumer falls behind. When an event invalidates server data, prefer invalidating the scoped Query key or loading a snapshot instead of mutating shared cache from an untrusted payload.

## Lifecycle rules

Tie every subscription to the same scope that controls the data it can update. For UI hooks, include the active auth, peer, profile, or connection scope in `lifecycleScopeKey`. Stale async callbacks must check that the current scope is still active before writing state. Cleanup should abort the subscription signal and close the active subscription.

The current hook flow is:

- Reset visible hook state when disabled, missing a client, or the lifecycle scope changes.
- Optionally bootstrap from a native snapshot.
- Subscribe with `client.events.subscribe` using the current cursor and an `AbortController` signal.
- Wait for subscription readiness.
- Iterate events, dedupe by event ID or payload sequence, update state, and call `onEvent`.
- On `native.events.gap`, mark recovery state, consume a snapshot, and resubscribe when needed.
- On cleanup, abort the controller and close the subscription.

Do not add feature-level polling when the native event bridge can provide the event and snapshot. If a transitional poll still exists, keep it bounded, scoped, and clearly documented as temporary.

## Security and privacy rules

Native events must be redacted at the producing boundary. The Rust envelope includes `NativeAuditReceipt` and `NativeRedactionMetadata`; populate them as close to the native observation as possible. Do not pass raw secrets, credentials, unredacted tool arguments, or raw transport internals through event payloads.

Mesh authority remains Rust-owned. TypeScript may render state, request commands through existing typed routes, and reconcile snapshots. It must not reimplement native grant decisions or infer authority from a received event.

Treat events as untrusted input at the SDK/UI boundary. Normalize shape, reject malformed cursors, preserve audit and redaction fields, and avoid turning event payload strings into user-facing technical copy. Product UI should describe user impact and next action, while implementation words such as event, bridge, manifest, protocol, schema, transport, fallback, or proof belong in tests and developer docs.

Profile and peer scope matter. The native hub resets on relevant profile changes, clears replay and subject snapshots, increments its epoch, and closes existing subscribers. New native publishers should capture the epoch at installation or request creation and use `publish_if_epoch` or `publish_observation_if_epoch` for async completion paths.

## Current transition notes

**Selected PER-281 delivery policy:** native producers keep voice and persistence work running. They publish into bounded queues and never block audio, assistant, saving, or UI threads on WebView consumption. Lifecycle, terminal, and persistence observations use bounded replay plus subject snapshots for recovery. Hub replay expiry or hub subscriber overflow becomes an explicit `native.events.gap` that `useAuroraEvents` can reconcile with `aurora_native_event_snapshot` and resume from the recovered cursor. Progress observations may remain lossy or coalesced. The Tauri SDK bridge may use one-event credit between the hub and IPC consumer to bound in-flight delivery; an IPC ack-window violation or local protocol flood is typed `transport_loss` with subscription cleanup, not a synthetic recovery gap. For native subscriptions, `useAuroraEvents` may recover typed `transport_loss` from subscription readiness or iterator reads through one scoped authoritative snapshot and resubscription, within the finite budget shared with gap recovery (one attempt by default). Resume uses the latest successfully processed native sequence, or the authoritative snapshot cursor. Event callbacks, snapshot callbacks, permission/privacy denials, and unknown or protocol errors remain terminal and do not start transport recovery; an inactive or aborted scope does not issue a recovery snapshot. Until the integrated Rust, SDK, and UI path is accepted, mark new native topics as candidate/partial rather than live-accepted.

**The bounded recovery drain is transitional:** When native assistant event consumption closes or errors, the UI performs one scoped recovery attempt using `nativeMobileVoice.takeBackgroundResult()`. It drains at most 32 queued results, checks the active scope and recovery generation around asynchronous work, and reconciles terminal results with persisted assistant state. This is not periodic polling and runs only while event consumption is unhealthy. New native observations should prefer `NativeEventHub` plus `useAuroraEvents` with snapshot recovery. Do not claim that background assistant delivery is fully live-accepted until this recovery path is replaced or formally accepted.

## Implementation checklist

Use this checklist for each new native event topic:

- Define the Rust event kind, topic, subjects, payload shape, redaction metadata, and audit fields.
- Publish through `NativeEventDraft` and the global native hub, with epoch guarding for async work.
- Add subject snapshots for any event stream that must recover visible state after missed events, remounts, app backgrounding, persistence completion, or subscriber overflow.
- Confirm `aurora_subscribe` and `aurora_native_event_snapshot` already expose the data; avoid adding duplicate stream commands.
- Add SDK typed payload helpers only when a feature needs a stable product model.
- Normalize through `normalizeNativeAuroraEvent`; preserve `native:<sequence>` IDs and `lastSequenceId`.
- Subscribe through `useAuroraEvents` with `source: "native"`, precise filters, scoped lifecycle key, abort cleanup, and snapshot recovery.
- Keep native/client device selection and transient UI state local; use scoped Query invalidation for server state refresh.
- Test Rust hub behavior, bounded hub overflow/gap handling, SDK one-event IPC ack handling, UI lifecycle/recovery from hub gaps, protocol-fault cleanup, and feature adapter behavior.
- Update durable docs and package README links after the feature is accepted.

# API and contracts

**Status:** Current source of truth

Aurora service APIs are contract-first. Python services declare typed bus methods with `@method_contract`; the Gateway exposes eligible methods as HTTP routes; the TypeScript SDK mirrors supported frontend-facing behavior through typed transports and conformance fixtures.

## Contract sources

| Source | Purpose |
| --- | --- |
| `app/shared/contracts/registry.py` | `@method_contract`, module registration, and contract lookup. |
| `app/shared/contracts/models/*.py` | Typed method constants and Pydantic IO models. |
| Service methods under `app/services/*/` | Actual implementations decorated with contract metadata. |
| `docs/SERVICE_METHODS_REFERENCE.md` | Human-readable method reference; manually maintained. |
| `packages/aurora-sdk` | TypeScript client, fixtures, transports, and conformance expectations. |

## Adding or changing a service method

1. Define or update the typed method constant and IO models in `app/shared/contracts/models/`.
2. Decorate the service method with `@method_contract`.
3. Use absolute imports and Pydantic models for all bus payloads.
4. Set `exposure`, `method_type`, and `required_perms` deliberately.
5. Add/update tests for the service behavior and Gateway exposure when external.
6. Update SDK fixtures/client surfaces if frontend-visible.
7. Update `docs/SERVICE_METHODS_REFERENCE.md` or the relevant subsystem doc.

## Exposure levels

| Exposure | Meaning |
| --- | --- |
| `internal` | Bus-only service method. Not exposed by generated Gateway routes. |
| `external` | Exposed externally through Gateway when policy allows it. |
| `both` | Internal and external use. |

External exposure is not enough by itself: Gateway/Auth permission checks still apply.

## Gateway route generation

Gateway discovers service announcements and contract metadata, then creates FastAPI routes for exposed methods. Requests are validated against the input model and forwarded over the bus. Responses are validated/serialized from output models.

See [`GATEWAY.md`](GATEWAY.md).

## Speech routing and voice contracts

Provider-neutral speech routing is defined in `app/shared/contracts/models/speech.py` and carried through contract registration, service announcements, recipient projections, Gateway routing, generated SDK descriptors, and peer-host manifests.

- Speech methods project `SpeechMethodConstraints`: exact languages, automatic-language support and coverage, declared locale fallbacks, ready logical voice IDs, a resident-model identity digest, and a monotonic speech capability revision.
- Version 1 accepts exact language tags `de`, `en`, `es`, `fr`, `it`, `ja`, `ko`, `pt`, and `zh`. It declares no implicit locale fallback. TTS accepts an exact language or no language; it does not accept `auto`.
- Logical voice IDs are provider-neutral: `standard:<group>:<name>` or `clone:<uuid>`. Filesystem paths, engine-specific speaker names, and raw model identifiers do not cross the public contract.
- Routing derives an immutable language/voice requirement from the typed request. A remote provider with missing legacy capability evidence, an incompatible language, an unavailable logical voice, a stale lease, or insufficient permission is ineligible before text or audio is sent to it.
- `SpeechRouteBinding` is trusted internal envelope/identity metadata, not a caller-set request field. It binds the selected service instance, projection digest/revision, provider lease epoch/revision, speech capability revision, and request-requirement digest. The target validates the binding again before capacity accounting or handler dispatch.
- If target-side state changed, Aurora returns a sanitized `capability_changed` pre-accept result. Automatic use-method routing may resolve once more only when the first target proves the request was not accepted; explicit selectors, management methods, generic failures, timeouts, and post-accept work are never replayed to another provider.

TTS discovery and synthesis are use surfaces. Voice-profile inventory and every profile/import mutation are manage surfaces. The exact permission declarations remain part of each method contract; see [`AUTH_AND_PERMISSIONS.md`](AUTH_AND_PERMISSIONS.md).

## Events and streaming

Gateway event streams expose selected backend events through SDK-compatible shapes. The SDK event API preserves IDs, topics, correlation IDs, peer/target metadata, redaction metadata, and transport evidence.

UI code should consume events through `AuroraClient`, not raw SSE or Tauri commands.

### Assistant token/tool/TTS stream contract

Assistant generation uses the typed bus first, then the Gateway live-event bridge, then the SDK stream helpers. Frontend code must not infer assistant state from logs or private service objects.

- `Orchestrator.Response` publishes `AssistantStreamEvent` payloads with `kind`, `delta`, cumulative `text`, `sequence`, `session_id`, `request_id`, `correlation_id`, `metadata`, and an optional redacted `tool` state.
- Token updates use `assistant.delta`; terminal states use `assistant.completed` or `assistant.failed`.
- Tool updates use `tool.requested`, `tool.running`, `tool.completed`, `tool.failed`, and `tool.requires_action`; args/results exposed to clients must be safe previews, never raw secrets.
- Low-latency TTS uses `TTS.StreamStart`, `TTS.StreamChunk`, and `TTS.StreamEnd` commands plus `TTS.AudioChunk` events. `TTSStreamStartRequest.play_on_server` controls whether the TTS service also speaks through the local audio output.
- Gateway event subscriptions for assistant response streams may include both `Orchestrator.Response` and `TTS.AudioChunk` when correlated to an `Orchestrator.use` request.
- The SDK `assistant.streamMessage()` surface can fall back to the final `Orchestrator.ExternalUserInput` response when a transport cannot provide a live assistant event stream, when process-mode bridging only yields the completed response, or when the correlated event is missed. Fallback updates are a single `kind: "fallback"` item and include `metadata.assistant_stream_contract = "single_response_fallback"`, `metadata.assistant_stream_transport`, and `metadata.assistant_stream_fallback = true`. Clients must not treat fallback updates as token-level streaming evidence.

Desktop daemon/STT-origin voice requests start streamed TTS with server playback enabled. Web, desktop client, and mobile UI read-aloud paths should consume `TTS.AudioChunk` through the SDK and play client-side unless a platform-specific native bridge explicitly owns playback.

### Assistant inference routing policy

`AssistantInferencePolicy` in the TypeScript SDK separates provider/model selection from UI policy hints:

- Serialized request selectors: `peerId`, `providerId`, `runtimeProviderId`/`inferenceProviderId`, `serviceInstanceId`, and `modelId` become `inference_selector`, `inference_provider_id`, and `inference_model_id` on `Orchestrator.ExternalUserInput`.
- Client hints only: `privacyClass`, `dataLeavesDevice`, `selectorRequired`, and `approvalRequired` are retained for UI labels, route sheets, and capability gating. They are not serialized as server enforcement constraints and do not replace Gateway/Auth permission checks.
- Raw inference primitives such as `Orchestrator.InferChat`/`StreamInferChat` and Gateway mesh inference proxy methods are transport/service contracts. External callers should prefer `Orchestrator.ExternalUserInput` through the SDK assistant APIs unless they have explicit permission for lower-level inference routing.

## SDK conformance

`SDK Backend Contract Conformance` checks prevent silent drift between backend contracts and TypeScript fixtures. The conformance docs live in [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md).

Shared Python/Pydantic DTOs that cross the SDK boundary are generated into checked TypeScript validation artifacts:

- `packages/aurora-sdk/src/generated/backend-contracts.schema.json`
- `packages/aurora-sdk/src/generated/backend-contracts.zod.ts`
- `packages/aurora-sdk/src/generated/backend-contracts.manifest.json`
- `packages/aurora-sdk/src/generated/tooling-local-provider-v1.json`

Use `make check-sdk-backend-contracts` after changing allowlisted contract models. The generator fails on unsupported schema constructs instead of weakening them to permissive TypeScript validators, and the checker fails strict schema, generated-artifact, stale fixture, and secret-redaction issues.

Some SDK fixture coverage and descriptor drift is known debt rather than a strict schema failure. The conformance checker keeps that debt behind an explicit nonfatal finding budget: current debt may be ratcheted down, but new categories or count increases fail the gate. SDK, WebRTC, native bridge, persistence, and import/export boundaries should parse untrusted values through the shared validation wrapper and return redacted validation errors.

The lightweight mesh-node implementation uses those generated contracts for the bounded peer host, speech handlers, and local Tooling provider. Generated peer-host descriptors preserve backend schemas, route metadata, permission casing, projection method type, callable features, and speech constraints. A peer host may advertise only methods granted to the recipient, and it does not accept inbound work until a structured manifest acknowledgement classifies every advertised service and matches the projection/auth evidence. Grant and permission decisions go through the Rust `aurora-mesh-authority` core on native and the same core through WebAssembly on web. It must not introduce literal ad hoc bus topics, arbitrary SQL surfaces, generic native process execution, or a second hand-maintained wire DTO model.

Relevant package commands:

```bash
pnpm --filter @aurora/client build
pnpm --filter @aurora/client test
pnpm --filter @aurora/client test:resilience
```

## Documentation ownership

- Use `docs/SERVICE_METHODS_REFERENCE.md` for human-readable service method summaries.
- Use subsystem docs for policy/architecture details.
- Do not create one-off method report docs. If a report is generated, publish it as a CI artifact or local `.artifacts/` output.


## Scheduler typed actions and Tooling policy contracts

New scheduler integrations should call `Scheduler.ScheduleAction`, not write
callback strings. The request contains a discriminated `SchedulerActionSpec`:

- `tts.speak` publishes the typed TTS request at fire time.
- `orchestrator.user_input` publishes local scheduler-origin input only for
  supported local contexts.
- `tooling.execute` first calls `Tooling.PrepareExecution` at schedule time and
  later calls `Tooling.ExecuteTool` at fire time.

For Tooling actions, `PrepareExecution` is the gate that resolves the local or
mesh provider, validates arguments against the current tool schema, returns a
normalized `SchedulerToolBinding`, and reports policy/approval state. The
scheduler persists the returned provider IDs, `global_tool_id`,
`args_schema_hash`, policy decision, resource selector, and correlation ID with
the job. `ExecuteTool` re-checks the stored schema hash and arguments before the
tool is invoked, so schema drift, removed remote tools, revoked grants, and
malformed payloads fail closed.

Runtime approval state is DB-backed: config defaults describe static policy
(`approve_all_local_safe`, `ask_each_time`, `deny_all`, `dry_run_only`,
`unrestricted_except_blocked`), while grants, revocations, pending runtime
approvals, and remote Tooling catalog snapshots are durable runtime records.
Recurring schedules that need approval use a durable `scheduled_execution`
grant; one-shot UI tokens are never stored as the authority for future firings.
Mesh Tooling catalogs are negotiated and cached by Tooling on peer
connect/reconnect/re-announcement. Orchestrator, Scheduler, SDK, and admin
surfaces must read that cache and still call `PrepareExecution` before creating
a job; they must not live-fanout to every peer on the user hot path.

### Tooling source-first management console

Aurora's `/tools` UI is the operator-facing control center for tool catalog policy. It is source-first rather than tool-card-first: core tools, MCP servers, plugins, mesh peers, unknown/quarantined sources, and blocked sources are grouped in a source rail, and individual tools expand only after a source is selected. The page consumes the Aurora SDK only; it does not call Python services directly.

Backend authority stays in Tooling/Auth/Config contracts:

- `Tooling.GetPolicySummary` reports global policy mode, default approval behavior, counts, and redaction state.
- `Tooling.ListToolSources` and `Tooling.GetToolSourceDetail` expose grouped source rows, selected-source tools, grants, policy rules, pending approvals, and mesh cache metadata.
- `Tooling.SetPolicyMode`, `Tooling.UpsertSourcePolicy`, and `Tooling.UpsertToolPolicyOverride` are manage methods guarded by `Tooling.manage`; dangerous unrestricted mode requires the confirmation text `ALLOW NON-BLOCKED TOOLS`.
- `Tooling.ListPendingApprovals` and `Tooling.ListPolicyAuditEvents` provide redacted management queues/history. Assistant inline approval remains separate: it resumes one exact paused tool call in the assistant thread, while `/tools` manages durable policy/grants.
- `Tooling.TestMCPSource`, `Tooling.CreateMCPSource`, `Tooling.TestPluginSource`, and `Tooling.CreatePluginSource` provide UI-safe onboarding contracts. Until a concrete backend installer/connector is available, these contracts return explicit unsupported results with secrets redacted.

Mesh tool catalogs shown here come from negotiated/cached Tooling announcements. The UI must not fan out to peers during prompt or page render; it displays epoch/hash/stale/unshared/removed state from the local Tooling cache. Newly announced child tools require review unless the operator explicitly enabled future-tool trust.

Surface behavior is resolved through `getAuroraSurfaceProfile`, while runtime role is stored in the runtime profile: desktop-local may show local sidecar affordances, remote-console clients show Gateway/home-peer controls only, mesh-node clients expose local capabilities only from real grants and platform evidence, and Android/iOS/mobile must not claim a Python sidecar. Sample/mock data must stay test-only or be explicitly labeled outside production UI.

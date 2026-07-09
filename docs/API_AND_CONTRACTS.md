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

Desktop daemon/STT-origin voice requests start streamed TTS with server playback enabled. Web, thin, and mobile UI read-aloud paths should consume `TTS.AudioChunk` through the SDK and play client-side unless a platform-specific native bridge explicitly owns playback.

### Assistant inference routing policy

`AssistantInferencePolicy` in the TypeScript SDK separates provider/model selection from UI policy hints:

- Serialized request selectors: `peerId`, `providerId`, `runtimeProviderId`/`inferenceProviderId`, `serviceInstanceId`, and `modelId` become `inference_selector`, `inference_provider_id`, and `inference_model_id` on `Orchestrator.ExternalUserInput`.
- Client hints only: `privacyClass`, `dataLeavesDevice`, `selectorRequired`, and `approvalRequired` are retained for UI labels, route sheets, and capability gating. They are not serialized as server enforcement constraints and do not replace Gateway/Auth permission checks.
- Raw inference primitives such as `Orchestrator.InferChat`/`StreamInferChat` and Gateway mesh inference proxy methods are transport/service contracts. External callers should prefer `Orchestrator.ExternalUserInput` through the SDK assistant APIs unless they have explicit permission for lower-level inference routing.

## SDK conformance

`SDK Backend Contract Conformance` checks prevent silent drift between backend contracts and TypeScript fixtures. The conformance docs live in [`SDK_BACKEND_CONFORMANCE_CI.md`](SDK_BACKEND_CONFORMANCE_CI.md).

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

Surface behavior is resolved through `getAuroraSurfaceProfile`: desktop-local may show local sidecar affordances, desktop/web thin show Gateway-backed controls only, and Android/iOS/mobile must not claim a Python sidecar. Demo/mock data must be labeled as fixture/demo.

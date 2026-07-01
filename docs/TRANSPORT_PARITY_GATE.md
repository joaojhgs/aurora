# QA-008 Transport Parity Gate

`scripts/transport_parity_gate.py` is the release gate for PER-274 / QA-008. It combines:

- `scripts/mesh_gap_e2e_harness.py` for thread/LocalBus, process/BullMQ+Redis, HTTP Gateway, Tauri local command smoke, and real two-peer Mesh/WebRTC DataChannel evidence.
- `pnpm --filter @aurora/client build` so package tests consume the SDK `dist/` entrypoint.
- `pnpm --filter @aurora/client test -- --runInBand` for the shared AuroraClient conformance suite across mock, HTTP, Tauri command, and mesh mock transports.
- `pnpm --filter @aurora/ui test` for SDK-bound user-flow smoke models.
- `pnpm --filter @aurora/tauri-ui test` for the desktop local/Tauri wrapper boundary.
- Android/iOS rows with explicit skipped-with-rationale status until Android emulator/device smoke or macOS/Xcode runner evidence is attached. The non-strict Android release report is useful evidence, but does not by itself pass the Android row.

Install the required Python extras before any local/manual gate run:

```bash
uv sync --extra gateway --extra mode-processes --extra test-e2e
```

Run the local report without executing package commands:

```bash
uv run --extra gateway --extra mode-processes --extra test-e2e python scripts/transport_parity_gate.py --output-dir .omx/reports/transport-parity/local
```

Run the full local gate where Node dependencies and platform tools are installed:

```bash
pnpm install --frozen-lockfile
uv run --extra gateway --extra mode-processes --extra test-e2e python scripts/transport_parity_gate.py --execute-commands --output-dir .omx/reports/transport-parity/local
```

Expected artifacts:

- `.omx/reports/transport-parity/local/transport_parity_report.json`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/report.json`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/events.ndjson`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/support_bundle.json`
- `.omx/reports/transport-parity/local/commands/*.log` when `--execute-commands` is used

The release is not ready unless `summary.status` is `pass`. A process/Redis dependency gap, missing SDK/UI command evidence, Android/iOS platform skip, or any failed row keeps `release_ready=false`.

## PER-274 event-flow evidence

Every matrix row now contains an `event_flow` array. Broad `coverage` labels and build-only command results are not sufficient for production-readiness approval.

Required event-flow checks per supported row:

- `registry_capability_graph` - SDK/client path can load registry or capability graph evidence.
- `assistant_request_stream_cancel` - assistant request/stream/cancel basics ran through SDK/UI/Tauri command evidence, or the row is blocked with an explicit degraded reason.
- `config_or_service_health_event` - a config or service-health event reaches the UI/SDK event subscriber.
- `denied_or_privacy_blocked_state` - a denied or privacy-blocked action surfaces a typed state.
- `audit_correlation_redacted` - audit/correlation IDs are present and redacted.
- `mesh_provenance_event` - required only for rows that claim mesh support; non-mesh rows record `not_applicable` with rationale.

A required event-flow item with `missing`, `not_run`, `dependency_gap`, `blocked`, or `fail` blocks that row. Mock-only SDK conformance still records useful evidence, but cannot pass the gate unless the live/hermetic transport row also has the required event-flow artifacts.

The report redacts Redis URLs, host paths, tokens, peer secrets, and secret-like fields. Mock transport conformance is useful evidence, but `mock_only_evidence_sufficient` is always `false`; a mock-only pass cannot satisfy QA-008.

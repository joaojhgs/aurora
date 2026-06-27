# QA-008 Transport Parity Gate

`scripts/transport_parity_gate.py` is the release gate for PER-229 / QA-008. It combines:

- `scripts/mesh_gap_e2e_harness.py` for thread/LocalBus, process/BullMQ+Redis, HTTP Gateway, Tauri local command smoke, and real two-peer Mesh/WebRTC DataChannel evidence.
- `pnpm --filter @aurora/client build` so package tests consume the SDK `dist/` entrypoint.
- `pnpm --filter @aurora/client test` for the shared AuroraClient conformance suite across mock, HTTP, Tauri command, and mesh mock transports.
- `pnpm --filter @aurora/ui test` for SDK-bound user-flow smoke models.
- `pnpm --filter @aurora/tauri-ui test` for the desktop local/Tauri wrapper boundary.
- Android/iOS rows with explicit skipped-with-rationale status until Android emulator/device smoke or macOS/Xcode runner evidence is attached. The non-strict Android release report is useful evidence, but does not by itself pass the Android row.

Run the local report without executing package commands:

```bash
uv run python scripts/transport_parity_gate.py --output-dir .omx/reports/transport-parity/local
```

Run the full local gate where Node dependencies and platform tools are installed:

```bash
pnpm install
pnpm --filter @aurora/client build
uv run python scripts/transport_parity_gate.py --execute-commands --output-dir .omx/reports/transport-parity/local
```

Expected artifacts:

- `.omx/reports/transport-parity/local/transport_parity_report.json`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/report.json`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/events.ndjson`
- `.omx/reports/transport-parity/local/mesh-gap-e2e/support_bundle.json`
- `.omx/reports/transport-parity/local/commands/*.log` when `--execute-commands` is used

The release is not ready unless `summary.status` is `pass`. A process/Redis dependency gap, missing SDK/UI command evidence, Android/iOS platform skip, or any failed row keeps `release_ready=false`.

The report redacts Redis URLs, host paths, tokens, peer secrets, and secret-like fields. Mock transport conformance is useful evidence, but `mock_only_evidence_sufficient` is always `false`; a mock-only pass cannot satisfy QA-008.

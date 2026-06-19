# Mesh Production E2E Harness

PER-163 / MESH-GAP-011 adds an executable two-peer harness for the mesh
capability fabric. The default CI profile creates isolated consumer/provider
peers in-process, drives provider calls through `LocalBus.request`, and uses the
production `app.services.gateway.webrtc.rpc.RPCHandler` for the final
Mesh/WebRTC JSON-RPC row. Deterministic provider handlers supply fake
Tooling/RAG/audio/scheduler data, but pass/fail comes from real request/reply
results.

## Run Locally

```bash
uv run python scripts/mesh_gap_e2e_harness.py
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
```

The runner writes:

- `.omx/reports/mesh-gap-e2e/latest/report.json`
- `.omx/reports/mesh-gap-e2e/latest/events.ndjson`
- `.omx/reports/mesh-gap-e2e/latest/support_bundle.json`

Run one transport row with:

```bash
uv run python scripts/mesh_gap_e2e_harness.py --mode mesh_webrtc
```

## Covered Modes

- `thread_localbus`: component-backed thread mode using `LocalBus.request`.
- `process_bullmq_redis`: preflight row for a Redis-backed process wrapper.
- `http_gateway_thin_client`: preflight row for a live Gateway HTTP wrapper.
- `tauri_local_native`: preflight row for a native/Tauri smoke wrapper.
- `mesh_webrtc`: component-backed final proof using `RPCHandler.on_message` and provider `LocalBus.request`.

The `mesh_webrtc` row is the final mesh proof row in the matrix. The default
runner does not count fixture-only or preflight rows as final acceptance proof.
Live peer startup can reuse the same mode and scenario IDs while replacing the
preflight rows with live service logs.

## Covered Scenarios

The report asserts all required PER-163 scenarios:

1. Pair peers and approve permissions.
2. Share Tooling service with selected tools only.
3. Show local tools, selected remote tools, and blocked providers/reasons.
4. Execute safe local/internal tool.
5. Execute safe remote mesh tool.
6. Require approval for dangerous local/internal tool unless approve-all allows it.
7. Enforce bound remote approval token, including missing token, replay, and mismatch.
8. Enforce RAG namespace selector/policy and provenance.
9. Prove batch remote transcription/synthesis.
10. Gate streaming/mic/wakeword by consent/session.
11. Scope remote scheduler create/list/cancel by namespace/owner/delegation.
12. Deny broad Auth/Config mesh RPC except pairing/login infrastructure.
13. Explain route inclusion, exclusion, and fallback.
14. Emit unified capability, approval, route, audit, audio, data, and scheduler events.
15. Produce redacted support bundle with correlation trail.

## CI Profile

Use the pytest gate for CI/dev:

```bash
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
```

The test checks that every required scenario is represented, component-backed
rows pass, preflight rows are explicitly labeled as non-final evidence, negative
security/privacy cases are present, and artifacts are redacted and
correlation-ready. The default fake data never includes raw tokens, Redis URLs,
host paths, raw audio, or raw RAG records in artifacts.

## Live Process/WebRTC Extension

For a live process-mode run, start the process stack first:

```bash
docker compose -f docker-compose.process.yml up -d redis auth gateway tooling db scheduler tts stt-transcription stt-wakeword
uv run python scripts/mesh_gap_e2e_harness.py --mode process_bullmq_redis --mode mesh_webrtc
```

The current runner is the stable artifact and assertion schema. A live wrapper
should preserve the same `mode_id`, `scenario_id`, `correlation_id`,
`report.json`, `events.ndjson`, and `support_bundle.json` shapes so CI and QA
can compare deterministic and live evidence directly.

The default harness reports the Redis, HTTP, and Tauri rows as `preflight` until
the wrapper provides:

- `AURORA_MESH_E2E_REDIS_URL` for process/BullMQ/Redis.
- `AURORA_MESH_E2E_GATEWAY_URL` for Gateway HTTP.
- `AURORA_MESH_E2E_TAURI=1` for native/Tauri smoke execution.

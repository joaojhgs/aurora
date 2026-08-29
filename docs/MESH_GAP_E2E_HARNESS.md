# Mesh Transport E2E Harness

The mesh transport E2E harness proves Aurora cross-peer capability fabric behavior with two executable peers. The default CI profile creates isolated consumer/provider
peers in-process, drives provider calls through `LocalBus.request`, generated
Gateway FastAPI routes, and an `aiortc` WebRTC DataChannel wired to the
production `app.services.gateway.webrtc.rpc.RPCHandler` for the final
Mesh/WebRTC JSON-RPC row. Deterministic provider handlers supply fake
Tooling/RAG/audio/scheduler data, but pass/fail comes from real request/reply
results on the exercised transport.

## Run Locally

```bash
uv run python scripts/mesh_gap_e2e_harness.py
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
```

The runner writes:

- `.artifacts/e2e/mesh-transport/latest/report.json`
- `.artifacts/e2e/mesh-transport/latest/events.ndjson`
- `.artifacts/e2e/mesh-transport/latest/support_bundle.json`

Run one transport row with:

```bash
uv run python scripts/mesh_gap_e2e_harness.py --mode mesh_webrtc
```

## Covered Modes

- `thread_localbus`: component-backed thread mode using `LocalBus.request`.
- `process_bullmq_redis`: live-gated process row using two `BullMQBus` instances and Redis-backed request/reply when the `mode-processes` dependencies and Redis endpoint are available. If Redis is unavailable, the row reports `dependency_gap` with concrete failure evidence and is not counted as proof.
- `http_gateway_thin_client`: component-backed HTTP row using generated Gateway FastAPI routes through `httpx.ASGITransport`.
- `tauri_local_native`: component-backed local/native command smoke boundary over `LocalBus.request`.
- `mesh_webrtc`: component-backed final proof using `RTCPeerConnection.DataChannel -> RPCHandler.on_message -> LocalBus.request`.

The `mesh_webrtc` row is the final mesh proof row in the matrix. The
`process_bullmq_redis` row now attempts live Redis by default using
`AURORA_MESH_E2E_REDIS_URL`, `REDIS_URL`, or `redis://127.0.0.1:6379`. When
Redis is reachable, each process-mode scenario must pass through
`BullMQBus.request -> Redis -> BullMQBus.worker -> BullMQBus.reply`. When Redis
or process-mode dependencies are unavailable, the full matrix reports
`status: blocked` with `dependency_gap` evidence and the row is not counted as
final acceptance proof.

## Covered Scenarios

The report asserts these durable mesh transport scenarios:

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

Use the pytest suite for CI/dev:

```bash
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py -q
```

The test checks that every required scenario is represented, component-backed
rows pass, dependency gaps are explicitly labeled as non-final evidence,
negative security/privacy cases are present, and artifacts are redacted and
correlation-ready. The default fake data never includes raw tokens, Redis URLs,
host paths, raw audio, or raw RAG records in artifacts.

## Live Process/WebRTC Run

Install the process extras and start Redis first:

```bash
uv sync --extra mode-processes --extra gateway --extra test-integration
docker compose -f docker-compose.process.yml up -d redis
uv run python scripts/mesh_gap_e2e_harness.py --mode process_bullmq_redis --mode mesh_webrtc
```

A non-Docker Redis is also valid:

```bash
REDIS_URL=redis://127.0.0.1:6379 uv run python scripts/mesh_gap_e2e_harness.py --mode process_bullmq_redis
```

The process row preserves the same `mode_id`, `scenario_id`, `correlation_id`,
`report.json`, `events.ndjson`, and `support_bundle.json` shapes as the other
rows. Its artifacts intentionally redact the Redis URL; use the command output
and `dependency_gap` evidence to diagnose unavailable dependencies.

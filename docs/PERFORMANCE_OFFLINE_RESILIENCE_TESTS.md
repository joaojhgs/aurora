# Performance, Offline, And Resilience Tests

## Scope

`pnpm --filter @aurora/client test:resilience` covers SDK behavior for streaming reconnect, offline handling, native/Tauri unavailable states, mesh failover evidence, and large capability/tool lists. Python performance tests remain under `tests/performance` and run from `performance.yml`.

## Commands

```bash
pnpm --filter @aurora/client test:resilience
pnpm --filter @aurora/client typecheck
pnpm --filter @aurora/client build
uv run pytest tests/performance -v
```

## Acceptance evidence

- Streaming reconnect preserves the last backend-proven event ID and avoids duplicate replay.
- Offline mode surfaces `transport_loss`, `unavailable_service`, `unsupported_feature`, or `native_permission_missing` instead of optimistic success.
- Tauri sidecar checks include startup/status/crash or unavailable evidence with a log path.
- Mesh failover includes selected peer/provider, stale or denied primary reason, fallback evidence, correlation ID, and redaction metadata.
- Large capability/tool lists keep policy, selector, provider, permission, and redaction fields while staying inside the asserted budget.

## Limits

These tests do not prove native packaging, physical-device assistant-role behavior, or signing readiness. Those belong to Tauri desktop/mobile workflows and release operations.

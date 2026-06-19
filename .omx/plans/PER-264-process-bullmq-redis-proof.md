# PER-264 Process BullMQ/Redis Proof Plan

## Requirements Summary

- Issue: PER-264, split from PER-163 / MESH-GAP-011.
- Goal: produce live `process_bullmq_redis` proof for `scripts/mesh_gap_e2e_harness.py` using real Redis and two `BullMQBus` instances.
- Scope guard: do not reopen accepted LocalBus, HTTP Gateway, Tauri local/native, or Mesh/WebRTC rows unless the process run exposes a shared regression.
- Required evidence:
  - `process_bullmq_redis` has 15/15 passing scenarios and no `dependency_gap` rows.
  - Artifacts under `.omx/reports/mesh-gap-e2e/` include route/audit/correlation evidence and redact Redis URLs/secrets/host paths.
  - `tests/integration/messaging/test_bullmq_redis_roundtrip.py` passes against the same Redis runtime, or the blocker is recorded exactly.

## Source Context

- Runtime issue description for PER-264.
- Root agent guidance: `AGENTS.md`.
- Messaging guidance: `app/messaging/AGENTS.md`.
- Test guidance: `tests/AGENTS.md`.
- Harness docs: `docs/MESH_GAP_E2E_HARNESS.md`.
- Harness implementation: `scripts/mesh_gap_e2e_harness.py`.
- Live Redis integration test: `tests/integration/messaging/test_bullmq_redis_roundtrip.py`.
- Process Redis compose service: `docker-compose.process.yml`.

## Implementation Steps

1. Preserve current worktree state: use branch `multica/PER-264-mesh-gap-process-redis-proof` and avoid unrelated `assets/graph.png`.
2. Install/verify required extras with `uv sync --extra mode-processes --extra gateway --extra test-integration`.
3. Start or locate Redis:
   - Preferred: `docker compose -f docker-compose.process.yml up -d redis`.
   - Fallback: reachable Redis from `REDIS_URL` / `AURORA_MESH_E2E_REDIS_URL`.
4. Run the process-only harness:
   - `uv run python scripts/mesh_gap_e2e_harness.py --mode process_bullmq_redis`.
5. Inspect `.omx/reports/mesh-gap-e2e/latest/report.json`, `events.ndjson`, and `support_bundle.json` for pass counts, no dependency gaps, route/audit/correlation evidence, and redaction.
6. Run `uv run pytest tests/integration/messaging/test_bullmq_redis_roundtrip.py -q` against the same Redis endpoint.
7. Patch only if the live command path exposes a deterministic harness, docs, or test issue. Re-run affected verification after any patch.
8. Commit scoped changes if any, push branch, open/update PR, and hand off to QA with exact commands and artifacts.

## Acceptance Criteria

- Harness summary status is `pass`, `passed` is 15, `failed` is 0, and `dependency_gap` is 0 for `--mode process_bullmq_redis`.
- Each result records `mode_id=process_bullmq_redis`, a correlation id, and transport path evidence equivalent to `BullMQBus.request->Redis->BullMQBus.worker->BullMQBus.reply`.
- Artifacts redact Redis URLs, tokens/secrets, and host paths.
- BullMQ Redis roundtrip integration test passes or the Multica issue records the exact missing runtime/dependency blocker.

## Risks And Mitigations

- Redis/Docker may be unavailable in this runtime. Mitigation: attempt Docker Compose first, then a local Redis endpoint; if both are unavailable, stop as blocked with exact command output.
- Harness artifacts are generated files under `.omx/reports`; commit only if repo conventions require evidence artifacts, otherwise cite their paths in handoff.
- Existing unrelated worktree change `assets/graph.png` must not be modified, staged, or reverted.

## Verification Strategy

- Required commands from issue description.
- JSON artifact inspection with `python`/`jq` style read-only checks.
- `git status --short` before commit/handoff to verify scope.

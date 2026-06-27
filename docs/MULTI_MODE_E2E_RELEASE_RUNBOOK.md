# Multi-Mode E2E Release Runbook

This runbook is the human-readable PER-223 / QA-002 release gate companion. The generated gate artifacts live under `.omx/reports/multi-mode-e2e/latest/`:

- `matrix.json`
- `matrix.md`
- `runbook.md`

Run the generator locally with:

```bash
uv run python scripts/multi_mode_e2e_matrix.py --print-summary
uv run pytest tests/e2e/test_mesh_gap_e2e_harness.py tests/e2e/test_multi_mode_e2e_matrix.py -q
```

## Install

Prepare Python and JavaScript dependencies before collecting evidence:

```bash
uv sync --extra test-e2e --extra gateway --extra mode-processes
pnpm install --frozen-lockfile
```

For process-mode proof, provide Redis through Docker Compose or a non-Docker Redis endpoint and set `REDIS_URL`. The mesh harness redacts Redis URLs from artifacts.

## Update

Release candidates must attach app/package artifacts from the owning workflows:

- Server web and desktop thin: `pnpm --filter @aurora/web build`.
- Desktop local: `pnpm --filter @aurora/tauri-ui build:bundle`.
- Android thin/local-light baseline: `.github/workflows/tauri-android.yml`.
- iOS thin/local-light baseline: `.github/workflows/tauri-ios.yml`.

Signed installers, updater manifests, Play/App Bundle outputs, and TestFlight/App Store outputs remain owned by QA-006 before final production release.

## Backup

Before update or rollback rehearsal:

1. Capture config backup through the AdminAction-gated backup workflow.
2. Capture DB/RAG export inventory and provenance where policy allows it.
3. Record model/runtime artifact inventory.
4. Store the backup manifest with the release candidate artifacts.

Do not include secrets, raw tokens, raw audio, or unredacted RAG records in attached artifacts.

## Diagnostics

Collect the automated gate artifacts:

```bash
uv run python scripts/mesh_gap_e2e_harness.py
uv run python scripts/multi_mode_e2e_matrix.py
```

Attach:

- `.omx/reports/mesh-gap-e2e/latest/report.json`
- `.omx/reports/mesh-gap-e2e/latest/events.ndjson`
- `.omx/reports/mesh-gap-e2e/latest/support_bundle.json`
- `.omx/reports/multi-mode-e2e/latest/matrix.json`
- `.omx/reports/multi-mode-e2e/latest/matrix.md`
- `.omx/reports/multi-mode-e2e/latest/runbook.md`

The support bundle must include correlation IDs and redaction assertions. It must not include raw credentials, Redis URLs, host paths, raw audio, or raw RAG records.

## Rollback

Rollback requires:

1. Previous signed package/sidecar bundle or web deployment artifact.
2. Backup manifest and restore rehearsal log.
3. AdminAction confirmation for config/data restore.
4. Re-run of the multi-mode matrix generator and relevant smoke tests after rollback.
5. Diagnostics bundle with correlation IDs for any rollback failure.

## Manual Device Lab

GitHub-hosted CI can build emulators/simulators, but it cannot prove final physical/OEM mobile behavior.

Production release still requires:

- Android physical/OEM assistant-role matrix evidence.
- iOS real-device/TestFlight evidence for App Intents, share extension, widgets, file associations, and foreground/background limits.

Emulator-only evidence must stay marked as partial until those artifacts are attached.

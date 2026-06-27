# Security/Privacy Regression Runbook

This runbook is the human-readable PER-224 / QA-003 production gate companion.
The generated artifacts live under `.omx/reports/security-privacy-regression/latest/`:

- `security_privacy_gate.json`
- `security_privacy_gate.md`
- `runbook.md`

Run the generator locally with:

```bash
uv run python scripts/security_privacy_regression_gate.py --print-summary
uv run pytest tests/e2e/test_security_privacy_regression_gate.py -q
```

## Install

Prepare Python and JavaScript dependencies before collecting release evidence:

```bash
uv sync --extra test-e2e --extra gateway --extra mode-processes
pnpm install --frozen-lockfile
```

For process-mode proof, provide Redis through Docker Compose or a non-Docker
Redis endpoint and set `REDIS_URL`. If Redis or process-mode dependencies are
unavailable, record that row as a dependency gap, not as a pass.

## Update

Release candidates must attach the relevant app/package artifacts from the
owning workflows:

- Python package or service artifact: `python scripts/build.py --target wheel --clean`.
- Desktop local bundle: `pnpm --filter @aurora/tauri-ui build:bundle`.
- Android and iOS outputs remain owned by the native release tasks.

Signed installers, updater manifests, Play/App Bundle outputs, and
TestFlight/App Store outputs remain owned by QA-006 before final production
release.

## Backup

Before update or rollback rehearsal:

1. Capture config backup through the AdminAction-gated backup workflow.
2. Capture DB/RAG export inventory and provenance where policy allows it.
3. Record model/runtime artifact inventory.
4. Store the backup manifest with the release candidate artifacts.

Do not include secrets, raw tokens, raw audio, or unredacted RAG records in
attached artifacts.

## Diagnostics

Collect the automated gate artifacts:

```bash
uv run python scripts/security_privacy_regression_gate.py
uv run python scripts/mesh_gap_e2e_harness.py
uv run --extra test --extra service-scheduler --extra service-tooling --extra gateway pytest tests/unit/tooling/test_service.py::TestToolingSharingPolicyAndApproval tests/unit/app/scheduler/test_scheduler_remote_policy.py tests/unit/gateway/test_rpc.py -q
uv run --extra test --extra service-db --extra service-scheduler --extra service-tooling --extra gateway pytest tests/integration/test_mesh_routing.py tests/integration/test_mesh_permissions.py tests/integration/test_mesh_rag_namespace_policy.py -q
```

Attach:

- `.omx/reports/security-privacy-regression/latest/security_privacy_gate.json`
- `.omx/reports/security-privacy-regression/latest/security_privacy_gate.md`
- `.omx/reports/security-privacy-regression/latest/runbook.md`
- `.omx/reports/mesh-gap-e2e/latest/report.json`
- `.omx/reports/mesh-gap-e2e/latest/events.ndjson`
- `.omx/reports/mesh-gap-e2e/latest/support_bundle.json`

The support bundle must include correlation IDs and redaction assertions. It
must not include raw credentials, Redis URLs, host paths, raw audio, or raw RAG
records.

## Rollback

Rollback requires:

1. Previous signed package/sidecar bundle or web deployment artifact.
2. Backup manifest and restore rehearsal log.
3. AdminAction confirmation for config/data restore.
4. Re-run of the security/privacy smoke subset after rollback.
5. Diagnostics bundle with correlation IDs for any rollback failure.

## Minimum Negative Coverage

The PER-224 gate requires negative cases for missing explicit selector, stale
peer, denied peer, privilege mismatch, approval replay, changed args hash,
changed provider identity, expired token, approve-all scope escape, dry-run
bypass, unauthorized remote RAG namespace, remote audio without consent,
scheduler foreign namespace, redaction leaks, and raw `confirmed=true` bypasses
for both local/internal and remote mesh tools.

Mock transport artifacts are fixture evidence only; they are never production
release proof.

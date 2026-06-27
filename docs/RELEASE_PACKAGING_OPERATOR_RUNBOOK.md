# Release Packaging And Operator Runbook

This runbook is the human-readable PER-227 / QA-006 release gate companion. The generated gate artifacts live under `.omx/reports/release-packaging-operator/latest/`:

- `release_packaging_gate.json`
- `release_packaging_gate.md`
- `runbook.md`

Run the generator locally with:

```bash
uv run python scripts/release_packaging_operator_gate.py --print-summary
uv run pytest tests/e2e/test_release_packaging_operator_gate.py -q
```

## Install

Prepare Python, JavaScript, Tauri, and platform toolchains before collecting evidence:

```bash
uv sync --extra test-e2e --extra gateway --extra mode-processes
pnpm install --frozen-lockfile
```

Native packaging also requires the relevant platform prerequisites: Tauri Linux WebKit packages, Windows signing/WebDriver tooling, macOS Xcode, Android SDK/NDK, and Apple signing inputs where applicable.

## Update

Release candidates must attach package artifacts and logs for the target platforms:

- Python/server: `python scripts/build.py --target wheel --clean`.
- Docker process mode: `make docker-process-mode` or the release Docker workflow digest output.
- Desktop local: `pnpm --filter @aurora/tauri-ui prepare:sidecar` and `pnpm --filter @aurora/tauri-ui build:bundle`.
- Android: `pnpm --filter @aurora/tauri-ui android:release-gate:strict` and signed APK/AAB evidence.
- iOS: `pnpm --filter @aurora/tauri-ui ios:policy` plus macOS/Xcode/TestFlight or App Store dry-run evidence.

Every update artifact must include version, commit SHA, package checksum, signing/notarization or upload receipt where applicable, smoke log, owner, and skipped-row rationale.

## Backup

Before update or rollback rehearsal:

1. Capture AdminAction-gated config backup.
2. Capture DB/RAG export inventory and provenance where policy allows it.
3. Record model/runtime artifact inventory.
4. Run restore rehearsal on an isolated profile.
5. Store the backup manifest with the release candidate artifacts.

Do not attach secrets, raw tokens, Redis URLs, host paths, raw audio, or unredacted RAG records.

## Diagnostics

Collect the automated gate artifacts:

```bash
uv run python scripts/release_packaging_operator_gate.py
uv run python scripts/multi_mode_e2e_matrix.py
uv run python scripts/security_privacy_regression_gate.py
uv run python scripts/mesh_gap_e2e_harness.py
```

Attach:

- `.omx/reports/release-packaging-operator/latest/release_packaging_gate.json`
- `.omx/reports/release-packaging-operator/latest/release_packaging_gate.md`
- `.omx/reports/release-packaging-operator/latest/runbook.md`
- `.omx/reports/multi-mode-e2e/latest/matrix.json`
- `.omx/reports/security-privacy-regression/latest/security_privacy_gate.json`
- `.omx/reports/mesh-gap-e2e/latest/support_bundle.json`

The support bundle must include correlation IDs and redaction assertions. It must not include raw credentials, Redis URLs, host paths, raw audio, or raw RAG records.

## Rollback

Rollback requires:

1. Previous signed package, sidecar bundle, web deployment artifact, or Docker image digest.
2. Backup manifest and restore rehearsal log.
3. AdminAction confirmation for config/data restore.
4. Re-run of package smoke, security/privacy smoke, diagnostics generation, and restore checks.
5. Redacted diagnostics bundle with correlation IDs for any rollback failure.

## Production Guardrails

- Mock transport artifacts are fixture evidence only, never production release proof.
- Android emulator-only evidence remains partial until physical/OEM assistant-role matrix evidence is attached.
- iOS simulator-only evidence remains partial until TestFlight/real-device evidence is attached; iOS must not claim default-assistant or Siri replacement behavior.
- Process-mode skips must name the missing Redis/BullMQ dependency, owner, follow-up, and attempted command.

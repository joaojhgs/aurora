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

## PER-275 Non-Signing UI/Tauri Preflight

PER-275 adds a narrower operator preflight that can be run before final
packaging/signing work. It records pass/fail/skipped-with-rationale rows for
web/UI builds, Tauri desktop prerequisites, sidecar expectations, local Gateway
health, process-mode Redis/Docker checks, mobile tooling availability, and
diagnostics redaction. It does not claim code signing, notarization, updater
publishing, App Store/TestFlight, Play Store, physical device, or final
production readiness.

Generate the preflight artifact:

```bash
uv run python scripts/ui_release_preflight.py --print-summary
uv run pytest tests/e2e/test_ui_release_preflight.py -q
```

When the host has the needed toolchain and you want command logs captured in the
artifact, run selected rows or the whole command set:

```bash
uv run python scripts/ui_release_preflight.py --execute-commands --command-id sdk-build --command-id ui-package-build --command-id tauri-ui-build --print-summary
uv run python scripts/ui_release_preflight.py --execute-commands --print-summary
```

The primary artifacts are:

- `.omx/reports/ui-release-preflight/latest/ui_release_preflight.json`
- `.omx/reports/ui-release-preflight/latest/ui_release_preflight.md`
- `.omx/reports/ui-release-preflight/latest/redaction_probe.json`
- `.omx/reports/ui-release-preflight/latest/logs/*.log` when command execution is enabled

The exact build commands that must be green before QA handoff are:

```bash
pnpm --filter @aurora/client build
pnpm --filter @aurora/ui build
pnpm --filter @aurora/tauri-ui build
```

## Install

Prepare Python, JavaScript, Tauri, and platform toolchains before collecting evidence:

```bash
uv sync --extra test-e2e --extra gateway --extra mode-processes
pnpm install --frozen-lockfile
```

Native packaging also requires the relevant platform prerequisites: Tauri Linux WebKit packages, Windows signing/WebDriver tooling, macOS Xcode, Android SDK/NDK, and Apple signing inputs where applicable.

For the PER-275 non-signing desktop preflight on Linux, missing WebKit/GTK/GLib
packages should be reported as a degraded row with remediation rather than as a
cryptic native build failure. Install the Tauri Linux prerequisites for the
target distro, including WebKitGTK, GTK3, GLib, `pkg-config`, OpenSSL dev
headers, appindicator, and librsvg packages.

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
uv run python scripts/ui_release_preflight.py
uv run python scripts/multi_mode_e2e_matrix.py
uv run python scripts/security_privacy_regression_gate.py
uv run python scripts/mesh_gap_e2e_harness.py
```

Attach:

- `.omx/reports/release-packaging-operator/latest/release_packaging_gate.json`
- `.omx/reports/release-packaging-operator/latest/release_packaging_gate.md`
- `.omx/reports/release-packaging-operator/latest/runbook.md`
- `.omx/reports/ui-release-preflight/latest/ui_release_preflight.json`
- `.omx/reports/ui-release-preflight/latest/ui_release_preflight.md`
- `.omx/reports/ui-release-preflight/latest/redaction_probe.json`
- `.omx/reports/multi-mode-e2e/latest/matrix.json`
- `.omx/reports/security-privacy-regression/latest/security_privacy_gate.json`
- `.omx/reports/mesh-gap-e2e/latest/support_bundle.json`

The support bundle must include correlation IDs and redaction assertions. It
must not include raw credentials, Redis URLs, host paths, peer secrets, model
paths, local files, private diagnostics, raw audio, or raw RAG records. The
PER-275 redaction probe is adversarial by design and should be attached when
diagnostics are shared with QA or support.

## Mode-Specific Operator Checks

### Desktop Local

Use desktop local mode when the Tauri shell supervises or connects to a local
Aurora node. Required preflight evidence:

- `pnpm --filter @aurora/tauri-ui build` passes.
- Rust, Cargo, and native Tauri dependencies are present or reported as degraded
  with exact remediation.
- `AURORA_TAURI_SIDECAR_SOURCE` points to a prebuilt executable before
  `pnpm --filter @aurora/tauri-ui build:bundle`; PER-275 does not build, sign,
  or publish the sidecar.
- Local sidecar health is expected at `/api/health`; sidecar logs must redact
  tokens, loopback auth, host paths, model paths, and private diagnostics.

### Desktop Thin

Use desktop thin mode when the Tauri shell connects to an operator-managed
Gateway rather than supervising local Python services. Required preflight
evidence:

- Tauri UI build passes.
- Gateway URL is configured without embedding tokens in the artifact.
- Gateway health is reachable at `/api/health` or skipped with the exact host,
  network, or auth blocker.
- Unsupported local-only native features remain degraded through SDK/native
  capability state instead of hidden mock success.

### Server Web

Use server web mode when browsers connect to a hosted/operator Gateway. Required
preflight evidence:

- SDK and shared UI builds pass.
- `pnpm --filter @aurora/web build` is run when validating the hosted web app.
- Gateway health, Auth/RBAC, event stream, diagnostics, and support bundle
  checks are collected through public Gateway/SDK paths.

### Process Mode

Use process mode when services communicate through BullMQ/Redis and Docker
Compose. Required preflight evidence:

- Redis is reachable or the preflight records an environment-gated skip with
  the exact blocker.
- `docker compose -f docker-compose.process.yml config --quiet` passes when
  Docker socket access is available.
- Process-mode smoke must not print raw `REDIS_URL`; attach redacted logs only.
- Gateway service health is checked after Redis and dependent services are up.

### Mesh Mode

Use mesh mode only with backend-proven peer, route, capability, policy, and
correlation evidence. Recovery checks:

- Confirm stable peer identity and bilateral trust state before retrying.
- If pairing fails, clear only the affected peer-scoped credential or reverse
  pairing state; do not rotate unrelated peers.
- Capture route diagnostics, provider eligibility reasons, policy decisions,
  and correlation IDs.
- Do not claim fallback success after an explicit selector target fails.

## Event Stream Troubleshooting

PER-269 identified that Tauri local event subscription and assistant streaming
are not final-production complete. During PER-275 preflight:

- Treat HTTP event stream and Tauri local event subscription issues as degraded
  readiness rows unless the tested path proves live events.
- Record whether the client targets `/api/events/stream`.
- Confirm event artifacts are redacted and include correlation IDs.
- Do not treat request/response fallback as proof of live streaming readiness.

## Rollback

Rollback requires:

1. Previous signed package, sidecar bundle, web deployment artifact, or Docker image digest.
2. Backup manifest and restore rehearsal log.
3. AdminAction confirmation for config/data restore.
4. Re-run of package smoke, security/privacy smoke, diagnostics generation, and restore checks.
5. Redacted diagnostics bundle with correlation IDs for any rollback failure.

For desktop local rollback, stop the sidecar first, restore the previous Tauri
bundle and sidecar binary, then verify `/api/health` and SDK request/response
paths before enabling event-dependent flows. For desktop thin and server web,
roll back the Gateway URL or hosted deployment independently from local native
storage. For process mode, roll back Compose image digests and Redis/BullMQ
configuration together, then regenerate a redacted support bundle.

## Production Guardrails

- Mock transport artifacts are fixture evidence only, never production release proof.
- Android emulator-only evidence remains partial until physical/OEM assistant-role matrix evidence is attached.
- iOS simulator-only evidence remains partial until TestFlight/real-device evidence is attached; iOS must not claim default-assistant or Siri replacement behavior.
- Process-mode skips must name the missing Redis/BullMQ dependency, owner, follow-up, and attempted command.

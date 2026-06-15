# TAURI-003 — Implement secure storage for tokens, mesh credentials, and local secrets

## Execution metadata

- **Phase:** P3 — Tauri desktop/native shell foundation
- **Lane:** tauri-desktop
- **Depends on:** TAURI-001, SDK-004
- **Parallelizable with:** None
- **Coverage matrix rows:** auth.session.state_machine
- **Isolation rule:** implement this task through its declared contracts and SDK surfaces only; do not make unrelated production changes.

## Goal

Use platform keychain/Stronghold-compatible storage and never localStorage for credentials.

## User-visible outcome

Auth/session, mesh credentials, and admin unlock survive app restarts safely.

## Backend/API implementation details

- No backend contract changes are expected in this task. If implementation discovers a missing backend dependency, create/link the relevant `BE-*` task instead of widening this task silently.

## SDK integration details

- Production UI talks through `AuroraClient` Tauri transport; no screen calls `invoke` directly except SDK adapter internals.

## Tauri/native integration details

- Use official Tauri 2 Rust core; do not select PyTauri/tauri-plugin-python for production shell.
- Use Tauri capability/permission files to limit exposed commands.
- Desktop sidecar commands must be token/origin/loopback hardened.

## UI/UX implementation details

- No production UI changes are expected in this task. Any UI impact should be documented as downstream work and linked to the relevant `UI-*`, `UIA-*`, `ADM-*`, or `MESH-*` task.

## Code references to inspect first

- Future `src-tauri/` / Tauri workspace
- `main.py`, `app/services/supervisor.py`, `app/messaging/local_bus.py`, `app/shared/messaging/bus_init.py`
- `.omx/research/ui-refinement/tauri-runtime-decision.md` if present

## Mock/component references

- All UI mock surfaces remain visual references; shell task owns runtime only.

## Data, permissions, and privacy contract

- Source: https://v2.tauri.app/develop/plugins/develop-mobile/
- Source: https://v2.tauri.app/security/permissions/
- Source: https://v2.tauri.app/develop/configuration-files/

## Acceptance criteria

- Tauri app launches UI in dev and production build.
- Security review lists every exposed command/capability and denied default.
- Desktop local mode can report sidecar health and shut down cleanly.
- Thin mode can connect to remote HTTP without sidecar.

## Verification commands / evidence

- `cargo check` in Tauri package.
- `pnpm build` for UI bundle.
- Smoke launch on Linux; later CI matrix for Windows/macOS.

## Risks and guardrails

- Do not ship broad shell/fs permissions.
- Do not store tokens in web storage.

## Handoff notes

- No additional handoff notes at planning time.

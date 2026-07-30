# Desktop Live E2E Harness

This directory owns the Python-free desktop client to real Python peer live harness.

Run the local contract checks:

```bash
node --test tests/e2e/desktop_live/desktop-live-harness.test.mjs
```

Run the non-launch preflight/report:

```bash
node tests/e2e/desktop_live/desktop-live-e2e.mjs --check-only
```

Full live mode is intentionally gated because the repository does not yet include
a desktop WebView driver fixture. A CI workflow can enable it by setting:

```bash
AURORA_DESKTOP_LIVE_E2E=1
AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND="node tests/e2e/desktop_live/desktop-webdriver-driver.mjs"
AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_URL="http://127.0.0.1:4444"
```

The harness starts the existing real Python WebRTC peer, launches the Tauri
desktop client with `AURORA_TAURI_DEV_AUTOSIDECAR=0`, verifies the Tauri-owned
process tree has no Python or sidecar descendants, and passes the Python ready
payload, runtime profile, invite, report paths, and room secret to the driver
command. The driver must perform WebView approval/RPC assertions and write
`desktop-done.json` plus `desktop-client-report.json`; the harness then reuses
`scripts/webrtc_interop_scan.py` for the aggregate report.

`desktop-webdriver-driver.mjs` is the repo-owned no-new-dependency fixture. It
connects to a running Tauri/WebDriver endpoint and invokes the narrow test-only
WebView hook `window.__AURORA_DESKTOP_LIVE_E2E__(payload)`.

Hook payload contract:

- `schema`: `aurora.desktop_live_e2e.hook_payload.v1`
- `sessionNonce`: launch nonce that must be echoed in the returned report
- `tauriPid`: launched Tauri PID that must be echoed in the returned report
- `ready`, `runtimeProfile`, `invite`: parsed Python peer/profile/invite inputs
- `readyPath`, `runtimeProfilePath`, `invitePath`, `reportPath`, `donePath`
- `roomSecret`: seeded room secret already present in the invite

The hook must seed the runtime profile/invite, approve pairing in the Tauri
WebView, execute the existing WebRTC interop approval/RPC/revoke/role-switch
contract, and return a report object with:

- `status: "passed"`
- matching `sessionNonce` and `tauriPid`
- `secretsRedacted: true`
- `roleSwitchEvidence: { passed: true, from: "remote-console", to: "mesh-node" }`
- `browserResult` or `desktopResult` evidence

The fixture writes `desktop-client-report.json` and `desktop-done.json` only for
a passed hook result. It fails closed when the hook is absent, throws, returns no
report, omits required evidence, reports missing/false/reversed role-switch
evidence, or echoes the wrong nonce/PID. The minimal shared follow-up is a
workflow/package script that starts `tauri-driver` and a Tauri bootstrap test
hook implementing this contract.

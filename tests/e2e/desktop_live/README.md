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

Run the maintained Linux live command:

```bash
pnpm test:desktop-client:live
```

The command builds the Python-free desktop client with the explicitly gated
WebView hook, starts `tauri-driver`, and launches the exact application through
the `tauri:options.application` capability. The application wrapper records its
PID before `exec`, allowing the driver to prove that the WebView it controls has
no Python or sidecar descendants. The harness starts the existing real Python
WebRTC peer and passes the ready payload, runtime profile, invite, report paths,
and room secret to the driver command. The driver performs WebView approval/RPC
assertions and writes
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
evidence, or echoes the wrong nonce/PID. The hook is compiled only when
`VITE_AURORA_DESKTOP_LIVE_E2E=1`; ordinary production builds do not install it.

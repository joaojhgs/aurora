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
AURORA_DESKTOP_LIVE_E2E_DRIVER_COMMAND="<tauri-driver/webdriver wrapper>"
```

The harness starts the existing real Python WebRTC peer, launches the Tauri
desktop client with `AURORA_TAURI_DEV_AUTOSIDECAR=0`, verifies the Tauri-owned
process tree has no Python or sidecar descendants, and passes the Python ready
payload, runtime profile, invite, report paths, and room secret to the driver
command. The driver must perform WebView approval/RPC assertions and write
`desktop-done.json` plus `desktop-client-report.json`; the harness then reuses
`scripts/webrtc_interop_scan.py` for the aggregate report.

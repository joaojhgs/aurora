# R5 — Background Measurement Harness

The numbers R6 sets its connection budget from come from one committed harness,
`apps/aurora-tauri/scripts/android-background-measurement.mjs`, and one report
format. This note is that format, plus an honest statement of what this
environment can and cannot measure today.

The harness is adb-driven and reads only what Android already reports:
`dumpsys meminfo`, `dumpsys battery`, `dumpsys thermalservice`,
`dumpsys activity service`, `dumpsys activity services` and `logcat`. It does not estimate. **A dimension it
cannot measure reports `not_yet_available` or `not_available` with the probe
result that says so, never a substituted number.**

---

## Running it

```bash
pnpm --filter @aurora/tauri-ui android:background:measure \
  --duration 600 --sample-interval 30 --peer-counts 0 --lifecycles foreground,background
```

| Option | Default | Meaning |
|---|---|---|
| `--app-id` | `dev.aurora.desktop` | package under measurement |
| `--serial` | discovered | adb serial; omit to select the Waydroid device from `adb devices -l` |
| `--duration` | `300` | seconds per scenario |
| `--sample-interval` | `30` | seconds between samples |
| `--peer-counts` | `0` | comma-separated device-connection counts to measure |
| `--lifecycles` | `foreground,background` | which lifecycle states to measure |
| `--out` | `/tmp/aurora-android-background-measurement.json` | report path |
| `--native-peer-id` | unset | stable peer whose Rust counters qualify one live background scenario |
| `--native-before-snapshot` | unset | JSON snapshot captured before the scenario |
| `--native-after-snapshot` | unset | JSON snapshot captured after the remote call |
| `--gateway-report` | unset | JSON report for the public Gateway tool call |

The four native-proof options are all-or-nothing and require exactly one
positive peer count with `--lifecycles background`. The before snapshot must
contain that number of live peers. This lets an external paired-peer driver
trigger the public call during the sampling window without letting the adb
harness invent a peer count. The report is always written; a failed strict
native proof also makes the command exit non-zero so CI cannot accept it as a
successful measurement.

Device selection follows the root `AGENTS.md`: Waydroid is the default target and
is discovered from `adb devices -l` by its description rather than a hardcoded
address, through the shared `resolveAndroidDeviceSerial` helper. A QEMU emulator
is never started for this lane.

---

## Report format (`formatVersion: 2`)

```jsonc
{
  "formatVersion": 2,
  "status": "passed | failed | measured",
  "generatedAt": "2026-08-20T00:00:00.000Z",
  "harness": "apps/aurora-tauri/scripts/android-background-measurement.mjs",
  "workstream": "R5",
  "appId": "dev.aurora.desktop",
  "device": {
    "serial": "…", "deviceClass": "waydroid-container | qemu-emulator | physical",
    "model": "…", "product": "…", "abi": "…", "sdkInt": 33,
    "physicalPowerReadings": false,
    "physicalThermalReadings": false
  },
  "caveats": ["…"],
  "settings": { "durationSeconds": 300, "sampleIntervalSeconds": 30, "peerCounts": [0], "lifecycles": ["foreground","background"] },
  "scenarios": [
    {
      "peerCount": 0,
      "lifecycle": "background",
      "status": "measured | not_yet_available",
      "blockedBy": "R3",              // present only when status is not_yet_available
      "reason": "…",                  // ditto
      "durationSeconds": 300,
      "sampleCount": 11,
      "dimensions": { /* see below; null when the scenario was not measured */ },
      "nativeBackgroundProof": { /* strict joined proof, or null */ },
      "samples": [ /* raw per-sample readings, kept so a summary can be re-derived */ ]
    }
  ]
}
```

### Dimensions

| Dimension | Statuses | Content when measured |
|---|---|---|
| `memory` | `measured`, `not_available` | `first`, `last`, `peak`, `deltaKb` in KiB total PSS |
| `battery` | `measured`, `measured_non_physical`, `not_available` | `first`, `last`, `deltaPercent`, `chargeCounterDeltaMicroAh`, `physical` |
| `thermal` | `measured`, `measured_non_physical`, `not_available` | `readings` — per-sensor name, type and °C |
| `survival` | `measured`, `not_available` | `lastAliveSeconds`, `diedAtSeconds`, `survivedWholeWindow` |
| `deviceLinkSurvival` | `measured`, `not_yet_available` | `lastHeldSeconds` — how long the connected-device foreground reason stayed held |
| `backgroundToolCalls` | `measured`, `observed_unqualified`, `not_qualified`, `not_yet_available` | `observed` — supporting Rust markers; `measured` only after the strict joined proof passes |

`measured_non_physical` means the reading exists and was taken, but the device
class synthesises it. Treat it as a shape check, never as a device figure.

### Per-sample readings

Each entry in `samples` carries `elapsedSeconds`, `processAlive`, `pid`,
`memoryTotalPssKb`, `battery`, `thermal` and `service`. `service` is the R4
signal: the Aurora runtime foreground service record with `isForeground`, the
live semantic `foregroundReasons`, and decoded `foregroundServiceTypes`
(`microphone`, `connectedDevice`, …). The harness prefers ActivityManager's
`types=` mask when Android prints it. Android 13 may omit that field, so the
service also exposes the current reason ledger and requested type mask through
Android's standard redacted `Service.dump` hook, read with
`dumpsys activity service`.

---

## What this environment can measure today

Measured against Waydroid (`waydroid_x86_64`, x86_64, SDK 33, container on the
host kernel):

- **Memory** — real. `dumpsys meminfo` total PSS for the app process.
- **Survival time** — real. Whether the process and its one foreground service
  are still alive across the window, and when they stopped being so.
- **Foreground reasons** — real, and the live R4 signal. The running service's
  redacted reason ledger plus the service types requested for that exact state.
- **Battery** — present but **synthesised**. Waydroid reports a fixed AC-powered
  state with a static level and a 35.0 °C battery temperature from the host.
  Reported as `measured_non_physical`.
- **Thermal** — **absent**. `dumpsys thermalservice` reports `HAL Ready: false`
  with no cached temperatures. Reported as `not_available`.

## The two R3 dimensions, now that R3 has landed

R3 (background tool serving) is milestone M6 and has landed. Both
dimensions that depend on it are wired to real probes rather than stubs,
and both now report a number as soon as the signal appears:

- **`deviceLinkSurvival`** reads the live `device_link` service reason and the
  decoded foreground service type for `connectedDevice`. R3 is the first caller of R4's
  `AuroraRuntimeForegroundService.holdDeviceLink`: it takes the reason on
  its first bound mesh session and releases it when the last one drops.
  The probe times how long that reason stays held.
- **`backgroundToolCalls`** counts log lines matching
  `/RustStdoutStderr.*\bbackground[ _-]?tool[ _-]?call\b/i` over the
  window, with the log cleared at the start so the count is exact. R3
  prints `background_tool_call` from
  `apps/aurora-tauri/src-tauri/src/mesh_session.rs`, once per inbound
  call it answers without the webview. The marker alone is reported as
  `observed_unqualified`. It becomes `measured` only when the same scenario's
  public Gateway result passed, the same Rust peer and native connection stayed
  bound for the entire window, and `servedCalls` increased without increasing
  `deferredCalls`, `deniedCalls`, or `failedCalls`.

On mobile, Android/iOS activity lifecycle is authoritative over the browser's
visibility observation. A native suspend takes a background hold before the
WebView can freeze. Stale WebView foreground or resume acknowledgements cannot
release that hold. The native resume event releases it and asks the WebView to
run the existing ordered drain before Rust returns the dispatcher to
foreground. This prevents a still-visible document from moving a genuinely
backgrounded Activity back onto the WebView execution path.

When either reports `not_yet_available` it now carries
`blockedBy: "no_signal_observed"` rather than `blockedBy: "R3"`, because
the absence no longer means the feature is missing. It means one of two
things, and the `reason` says both: no session or no remote call
happened during the window, or the build under measurement predates R3.

A scenario with `peerCount > 0` is recorded as `not_yet_available` with
`blockedBy: "no_peer_driver"` unless the native-proof options identify the
same peer in the before snapshot. This harness does not establish device
connections, so it will not label a scenario with an unproved count.

### Qualifying an R3 measurement

A qualifying run must use the maintained Android client APK built from the
same revision as the harness. The x86_64 build uses the complete Android
Sherpa runtime directory, not the generated project's partial library folder:

```bash
AURORA_SHERPA_ONNX_ANDROID_X86_64_LIB_DIR="$PWD/.artifacts/sherpa-onnx/android-runtime-build/runtime/x86_64" \
VITE_AURORA_NATIVE_WEBRTC_TRANSPORT_V1=1 \
VITE_AURORA_DESKTOP_LIVE_E2E=1 \
VITE_AURORA_WEBRTC_ALLOW_INSECURE_LOOPBACK=1 \
pnpm --filter @aurora/tauri-ui android:build:client:apk:x86_64

pnpm --filter @aurora/tauri-ui android:verify:client:apk
```

The run must then prove all of the following against one live paired session:

1. the device advertises the local bounded tool through the ordinary mesh
   service catalog;
2. the remote peer discovers and prepares that tool through `PeerBridge.call`
   while the app is foregrounded;
3. the app is moved to the background before the remote peer executes it;
4. a Rust snapshot immediately before backgrounding identifies the bound peer
   and native connection, and records its `servedCalls` count;
5. the report records both a held `connectedDevice` foreground reason and at
   least one `background_tool_call` marker while the Activity is backgrounded;
6. after resume, a second Rust snapshot shows the same peer and connection with
   `servedCalls` increased by at least one, with no increase in `deferredCalls`,
   `deniedCalls`, or `failedCalls`; and
7. after force-stop and relaunch, the saved profile reconnects to the same live
   peer without another pairing flow.

An APK build, artifact scan, foreground-only call, direct service invocation,
gateway payload success without the Rust counter/marker evidence, or a report
with `no_signal_observed` does not satisfy that proof.

Waydroid is still **not a physical device**. Its container does not reproduce
Doze, app standby buckets, OEM process killing, physical battery draw, or a
thermal HAL. Its report therefore remains a protocol, memory, service-hold,
and process-survival check; it cannot close the physical-device power and
survival acceptance gate.

## What still needs a physical device

The release acceptance gate requires an adb-driven background soak on a
physical device. R5 supplies the harness for that run; Waydroid does not
substitute for it.
Battery and thermal numbers for R6 must come from a `deviceClass: "physical"`
report. A Waydroid report is a shape and memory/survival check only — its
`physicalPowerReadings` and `physicalThermalReadings` flags are `false` precisely
so a reader cannot mistake it for one.

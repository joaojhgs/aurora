# R5 — Background Measurement Harness

The numbers R6 sets its connection budget from come from one committed harness,
`apps/aurora-tauri/scripts/android-background-measurement.mjs`, and one report
format. This note is that format, plus an honest statement of what this
environment can and cannot measure today.

The harness is adb-driven and reads only what Android already reports:
`dumpsys meminfo`, `dumpsys battery`, `dumpsys thermalservice`,
`dumpsys activity services` and `logcat`. It does not estimate. **A dimension it
cannot measure reports `not_yet_available` or `not_available` with the probe
result that says so, never a substituted number.**

---

## Running it

```bash
pnpm --filter @aurora/tauri-ui android:background:measure -- \
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

Device selection follows the root `AGENTS.md`: Waydroid is the default target and
is discovered from `adb devices -l` by its description rather than a hardcoded
address, through the shared `resolveAndroidDeviceSerial` helper. A QEMU emulator
is never started for this lane.

---

## Report format (`formatVersion: 1`)

```jsonc
{
  "formatVersion": 1,
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
| `backgroundToolCalls` | `measured`, `not_yet_available` | `observed` — served calls counted in the log over the window |

`measured_non_physical` means the reading exists and was taken, but the device
class synthesises it. Treat it as a shape check, never as a device figure.

### Per-sample readings

Each entry in `samples` carries `elapsedSeconds`, `processAlive`, `pid`,
`memoryTotalPssKb`, `battery`, `thermal` and `service`. `service` is the R4
signal: the Aurora runtime foreground service record with `isForeground` and the
decoded `foregroundServiceTypes` (`microphone`, `connectedDevice`, …), taken
from the `types=` mask that `dumpsys activity services` prints.

---

## What this environment can measure today

Measured against Waydroid (`waydroid_x86_64`, x86_64, SDK 33, container on the
host kernel):

- **Memory** — real. `dumpsys meminfo` total PSS for the app process.
- **Survival time** — real. Whether the process and its one foreground service
  are still alive across the window, and when they stopped being so.
- **Foreground reasons** — real, and the live R4 signal. Which service types the
  one Aurora service is actually running with.
- **Battery** — present but **synthesised**. Waydroid reports a fixed AC-powered
  state with a static level and a 35.0 °C battery temperature from the host.
  Reported as `measured_non_physical`.
- **Thermal** — **absent**. `dumpsys thermalservice` reports `HAL Ready: false`
  with no cached temperatures. Reported as `not_available`.

## The two R3 dimensions, now that R3 has landed

R3 (background tool serving) is milestone M6 and has landed. Both
dimensions that depend on it are wired to real probes rather than stubs,
and both now report a number as soon as the signal appears:

- **`deviceLinkSurvival`** reads the decoded foreground service types for
  `connectedDevice`. R3 is the first caller of R4's
  `AuroraRuntimeForegroundService.holdDeviceLink`: it takes the reason on
  its first bound mesh session and releases it when the last one drops.
  The probe times how long that reason stays held.
- **`backgroundToolCalls`** counts log lines matching
  `/RustStdoutStderr.*\bbackground[ _-]?tool[ _-]?call\b/i` over the
  window, with the log cleared at the start so the count is exact. R3
  prints `background_tool_call` from
  `apps/aurora-tauri/src-tauri/src/mesh_session.rs`, once per inbound
  call it answers without the webview. **Served, deferred and denied
  calls all count**: all three are the device answering a remote call
  while backgrounded, and a denial that never reached the wire is
  indistinguishable from a dead session at the other end.

When either reports `not_yet_available` it now carries
`blockedBy: "no_signal_observed"` rather than `blockedBy: "R3"`, because
the absence no longer means the feature is missing. It means one of two
things, and the `reason` says both: no session or no remote call
happened during the window, or the build under measurement predates R3.

A scenario with `peerCount > 0` is still recorded as `not_yet_available`,
now with `blockedBy: "no_peer_driver"`: this harness reads what Android
reports and does not itself establish device connections, so it will not
label a scenario with a device count it did not set up.

### What was actually measured for R3, and what was not

The R3 soak was run on Waydroid, and Waydroid is **not a physical
device**. A container does not reproduce Doze, app standby buckets or
OEM process killing, which are exactly what a background-survival claim
rests on. Its report carries `physicalPowerReadings: false` and
`physicalThermalReadings: false` so it cannot be mistaken for one.

Beyond that, the run could not exercise R3 at all. Installing a build
containing it requires an Android APK, and the APK build fails in
`aurora-voice-sherpa-sys` for want of the sherpa-onnx CI artifact
(`AURORA_SHERPA_ONNX_ANDROID_ARM64_V8A_LIB_DIR`), which is not present in
this environment. The package installed on the device predates R3. So the
report is a harness and shape check against a pre-R3 build, and both R3
dimensions correctly report `no_signal_observed`.

**R3's acceptance criterion -- an adb-driven background soak on the
physical device -- is therefore unverified.** It needs the sherpa
artifact to build an APK, and real hardware to run it on.

## What still needs a physical device

R3's own acceptance requires an adb-driven background soak on the physical
device. R5 supplies the harness for that run; it does not substitute for it.
Battery and thermal numbers for R6 must come from a `deviceClass: "physical"`
report. A Waydroid report is a shape and memory/survival check only — its
`physicalPowerReadings` and `physicalThermalReadings` flags are `false` precisely
so a reader cannot mistake it for one.

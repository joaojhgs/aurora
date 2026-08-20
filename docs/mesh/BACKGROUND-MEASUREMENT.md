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

## What is not measurable until R3 lands

R3 (background tool serving) is milestone M6 and does not exist yet. Two
dimensions depend on it, and both are wired to real probes that start producing
data the moment it lands rather than being stubbed out:

- **`deviceLinkSurvival`** reads the decoded foreground service types for
  `connectedDevice`. Nothing holds that reason yet — R4 added
  `AuroraRuntimeForegroundService.holdDeviceLink` and R3 is its first caller — so
  it reports `not_yet_available` with `blockedBy: "R3"`. As soon as a background
  session holds a device connection, the same probe times how long it survives.
- **`backgroundToolCalls`** counts log lines matching
  `/RustStdoutStderr.*\bbackground[ _-]?tool[ _-]?call\b/i` over the window,
  with the log cleared at the start so the count is exact. R3 serves tool calls
  from Rust, which reaches Android's log under `RustStdoutStderr`; until it emits
  a line the count stays zero and the dimension says why.

A scenario with `peerCount > 0` is likewise recorded as `not_yet_available`
rather than sampled, because the phone cannot hold a connection to another
device yet and the harness will not label a scenario with a device count it did
not establish.

## What still needs a physical device

R3's own acceptance requires an adb-driven background soak on the physical
device. R5 supplies the harness for that run; it does not substitute for it.
Battery and thermal numbers for R6 must come from a `deviceClass: "physical"`
report. A Waydroid report is a shape and memory/survival check only — its
`physicalPowerReadings` and `physicalThermalReadings` flags are `false` precisely
so a reader cannot mistake it for one.

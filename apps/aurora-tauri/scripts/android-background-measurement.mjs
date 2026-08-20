#!/usr/bin/env node
// Android background measurement harness (R5).
//
// Drives adb to sample battery, memory, thermal state and survival time for the
// Aurora Android app across lifecycle states and device-connection counts, and
// writes one JSON report in the format documented in
// docs/mesh/BACKGROUND-MEASUREMENT.md.
//
// Every dimension carries its own availability. A dimension that cannot be
// measured on this device, or that depends on work that has not landed yet,
// reports `status: "not_yet_available"` with the probe result that says so. The
// harness never substitutes an estimate for a measurement.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { resolveAndroidDeviceSerial } from './android-voice-live-smoke.mjs'

const DEFAULT_APP_ID = 'dev.aurora.desktop'
const RUNTIME_SERVICE = 'dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService'
const COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_DURATION_S = 300
const DEFAULT_SAMPLE_INTERVAL_S = 30
const DEFAULT_OUT = '/tmp/aurora-android-background-measurement.json'
const REPORT_FORMAT_VERSION = 1

/**
 * Foreground service type bits. `dumpsys activity services` prints the mask as
 * `types=%08X`, so the harness decodes it rather than depending on a textual
 * field that only some Android versions print.
 */
export const FOREGROUND_SERVICE_TYPE_BITS = Object.freeze({
  dataSync: 1,
  mediaPlayback: 2,
  phoneCall: 4,
  location: 8,
  connectedDevice: 16,
  mediaProjection: 32,
  camera: 64,
  microphone: 128,
  health: 256,
  remoteMessaging: 512,
  systemExempted: 1024,
  shortService: 2048,
  fileManagement: 4096,
  mediaProcessing: 8192,
  specialUse: 1073741824,
})

/**
 * A background tool call served while the webview is frozen is R3's work, and
 * R3 runs in Rust, which reaches Android's log under `RustStdoutStderr`. The
 * harness counts those lines over the sampling window. Until R3 emits them the
 * count stays zero and the dimension reports why.
 */
export const BACKGROUND_TOOL_CALL_MARKER = /RustStdoutStderr.*\bbackground[ _-]?tool[ _-]?call\b/iu

export function parseMeminfoTotalPssKb(output) {
  const text = String(output ?? '')
  const summary = text.match(/^\s*TOTAL PSS:\s+(\d+)/mu)
  if (summary) return Number(summary[1])
  const table = text.match(/^\s*TOTAL\s+(\d+)/mu)
  return table ? Number(table[1]) : null
}

export function parseBatteryState(output) {
  const text = String(output ?? '')
  const num = (label) => {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(-?\\d+)\\s*$`, 'mu'))
    return match ? Number(match[1]) : null
  }
  const bool = (label) => {
    const match = text.match(new RegExp(`^\\s*${label}:\\s*(true|false)\\s*$`, 'mu'))
    return match ? match[1] === 'true' : null
  }
  return {
    levelPercent: num('level'),
    scale: num('scale'),
    chargeCounterMicroAh: num('Charge counter'),
    voltageMilliV: num('voltage'),
    temperatureDeciCelsius: num('temperature'),
    acPowered: bool('AC powered'),
    usbPowered: bool('USB powered'),
  }
}

export function parseThermalState(output) {
  const text = String(output ?? '')
  const halReady = /^\s*HAL Ready:\s*true\s*$/mu.test(text)
  const statusMatch = text.match(/^\s*Thermal Status:\s*(-?\d+)\s*$/mu)
  const temperatures = []
  for (const match of text.matchAll(/Temperature\{mValue=(-?[\d.]+),\s*mType=(\d+),\s*mName=([^,}]+)/gu)) {
    temperatures.push({ name: match[3].trim(), type: Number(match[2]), celsius: Number(match[1]) })
  }
  return {
    halReady,
    status: statusMatch ? Number(statusMatch[1]) : null,
    temperatures,
  }
}

export function decodeForegroundServiceTypes(mask) {
  const value = Number(mask)
  if (!Number.isFinite(value) || value <= 0) return []
  return Object.entries(FOREGROUND_SERVICE_TYPE_BITS)
    .filter(([, bit]) => (value & bit) === bit)
    .map(([name]) => name)
}

/**
 * Reads the Aurora runtime foreground service out of `dumpsys activity
 * services`. The active foreground types are the live R4 signal for which
 * reasons are holding the one service.
 */
export function parseRuntimeServiceState(output, serviceClass = RUNTIME_SERVICE) {
  const text = String(output ?? '')
  const shortName = serviceClass.slice(serviceClass.lastIndexOf('.') + 1)
  const recordStart = text.search(new RegExp(`ServiceRecord\\{[^}]*(?:${escapeRegExp(serviceClass)}|${escapeRegExp(shortName)})`, 'u'))
  if (recordStart < 0) {
    return { present: false, isForeground: false, foregroundServiceTypes: [], foregroundServiceTypeMask: 0 }
  }
  const nextRecord = text.indexOf('ServiceRecord{', recordStart + 1)
  const record = text.slice(recordStart, nextRecord < 0 ? text.length : nextRecord)
  const foregroundMatch = record.match(/isForeground=(true|false)/u)
  const maskMatch = record.match(/\btypes=([0-9A-Fa-f]+)/u)
  const mask = maskMatch ? Number.parseInt(maskMatch[1], 16) : 0
  const textualTypes = record.match(/foregroundServiceType=([A-Za-z|]+)/u)
  const types = mask > 0
    ? decodeForegroundServiceTypes(mask)
    : (textualTypes ? textualTypes[1].split('|').filter(Boolean) : [])
  return {
    present: true,
    isForeground: foregroundMatch ? foregroundMatch[1] === 'true' : false,
    foregroundServiceTypes: types,
    foregroundServiceTypeMask: mask,
  }
}

export function countBackgroundToolCalls(logcat) {
  return String(logcat ?? '')
    .split(/\r?\n/u)
    .filter((line) => BACKGROUND_TOOL_CALL_MARKER.test(line))
    .length
}

/**
 * Names the device class and says plainly which readings are physical. Waydroid
 * and QEMU both synthesise the battery and expose no thermal HAL, so their
 * power and temperature numbers must never be read as device figures.
 */
export function classifyAndroidDevice(props) {
  const device = String(props?.['ro.product.device'] ?? '')
  const qemu = String(props?.['ro.kernel.qemu'] ?? props?.['ro.boot.qemu'] ?? '') === '1'
  const model = String(props?.['ro.product.model'] ?? '')
  if (/waydroid/iu.test(device) || /waydroid/iu.test(model)) {
    return {
      deviceClass: 'waydroid-container',
      physicalPowerReadings: false,
      physicalThermalReadings: false,
      caveats: [
        'Waydroid runs Android in a container on the host kernel; its battery level, charge counter and battery temperature are synthesised by the host and are not device measurements.',
        'Waydroid exposes no thermal HAL, so no temperature sensor is available.',
        'Memory and survival figures are real for this container but reflect x86_64 host performance, not phone hardware.',
      ],
    }
  }
  if (qemu || /sdk_|emulator|generic/iu.test(device)) {
    return {
      deviceClass: 'qemu-emulator',
      physicalPowerReadings: false,
      physicalThermalReadings: false,
      caveats: [
        'The QEMU emulator synthesises battery state and usually exposes no thermal HAL; its power and temperature readings are not device measurements.',
      ],
    }
  }
  return {
    deviceClass: 'physical',
    physicalPowerReadings: true,
    physicalThermalReadings: true,
    caveats: [],
  }
}

/**
 * Turns a scenario's samples into the per-dimension result. Each dimension
 * states its own status so a reader never has to guess whether a zero is a
 * measurement or a gap.
 */
export function summariseScenario(scenario, deviceClass) {
  const samples = scenario.samples ?? []
  const first = samples[0]
  const last = samples[samples.length - 1]
  const memoryValues = samples.map((sample) => sample.memoryTotalPssKb).filter((value) => typeof value === 'number')
  const batteryLevels = samples.map((sample) => sample.battery?.levelPercent).filter((value) => typeof value === 'number')
  const thermalSeen = samples.some((sample) => (sample.thermal?.temperatures?.length ?? 0) > 0)
  const survivedTo = [...samples].reverse().find((sample) => sample.processAlive)
  const died = samples.find((sample) => !sample.processAlive)

  const memory = memoryValues.length > 0
    ? {
      status: 'measured',
      unit: 'KiB total PSS',
      first: memoryValues[0],
      last: memoryValues[memoryValues.length - 1],
      peak: Math.max(...memoryValues),
      deltaKb: memoryValues[memoryValues.length - 1] - memoryValues[0],
      samples: memoryValues.length,
    }
    : { status: 'not_available', reason: 'the app process reported no memory while this scenario ran' }

  const battery = batteryLevels.length > 0
    ? {
      status: deviceClass.physicalPowerReadings ? 'measured' : 'measured_non_physical',
      unit: 'percent',
      first: batteryLevels[0],
      last: batteryLevels[batteryLevels.length - 1],
      deltaPercent: batteryLevels[batteryLevels.length - 1] - batteryLevels[0],
      chargeCounterDeltaMicroAh: numericDelta(first?.battery?.chargeCounterMicroAh, last?.battery?.chargeCounterMicroAh),
      physical: deviceClass.physicalPowerReadings,
      note: deviceClass.physicalPowerReadings
        ? undefined
        : 'Synthesised by the host; not a device power measurement.',
    }
    : { status: 'not_available', reason: 'the battery service reported no level' }

  const thermal = thermalSeen
    ? {
      status: deviceClass.physicalThermalReadings ? 'measured' : 'measured_non_physical',
      unit: 'celsius',
      readings: last?.thermal?.temperatures ?? [],
      physical: deviceClass.physicalThermalReadings,
    }
    : {
      status: 'not_available',
      reason: last?.thermal?.halReady === false
        ? 'no thermal HAL on this device class'
        : 'the thermal service reported no sensors',
    }

  const survival = {
    status: samples.length > 0 ? 'measured' : 'not_available',
    lastAliveSeconds: survivedTo ? survivedTo.elapsedSeconds : null,
    diedAtSeconds: died ? died.elapsedSeconds : null,
    survivedWholeWindow: samples.length > 0 && !died,
    windowSeconds: scenario.durationSeconds,
  }

  const deviceLinkHeld = samples.some((sample) => (sample.service?.foregroundServiceTypes ?? []).includes('connectedDevice'))
  const deviceLinkSurvival = deviceLinkHeld
    ? {
      status: 'measured',
      lastHeldSeconds: [...samples].reverse().find(
        (sample) => (sample.service?.foregroundServiceTypes ?? []).includes('connectedDevice'),
      )?.elapsedSeconds ?? null,
    }
    : {
      status: 'not_yet_available',
      blockedBy: 'R3',
      reason: 'no connected-device foreground reason was held while this scenario ran, so there is no device connection whose survival could be timed',
      probe: 'dumpsys activity services -> ServiceRecord types mask, decoded for connectedDevice',
    }

  const toolCallsObserved = scenario.backgroundToolCallsObserved ?? 0
  const backgroundToolCalls = toolCallsObserved > 0
    ? { status: 'measured', observed: toolCallsObserved }
    : {
      status: 'not_yet_available',
      blockedBy: 'R3',
      observed: 0,
      reason: 'background tool serving is not implemented yet, so no served call reached the log during this window',
      probe: `logcat lines matching ${BACKGROUND_TOOL_CALL_MARKER}`,
    }

  return { memory, battery, thermal, survival, deviceLinkSurvival, backgroundToolCalls }
}

function numericDelta(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number') return null
  return to - from
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function parseArgs(argv) {
  const args = {
    appId: DEFAULT_APP_ID,
    serial: undefined,
    durationSeconds: DEFAULT_DURATION_S,
    sampleIntervalSeconds: DEFAULT_SAMPLE_INTERVAL_S,
    peerCounts: [0],
    lifecycles: ['foreground', 'background'],
    out: DEFAULT_OUT,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${token} needs a value`)
      index += 1
      return next
    }
    switch (token) {
      case '--app-id': args.appId = value(); break
      case '--serial': args.serial = value(); break
      case '--duration': args.durationSeconds = Number(value()); break
      case '--sample-interval': args.sampleIntervalSeconds = Number(value()); break
      case '--peer-counts': args.peerCounts = value().split(',').map((item) => Number(item.trim())); break
      case '--lifecycles': args.lifecycles = value().split(',').map((item) => item.trim()); break
      case '--out': args.out = value(); break
      default: throw new Error(`Unknown option: ${token}`)
    }
  }
  if (!Number.isFinite(args.durationSeconds) || args.durationSeconds <= 0) {
    throw new Error('--duration must be a positive number of seconds')
  }
  if (!Number.isFinite(args.sampleIntervalSeconds) || args.sampleIntervalSeconds <= 0) {
    throw new Error('--sample-interval must be a positive number of seconds')
  }
  if (args.peerCounts.some((count) => !Number.isInteger(count) || count < 0)) {
    throw new Error('--peer-counts must be a comma-separated list of non-negative integers')
  }
  for (const lifecycle of args.lifecycles) {
    if (lifecycle !== 'foreground' && lifecycle !== 'background') {
      throw new Error(`--lifecycles accepts foreground and background, got ${lifecycle}`)
    }
  }
  return args
}

function adbOutput(serial, adbArgs, { allowFailure = true } = {}) {
  const result = spawnSync('adb', ['-s', serial, ...adbArgs], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  })
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`adb ${adbArgs.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function readProps(serial) {
  const raw = adbOutput(serial, ['shell', 'getprop'])
  const props = {}
  for (const match of raw.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]$/gmu)) {
    props[match[1]] = match[2]
  }
  return props
}

function sleep(ms) {
  return new Promise((done) => { setTimeout(done, ms) })
}

function sampleOnce(serial, appId, elapsedSeconds) {
  const pid = adbOutput(serial, ['shell', 'pidof', appId]).trim()
  const processAlive = /^\d+$/u.test(pid)
  const meminfo = processAlive ? adbOutput(serial, ['shell', 'dumpsys', 'meminfo', appId]) : ''
  return {
    elapsedSeconds,
    processAlive,
    pid: processAlive ? Number(pid) : null,
    memoryTotalPssKb: processAlive ? parseMeminfoTotalPssKb(meminfo) : null,
    battery: parseBatteryState(adbOutput(serial, ['shell', 'dumpsys', 'battery'])),
    thermal: parseThermalState(adbOutput(serial, ['shell', 'dumpsys', 'thermalservice'])),
    service: parseRuntimeServiceState(adbOutput(serial, ['shell', 'dumpsys', 'activity', 'services', appId])),
  }
}

function enterLifecycle(serial, appId, lifecycle) {
  if (lifecycle === 'foreground') {
    adbOutput(serial, ['shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1'])
    return
  }
  adbOutput(serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
}

async function runScenario(serial, appId, { peerCount, lifecycle, durationSeconds, sampleIntervalSeconds }) {
  if (peerCount > 0) {
    // Nothing can hold a device connection on the phone until R3 lands, so a
    // scenario asking for one is recorded as unreachable rather than sampled
    // with a peer count the harness did not actually establish.
    return {
      peerCount,
      lifecycle,
      durationSeconds,
      status: 'not_yet_available',
      blockedBy: 'R3',
      reason: 'the phone cannot hold a connection to another device yet, so a scenario with a non-zero device count cannot be established',
      samples: [],
    }
  }
  // Clearing the log at the start of the window makes the tool-call count an
  // exact measurement over this scenario rather than a sample that could
  // double-count lines already read.
  adbOutput(serial, ['logcat', '-c'])
  enterLifecycle(serial, appId, lifecycle)
  const samples = []
  const started = Date.now()
  let elapsed = 0
  for (;;) {
    samples.push(sampleOnce(serial, appId, elapsed))
    elapsed = Math.round((Date.now() - started) / 1000)
    const remaining = Math.min(sampleIntervalSeconds, durationSeconds - elapsed)
    if (remaining <= 0) break
    await sleep(remaining * 1000)
    elapsed = Math.round((Date.now() - started) / 1000)
  }
  const backgroundToolCallsObserved = countBackgroundToolCalls(adbOutput(serial, ['logcat', '-d']))
  return {
    peerCount,
    lifecycle,
    durationSeconds,
    status: 'measured',
    samples,
    backgroundToolCallsObserved,
  }
}

export function buildReport({ device, appId, args, scenarios }) {
  const deviceClass = device.classification
  return {
    formatVersion: REPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    harness: 'apps/aurora-tauri/scripts/android-background-measurement.mjs',
    workstream: 'R5',
    appId,
    device: {
      serial: device.serial,
      deviceClass: deviceClass.deviceClass,
      model: device.props['ro.product.model'] ?? null,
      product: device.props['ro.product.device'] ?? null,
      abi: device.props['ro.product.cpu.abi'] ?? null,
      sdkInt: Number(device.props['ro.build.version.sdk'] ?? 0) || null,
      physicalPowerReadings: deviceClass.physicalPowerReadings,
      physicalThermalReadings: deviceClass.physicalThermalReadings,
    },
    caveats: deviceClass.caveats,
    settings: {
      durationSeconds: args.durationSeconds,
      sampleIntervalSeconds: args.sampleIntervalSeconds,
      peerCounts: args.peerCounts,
      lifecycles: args.lifecycles,
    },
    scenarios: scenarios.map((scenario) => ({
      peerCount: scenario.peerCount,
      lifecycle: scenario.lifecycle,
      status: scenario.status,
      blockedBy: scenario.blockedBy,
      reason: scenario.reason,
      durationSeconds: scenario.durationSeconds,
      sampleCount: scenario.samples.length,
      dimensions: scenario.status === 'measured'
        ? summariseScenario(scenario, deviceClass)
        : null,
      samples: scenario.samples,
    })),
  }
}

export function summariseReportForConsole(report) {
  const lines = [
    `device: ${report.device.serial} (${report.device.deviceClass}, ${report.device.abi}, sdk ${report.device.sdkInt})`,
  ]
  for (const caveat of report.caveats) lines.push(`caveat: ${caveat}`)
  for (const scenario of report.scenarios) {
    if (scenario.status !== 'measured') {
      lines.push(`${scenario.lifecycle}/${scenario.peerCount} devices: ${scenario.status} (${scenario.blockedBy}) - ${scenario.reason}`)
      continue
    }
    const dims = scenario.dimensions
    const memory = dims.memory.status === 'measured'
      ? `memory ${dims.memory.first}->${dims.memory.last} KiB (peak ${dims.memory.peak})`
      : `memory ${dims.memory.status}`
    const battery = dims.battery.status.startsWith('measured')
      ? `battery ${dims.battery.first}%->${dims.battery.last}%${dims.battery.physical ? '' : ' (non-physical)'}`
      : `battery ${dims.battery.status}`
    const thermal = dims.thermal.status.startsWith('measured')
      ? `thermal ${dims.thermal.readings.length} sensors`
      : `thermal ${dims.thermal.status}`
    const survival = dims.survival.survivedWholeWindow
      ? `survived ${scenario.durationSeconds}s`
      : `died at ${dims.survival.diedAtSeconds}s`
    lines.push(`${scenario.lifecycle}/${scenario.peerCount} devices: ${memory}, ${battery}, ${thermal}, ${survival}`)
    lines.push(`  device-connection survival: ${dims.deviceLinkSurvival.status}`)
    lines.push(`  background tool calls: ${dims.backgroundToolCalls.status} (observed ${dims.backgroundToolCalls.observed ?? 0})`)
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const devicesOutput = execFileSync('adb', ['devices', '-l'], { encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS })
  const serial = resolveAndroidDeviceSerial(devicesOutput, args.serial)
  const props = readProps(serial)
  const classification = classifyAndroidDevice(props)

  const installed = adbOutput(serial, ['shell', 'pm', 'list', 'packages', args.appId]).includes(args.appId)
  if (!installed) {
    throw new Error(`${args.appId} is not installed on ${serial}; install it before measuring.`)
  }

  const scenarios = []
  for (const peerCount of args.peerCounts) {
    for (const lifecycle of args.lifecycles) {
      scenarios.push(await runScenario(serial, args.appId, {
        peerCount,
        lifecycle,
        durationSeconds: args.durationSeconds,
        sampleIntervalSeconds: args.sampleIntervalSeconds,
      }))
    }
  }

  const report = buildReport({
    device: { serial, props, classification },
    appId: args.appId,
    args,
    scenarios,
  })
  const out = resolve(args.out)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${summariseReportForConsole(report)}\n`)
  process.stdout.write(`report: ${out}\n`)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exitCode = 1
  })
}

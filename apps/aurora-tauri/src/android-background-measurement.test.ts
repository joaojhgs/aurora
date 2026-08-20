import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error The Node-executed .mjs harness intentionally has no TS build output.
import { BACKGROUND_TOOL_CALL_MARKER, buildReport, classifyAndroidDevice, countBackgroundToolCalls, decodeForegroundServiceTypes, parseArgs, parseBatteryState, parseMeminfoTotalPssKb, parseRuntimeServiceState, parseThermalState, summariseReportForConsole, summariseScenario } from '../scripts/android-background-measurement.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

// Captured from the Waydroid target (waydroid_x86_64, SDK 33) this harness
// selects by default.
const MEMINFO = `Applications Memory Usage (in Kilobytes):
Uptime: 626198896 Realtime: 626198896

** MEMINFO in pid 39322 [dev.aurora.desktop] **
                   Pss  Private  Private  SwapPss      Rss
                 Total    Dirty    Clean    Dirty    Total
  Native Heap   254416   244312        4      228   257308
        TOTAL   344984   319036    16176      302   405384

 App Summary
                       Pss(KB)                        Rss(KB)
           Java Heap:    30288                          52308

           TOTAL PSS:   344984            TOTAL RSS:   405384       TOTAL SWAP PSS:      302
`

const BATTERY = `Current Battery Service state:
  AC powered: true
  USB powered: true
  Wireless powered: false
  Charge counter: 1900000
  status: 2
  health: 2
  present: true
  level: 85
  scale: 100
  voltage: 3600
  temperature: 350
  technology: Li-ion
`

const THERMAL_WAYDROID = `IsStatusOverride: false
ThermalEventListeners:
	callbacks: 2
Thermal Status: 0
Cached temperatures:
HAL Ready: false
`

const THERMAL_PHYSICAL = `IsStatusOverride: false
Thermal Status: 1
Cached temperatures:
	Temperature{mValue=41.2, mType=3, mName=battery, mStatus=0}
	Temperature{mValue=38.9, mType=0, mName=cpu, mStatus=0}
HAL Ready: true
`

function serviceDump(typesHex: string, isForeground = true): string {
  return `ACTIVITY MANAGER SERVICES (dumpsys activity services)
  User 0 active services:
  * ServiceRecord{6ee1cb4 u0 dev.aurora.desktop/org.chromium.content.app.SandboxedProcessService0:0}
    packageName=dev.aurora.desktop
  * ServiceRecord{1a2b3c4 u0 dev.aurora.desktop/dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService}
    intent={cmp=dev.aurora.desktop/dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService}
    packageName=dev.aurora.desktop
    isForeground=${isForeground} foregroundId=4203 types=${typesHex} foregroundNoti=Notification(channel=aurora_voice_capture)
    createTime=-1m2s
`
}

function sample(overrides: Record<string, unknown> = {}) {
  return {
    elapsedSeconds: 0,
    processAlive: true,
    pid: 39322,
    memoryTotalPssKb: 344984,
    battery: parseBatteryState(BATTERY),
    thermal: parseThermalState(THERMAL_WAYDROID),
    service: parseRuntimeServiceState(serviceDump('00000080')),
    ...overrides,
  }
}

describe('android background measurement parsers', () => {
  it('reads total PSS from the App Summary rather than the table row', () => {
    expect(parseMeminfoTotalPssKb(MEMINFO)).toBe(344984)
    expect(parseMeminfoTotalPssKb('')).toBeNull()
  })

  it('reads the battery service state', () => {
    expect(parseBatteryState(BATTERY)).toMatchObject({
      levelPercent: 85,
      scale: 100,
      chargeCounterMicroAh: 1900000,
      voltageMilliV: 3600,
      temperatureDeciCelsius: 350,
      acPowered: true,
    })
  })

  it('distinguishes a missing thermal HAL from real sensors', () => {
    const waydroid = parseThermalState(THERMAL_WAYDROID)
    expect(waydroid.halReady).toBe(false)
    expect(waydroid.temperatures).toEqual([])

    const physical = parseThermalState(THERMAL_PHYSICAL)
    expect(physical.halReady).toBe(true)
    expect(physical.temperatures).toEqual([
      { name: 'battery', type: 3, celsius: 41.2 },
      { name: 'cpu', type: 0, celsius: 38.9 },
    ])
  })

  it('decodes the foreground service type mask that dumpsys prints', () => {
    expect(decodeForegroundServiceTypes(0x80)).toEqual(['microphone'])
    expect(decodeForegroundServiceTypes(0x10)).toEqual(['connectedDevice'])
    expect(decodeForegroundServiceTypes(0x90)).toEqual(['connectedDevice', 'microphone'])
    expect(decodeForegroundServiceTypes(0)).toEqual([])
  })

  it('finds the Aurora runtime service among the other service records', () => {
    expect(parseRuntimeServiceState(serviceDump('00000090'))).toEqual({
      present: true,
      isForeground: true,
      foregroundServiceTypes: ['connectedDevice', 'microphone'],
      foregroundServiceTypeMask: 0x90,
    })
    expect(parseRuntimeServiceState('ACTIVITY MANAGER SERVICES\n')).toEqual({
      present: false,
      isForeground: false,
      foregroundServiceTypes: [],
      foregroundServiceTypeMask: 0,
    })
  })

  it('counts only background tool-call lines from the Rust log tag', () => {
    const log = [
      '08-20 00:00:01.000  1 1 I RustStdoutStderr: background tool call served id=7',
      '08-20 00:00:02.000  1 1 I RustStdoutStderr: background_tool_call deferred id=8',
      '08-20 00:00:03.000  1 1 I RustStdoutStderr: hello',
      '08-20 00:00:04.000  1 1 I SomethingElse: background tool call',
    ].join('\n')
    expect(countBackgroundToolCalls(log)).toBe(2)
    expect(countBackgroundToolCalls('')).toBe(0)
    expect(BACKGROUND_TOOL_CALL_MARKER.test('RustStdoutStderr: background tool call')).toBe(true)
  })
})

describe('android background measurement device honesty', () => {
  it('labels Waydroid power and thermal readings as not physical', () => {
    const classification = classifyAndroidDevice({
      'ro.product.device': 'waydroid_x86_64',
      'ro.product.model': 'WayDroid_x86_64_Device',
    })
    expect(classification.deviceClass).toBe('waydroid-container')
    expect(classification.physicalPowerReadings).toBe(false)
    expect(classification.physicalThermalReadings).toBe(false)
    expect(classification.caveats.length).toBeGreaterThan(0)
  })

  it('labels the QEMU emulator the same way and a real device as physical', () => {
    expect(classifyAndroidDevice({ 'ro.kernel.qemu': '1', 'ro.product.device': 'emulator64_x86_64' }))
      .toMatchObject({ deviceClass: 'qemu-emulator', physicalPowerReadings: false })
    expect(classifyAndroidDevice({ 'ro.product.device': 'oriole', 'ro.product.model': 'Pixel 6' }))
      .toMatchObject({ deviceClass: 'physical', physicalPowerReadings: true, physicalThermalReadings: true, caveats: [] })
  })
})

describe('android background measurement reporting', () => {
  const waydroid = classifyAndroidDevice({ 'ro.product.device': 'waydroid_x86_64' })

  it('reports measurable dimensions and refuses to invent the rest', () => {
    const scenario = {
      peerCount: 0,
      lifecycle: 'background',
      durationSeconds: 60,
      status: 'measured',
      backgroundToolCallsObserved: 0,
      samples: [
        sample({ elapsedSeconds: 0, memoryTotalPssKb: 300000 }),
        sample({ elapsedSeconds: 30, memoryTotalPssKb: 344984 }),
        sample({ elapsedSeconds: 60, memoryTotalPssKb: 320000 }),
      ],
    }
    const dimensions = summariseScenario(scenario, waydroid)

    expect(dimensions.memory).toMatchObject({ status: 'measured', first: 300000, last: 320000, peak: 344984, deltaKb: 20000 })
    expect(dimensions.survival).toMatchObject({ survivedWholeWindow: true, diedAtSeconds: null, lastAliveSeconds: 60 })
    // Present but synthesised, and it says so.
    expect(dimensions.battery).toMatchObject({ status: 'measured_non_physical', physical: false })
    expect(dimensions.battery.note).toMatch(/not a device power measurement/iu)
    // Absent, and it says so rather than reporting a temperature.
    expect(dimensions.thermal).toMatchObject({ status: 'not_available' })
    expect(dimensions.thermal).not.toHaveProperty('readings')
    // R3 has not landed, so neither of its dimensions may report a number.
    expect(dimensions.deviceLinkSurvival).toMatchObject({ status: 'not_yet_available', blockedBy: 'R3' })
    expect(dimensions.deviceLinkSurvival.probe).toBeTruthy()
    expect(dimensions.backgroundToolCalls).toMatchObject({ status: 'not_yet_available', blockedBy: 'R3', observed: 0 })
  })

  it('starts measuring R3 dimensions the moment the signals appear', () => {
    const scenario = {
      peerCount: 0,
      lifecycle: 'background',
      durationSeconds: 60,
      status: 'measured',
      backgroundToolCallsObserved: 4,
      samples: [
        sample({ elapsedSeconds: 0, service: parseRuntimeServiceState(serviceDump('00000010')) }),
        sample({ elapsedSeconds: 45, service: parseRuntimeServiceState(serviceDump('00000010')) }),
      ],
    }
    const dimensions = summariseScenario(scenario, waydroid)
    expect(dimensions.deviceLinkSurvival).toEqual({ status: 'measured', lastHeldSeconds: 45 })
    expect(dimensions.backgroundToolCalls).toEqual({ status: 'measured', observed: 4 })
  })

  it('records a death rather than rounding it into the window', () => {
    const scenario = {
      peerCount: 0,
      lifecycle: 'background',
      durationSeconds: 120,
      status: 'measured',
      backgroundToolCallsObserved: 0,
      samples: [
        sample({ elapsedSeconds: 0 }),
        sample({ elapsedSeconds: 60 }),
        sample({ elapsedSeconds: 90, processAlive: false, pid: null, memoryTotalPssKb: null }),
      ],
    }
    const dimensions = summariseScenario(scenario, waydroid)
    expect(dimensions.survival).toMatchObject({ survivedWholeWindow: false, diedAtSeconds: 90, lastAliveSeconds: 60 })
  })

  it('carries the device class, caveats and unreachable scenarios into the report', () => {
    const report = buildReport({
      device: {
        serial: '192.168.240.112:5555',
        props: {
          'ro.product.device': 'waydroid_x86_64',
          'ro.product.model': 'WayDroid_x86_64_Device',
          'ro.product.cpu.abi': 'x86_64',
          'ro.build.version.sdk': '33',
        },
        classification: waydroid,
      },
      appId: 'dev.aurora.desktop',
      args: { durationSeconds: 60, sampleIntervalSeconds: 30, peerCounts: [0, 2], lifecycles: ['background'] },
      scenarios: [
        {
          peerCount: 0,
          lifecycle: 'background',
          durationSeconds: 60,
          status: 'measured',
          backgroundToolCallsObserved: 0,
          samples: [sample()],
        },
        {
          peerCount: 2,
          lifecycle: 'background',
          durationSeconds: 60,
          status: 'not_yet_available',
          blockedBy: 'R3',
          reason: 'the phone cannot hold a connection to another device yet',
          samples: [],
        },
      ],
    })

    expect(report.formatVersion).toBe(1)
    expect(report.workstream).toBe('R5')
    expect(report.device).toMatchObject({
      deviceClass: 'waydroid-container',
      abi: 'x86_64',
      sdkInt: 33,
      physicalPowerReadings: false,
      physicalThermalReadings: false,
    })
    expect(report.caveats.length).toBeGreaterThan(0)
    expect(report.scenarios[1]).toMatchObject({ status: 'not_yet_available', blockedBy: 'R3', dimensions: null })

    const console = summariseReportForConsole(report)
    expect(console).toContain('waydroid-container')
    expect(console).toContain('non-physical')
    expect(console).toContain('not_yet_available')
  })
})

describe('android background measurement options', () => {
  it('defaults to the documented settings and validates the rest', () => {
    expect(parseArgs([])).toMatchObject({
      appId: 'dev.aurora.desktop',
      durationSeconds: 300,
      sampleIntervalSeconds: 30,
      peerCounts: [0],
      lifecycles: ['foreground', 'background'],
    })
    expect(parseArgs(['--duration', '60', '--peer-counts', '0,1,2', '--lifecycles', 'background']))
      .toMatchObject({ durationSeconds: 60, peerCounts: [0, 1, 2], lifecycles: ['background'] })
    expect(() => parseArgs(['--duration', '0'])).toThrow(/positive/u)
    expect(() => parseArgs(['--lifecycles', 'doze'])).toThrow(/foreground and background/u)
    expect(() => parseArgs(['--peer-counts', '-1'])).toThrow(/non-negative/u)
  })

  it('selects the Waydroid device by description instead of a hardcoded address', () => {
    const source = readFileSync(
      resolve(repoRoot, 'apps/aurora-tauri/scripts/android-background-measurement.mjs'),
      'utf8',
    )
    expect(source).toContain("import { resolveAndroidDeviceSerial } from './android-voice-live-smoke.mjs'")
    expect(source).toContain("resolveAndroidDeviceSerial(devicesOutput, args.serial)")
    expect(source).toContain("'-s', serial")
    expect(source).not.toMatch(/\b192\.168\.\d+\.\d+\b/u)
    // The harness must never boot a QEMU emulator for this lane.
    expect(source).not.toContain('emulator -avd')
    expect(source).not.toContain('avdmanager')
  })

  it('keeps the documented report format next to the harness', () => {
    const doc = readFileSync(resolve(repoRoot, 'docs/mesh/BACKGROUND-MEASUREMENT.md'), 'utf8')
    expect(doc).toContain('formatVersion')
    for (const dimension of ['memory', 'battery', 'thermal', 'survival', 'deviceLinkSurvival', 'backgroundToolCalls']) {
      expect(doc, dimension).toContain(dimension)
    }
    expect(doc).toContain('not_yet_available')
    expect(doc).toContain('measured_non_physical')
    expect(doc).toContain('apps/aurora-tauri/scripts/android-background-measurement.mjs')
  })
})

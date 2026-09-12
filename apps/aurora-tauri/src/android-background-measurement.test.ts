import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// @ts-expect-error The Node-executed .mjs harness intentionally has no TS build output.
import { BACKGROUND_TOOL_CALL_MARKER, buildReport, classifyAndroidDevice, countBackgroundToolCalls, decodeForegroundServiceTypes, parseArgs, parseBatteryState, parseMeminfoTotalPssKb, parseRuntimeServiceState, parseThermalState, qualificationExitCode, summariseNativeBackgroundProof, summariseReportForConsole, summariseScenario } from '../scripts/android-background-measurement.mjs'

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

function api33ServiceDump(reasons: string, typesHex: string): string {
  return `ACTIVITY MANAGER SERVICES (dumpsys activity service)
  * ServiceRecord{1a2b3c4 u0 dev.aurora.desktop/dev.aurora.tauri.nativeplugin.AuroraRuntimeForegroundService}
    packageName=dev.aurora.desktop
    isForeground=true foregroundId=4203 foregroundNoti=Notification(channel=aurora_voice_capture)
  aurora.runtime.running=true
  aurora.runtime.foregroundReasons=${reasons}
  aurora.runtime.foregroundServiceTypeMask=${typesHex}
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
      foregroundReasons: [],
      foregroundReasonsReported: false,
    })
    expect(parseRuntimeServiceState('ACTIVITY MANAGER SERVICES\n')).toEqual({
      present: false,
      isForeground: false,
      foregroundServiceTypes: [],
      foregroundServiceTypeMask: 0,
      foregroundReasons: [],
      foregroundReasonsReported: false,
    })
  })

  it('reads live semantic reasons when API 33 omits the service type field', () => {
    expect(parseRuntimeServiceState(api33ServiceDump('device_link', '00000010'))).toEqual({
      present: true,
      isForeground: true,
      foregroundServiceTypes: ['connectedDevice'],
      foregroundServiceTypeMask: 0x10,
      foregroundReasons: ['device_link'],
      foregroundReasonsReported: true,
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
    // R3's two dimensions saw no signal in this window, so neither may report
    // a number. Absence is reported as absence, never as a zero that reads
    // like a measurement.
    expect(dimensions.deviceLinkSurvival).toMatchObject({ status: 'not_yet_available', blockedBy: 'no_signal_observed' })
    expect(dimensions.deviceLinkSurvival.probe).toBeTruthy()
    expect(dimensions.backgroundToolCalls).toMatchObject({ status: 'not_yet_available', blockedBy: 'no_signal_observed', observed: 0 })
  })

  it('keeps a Rust marker unqualified until public and native evidence agrees', () => {
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
    expect(dimensions.backgroundToolCalls).toMatchObject({ status: 'observed_unqualified', observed: 4 })
  })

  it('measures a held device link from the service reason on API 33', () => {
    const scenario = {
      peerCount: 0,
      lifecycle: 'background',
      durationSeconds: 60,
      status: 'measured',
      backgroundToolCallsObserved: 1,
      samples: [
        sample({ elapsedSeconds: 0, service: parseRuntimeServiceState(api33ServiceDump('device_link', '00000010')) }),
        sample({ elapsedSeconds: 60, service: parseRuntimeServiceState(api33ServiceDump('device_link', '00000010')) }),
      ],
    }
    expect(summariseScenario(scenario, waydroid).deviceLinkSurvival).toEqual({
      status: 'measured',
      lastHeldSeconds: 60,
    })
  })

  it('does not mistake the API 33 default service type for a held device link', () => {
    const scenario = {
      peerCount: 0,
      lifecycle: 'background',
      durationSeconds: 60,
      status: 'measured',
      backgroundToolCallsObserved: 0,
      samples: [
        sample({ elapsedSeconds: 0, service: parseRuntimeServiceState(api33ServiceDump('', '00000010')) }),
        sample({ elapsedSeconds: 60, service: parseRuntimeServiceState(api33ServiceDump('', '00000010')) }),
      ],
    }

    expect(summariseScenario(scenario, waydroid).deviceLinkSurvival).toMatchObject({
      status: 'not_yet_available',
      blockedBy: 'no_signal_observed',
    })
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
          blockedBy: 'no_peer_driver',
          reason: 'the phone cannot hold a connection to another device yet',
          samples: [],
        },
      ],
    })

    expect(report.formatVersion).toBe(2)
    expect(report.status).toBe('measured')
    expect(report.workstream).toBe('R5')
    expect(report.device).toMatchObject({
      deviceClass: 'waydroid-container',
      abi: 'x86_64',
      sdkInt: 33,
      physicalPowerReadings: false,
      physicalThermalReadings: false,
    })
    expect(report.caveats.length).toBeGreaterThan(0)
    expect(report.scenarios[1]).toMatchObject({ status: 'not_yet_available', blockedBy: 'no_peer_driver', dimensions: null })

    const console = summariseReportForConsole(report)
    expect(console).toContain('waydroid-container')
    expect(console).toContain('non-physical')
    expect(console).toContain('not_yet_available')
  })
})

describe('native background proof qualification', () => {
  const peerId = 'python-gateway-g009'
  const snapshot = (
    servedCalls: number,
    deferredCalls = 0,
    deniedCalls = 0,
    failedCalls = 0,
    connectionId = 17,
  ) => ({
    lifecycle: 'foreground',
    peers: [{ peerId, connectionId, servedCalls, deferredCalls, deniedCalls, failedCalls }],
  })
  const scenario = {
    dimensions: {
      survival: { survivedWholeWindow: true, windowSeconds: 130 },
      deviceLinkSurvival: { status: 'measured', lastHeldSeconds: 130 },
      backgroundToolCalls: { status: 'measured', observed: 1 },
    },
  }
  const gatewayReport = { nativeDeviceToolEvidence: { status: 'passed' } }

  it('passes only when the same Rust peer served the background call', () => {
    expect(summariseNativeBackgroundProof({
      peerId,
      beforeSnapshot: snapshot(3),
      afterSnapshot: snapshot(4),
      scenario,
      gatewayReport,
    })).toMatchObject({
      status: 'passed',
      counters: { markerCount: 1, servedCallsDelta: 1, deferredCallsDelta: 0, deniedCallsDelta: 0, failedCallsDelta: 0 },
    })
  })

  it('rejects gateway payload success when Rust served nothing', () => {
    expect(summariseNativeBackgroundProof({
      peerId,
      beforeSnapshot: snapshot(3),
      afterSnapshot: snapshot(3),
      scenario,
      gatewayReport,
    })).toMatchObject({ status: 'failed', checks: { publicGatewayCallPassed: true, rustServedCall: false } })
  })

  it('rejects a replacement native session and a device link that did not survive the window', () => {
    const droppedLinkScenario = {
      dimensions: {
        ...scenario.dimensions,
        deviceLinkSurvival: { status: 'measured', lastHeldSeconds: 120 },
      },
    }
    expect(summariseNativeBackgroundProof({
      peerId,
      beforeSnapshot: snapshot(3),
      afterSnapshot: snapshot(4, 0, 0, 0, 18),
      scenario: droppedLinkScenario,
      gatewayReport,
    })).toMatchObject({
      status: 'failed',
      checks: { sameNativePeer: false, deviceLinkHeld: false },
    })
  })

  it('rejects missing markers and deferred, denied, or failed calls', () => {
    const missingMarker = {
      dimensions: {
        ...scenario.dimensions,
        backgroundToolCalls: { status: 'not_yet_available', observed: 0 },
      },
    }
    expect(summariseNativeBackgroundProof({
      peerId,
      beforeSnapshot: snapshot(3),
      afterSnapshot: snapshot(4, 1, 1, 1),
      scenario: missingMarker,
      gatewayReport,
    })).toMatchObject({
      status: 'failed',
      checks: {
        backgroundMarkerObserved: false,
        noDeferredCall: false,
        noDeniedCall: false,
        noFailedCall: false,
      },
    })
  })

  it('keeps a marker-present report failed when the public Gateway call failed', () => {
    const waydroid = classifyAndroidDevice({ 'ro.product.device': 'waydroid_x86_64' })
    const report = buildReport({
      device: {
        serial: 'waydroid',
        props: {
          'ro.product.device': 'waydroid_x86_64',
          'ro.product.cpu.abi': 'x86_64',
          'ro.build.version.sdk': '33',
        },
        classification: waydroid,
      },
      appId: 'dev.aurora.desktop',
      args: { durationSeconds: 130, sampleIntervalSeconds: 10, peerCounts: [1], lifecycles: ['background'] },
      scenarios: [{
        peerCount: 1,
        lifecycle: 'background',
        durationSeconds: 130,
        status: 'measured',
        backgroundToolCallsObserved: 1,
        samples: [
          sample({ elapsedSeconds: 0, service: parseRuntimeServiceState(api33ServiceDump('device_link', '00000010')) }),
          sample({ elapsedSeconds: 130, service: parseRuntimeServiceState(api33ServiceDump('device_link', '00000010')) }),
        ],
        nativeBackgroundEvidence: {
          peerId,
          beforeSnapshot: snapshot(3),
          afterSnapshot: snapshot(4),
          gatewayReport: { nativeDeviceToolEvidence: { status: 'failed' } },
        },
      }],
    })

    expect(report.status).toBe('failed')
    expect(report.scenarios[0].nativeBackgroundProof).toMatchObject({
      status: 'failed',
      checks: { publicGatewayCallPassed: false, rustServedCall: true },
    })
    expect(report.scenarios[0].dimensions.backgroundToolCalls).toMatchObject({
      status: 'not_qualified',
      blockedBy: 'native_background_proof_failed',
      observed: 1,
    })
    expect(summariseReportForConsole(report)).toContain('native background proof: failed')
    expect(qualificationExitCode(report)).toBe(1)
  })

  it('keeps measured and qualified reports successful for automation', () => {
    expect(qualificationExitCode({ status: 'measured' })).toBe(0)
    expect(qualificationExitCode({ status: 'passed' })).toBe(0)
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
    expect(parseArgs([
      '--peer-counts', '1',
      '--lifecycles', 'background',
      '--native-peer-id', 'peer-a',
      '--native-before-snapshot', 'before.json',
      '--native-after-snapshot', 'after.json',
      '--gateway-report', 'gateway.json',
    ])).toMatchObject({ nativePeerId: 'peer-a', nativeBeforeSnapshot: 'before.json' })
    expect(() => parseArgs(['--duration', '0'])).toThrow(/positive/u)
    expect(() => parseArgs(['--lifecycles', 'doze'])).toThrow(/foreground and background/u)
    expect(() => parseArgs(['--peer-counts', '-1'])).toThrow(/non-negative/u)
    expect(() => parseArgs(['--native-peer-id', 'peer-a'])).toThrow(/requires/u)
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

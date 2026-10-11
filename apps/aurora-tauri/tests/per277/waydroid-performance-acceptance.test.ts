import { describe, expect, it } from 'vitest'

import {
  buildWaydroidPerformanceReport,
  calculateFrameMetrics,
  calculateUsedScriptBytes,
  isInteractiveDocumentState,
  mergeCoverageRanges,
  parseAdbDevices,
  resolveAndroidDeviceSerial,
  sanitizeTraceEvents,
  stopFrameSampler,
} from '../../scripts/per277-waydroid-performance-acceptance.mjs'

describe('PER-277 Waydroid performance acceptance helpers', () => {
  it('selects the single Waydroid device from adb devices -l output', () => {
    const output = `List of devices attached\nemulator-5554 device product:sdk_gphone_x86 model:sdk_gphone device:generic\n192.168.240.112:5555 device product:waydroid_x86_64 model:WayDroid device:waydroid\n`

    expect(resolveAndroidDeviceSerial(output)).toBe('192.168.240.112:5555')
  })

  it('requires an explicit serial when no Waydroid line is present', () => {
    const output = `List of devices attached\nemulator-5554 device product:sdk_gphone_x86 model:sdk_gphone device:generic\n`

    expect(() => resolveAndroidDeviceSerial(output)).toThrow(/No Waydroid device/u)
    expect(resolveAndroidDeviceSerial(output, 'emulator-5554')).toBe('emulator-5554')
  })

  it('computes frame metrics from requestAnimationFrame deltas', () => {
    const metrics = calculateFrameMetrics([
      { deltaMs: 16.6 },
      { deltaMs: 16.7 },
      { deltaMs: 50.1 },
      { deltaMs: 20 },
    ], 100)

    expect(metrics.frames).toBe(4)
    expect(metrics.averageFps).toBe(40)
    expect(metrics.droppedFrameCount).toBe(1)
    expect(metrics.maxFrameDeltaMs).toBe(50.1)
  })

  it('merges overlapping precise-coverage ranges before counting used script bytes', () => {
    const ranges = mergeCoverageRanges([
      { startOffset: 0, endOffset: 10 },
      { startOffset: 4, endOffset: 12 },
      { startOffset: 20, endOffset: 25 },
      { startOffset: 24, endOffset: 30 },
    ])

    expect(ranges).toEqual([
      { startOffset: 0, endOffset: 12 },
      { startOffset: 20, endOffset: 30 },
    ])
  })

  it('counts used script bytes from positive coverage counts without double-counting overlaps', () => {
    const source = 'const café = 1;\nconsole.log(café);'
    const functions = [{ ranges: [
      { startOffset: 0, endOffset: 10, count: 1 },
      { startOffset: 6, endOffset: 15, count: 1 },
    ] }]

    expect(calculateUsedScriptBytes(source, functions)).toBe(new TextEncoder().encode(source.slice(0, 15)).byteLength)
  })

  it('uses the innermost precise-coverage count for nested zero and positive ranges', () => {
    const source = 'abcdefghijklmnopqrst'
    const functions = [{ ranges: [
      { startOffset: 0, endOffset: 20, count: 0 },
      { startOffset: 5, endOffset: 10, count: 1 },
      { startOffset: 12, endOffset: 16, count: 2 },
    ] }]

    expect(calculateUsedScriptBytes(source, functions)).toBe(new TextEncoder().encode(`${source.slice(5, 10)}${source.slice(12, 16)}`).byteLength)
  })

  it('treats nested zero-count ranges inside used ranges as unused', () => {
    const source = 'abcdefghijklmnopqrst'
    const functions = [{ ranges: [
      { startOffset: 0, endOffset: 20, count: 1 },
      { startOffset: 5, endOffset: 10, count: 0 },
      { startOffset: 12, endOffset: 16, count: 1 },
    ] }]

    expect(calculateUsedScriptBytes(source, functions)).toBe(new TextEncoder().encode(`${source.slice(0, 5)}${source.slice(10, 20)}`).byteLength)
  })

  it('counts equal-span overlapping function ranges as used when any innermost range is positive', () => {
    const source = 'abcdefghijklmnopqrst'
    const functions = [
      { ranges: [{ startOffset: 2, endOffset: 12, count: 0 }] },
      { ranges: [{ startOffset: 2, endOffset: 12, count: 3 }] },
    ]

    expect(calculateUsedScriptBytes(source, functions)).toBe(new TextEncoder().encode(source.slice(2, 12)).byteLength)
  })

  it('uses the WebView sampling duration rather than CDP round-trip time for FPS', async () => {
    const capture = {
      samples: Array.from({ length: 60 }, () => ({ deltaMs: 1000 / 60 })),
      durationMs: 1000,
    }
    const client = {
      async send(method: string, options: { expression: string }) {
        expect(method).toBe('Runtime.evaluate')
        expect(options.expression).toContain('performance.now()')
        expect(options.expression).toContain('__PER277_FRAME_SAMPLER_STARTED_AT__')
        return { result: { result: { value: JSON.stringify(capture) } } }
      },
    }

    const measured = await stopFrameSampler(client)
    const metrics = calculateFrameMetrics(measured.samples, measured.durationMs)
    expect(metrics.averageFps).toBe(60)
    expect(measured.durationMs).toBe(1000)
  })

  it('keeps performance budgets explicit and reports failures instead of inventing pass evidence', () => {
    const report = buildWaydroidPerformanceReport({
      appId: 'dev.aurora.desktop',
      device: {
        serial: 'waydroid-1',
        deviceClass: 'waydroid',
        adbLine: 'waydroid-1 device model:WayDroid',
        release: '13',
        sdk: '33',
        abi: 'x86_64',
        webviewSummary: 'redacted',
      },
      launch: { hostLaunchCommandMs: 100, amStartTotalTimeMs: 80, amStartWaitTimeMs: 90, raw: '' },
      observations: [{
        routeId: 'mesh',
        href: '/mesh',
        phase: 'navigation',
        interactive: true,
        interactiveMs: 900,
        document: { pathname: '/mesh' },
        frameMetrics: { frames: 20, averageFps: 20, droppedFrameCount: 2, maxFrameDeltaMs: 80, p95FrameDeltaMs: 80 },
        navigation: { ok: true, mode: 'visible-link-click' },
      }],
      budgets: { minimumNavFps: 55, maximumRouteInteractiveMs: 500 },
      expectedRoutes: [{ id: 'mesh', href: '/mesh', heading: 'Connected devices' }],
    })

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/average FPS/u),
      expect.stringMatching(/interactive/u),
    ]))
  })

  it('sanitizes CDP trace artifacts before claiming redaction', () => {
    const events = sanitizeTraceEvents([{
      cat: 'blink.user_timing',
      name: 'https://example.invalid/path?token=secret',
      ph: 'X',
      ts: 42,
      dur: 7,
      args: {
        frame: 'leaked-frame-id',
        url: 'https://example.invalid/path?token=secret',
        safeNumber: 3,
        nested: { stack: 'secret stack', count: 2 },
      },
    }])

    expect(events).toEqual([{
      cat: 'blink.user_timing',
      name: '[redacted-user-timing]',
      ph: 'X',
      ts: 42,
      dur: 7,
      args: {
        safeNumber: 3,
        nested: { count: 2 },
      },
    }])
  })

  it('fails the report when cold-home script coverage is missing or errored', () => {
    const report = buildWaydroidPerformanceReport({
      appId: 'dev.aurora.desktop',
      device: {
        serial: 'waydroid-1',
        deviceClass: 'waydroid',
        adbLine: 'waydroid-1 device model:WayDroid',
        release: '13',
        sdk: '33',
        abi: 'x86_64',
        webviewSummary: 'redacted',
      },
      launch: { hostLaunchCommandMs: 100, amStartTotalTimeMs: 80, amStartWaitTimeMs: 90, raw: '' },
      observations: [{
        routeId: 'assistant',
        href: '/',
        phase: 'cold-home',
        interactive: true,
        interactiveMs: 1200,
        document: { pathname: '/' },
        scriptCoverage: {
          ok: false,
          parsedScriptCount: 0,
          measuredScriptCount: 0,
          totalParsedJsBytes: 0,
          errors: ['Debugger.getScriptSource(7): denied'],
        },
      }],
      budgets: { minimumNavFps: null, maximumRouteInteractiveMs: null },
      expectedRoutes: [{ id: 'assistant', href: '/', heading: 'Text chat with Aurora' }],
    })

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/script coverage did not complete/u),
      expect.stringMatching(/did not record parsed scripts/u),
      expect.stringMatching(/did not measure any script source/u),
      expect.stringMatching(/positive parsed JS bytes/u),
      expect.stringMatching(/Debugger\.getScriptSource/u),
    ]))
  })

  it('requires route-specific visible main readiness instead of body-shell text', () => {
    expect(isInteractiveDocumentState({
      readyState: 'complete',
      rootChildren: 1,
      mainVisible: true,
      routeMatches: true,
      headingPresent: true,
      loadingPresent: false,
    })).toBe(true)

    expect(isInteractiveDocumentState({
      readyState: 'complete',
      rootChildren: 1,
      mainVisible: true,
      routeMatches: true,
      headingPresent: false,
      mainTextIncludesExpectedHeading: true,
      loadingPresent: false,
    })).toBe(false)

    expect(isInteractiveDocumentState({
      readyState: 'complete',
      rootChildren: 1,
      mainVisible: true,
      routeMatches: true,
      headingPresent: true,
      loadingPresent: true,
    })).toBe(false)
  })

  it('fails when expected route observations are missing', () => {
    const report = buildWaydroidPerformanceReport({
      appId: 'dev.aurora.desktop',
      device: {
        serial: 'waydroid-1',
        deviceClass: 'waydroid',
        adbLine: 'waydroid-1 device model:WayDroid',
        release: '13',
        sdk: '33',
        abi: 'x86_64',
        webviewSummary: 'redacted',
      },
      launch: { hostLaunchCommandMs: 100, amStartTotalTimeMs: 80, amStartWaitTimeMs: 90, raw: '' },
      observations: [],
      budgets: { minimumNavFps: null, maximumRouteInteractiveMs: null },
      expectedRoutes: [
        { id: 'assistant', href: '/', heading: 'Text chat with Aurora' },
        { id: 'settings', href: '/settings', heading: 'This device' },
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/no route observations/u),
      expect.stringMatching(/missing observation for expected route assistant/u),
      expect.stringMatching(/missing observation for expected route settings/u),
    ]))
  })

  it('fails a navigation budget when FPS metrics or a visible-link action are absent', () => {
    const report = buildWaydroidPerformanceReport({
      appId: 'dev.aurora.desktop',
      device: {
        serial: 'waydroid-1',
        deviceClass: 'waydroid',
        adbLine: 'waydroid-1 device model:WayDroid',
        release: '13',
        sdk: '33',
        abi: 'x86_64',
        webviewSummary: 'redacted',
      },
      launch: { hostLaunchCommandMs: 100, amStartTotalTimeMs: 80, amStartWaitTimeMs: 90, raw: '' },
      observations: [{
        routeId: 'settings',
        href: '/settings',
        phase: 'navigation',
        interactive: true,
        interactiveMs: 300,
        document: { pathname: '/settings' },
        frameMetrics: null,
        navigation: { ok: false, mode: 'history-push' },
      }],
      budgets: { minimumNavFps: 55, maximumRouteInteractiveMs: null },
      expectedRoutes: [{ id: 'settings', href: '/settings', heading: 'This device' }],
    })

    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/visible link click/u),
      expect.stringMatching(/missing navigation FPS metrics/u),
    ]))
  })

  it('parses only authorized adb devices', () => {
    const devices = parseAdbDevices(`List of devices attached\na device usb:1\nb unauthorized usb:2\nc offline usb:3\n`)

    expect(devices.map((device) => device.serial)).toEqual(['a'])
  })
})

import { describe, expect, it } from 'vitest'

import {
  androidMobileInteropHarnessHtml,
  androidWebRtcBrokerUrl,
  androidWebRtcComposeArgs,
  androidWebRtcServicesComposeYaml,
  androidWebRtcStunUrl,
  androidWebRtcTurnUrl,
  createAndroidHarnessRequestLog,
  formatAndroidRuntimeException,
  isBenignTauriBootstrapRedefineError,
  resolveAndroidWebRtcServicePorts,
  splitAndroidConsoleErrors,
} from '../tests/android/android-webrtc-harness-utils.js'

describe('Android WebRTC harness utilities', () => {
  it('marks only source-verified Tauri bootstrap exceptions as benign', () => {
    const details = {
      text: 'Uncaught TypeError: Cannot redefine property: postMessage',
      lineNumber: 133,
      columnNumber: 9,
      scriptId: '4',
      stackTrace: {
        callFrames: [
          {
            functionName: '',
            scriptId: '4',
            url: '',
            lineNumber: 133,
            columnNumber: 9,
          },
        ],
      },
    }
    const tauriSource = [
      'Tauri Programme within The Commons Conservancy',
      "Object.defineProperty(window.__TAURI_INTERNALS__, 'postMessage', { value: sendIpcMessage })",
    ].join('\n')

    expect(
      isBenignTauriBootstrapRedefineError(
        formatAndroidRuntimeException(details, tauriSource),
      ),
    ).toBe(true)
    expect(
      isBenignTauriBootstrapRedefineError(
        formatAndroidRuntimeException(details),
      ),
    ).toBe(false)
    expect(
      isBenignTauriBootstrapRedefineError(
        formatAndroidRuntimeException(details, 'throw new TypeError()'),
      ),
    ).toBe(false)
    expect(
      isBenignTauriBootstrapRedefineError(
        formatAndroidRuntimeException(
          {
            ...details,
            stackTrace: {
              callFrames: [
                {
                  ...details.stackTrace.callFrames[0],
                  url: 'https://example.test/app.js',
                },
              ],
            },
          },
          tauriSource,
        ),
      ),
    ).toBe(false)
  })

  it('classifies only exact Tauri bootstrap redefine errors as ignorable', () => {
    const bootstrapError = [
      'TypeError: Cannot redefine property: __TAURI_PATTERN__',
      '    at Function.defineProperty (<anonymous>)',
      '    at <anonymous>:25:10',
    ].join('\n')

    expect(isBenignTauriBootstrapRedefineError(bootstrapError)).toBe(true)
    expect(
      isBenignTauriBootstrapRedefineError(
        'Uncaught TypeError: Cannot redefine property: postMessage',
      ),
    ).toBe(false)
    expect(
      isBenignTauriBootstrapRedefineError(
        'Uncaught TypeError: Cannot redefine property: postMessage\n    at app.js:1:1',
      ),
    ).toBe(false)
    expect(
      isBenignTauriBootstrapRedefineError(
        'TypeError: Cannot redefine property: appState\n    at app.js:1:1',
      ),
    ).toBe(false)
    expect(
      isBenignTauriBootstrapRedefineError(
        'ReferenceError: runAuroraWebRtcInterop is not defined',
      ),
    ).toBe(false)
  })

  it('keeps real Android WebView console failures actionable', () => {
    const actionable = 'Error: WebRTC interop assertions failed'
    const benign = [
      'TypeError: Cannot redefine property: postMessage',
      '    at Function.defineProperty (<anonymous>)',
      '    at <anonymous>:134:10',
    ].join('\n')

    expect(splitAndroidConsoleErrors([benign, actionable])).toEqual({
      actionable: [actionable],
      ignoredTauriBootstrap: [benign],
    })
  })

  it('records harness page load milestones without exposing request bodies', () => {
    const log = createAndroidHarnessRequestLog()

    log.record('document', '/', 'GET')
    log.record('bundle', '/android-mobile-browser-bundle.js', 'GET')
    log.record('config', '/interop-config', 'GET')

    expect(log.hasAll(['document', 'bundle', 'config'])).toBe(true)
    expect(log.has('result')).toBe(false)
    expect(log.snapshot()).toEqual([
      expect.objectContaining({ kind: 'document', path: '/' }),
      expect.objectContaining({
        kind: 'bundle',
        path: '/android-mobile-browser-bundle.js',
      }),
      expect.objectContaining({
        kind: 'config',
        path: '/interop-config',
      }),
    ])
  })

  it('reports browser outcomes outside the instrumented application fetch path', () => {
    const html = androidMobileInteropHarnessHtml(
      '{"imports":{"mqtt":"/mqtt-bundle.mjs"}}',
    )

    expect(html).toContain("fetch('/interop-config'")
    expect(html).toContain('new XMLHttpRequest()')
    expect(html).toContain("request.open('POST', '/interop-result')")
    expect(html).not.toContain("fetch('/interop-result'")
  })

  it('uses env-selected WebRTC service host ports without binding host MQTT TCP', () => {
    const ports = resolveAndroidWebRtcServicePorts({
      AURORA_ANDROID_WEBRTC_MQTT_WS_HOST_PORT: '19091',
      AURORA_ANDROID_WEBRTC_TURN_HOST_PORT: '13479',
    })

    expect(ports).toEqual({
      mqttWsHostPort: 19091,
      turnHostPort: 13479,
    })
    expect(androidWebRtcBrokerUrl(ports)).toBe(
      'ws://127.0.0.1:19091/mqtt',
    )
    expect(androidWebRtcStunUrl('10.0.2.2', ports)).toBe(
      'stun:10.0.2.2:13479',
    )
    expect(androidWebRtcTurnUrl('10.0.2.2', ports)).toBe(
      'turn:10.0.2.2:13479?transport=tcp',
    )

    const composeYaml = androidWebRtcServicesComposeYaml(ports)
    expect(composeYaml).toContain('"19091:9001"')
    expect(composeYaml).toContain('"13479:3478/tcp"')
    expect(composeYaml).toContain('"13479:3478/udp"')
    expect(composeYaml).not.toContain(':1883"')
  })

  it('rejects invalid Android WebRTC service host ports', () => {
    expect(() =>
      resolveAndroidWebRtcServicePorts({
        AURORA_ANDROID_WEBRTC_MQTT_WS_HOST_PORT: 'not-a-port',
      }),
    ).toThrow('AURORA_ANDROID_WEBRTC_MQTT_WS_HOST_PORT')
    expect(() =>
      resolveAndroidWebRtcServicePorts({
        AURORA_ANDROID_WEBRTC_TURN_HOST_PORT: '70000',
      }),
    ).toThrow('AURORA_ANDROID_WEBRTC_TURN_HOST_PORT')
  })

  it('builds deterministic docker compose commands for generated service files', () => {
    expect(
      androidWebRtcComposeArgs(
        '/tmp/android-webrtc-compose.yml',
        'up',
        'aurora-android-mobile-webrtc-e2e',
      ),
    ).toEqual([
      'compose',
      '-p',
      'aurora-android-mobile-webrtc-e2e',
      '-f',
      '/tmp/android-webrtc-compose.yml',
      'up',
      '-d',
      'webrtc-interop-mqtt',
      'webrtc-interop-turn',
    ])
  })
})

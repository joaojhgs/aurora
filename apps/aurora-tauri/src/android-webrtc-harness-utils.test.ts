import { describe, expect, it } from 'vitest'

import {
  createAndroidHarnessRequestLog,
  formatAndroidRuntimeException,
  isBenignTauriBootstrapRedefineError,
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
})

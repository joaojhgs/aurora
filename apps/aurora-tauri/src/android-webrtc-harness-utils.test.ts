import { describe, expect, it } from 'vitest'

import {
  createAndroidHarnessRequestLog,
  isBenignTauriBootstrapRedefineError,
  splitAndroidConsoleErrors,
} from '../tests/android/android-webrtc-harness-utils.js'

describe('Android WebRTC harness utilities', () => {
  it('classifies only exact Tauri bootstrap redefine errors as ignorable', () => {
    const bootstrapError = [
      'TypeError: Cannot redefine property: __TAURI_PATTERN__',
      '    at Function.defineProperty (<anonymous>)',
      '    at <anonymous>:25:10',
    ].join('\n')

    expect(isBenignTauriBootstrapRedefineError(bootstrapError)).toBe(true)
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

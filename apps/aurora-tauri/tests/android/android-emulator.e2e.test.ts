// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { runAndroidEmulatorSmoke } from '../../scripts/android-emulator-smoke.mjs'

describe('Android thin-shell emulator E2E', () => {
  it(
    'installs the APK, validates the redacted native payload, and renders the WebView frontend',
    async () => {
      const result = await runAndroidEmulatorSmoke()

      expect(result.payload.platform).toBe('android')
      expect(result.payload.secureStorage).toMatchObject({
        backend: 'android-keystore',
        persisted: true,
        secretsRedacted: true,
      })
      expect(result.webview).toMatchObject({
        url: 'http://tauri.localhost/',
        title: 'Aurora',
        readyState: 'complete',
      })
      expect(result.webview.rootChildren).toBeGreaterThan(0)
      expect(result.webview.bodyText).toContain('Text chat with Aurora')
      expect(result.webview.mainWidth).toBeGreaterThanOrEqual(300)
      expect(result.webview.mobileNavigationHeight).toBeGreaterThanOrEqual(40)
      expect(result.webview.mobileNavigationHeight).toBeLessThanOrEqual(128)
      expect(result.webview.mobileNavigationPaddingBottom).toBeGreaterThanOrEqual(40)
      expect(result.webview.mobileNavigationPosition).toBe('fixed')
    },
    240_000,
  )
})

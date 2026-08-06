// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { runAndroidEmulatorSmoke } from '../../scripts/android-emulator-smoke.mjs'

const androidSmokeTimeoutMs = Number(process.env.AURORA_ANDROID_TEST_TIMEOUT_MS ?? 240_000)

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
      expect(
        result.webview.bodyText.includes('Text chat with Aurora')
          || result.webview.bodyText.includes('Set up Aurora on this device'),
      ).toBe(true)
      expect(result.webview.mainWidth).toBeGreaterThanOrEqual(300)
      if (result.webview.bodyText.includes('Text chat with Aurora')) {
        expect(result.webview.mobileNavigationHeight).toBeGreaterThanOrEqual(40)
        expect(result.webview.mobileNavigationHeight).toBeLessThanOrEqual(128)
        expect(result.webview.mobileNavigationPaddingBottom).toBeGreaterThanOrEqual(40)
        expect(result.webview.mobileNavigationPosition).toBe('fixed')
      } else {
        expect(result.webview.bodyText).toContain('Set up Aurora on this device')
      }
    },
    androidSmokeTimeoutMs,
  )
})

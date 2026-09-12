// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

// @ts-expect-error The Node-executed .mjs harness intentionally has no TS build output.
import { extractWebviewConsoleErrors, invokeNativePluginPayload } from '../scripts/android-emulator-smoke.mjs'

describe('Android emulator native payload probe', () => {
  it('extracts only Tauri WebView error records from filtered logcat output', () => {
    const output = [
      '09-11 00:00:01.000  123  456 E Tauri/Console: Error: frontend failed',
      '09-11 00:00:02.000  123  456 W Tauri/Console: warning is allowed',
      '09-11 00:00:03.000  123  456 E OtherTag: unrelated system error',
    ].join('\n')

    expect(extractWebviewConsoleErrors(output)).toEqual([
      '09-11 00:00:01.000  123  456 E Tauri/Console: Error: frontend failed',
    ])
  })

  it('reads the manifest through the packaged Tauri command boundary', async () => {
    const send = vi.fn().mockResolvedValue({
      result: {
        result: {
          value: JSON.stringify({
            ok: true,
            result: { platform: 'android', secretsRedacted: true },
          }),
        },
      },
    })

    await expect(invokeNativePluginPayload({ send })).resolves.toEqual({
      platform: 'android',
      secretsRedacted: true,
    })
    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        expression: expect.stringContaining("invoke('aurora_android_native_plugin_payload', {})"),
        awaitPromise: true,
        returnByValue: true,
      }),
      60_000,
    )
  })

  it('surfaces native command errors instead of waiting on stdout', async () => {
    const send = vi.fn().mockResolvedValue({
      result: {
        result: {
          value: JSON.stringify({ ok: false, error: 'plugin handle unavailable' }),
        },
      },
    })

    await expect(invokeNativePluginPayload({ send })).rejects.toThrow(
      'Android native plugin command failed: plugin handle unavailable',
    )
  })
})

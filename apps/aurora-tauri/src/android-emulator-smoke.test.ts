// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

// @ts-expect-error The Node-executed .mjs harness intentionally has no TS build output.
import { invokeNativePluginPayload } from '../scripts/android-emulator-smoke.mjs'

describe('Android emulator native payload probe', () => {
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

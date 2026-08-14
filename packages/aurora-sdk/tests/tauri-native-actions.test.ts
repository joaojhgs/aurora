import { describe, expect, it } from 'vitest'

import { AuroraError, TauriLocalTransport } from '../src/index.js'

describe('Tauri bounded native action transport', () => {
  it('uses only exact native action commands and omits absent optional fields', async () => {
    const calls: Array<{ command: string, args: unknown }> = []
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        if (command === 'aurora_native_share_text') return { shared: true, secretsRedacted: true }
        if (command === 'aurora_native_open_deep_link') return { opened: true, secretsRedacted: true }
        if (command === 'aurora_native_show_notification') return { shown: true, secretsRedacted: true }
        throw new Error(`unexpected command: ${command}`)
      }
    })

    await expect(transport.shareNativeText({ text: 'hello' })).resolves.toEqual({ shared: true })
    await expect(transport.openNativeDeepLink({ url: 'https://aurora.example/path' })).resolves.toEqual({ opened: true })
    await expect(transport.showNativeNotification({ title: 'Ready' })).resolves.toEqual({ shown: true })

    expect(calls).toEqual([
      {
        command: 'aurora_native_share_text',
        args: { request: { text: 'hello' } }
      },
      {
        command: 'aurora_native_open_deep_link',
        args: { request: { url: 'https://aurora.example/path' } }
      },
      {
        command: 'aurora_native_show_notification',
        args: { request: { title: 'Ready' } }
      }
    ])
  })

  it('rejects false or malformed native action results', async () => {
    const transport = new TauriLocalTransport({
      invoke: async () => ({ shared: false })
    })

    await expect(transport.shareNativeText({ text: 'hello' })).rejects.toMatchObject({
      name: 'AuroraError',
      code: 'validation'
    } satisfies Partial<AuroraError>)
  })

  it('preserves structured native permission failures', async () => {
    const transport = new TauriLocalTransport({
      invoke: async () => {
        throw {
          detail: {
            code: 'native_permission_missing',
            message: 'The required native permission is unavailable'
          }
        }
      }
    })

    await expect(transport.showNativeNotification({ title: 'Ready' })).rejects.toMatchObject({
      name: 'AuroraError',
      code: 'native_permission_missing'
    } satisfies Partial<AuroraError>)
  })

})

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

  it('routes native speech download status and mutations through exact commands', async () => {
    const calls: Array<{ command: string, args: unknown }> = []
    const status = {
      available: true,
      state: 'ready',
      activePackId: 'pt-BR-local',
      defaultPackId: 'pt-BR-local',
      languages: ['pt-BR'],
      engineCapabilities: { vad: true, kws: true, stt: true, tts: true },
      catalog: [{
        packId: 'pt-BR-local',
        displayName: 'Brazilian Portuguese',
        languages: ['pt-BR'],
        installed: true,
        ready: true,
        active: true,
        default: true,
        downloadable: true,
        compatibleEngine: true,
        revision: 'rev-1',
      }],
      secretsRedacted: true as const,
    }
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        if (command === 'aurora_native_speech_pack_status') return status
        if (command === 'aurora_native_speech_pack_catalog') return status.catalog
        if (command === 'aurora_native_speech_pack_install') return { status: 'installed', packId: 'pt-BR-local', revision: 'rev-2', idempotent: false, secretsRedacted: true }
        if (command === 'aurora_native_speech_pack_set_default') return { status: 'activated', packId: 'pt-BR-local', revision: 'rev-2', idempotent: false, secretsRedacted: true }
        if (command === 'aurora_native_speech_pack_remove') return { status: 'removed', packId: 'pt-BR-local', revision: null, idempotent: false, secretsRedacted: true }
        throw new Error(`unexpected command: ${command}`)
      }
    })

    await expect(transport.getNativeSpeechPackStatus()).resolves.toEqual(status)
    await expect(transport.getNativeSpeechPackCatalog()).resolves.toEqual(status.catalog)
    await expect(transport.installNativeSpeechPack({ packId: 'pt-BR-local', expectedRevision: 'rev-1', operationId: 'op-1' })).resolves.toMatchObject({ status: 'installed' })
    await expect(transport.setDefaultNativeSpeechPack({ packId: 'pt-BR-local', operationId: 'op-2' })).resolves.toMatchObject({ status: 'activated' })
    await expect(transport.removeNativeSpeechPack({ packId: 'pt-BR-local', operationId: 'op-3' })).resolves.toMatchObject({ status: 'removed' })

    expect(calls).toEqual([
      { command: 'aurora_native_speech_pack_status', args: undefined },
      { command: 'aurora_native_speech_pack_catalog', args: undefined },
      { command: 'aurora_native_speech_pack_install', args: { request: { packId: 'pt-BR-local', expectedRevision: 'rev-1', operationId: 'op-1' } } },
      { command: 'aurora_native_speech_pack_set_default', args: { request: { packId: 'pt-BR-local', operationId: 'op-2' } } },
      { command: 'aurora_native_speech_pack_remove', args: { request: { packId: 'pt-BR-local', operationId: 'op-3' } } },
    ])
  })
})

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

  it('routes native speech pack commands through typed request payloads', async () => {
    const calls: Array<{ command: string, args: unknown }> = []
    const status = {
      available: true,
      activeSlots: {},
      count: 0,
      packs: [],
      secretsRedacted: true
    }
    const transport = new TauriLocalTransport({
      invoke: async (command, args) => {
        calls.push({ command, args })
        if (command === 'aurora_native_speech_pack_catalog') {
          return { ...status, languages: [] }
        }
        if (command.startsWith('aurora_native_speech_pack_')) return status
        if (command.startsWith('aurora_ios_voice_pack_')) return { ok: true, secretsRedacted: true }
        if (command === 'aurora_android_voice_pack_catalog_status') {
          return { platform: 'android', available: true, entries: [], secretsRedacted: true }
        }
        if (command === 'aurora_android_voice_pack_download') {
          return { started: true, packId: 'pocket.en', jobId: 'job-1' }
        }
        if (command === 'aurora_android_voice_pack_download_status') {
          return { jobId: 'job-1', status: 'completed', packId: 'pocket.en', downloadedBytes: 1, totalBytes: 1 }
        }
        if (command.startsWith('aurora_android_voice_pack_')) return { ok: true, secretsRedacted: true }
        throw new Error(`unexpected command: ${command}`)
      }
    })

    await transport.getNativeSpeechPackCatalog({ task: 'stt', language: 'en' })
    await transport.getNativeSpeechPackStatus()
    await transport.installNativeSpeechPack({ task: 'tts', packId: 'piper.en' })
    await transport.activateNativeSpeechPack({ task: 'tts', packId: 'piper.en', slot: 'tts' })
    await transport.removeNativeSpeechPack({ task: 'tts', packId: 'piper.en' })
    await transport.setIosVoicePackCatalog({ entries: [], replaceExisting: true })
    await transport.downloadIosVoicePack({ task: 'stt', packId: 'whisper.tiny.en' })
    await transport.activateIosVoicePack({ task: 'stt', packId: 'whisper.tiny.en', slot: 'stt' })
    await transport.removeIosVoicePack({ task: 'stt', packId: 'whisper.tiny.en' })
    await transport.getAndroidVoicePackCatalogStatus()
    await transport.downloadAndroidVoicePack({
      task: 'tts',
      packId: 'pocket.en',
      activate: true,
      referenceId: 'reference-1',
      referenceText: 'A reference sentence.',
      referenceRevision: 'sha256:abc',
      referenceSampleRateHz: 24_000,
      referenceSamples: [0, 0.25, -0.25]
    })
    await transport.getAndroidVoicePackDownloadStatus('job-1')
    await transport.activateAndroidVoicePack({ task: 'tts', packId: 'pocket.en', slot: 'tts' })
    await transport.removeAndroidVoicePack({ task: 'tts', packId: 'pocket.en' })

    expect(calls).toEqual([
      {
        command: 'aurora_native_speech_pack_catalog',
        args: { request: { task: 'stt', language: 'en' } }
      },
      {
        command: 'aurora_native_speech_pack_status',
        args: undefined
      },
      {
        command: 'aurora_native_speech_pack_install',
        args: { request: { task: 'tts', packId: 'piper.en' } }
      },
      {
        command: 'aurora_native_speech_pack_activate',
        args: { request: { task: 'tts', packId: 'piper.en', slot: 'tts' } }
      },
      {
        command: 'aurora_native_speech_pack_remove',
        args: { request: { task: 'tts', packId: 'piper.en' } }
      },
      {
        command: 'aurora_ios_voice_pack_catalog_set',
        args: { request: { entries: [], replaceExisting: true } }
      },
      {
        command: 'aurora_ios_voice_pack_download',
        args: { request: { task: 'stt', packId: 'whisper.tiny.en' } }
      },
      {
        command: 'aurora_ios_voice_pack_activate',
        args: { request: { task: 'stt', packId: 'whisper.tiny.en', slot: 'stt' } }
      },
      {
        command: 'aurora_ios_voice_pack_remove',
        args: { request: { task: 'stt', packId: 'whisper.tiny.en' } }
      },
      {
        command: 'aurora_android_voice_pack_catalog_status',
        args: undefined
      },
      {
        command: 'aurora_android_voice_pack_download',
        args: {
          request: {
            task: 'tts',
            packId: 'pocket.en',
            activate: true,
            referenceId: 'reference-1',
            referenceText: 'A reference sentence.',
            referenceRevision: 'sha256:abc',
            referenceSampleRateHz: 24_000,
            referenceSamples: [0, 0.25, -0.25]
          }
        }
      },
      {
        command: 'aurora_android_voice_pack_download_status',
        args: { request: { jobId: 'job-1' } }
      },
      {
        command: 'aurora_android_voice_pack_activate',
        args: { request: { task: 'tts', packId: 'pocket.en', slot: 'tts' } }
      },
      {
        command: 'aurora_android_voice_pack_remove',
        args: { request: { task: 'tts', packId: 'pocket.en' } }
      }
    ])
  })

})

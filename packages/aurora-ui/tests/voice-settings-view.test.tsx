// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient, GeneratedBackendMethodOutput, JsonObject, JsonValue } from '@aurora/client'
import { VoiceSettingsView, type VoiceSettingsViewProps } from '../src/voice-settings-view'
import { SettingsView } from '../src/settings-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { AuroraShellSnapshot, RouteAvailability } from '../src/shell-data'
import { buildCapabilityGraph, capabilityGraphCatalogFixture, gatewayRegistryFixture } from '@aurora/client'
import { snapshotFromGraph } from '../src/shell-data'
import type { AuroraRuntimeProfileV2 } from '../src/runtime-profile'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SpeechLanguage = string
type InstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'
type RemoveStatus = 'drained' | 'not_found' | 'rejected' | 'removed' | 'revision_conflict' | 'unchanged'
type DefaultStatus = 'activated' | 'drained' | 'not_found' | 'rejected' | 'revision_conflict'
type DeleteStatus = 'deleted' | 'not_found' | 'rejected' | 'revision_conflict'
type ImportOutput = GeneratedBackendMethodOutput<'TTS.ImportVoiceProfile'>

interface CloneTransferBundle extends JsonObject {
  bundle_type: 'aurora-cloned-tts-voice-state'
  voice_id: string
  display_name: string
  artifact_revision?: string | null | undefined
  artifact_data_base64: string
  artifact_sha256: string
  artifact_size_bytes: number
  [key: string]: JsonValue | undefined
}

interface Capabilities {
  contract_revision: 'aurora-tts-capabilities-v1'
  ready: boolean
  model_status: 'ready' | 'loading' | 'degraded' | 'error' | 'unavailable'
  ready_languages: SpeechLanguage[]
  supported_language_pack_ids: string[]
  installed_language_pack_ids: string[]
  active_language_pack_id?: string | null
  default_language_pack_id?: string | null
  language_packs?: LanguagePack[]
  resident_language_pack_ids: string[]
  resident_language_packs: Array<{ pack_id: string; ready_languages: SpeechLanguage[] }>
  resident_base_model_count: number
  max_resident_base_models: number
  output_formats: string[]
  sample_rates: number[]
  streaming: boolean
  cancellation: boolean
  cloning: boolean
  engine_capabilities?: {
    vad?: boolean
    kws?: boolean
    stt?: boolean
    tts?: boolean
  }
  local_speech_assets?: {
    vad?: LocalSpeechAsset[]
    kws?: LocalSpeechAsset[]
    wakeword?: LocalSpeechAsset[]
    wkw?: LocalSpeechAsset[]
    stt?: LocalSpeechAsset[]
  }
  local_speech_packs?: LocalSpeechAsset[]
}

interface LocalSpeechAsset {
  task?: 'vad' | 'kws' | 'wakeword' | 'wkw' | 'stt'
  pack_id?: string
  packId?: string
  revision?: string | null
  pack_revision?: string | null
  display_name?: string | null
  label?: string | null
  installed?: boolean
  ready?: boolean
  enabled?: boolean
  compatible_engine?: boolean
}

interface LanguagePack {
  pack_id: string
  language?: SpeechLanguage
  display_name?: string | null
  revision?: string | null
  languages?: SpeechLanguage[]
  ready_languages?: SpeechLanguage[]
  installed?: boolean
  ready?: boolean
  active?: boolean
  default?: boolean
  downloadable?: boolean
  download_progress?: number | null
  compatible_engine?: boolean
  voices?: LanguagePackVoice[]
}

interface LanguagePackVoice {
  voice_id: string
  display_name: string
  revision: string
  installed: boolean
  ready: boolean
  active: boolean
  default: boolean
}

interface Voice {
  voice_id: string
  display_name: string
  kind: 'standard' | 'cloned'
  preview_available: boolean
  ready: boolean
  revision: string
  compatible_language_pack_ids: string[]
  selection_mode: 'active_only'
  visible_scope: 'local'
  attribution_label?: string | null | undefined
}

interface Profile {
  voice_id: string
  display_name: string
  kind: 'standard' | 'cloned'
  active: boolean
  default: boolean
  enabled: boolean
  installed: boolean
  ready: boolean
  retained_source: boolean
  revision: string
  visibility: 'private'
  compatible_language_pack_ids: string[]
}

interface InstallOutput {
  status: InstallStatus
  voice_id: string
  revision: string | null
  idempotent: boolean
}

interface MutationOutput<TStatus extends string> {
  status: TStatus
  voice_id: string
  revision: string | null
  idempotent: boolean
  correlation_id?: string | null
}

describe('VoiceSettingsView', () => {
  it('loads voice discovery without mutating and maps unavailable voice inventory to product copy', async () => {
    const installVoiceProfile = vi.fn()
    const listVoiceProfiles = vi.fn()
    const adminExecute = vi.fn(async (_input: { methodId: string }) => {
      throw { code: 'permission_denied', message: 'TTS.manage denied raw provider manifest' }
    })
    const client = voiceClient({
      installVoiceProfile,
      listVoiceProfiles,
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client)

    expect(client.speech.tts.getCapabilities).toHaveBeenCalledTimes(1)
    expect(client.speech.tts.listVoices).toHaveBeenCalledTimes(1)
    expect(client.speech.tts.listVoiceProfiles).not.toHaveBeenCalled()
    expect(adminExecute).not.toHaveBeenCalled()
    expect(installVoiceProfile).not.toHaveBeenCalled()

    await loadManagedVoices(container)
    expect(adminExecute.mock.calls[0]?.[0]).not.toHaveProperty('phrase')
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.ListVoiceProfiles',
      payload: { include_unavailable: true },
      reason: 'Load available voice settings: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profiles'],
      path: '/api/TTS/ListVoiceProfiles'
    }))

    const text = visibleText(container)
    expect(text).toContain('English')
    expect(text).toContain('Ava')
    expect(text).toContain('Available voices could not be loaded. Review access and try again.')
    expect(text).not.toContain('standard:en_pack:ava')
    expect(text).not.toContain('en_pack')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('does not load protected voice inventory before the user confirms access', async () => {
    const adminExecute = vi.fn(async () => adminResult({ profiles: [profile()] }))
    const client = voiceClient({ adminExecute })
    const { container, unmount } = await renderVoiceSettings(client)

    const showButton = buttonByText(container, 'Show available voices')
    expect(showButton.disabled).toBe(true)
    await act(async () => {
      showButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(adminExecute).not.toHaveBeenCalled()
    await unmount()
  })

  it('adds a voice only after an explicit click', async () => {
    const installVoiceProfile = vi.fn()
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => (
      input.methodId === 'TTS.ListVoiceProfiles'
        ? adminResult({ profiles: [profile({ installed: false, ready: false })] })
        : adminResult(installResult('installed'))
    ))
    const client = voiceClient({
      installVoiceProfile,
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    expect(installVoiceProfile).not.toHaveBeenCalled()
    await loadManagedVoices(container)
    const button = buttonByText(container, 'Add voice')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(installVoiceProfile).not.toHaveBeenCalled()
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.InstallVoiceProfile',
      payload: expect.objectContaining({
        voice_id: 'standard:en_pack:ava',
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-install-/u)
      }),
      reason: 'Add spoken reply voice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:standard:en_pack:ava'],
      path: '/api/TTS/InstallVoiceProfile'
    }))
    expect(adminExecute.mock.calls.find(([input]) => input.methodId === 'TTS.InstallVoiceProfile')?.[0]).not.toHaveProperty('phrase')
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenCalledWith({
      tts: {
        packId: 'en_pack',
        packRevision: 'pack-rev-1',
        voiceId: 'standard:en_pack:ava',
        voiceRevision: 'rev-1',
      },
    })
    expect(visibleText(container)).toContain('Voice added.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('uses distinct fallback operation IDs for sequential installs', async () => {
    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(123456)
    const operationIds: string[] = []
    const adminExecute = vi.fn(async (input: { methodId: string, payload?: { operation_id?: string } }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [profile({ installed: false, ready: false })] })
      if (input.methodId === 'TTS.ListLanguagePacks') return adminResult({ packs: [] })
      if (input.methodId === 'TTS.InstallVoiceProfile') operationIds.push(input.payload?.operation_id ?? '')
      return adminResult(installResult('installed'))
    })
    const client = voiceClient({
      adminExecute
    })
    let unmount: (() => Promise<void>) | null = null

    try {
      const rendered = await renderVoiceSettings(client)
      unmount = rendered.unmount
      const { container } = rendered
      await loadManagedVoices(container)
      await act(async () => {
        buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flushReactWork()
      await act(async () => {
        buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flushReactWork()

      expect(operationIds).toHaveLength(2)
      expect(operationIds[0]).toMatch(/^voice-install-2n9c-[a-z0-9]+$/u)
      expect(operationIds[1]).toMatch(/^voice-install-2n9c-[a-z0-9]+$/u)
      expect(operationIds[0]).not.toBe(operationIds[1])
    } finally {
      await unmount?.()
      dateNow.mockRestore()
      if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, 'crypto')
      }
    }
  })

  it('prevents a second install submit while one is pending', async () => {
    const pendingInstall = deferred<unknown>()
    const adminExecute = vi.fn((input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return Promise.resolve(adminResult({ profiles: [profile({ installed: false, ready: false })] }))
      if (input.methodId === 'TTS.ListLanguagePacks') return Promise.resolve(adminResult({ packs: [] }))
      return pendingInstall.promise
    })
    const client = voiceClient({
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonByText(container, 'Adding').disabled).toBe(true)
    await act(async () => {
      buttonByText(container, 'Adding').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.InstallVoiceProfile')).toHaveLength(1)
    pendingInstall.resolve(adminResult(installResult('installed')))
    await flushReactWork()
    await unmount()
  })

  it('maps install outcomes without exposing returned identifiers', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => (
      input.methodId === 'TTS.ListVoiceProfiles'
        ? adminResult({ profiles: [profile({ installed: false, ready: false })] })
        : adminResult(installResult('rejected'))
    ))
    const client = voiceClient({
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    const text = visibleText(container)
    expect(text).toContain('Voice was not added. Try again.')
    expect(text).not.toContain('standard:en_pack:ava')
    expect(onLocalSpeechSelectionConfirmed).not.toHaveBeenCalled()
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('hides cloning controls when cloning is not available', async () => {
    const installVoiceProfile = vi.fn()
    const client = voiceClient({
      installVoiceProfile,
      capabilities: capabilities({ cloning: false }),
      profiles: [profile({ kind: 'cloned', voice_id: 'clone:11111111-1111-4111-8111-111111111111', installed: false, ready: false })]
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    expect(container.textContent).not.toContain('Add voice')
    expect(container.textContent).not.toContain('Clone')
    expect(container.textContent).not.toContain('Import')
    expect(installVoiceProfile).not.toHaveBeenCalled()
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('shows management actions only for profiles that can use them', async () => {
    const client = voiceClient({
      profiles: [
        profile({ display_name: 'Ava', voice_id: 'standard:en_pack:ava', installed: true, ready: true, default: false, active: false }),
        profile({ display_name: 'Bree', voice_id: 'standard:en_pack:bree', installed: true, ready: true, default: true, active: true }),
        profile({ display_name: 'Cora', voice_id: 'standard:en_pack:cora', installed: false, ready: false }),
        profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true }),
        profile({ display_name: 'Eli', voice_id: 'clone:22222222-2222-4222-8222-222222222222', kind: 'cloned', installed: true, ready: true, default: true, active: true, retained_source: true })
      ]
    })
    const { container, unmount } = await renderVoiceSettings(client)
    await loadManagedVoices(container)
    const text = visibleText(container)

    expect(text).toContain('Ava')
    expect(text).toContain('Bree')
    expect(text).toContain('Cora')
    expect(text).toContain('Dina')
    expect(text).toContain('Eli')
    expect(buttonsByText(container, 'Use by default')).toHaveLength(2)
    expect(buttonsByText(container, 'Remove')).toHaveLength(1)
    expect(buttonsByText(container, 'Add voice')).toHaveLength(1)
    expect(buttonsByText(container, 'Delete')).toHaveLength(1)
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('keeps cloned voice transfer disabled until management access is confirmed', async () => {
    const exportVoiceProfile = vi.fn()
    const importVoiceProfile = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({ cloning: true }),
      exportVoiceProfile,
      importVoiceProfile,
      profiles: [
        profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })
      ]
    })
    const { container, unmount } = await renderVoiceSettings(client)

    expect(buttonByText(container, 'Show available voices').disabled).toBe(true)
    expect(visibleText(container)).not.toContain('Download')
    expect(visibleText(container)).not.toContain('Add from file')
    await flushReactWork()

    expect(exportVoiceProfile).not.toHaveBeenCalled()
    expect(importVoiceProfile).not.toHaveBeenCalled()
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('downloads a cloned voice through the typed SDK without rendering private data', async () => {
    const bundle = cloneTransferBundle()
    const exportVoiceProfile = vi.fn(async () => ({
      ok: true,
      data: {
        status: 'exported',
        voice_id: bundle.voice_id,
        revision: 'rev-1',
        idempotent: false,
        bundle,
      } satisfies GeneratedBackendMethodOutput<'TTS.ExportVoiceProfile'>,
    }))
    const importVoiceProfile = vi.fn()
    const objectUrls: string[] = []
    const clickedDownloads: string[] = []
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const originalClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = vi.fn((blob: Blob) => {
      objectUrls.push(blob.type)
      return 'blob:voice-transfer'
    })
    URL.revokeObjectURL = vi.fn()
    HTMLAnchorElement.prototype.click = function click() {
      clickedDownloads.push(this.download)
    }
    const client = voiceClient({
      capabilities: capabilities({ cloning: true }),
      exportVoiceProfile,
      importVoiceProfile,
      profiles: [
        profile({ display_name: 'Dina', voice_id: bundle.voice_id, kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })
      ]
    })

    try {
      const { container, unmount } = await renderVoiceSettings(client)
      await loadManagedVoices(container)
      await act(async () => {
        buttonByText(container, 'Download').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flushReactWork()

      expect(exportVoiceProfile).toHaveBeenCalledWith({
        voice_id: bundle.voice_id,
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-export-/u),
      })
      expect(importVoiceProfile).not.toHaveBeenCalled()
      expect(objectUrls).toEqual(['application/json'])
      expect(clickedDownloads).toEqual(['aurora-voice-Dina-clone-rev-a.json'])
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:voice-transfer')
      const text = visibleText(container)
      expect(text).toContain('Voice file downloaded.')
      expect(text).not.toContain(bundle.artifact_data_base64)
      expect(text).not.toContain(bundle.artifact_sha256)
      expect(text).not.toContain('11111111-1111-4111-8111-111111111111')
      assertNoForbiddenCopy(text)
      await unmount()
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      HTMLAnchorElement.prototype.click = originalClick
    }
  })

  it('imports a cloned voice file through the typed SDK and clears the upload', async () => {
    const bundle = cloneTransferBundle()
    const importVoiceProfile = vi.fn(async (input: { bundle: CloneTransferBundle }) => ({
      ok: true,
      data: {
        status: 'imported',
        voice_id: input.bundle.voice_id,
        revision: 'rev-imported',
        idempotent: false,
      } satisfies ImportOutput,
    }))
    const exportVoiceProfile = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        const listCalls = adminExecute.mock.calls.filter(([call]) => call.methodId === 'TTS.ListVoiceProfiles').length
        return adminResult({
          profiles: listCalls === 1
            ? []
            : [profile({ display_name: 'Dina', voice_id: bundle.voice_id, kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })]
        })
      }
      if (input.methodId === 'TTS.ListLanguagePacks') return adminResult({ packs: [] })
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({ cloning: true }),
      exportVoiceProfile,
      importVoiceProfile
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    const fileInput = inputByLabel(container, 'Voice file')
    const file = textFile(JSON.stringify(bundle), 'dina.json')
    await setFileInput(fileInput, file)
    await act(async () => {
      buttonByText(container, 'Add voice file').click()
    })
    await flushReactWork()

    await vi.waitFor(() => expect(importVoiceProfile).toHaveBeenCalledWith({
      bundle,
      operation_id: expect.stringMatching(/^voice-import-/u),
    }))
    expect(exportVoiceProfile).not.toHaveBeenCalled()
    expect(fileInput.value).toBe('')
    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.ListVoiceProfiles')).toHaveLength(2)
    const text = visibleText(container)
    expect(text).toContain('Voice file added.')
    expect(text).toContain('Dina')
    expect(text).not.toContain(bundle.artifact_data_base64)
    expect(text).not.toContain(bundle.artifact_sha256)
    expect(text).not.toContain('11111111-1111-4111-8111-111111111111')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('keeps cloned voice transfer failure copy product-safe', async () => {
    const bundle = cloneTransferBundle()
    const exportVoiceProfile = vi.fn(async () => ({
      ok: false,
      error: { code: 'permission_denied', message: `artifact_data_base64 ${bundle.artifact_data_base64} schema denied` },
    }))
    const importVoiceProfile = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({ cloning: true }),
      exportVoiceProfile,
      importVoiceProfile,
      profiles: [
        profile({ display_name: 'Dina', voice_id: bundle.voice_id, kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })
      ]
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Download').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    expect(visibleText(container)).toContain('Permission is needed to use this feature. Review access.')

    const fileInput = inputByLabel(container, 'Voice file')
    await setFileInput(fileInput, textFile('{"bundle_type":"wrong"}', 'bad.json'))
    await act(async () => {
      buttonByText(container, 'Add voice file').click()
    })
    await flushReactWork()

    await vi.waitFor(() => expect(visibleText(container)).toContain('Choose a valid Aurora voice file.'))
    const text = visibleText(container)
    expect(importVoiceProfile).not.toHaveBeenCalled()
    expect(text).not.toContain(bundle.artifact_data_base64)
    expect(text).not.toContain('schema')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('rejects oversized cloned voice files before import', async () => {
    const importVoiceProfile = vi.fn()
    const oversizedRead = vi.fn(async () => new ArrayBuffer(0))
    const file = textFile('{"bundle_type":"aurora-cloned-tts-voice-state"}', 'too-large.json')
    Object.defineProperty(file, 'size', { configurable: true, value: (3 * 1024 * 1024) + 1 })
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: oversizedRead })
    const client = voiceClient({
      capabilities: capabilities({ cloning: true }),
      importVoiceProfile,
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    const fileInput = inputByLabel(container, 'Voice file')
    await setFileInput(fileInput, file)
    await act(async () => {
      buttonByText(container, 'Add voice file').click()
    })
    await flushReactWork()

    await vi.waitFor(() => expect(visibleText(container)).toContain('Choose a valid Aurora voice file.'))
    expect(importVoiceProfile).not.toHaveBeenCalled()
    expect(oversizedRead).not.toHaveBeenCalled()
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('sets the default voice with the expected SDK payload and refreshes on success', async () => {
    const setDefaultVoice = vi.fn()
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        const listCalls = adminExecute.mock.calls.filter(([call]) => call.methodId === 'TTS.ListVoiceProfiles').length
        return adminResult({
          profiles: listCalls === 1
            ? [profile({ default: false, ready: true, installed: true })]
            : [profile({ default: true, active: true, ready: true, installed: true })]
        })
      }
      return adminResult(mutationResult<DefaultStatus>('activated'))
    })
    const client = voiceClient({ setDefaultVoice, adminExecute })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Use by default').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(setDefaultVoice).not.toHaveBeenCalled()
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.SetDefaultVoice',
      payload: expect.objectContaining({
        voice_id: 'standard:en_pack:ava',
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-default-/u)
      }),
      reason: 'Update spoken reply voice choice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:standard:en_pack:ava'],
      path: '/api/TTS/SetDefaultVoice'
    }))
    expect(adminExecute.mock.calls.find(([input]) => input.methodId === 'TTS.SetDefaultVoice')?.[0]).not.toHaveProperty('phrase')
    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.ListVoiceProfiles')).toHaveLength(2)
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenCalledWith({
      tts: {
        packId: 'en_pack',
        packRevision: 'pack-rev-1',
        voiceId: 'standard:en_pack:ava',
        voiceRevision: 'rev-1',
      },
    })
    expect(visibleText(container)).toContain('Voice choice updated.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('does not render operation identifiers from failed default changes', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [profile({ default: false, ready: true, installed: true })] })
      throw { code: 'transport_loss', message: 'operation_id voice-default-secret correlation_id OP-123 failed' }
    })
    const client = voiceClient({ adminExecute })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Use by default').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    const text = visibleText(container)
    expect(text).toContain('Connection lost')
    expect(text).not.toContain('voice-default-secret')
    expect(text).not.toContain('OP-123')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('requires confirmation before removing a standard voice and honors cancel', async () => {
    const removeVoiceProfile = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => (
      input.methodId === 'TTS.ListVoiceProfiles'
        ? adminResult({ profiles: [profile({ installed: true, ready: true, default: false, active: false })] })
        : adminResult(mutationResult<RemoveStatus>('removed'))
    ))
    const client = voiceClient({ removeVoiceProfile, adminExecute })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(visibleText(document.body)).toContain('Remove voice?')
    await act(async () => {
      buttonByText(document.body, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    expect(removeVoiceProfile).not.toHaveBeenCalled()
    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.RemoveVoiceProfile')).toHaveLength(0)

    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(removeVoiceProfile).not.toHaveBeenCalled()
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.RemoveVoiceProfile',
      payload: expect.objectContaining({
        voice_id: 'standard:en_pack:ava',
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-remove-/u)
      }),
      reason: 'Remove spoken reply voice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:standard:en_pack:ava'],
      path: '/api/TTS/RemoveVoiceProfile'
    }))
    expect(adminExecute.mock.calls.find(([input]) => input.methodId === 'TTS.RemoveVoiceProfile')?.[0]).not.toHaveProperty('phrase')
    expect(visibleText(container)).toContain('Voice removed.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('prevents duplicate confirmed removal while the request is pending', async () => {
    const pendingRemove = deferred<unknown>()
    const adminExecute = vi.fn((input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return Promise.resolve(adminResult({ profiles: [profile({ installed: true, ready: true, default: false, active: false })] }))
      if (input.methodId === 'TTS.ListLanguagePacks') return Promise.resolve(adminResult({ packs: [] }))
      return pendingRemove.promise
    })
    const client = voiceClient({ adminExecute })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonByText(document.body, 'Removing').disabled).toBe(true)
    await act(async () => {
      buttonByText(document.body, 'Removing').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.RemoveVoiceProfile')).toHaveLength(1)
    pendingRemove.resolve(adminResult(mutationResult('removed')))
    await flushReactWork()
    await unmount()
  })

  it('deletes only allowed cloned profiles after confirmation and refreshes', async () => {
    const deleteVoiceProfile = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        const listCalls = adminExecute.mock.calls.filter(([call]) => call.methodId === 'TTS.ListVoiceProfiles').length
        return adminResult({
          profiles: listCalls === 1
            ? [
              profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true }),
              profile({ display_name: 'Eli', voice_id: 'clone:22222222-2222-4222-8222-222222222222', kind: 'cloned', installed: true, ready: true, default: true, active: true, retained_source: true })
            ]
            : []
        })
      }
      return adminResult(mutationResult<DeleteStatus>('deleted', 'clone:11111111-1111-4111-8111-111111111111'))
    })
    const client = voiceClient({ deleteVoiceProfile, adminExecute })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    expect(buttonsByText(container, 'Delete')).toHaveLength(1)
    await act(async () => {
      buttonByText(container, 'Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(visibleText(document.body)).toContain('Delete voice?')
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(deleteVoiceProfile).not.toHaveBeenCalled()
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.DeleteVoiceProfile',
      payload: expect.objectContaining({
        voice_id: 'clone:11111111-1111-4111-8111-111111111111',
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-delete-/u)
      }),
      reason: 'Delete spoken reply voice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:clone:11111111-1111-4111-8111-111111111111'],
      path: '/api/TTS/DeleteVoiceProfile'
    }))
    expect(adminExecute.mock.calls.find(([input]) => input.methodId === 'TTS.DeleteVoiceProfile')?.[0]).not.toHaveProperty('phrase')
    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.ListVoiceProfiles')).toHaveLength(2)
    expect(visibleText(container)).toContain('Voice deleted.')
    expect(visibleText(container)).not.toContain('11111111-1111-4111-8111-111111111111')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('keeps failure copy clean for remove and delete results', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        return adminResult({
          profiles: [
            profile({ display_name: 'Ava', voice_id: 'standard:en_pack:ava', installed: true, ready: true, default: false, active: false }),
            profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })
          ]
        })
      }
      if (input.methodId === 'TTS.RemoveVoiceProfile') return adminResult(mutationResult<RemoveStatus>('rejected'))
      return adminResult(mutationResult<DeleteStatus>('rejected', 'clone:11111111-1111-4111-8111-111111111111'))
    })
    const client = voiceClient({
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    expect(visibleText(container)).toContain('Voice was not removed. Try again.')

    await act(async () => {
      buttonByText(container, 'Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    const text = visibleText(container)
    expect(text).toContain('Voice was not deleted. Try again.')
    expect(text).not.toContain('standard:en_pack:ava')
    expect(text).not.toContain('11111111-1111-4111-8111-111111111111')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('does not render hostile voice names, pack names, or internal wording', async () => {
    const client = voiceClient({
      voices: [
        voice({
          display_name: 'raw provider manifest standard:en_pack:ava',
          attribution_label: 'provider',
          voice_id: 'standard:en_pack:ava'
        })
      ],
      profiles: [
        profile({
          display_name: 'schema fallback services.tts.provider raw',
          voice_id: 'standard:en_pack:ava',
          installed: false,
          ready: false
        })
      ]
    })
    const { container, unmount } = await renderVoiceSettings(client)
    await loadManagedVoices(container)
    const text = visibleText(container)

    expect(text).toContain('Voice option 1')
    expect(text).toContain('Available voice 1')
    expect(text).not.toContain('standard:en_pack:ava')
    expect(text).not.toContain('en_pack')
    expect(text).not.toContain('provider')
    expect(text).not.toContain('schema')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('keeps Settings as a local This-device page without spoken-reply tabs', () => {
    const snapshot = webSnapshot()
    const route = availableRoute(snapshot, 'settings')
    const markup = renderToStaticMarkup(
      <SettingsView
        client={voiceClient()}
        snapshot={snapshot}
        configRoute={availableRoute(snapshot, 'config') ?? route}
        dataRoute={availableRoute(snapshot, 'data') ?? route}
      />
    )

    expect(markup).toContain('This device')
    expect(markup).not.toContain('id="settings-home-title"')
    expect(markup).not.toContain('All Aurora settings')
    expect(markup).not.toContain('>General<')
    expect(markup).not.toContain('role="tab"')
    expect(markup).not.toContain('role="tablist"')
    expect(markup).not.toContain('Configuration')
    expect(markup).not.toContain('>Advanced<')
  })

  it('hides server spoken-reply controls in This-device Settings and on-device sections in Operate', async () => {
    const client = voiceClient({
      profiles: [profile({ installed: false, ready: false })]
    })
    const local = await renderVoiceSettings(client, { hideServerVoiceSections: true })
    expect(local.container.querySelector('[aria-label="Spoken reply summary"]')).toBeNull()
    expect(local.container.textContent).not.toContain('Spoken reply voices')
    expect(local.container.textContent).not.toContain('Voices available to Aurora')
    expect(local.container.textContent).toContain('Wake phrase')
    await local.unmount()

    const operate = await renderVoiceSettings(client, { hideOnDeviceSections: true })
    expect(operate.container.querySelector('[aria-label="Spoken reply summary"]')).not.toBeNull()
    expect(operate.container.textContent).toContain('Spoken reply voices')
    expect(operate.container.textContent).toContain('Voices available to Aurora')
    expect(operate.container.textContent).not.toContain('Wake phrase')
    await operate.unmount()
  })

  it('keeps shared web and client copy neutral about where voices are kept', async () => {
    const client = voiceClient({
      profiles: [profile({ installed: false, ready: false })]
    })
    const { container, unmount } = await renderVoiceSettings(client)
    await loadManagedVoices(container)
    const text = visibleText(container)

    expect(text).toContain('Voices available to Aurora')
    expect(text).toContain('Can be added for spoken replies.')
    expect(text).not.toMatch(/\b(?:this device|on this device|kept on|stored|local storage|saved voices|saved voice)\b/iu)
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('shows language catalog metadata but downloads only the selected voice', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [] })
      if (input.methodId === 'TTS.ListLanguagePacks') {
        return adminResult({
          packs: [
            languagePack({
              pack_id: 'pt-br',
              language: 'pt-BR',
              display_name: 'Brazilian Portuguese',
              installed: false,
              ready: false,
              active: false,
              default: false,
              downloadable: true,
              voices: [{
                voice_id: 'standard:piper:pt_br-faber-medium',
                display_name: 'Faber medium',
                revision: 'voice-rev-pt-br-1',
                installed: false,
                ready: false,
                active: false,
                default: false,
              }],
            }),
          ],
        })
      }
      if (input.methodId === 'TTS.InstallVoiceProfile') return adminResult(installResult('installed'))
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({
        ready: false,
        ready_languages: [],
        supported_language_pack_ids: ['pt-br'],
        installed_language_pack_ids: [],
        resident_language_pack_ids: [],
        resident_language_packs: [],
        language_packs: [languagePack({ pack_id: 'pt-br', language: 'pt-BR', languages: ['pt-BR'], ready_languages: ['pt-BR'], installed: false, ready: false, active: false, default: false })],
        engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
      voices: [],
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    const text = visibleText(container)
    expect(text).toContain('Brazilian Portuguese')
    expect(text).toContain('Available with supported voices.')
    expect(text).not.toContain('pt-BR-local')
    expect(buttonsByText(container, 'Add and use')).toHaveLength(0)

    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.InstallVoiceProfile',
      payload: expect.objectContaining({
        voice_id: 'standard:piper:pt_br-faber-medium',
        expected_revision: 'voice-rev-pt-br-1',
        operation_id: expect.stringMatching(/^voice-install-/u)
      }),
      reason: 'Add spoken reply voice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:standard:piper:pt_br-faber-medium'],
      path: '/api/TTS/InstallVoiceProfile'
    }))
    expect(new Set(adminExecute.mock.calls.map(([input]) => input.methodId))).toEqual(new Set([
      'TTS.ListVoiceProfiles',
      'TTS.ListLanguagePacks',
      'TTS.InstallVoiceProfile',
    ]))
    expect(visibleText(container)).toContain('Voice added.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('keeps returned language rows visible when the catalog reports limited availability', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [] })
      if (input.methodId === 'TTS.ListLanguagePacks') {
        return adminResult({
          catalog_status: 'unavailable',
          catalog_error_code: 'catalog_unavailable',
          packs: [
            languagePack({
              pack_id: 'en',
              language: 'en',
              display_name: 'English',
              installed: true,
              ready: true,
              default: true,
              voices: [{
                voice_id: 'standard:starter_en:alba',
                display_name: 'Alba',
                revision: 'voice-rev-en-1',
                installed: true,
                ready: true,
                active: false,
                default: true,
              }],
            }),
          ],
        })
      }
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({
        supported_language_pack_ids: ['en-local'],
        installed_language_pack_ids: ['en-local'],
        resident_language_pack_ids: ['en-local'],
        resident_language_packs: [{ pack_id: 'en-local', ready_languages: ['en'] }],
        active_language_pack_id: 'en-local',
        default_language_pack_id: 'en-local',
        language_packs: [],
      }),
      voices: [],
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)

    const text = visibleText(container)
    expect(text).toContain('Language options could not be loaded. Review access and try again.')
    expect(text).toContain('English')
    expect(text).toContain('Used by default for spoken replies.')
    expect(text).not.toContain('No language options are available yet.')
    expect(text).not.toContain('catalog_unavailable')
    expect(text).not.toContain('en-local')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('allows a catalog voice only when its exact voice revision maps to an advertised language capability', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [] })
      if (input.methodId === 'TTS.ListLanguagePacks') {
        return adminResult({
          catalog_status: 'available',
          catalog_error_code: null,
          packs: [
            languagePack({
              pack_id: 'en',
              language: 'en',
              display_name: 'English',
              installed: false,
              ready: false,
              voices: [{
                voice_id: 'standard:starter_en:alba',
                display_name: 'Alba',
                revision: 'voice-rev-en-1',
                installed: false,
                ready: false,
                active: false,
                default: false,
              }],
            }),
          ],
        })
      }
      if (input.methodId === 'TTS.InstallVoiceProfile') return adminResult(installResult('installed'))
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({
        ready: false,
        ready_languages: [],
        supported_language_pack_ids: ['en-local'],
        installed_language_pack_ids: [],
        resident_language_pack_ids: [],
        resident_language_packs: [],
        language_packs: [],
      }),
      voices: [],
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.InstallVoiceProfile',
      payload: expect.objectContaining({
        voice_id: 'standard:starter_en:alba',
        expected_revision: 'voice-rev-en-1',
        operation_id: expect.stringMatching(/^voice-install-/u)
      }),
      affectedResources: ['voice-profile:standard:starter_en:alba'],
      path: '/api/TTS/InstallVoiceProfile'
    }))
    const text = visibleText(container)
    expect(text).toContain('Voice added.')
    expect(text).not.toContain('standard:starter_en:alba')
    expect(text).not.toContain('en-local')
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenCalledWith({
      tts: {
        packId: 'en',
        packRevision: 'pack-rev-1',
        voiceId: 'standard:starter_en:alba',
        voiceRevision: 'voice-rev-en-1',
      },
    })
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('keeps catalog-only voice installs disabled when no language capability is advertised', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [] })
      if (input.methodId === 'TTS.ListLanguagePacks') {
        return adminResult({
          catalog_status: 'available',
          catalog_error_code: null,
          packs: [
            languagePack({
              pack_id: 'en',
              language: 'en',
              display_name: 'English',
              installed: false,
              ready: false,
              voices: [{
                voice_id: 'standard:starter_en:alba',
                display_name: 'Alba',
                revision: 'voice-rev-en-1',
                installed: false,
                ready: false,
                active: false,
                default: false,
              }],
            }),
          ],
        })
      }
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({
        ready: false,
        ready_languages: [],
        supported_language_pack_ids: [],
        installed_language_pack_ids: [],
        resident_language_pack_ids: [],
        resident_language_packs: [],
        language_packs: [],
      }),
      voices: [],
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)

    const text = visibleText(container)
    expect(text).toContain('English')
    expect(text).toContain('Not available for spoken replies on this Aurora.')
    expect(buttonsByText(container, 'Add voice')).toHaveLength(0)
    expect(adminExecute.mock.calls.filter(([input]) => input.methodId === 'TTS.InstallVoiceProfile')).toHaveLength(0)
    expect(text).not.toContain('standard:starter_en:alba')
    expect(text).not.toContain('Can be added for spoken replies.')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('persists catalog-backed on-device speech choices with exact pack revisions', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({
        local_speech_assets: {
          vad: [{
            pack_id: 'vad.webrtc',
            revision: 'vad-rev-1',
            display_name: 'Speech start',
            installed: true,
            ready: true,
          }],
          wakeword: [{
            pack_id: 'wake.aurora',
            revision: 'wake-rev-1',
            display_name: 'Aurora wake phrase',
            installed: true,
            ready: true,
          }],
          stt: [{
            pack_id: 'whisper.tiny.en',
            revision: 'stt-rev-1',
            display_name: 'English transcription',
            installed: true,
            ready: true,
          }],
        },
      }),
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    await act(async () => {
      buttonByText(container, 'Use listening start').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Use wake phrase').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Use transcription').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(1, {
      vad: {
        packId: 'vad.webrtc',
        packRevision: 'vad-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(2, {
      kws: {
        packId: 'wake.aurora',
        packRevision: 'wake-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(3, {
      stt: {
        packId: 'whisper.tiny.en',
        packRevision: 'stt-rev-1',
      },
    })
    const text = visibleText(container)
    expect(text).toContain('On-device speech')
    expect(text).not.toContain('vad.webrtc')
    expect(text).not.toContain('wake.aurora')
    expect(text).not.toContain('whisper.tiny.en')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('uses the local speech catalog port for on-demand speech and voice choices', async () => {
    const select = vi.fn(async (request: Parameters<NonNullable<VoiceSettingsViewProps['localSpeechCatalog']>['select']>[0]) => {
      request.onProgress?.({ state: 'downloading', receivedBytes: 50, totalBytes: 100 })
      request.onProgress?.({ state: 'saving' })
      request.onProgress?.({ state: 'ready' })
      return {
        task: request.selection.task,
        packId: request.selection.packId,
        packVersion: request.selection.packVersion,
        trust: {
          task: request.selection.task,
          packId: request.selection.packId,
          packVersion: request.selection.packVersion,
          voiceId: request.selection.voiceId,
          ...(request.selection.referenceProfileId ? { referenceProfileId: request.selection.referenceProfileId } : {}),
          releaseKeyId: 'aurora-release',
          releasePublicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          expectedManifestSha256: 'a'.repeat(64),
        },
      }
    })
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const client = voiceClient({ capabilities: capabilities({ engine_capabilities: { vad: true, kws: true, stt: true, tts: true } }) })
    const { container, unmount } = await renderVoiceSettings(client, {
      runtimeProfile: meshVoiceRuntimeProfile(),
      onLocalSpeechSelectionConfirmed,
      localSpeechCatalog: {
        available: true,
        listCatalog: vi.fn(async () => ({
          state: 'ready' as const,
          items: [{
            task: 'stt' as const,
            packId: 'whisper.tiny.en',
            packVersion: 'stt-rev-1',
            displayName: 'English transcription',
            language: 'English',
          }, {
            task: 'tts' as const,
            packId: 'piper.en',
            packVersion: 'tts-pack-rev-1',
            profilePackId: 'en',
            profilePackRevision: 'tts-catalog-rev-1',
            displayName: 'Ava',
            language: 'English',
            voiceId: 'ava.en',
            voiceRevision: 'voice-rev-1',
          }, {
            task: 'tts' as const,
            packId: 'pocket.en',
            packVersion: 'pocket-pack-rev-1',
            profilePackId: 'en',
            profilePackRevision: 'tts-catalog-rev-1',
            displayName: 'Pocket voice',
            language: 'English',
            voiceId: 'pocket.en',
            voiceRevision: 'pocket-voice-rev-1',
            cached: true,
            active: true,
            requiresReferenceProfile: true,
            referenceProfileSelected: false,
          }],
        })),
        listReferenceProfiles: vi.fn(async () => []),
        saveReferenceProfile: vi.fn(async () => ({
          id: 'voice-ref-1',
          label: 'sample.wav',
          transcript: '',
          sampleRateHz: 16_000,
          durationMs: 1000,
          byteLength: 32044,
          sha256: 'c'.repeat(64),
          createdAtMs: 1,
          updatedAtMs: 1,
        })),
        select,
      },
    })
    await flushReactWork()

    await act(async () => {
      buttonByText(container, 'Add').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Add voice sample').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    expect(select).toHaveBeenCalledTimes(2)
    expect(visibleText(container)).toContain('Add a short WAV recording of the voice to clone.')
    expect(visibleText(container)).not.toContain('Spoken words')
    expect(visibleText(container)).not.toContain('type the words spoken')
    expect(container.querySelector('textarea')).toBeNull()
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement | null
    if (!fileInput) throw new Error('expected voice sample form')
    const file = new File([new Uint8Array([1, 2, 3])], 'sample.wav', { type: 'audio/wav' })
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer) })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Save sample').click()
    })
    await flushReactWork()

    expect(select).toHaveBeenNthCalledWith(1, expect.objectContaining({
      selection: expect.objectContaining({
        task: 'stt',
        packId: 'whisper.tiny.en',
        packVersion: 'stt-rev-1',
      }),
    }))
    expect(select).toHaveBeenNthCalledWith(2, expect.objectContaining({
      selection: expect.objectContaining({
        task: 'tts',
        packId: 'piper.en',
        packVersion: 'tts-pack-rev-1',
        voiceId: 'ava.en',
        voiceRevision: 'voice-rev-1',
      }),
    }))
    expect(select).toHaveBeenNthCalledWith(3, expect.objectContaining({
      selection: expect.objectContaining({
        task: 'tts',
        packId: 'pocket.en',
        packVersion: 'pocket-pack-rev-1',
        voiceId: 'pocket.en',
        voiceRevision: 'pocket-voice-rev-1',
        referenceProfileId: 'voice-ref-1',
        referenceProfileSelected: true,
      }),
    }))
    expect(select).toHaveBeenCalledTimes(3)
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(1, {
      stt: {
        packId: 'whisper.tiny.en',
        packRevision: 'stt-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(2, {
      tts: {
        packId: 'en',
        packRevision: 'tts-catalog-rev-1',
        voiceId: 'ava.en',
        voiceRevision: 'voice-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(3, {
      tts: {
        packId: 'en',
        packRevision: 'tts-catalog-rev-1',
        voiceId: 'pocket.en',
        voiceRevision: 'pocket-voice-rev-1',
        referenceProfileId: 'voice-ref-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenCalledTimes(3)
    const text = visibleText(container)
    expect(text).toContain('On-device speech')
    expect(text).toContain('On-device voices')
    expect(text).toContain('Voice sample saved.')
    expect(text).not.toContain('Voice choice updated.')
    expect(text).not.toContain('whisper.tiny.en')
    expect(text).not.toContain('piper.en')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('shows catalog choices before cached speech is ready and downloads only the selected item', async () => {
    const select = vi.fn(async (request: Parameters<NonNullable<VoiceSettingsViewProps['localSpeechCatalog']>['select']>[0]) => ({
      task: request.selection.task,
      packId: request.selection.packId,
      packVersion: request.selection.packVersion,
      trust: {
        task: request.selection.task,
        packId: request.selection.packId,
        packVersion: request.selection.packVersion,
        expectedManifestSha256: 'a'.repeat(64),
      },
    }))
    const client = voiceClient({ capabilities: capabilities({ engine_capabilities: { vad: false, kws: false, stt: false, tts: false } }) })
    const { container, unmount } = await renderVoiceSettings(client, {
      runtimeProfile: meshVoiceRuntimeProfile(),
      surfaceProfile: browserCatalogSurfaceProfile(),
      onLocalSpeechSelectionConfirmed: vi.fn(),
      localSpeechCatalog: {
        available: true,
        listCatalog: vi.fn(async () => ({
          state: 'ready' as const,
          items: [{
            task: 'vad' as const,
            packId: 'vad.web',
            packVersion: 'vad-rev-1',
            displayName: 'Speech start',
          }, {
            task: 'stt' as const,
            packId: 'stt.web',
            packVersion: 'stt-rev-1',
            displayName: 'English transcription',
          }],
        })),
        listReferenceProfiles: vi.fn(async () => []),
        select,
      },
    })
    await flushReactWork()

    const beforeClickText = visibleText(container)
    expect(beforeClickText).toContain('Speech start')
    expect(beforeClickText).toContain('English transcription')
    expect(select).not.toHaveBeenCalled()

    await act(async () => {
      buttonByText(container, 'Add').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(select).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      selection: expect.objectContaining({ task: 'stt', packId: 'stt.web' }),
    }))
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('allows local speech choice persistence for capable remote-console profiles', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({
        local_speech_packs: [{
          task: 'vad',
          pack_id: 'vad.webrtc',
          revision: 'vad-rev-1',
          display_name: 'Speech start',
          installed: true,
          ready: true,
        }, {
          task: 'wakeword',
          pack_id: 'wake.aurora',
          revision: 'wake-rev-1',
          display_name: 'Aurora wake phrase',
          installed: true,
          ready: true,
        }, {
          task: 'stt',
          pack_id: 'whisper.tiny.en',
          revision: 'stt-rev-1',
          display_name: 'English transcription',
          installed: true,
          ready: true,
        }],
      }),
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: remoteVoiceRuntimeProfile(),
    })

    await act(async () => {
      buttonByText(container, 'Use listening start').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Use wake phrase').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    await act(async () => {
      buttonByText(container, 'Use transcription').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(1, {
      vad: {
        packId: 'vad.webrtc',
        packRevision: 'vad-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(2, {
      kws: {
        packId: 'wake.aurora',
        packRevision: 'wake-rev-1',
      },
    })
    expect(onLocalSpeechSelectionConfirmed).toHaveBeenNthCalledWith(3, {
      stt: {
        packId: 'whisper.tiny.en',
        packRevision: 'stt-rev-1',
      },
    })
    const text = visibleText(container)
    expect(text).toContain('On-device speech')
    expect(text).not.toContain('vad.webrtc')
    expect(text).not.toContain('wake.aurora')
    expect(text).not.toContain('whisper.tiny.en')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('hides local speech choice persistence when the surface has no local engine evidence', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({
        engine_capabilities: { vad: false, kws: false, stt: false, tts: false },
        local_speech_packs: [{
          task: 'vad',
          pack_id: 'vad.webrtc',
          revision: 'vad-rev-1',
          display_name: 'Speech start',
          installed: true,
          ready: true,
        }, {
          task: 'wakeword',
          pack_id: 'wake.aurora',
          revision: 'wake-rev-1',
          display_name: 'Aurora wake phrase',
          installed: true,
          ready: true,
        }, {
          task: 'stt',
          pack_id: 'whisper.tiny.en',
          revision: 'stt-rev-1',
          display_name: 'English transcription',
          installed: true,
          ready: true,
        }],
      }),
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: remoteVoiceRuntimeProfile(),
    })

    const text = visibleText(container)
    expect(text).not.toContain('On-device speech')
    expect(buttonsByText(container, 'Use listening start')).toHaveLength(0)
    expect(buttonsByText(container, 'Use wake phrase')).toHaveLength(0)
    expect(buttonsByText(container, 'Use transcription')).toHaveLength(0)
    expect(onLocalSpeechSelectionConfirmed).not.toHaveBeenCalled()
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('does not render or persist VAD, wake phrase, or transcription choices on TTS-only devices', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const client = voiceClient({
      capabilities: capabilities({
        engine_capabilities: { vad: false, kws: false, stt: false, tts: true },
        local_speech_assets: {
          vad: [{
            pack_id: 'vad.webrtc',
            revision: 'vad-rev-1',
            display_name: 'Speech start',
            installed: true,
            ready: true,
          }],
          wakeword: [{
            pack_id: 'wake.aurora',
            revision: 'wake-rev-1',
            display_name: 'Aurora wake phrase',
            installed: true,
            ready: true,
          }],
          stt: [{
            pack_id: 'whisper.tiny.en',
            revision: 'stt-rev-1',
            display_name: 'English transcription',
            installed: true,
            ready: true,
          }],
        },
      }),
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      onLocalSpeechSelectionConfirmed,
      runtimeProfile: meshVoiceRuntimeProfile(),
    })

    const text = visibleText(container)
    expect(text).not.toContain('On-device speech')
    expect(buttonsByText(container, 'Use listening start')).toHaveLength(0)
    expect(buttonsByText(container, 'Use wake phrase')).toHaveLength(0)
    expect(buttonsByText(container, 'Use transcription')).toHaveLength(0)
    expect(onLocalSpeechSelectionConfirmed).not.toHaveBeenCalled()
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('shows a limited state instead of treating missing language options as an empty catalog', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        return adminResult({
          profiles: [profile({
            installed: false,
            ready: false,
            compatible_language_pack_ids: ['pt-BR-local'],
          })],
        })
      }
      if (input.methodId === 'TTS.ListLanguagePacks') {
        throw { code: 'not_found', message: 'TTS.ListLanguagePacks unavailable provider manifest' }
      }
      throw new Error(`Unexpected action: ${input.methodId}`)
    })
    const client = voiceClient({
      adminExecute,
      capabilities: capabilities({
        ready: false,
        ready_languages: [],
        supported_language_pack_ids: [],
        installed_language_pack_ids: [],
        resident_language_pack_ids: [],
        resident_language_packs: [],
        language_packs: [],
      }),
      voices: [voice({ compatible_language_pack_ids: ['pt-BR-local'], ready: false })],
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)

    const text = visibleText(container)
    expect(text).toContain('Language options could not be loaded. Review access and try again.')
    expect(text).not.toContain('No language options are available yet.')
    expect(text).not.toContain('pt-BR-local')
    expect(buttonsByText(container, 'Add and use')).toHaveLength(0)
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('does not mark speech downloads ready without runtime profile evidence', async () => {
    const client = voiceClient({
      capabilities: capabilities({
        ready: true,
        ready_languages: ['zh-Hant-TW'],
        supported_language_pack_ids: ['zh-Hant-TW-local'],
        installed_language_pack_ids: ['zh-Hant-TW-local'],
        resident_language_pack_ids: ['zh-Hant-TW-local'],
        resident_language_packs: [{ pack_id: 'zh-Hant-TW-local', ready_languages: ['zh-Hant-TW'] }],
        active_language_pack_id: 'zh-Hant-TW-local',
        default_language_pack_id: 'zh-Hant-TW-local',
        engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
      languagePacks: [
        languagePack({
          pack_id: 'zh-Hant-TW-local',
          languages: ['zh-Hant-TW'],
          ready_languages: ['zh-Hant-TW'],
          installed: true,
          ready: true,
          active: true,
          default: true,
        }),
      ],
    })
    const { container, unmount } = await renderVoiceSettings(client)
    await loadManagedVoices(container)

    const text = visibleText(container)
    expect(text).toContain('Chinese')
    expect(text).toContain('Spoken replies come from the connected Aurora device.')
    expect(text).not.toContain('This device can speak without a remote connection.')
    expect(text).toContain('Used by default for spoken replies.')
    expect(text).not.toContain('zh-Hant-TW-local')
    assertNoForbiddenCopy(text)
    await unmount()

    const readyClient = voiceClient({
      capabilities: capabilities({
        ready: true,
        ready_languages: ['zh-Hant-TW'],
        supported_language_pack_ids: ['zh-Hant-TW-local'],
        installed_language_pack_ids: ['zh-Hant-TW-local'],
        resident_language_pack_ids: ['zh-Hant-TW-local'],
        resident_language_packs: [{ pack_id: 'zh-Hant-TW-local', ready_languages: ['zh-Hant-TW'] }],
        active_language_pack_id: 'zh-Hant-TW-local',
        default_language_pack_id: 'zh-Hant-TW-local',
        engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
      languagePacks: [
        languagePack({
          pack_id: 'zh-Hant-TW-local',
          languages: ['zh-Hant-TW'],
          ready_languages: ['zh-Hant-TW'],
          installed: true,
          ready: true,
          active: true,
          default: true,
        }),
      ],
    })
    const readyRendered = await renderVoiceSettings(readyClient, { runtimeProfile: meshVoiceRuntimeProfile() })
    await loadManagedVoices(readyRendered.container)

    const readyText = visibleText(readyRendered.container)
    expect(readyText).toContain('This device can speak without a remote connection.')
    expect(readyText).toContain('Used by default for spoken replies.')
    expect(readyText).not.toContain('zh-Hant-TW-local')
    assertNoForbiddenCopy(readyText)
    await readyRendered.unmount()
  })

  it('updates the wake phrase without replacing selected speech packs', async () => {
    const onLocalSpeechSelectionConfirmed = vi.fn()
    const runtimeProfile = meshVoiceRuntimeProfile()
    runtimeProfile.localNode.localSpeechPackState = 'ready'
    runtimeProfile.localNode.localSpeechSelection = {
      vad: { packId: 'vad-small.en', packRevision: 'vad-rev-1' },
      kws: {
        packId: 'sherpa-kws-zipformer-gigaspeech.en',
        packRevision: 'kws-rev-2',
      },
      stt: { packId: 'whisper.en', packRevision: 'stt-rev-3' },
      tts: {
        packId: 'piper.en',
        packRevision: 'pack-rev-4',
        voiceId: 'standard:piper.en:ava',
        voiceRevision: 'voice-rev-5',
      },
      wakePhrase: {
        phraseId: 'aurora.en',
        phrase: 'Aurora',
        language: 'en',
        revision: 'wakephrase-v1-old',
      },
    }
    const client = voiceClient({
      capabilities: capabilities({
        engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
    })
    const { container, unmount } = await renderVoiceSettings(client, {
      runtimeProfile,
      onLocalSpeechSelectionConfirmed,
    })

    expect(visibleText(container)).toContain('Wake phrase')
    expect(visibleText(container)).toContain('Hey Aurora')
    expect(visibleText(container)).toContain('Selected')
    await act(async () => {
      buttonByText(container, 'Use phrase').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(onLocalSpeechSelectionConfirmed).toHaveBeenCalledWith({
      vad: { packId: 'vad-small.en', packRevision: 'vad-rev-1' },
      kws: {
        packId: 'sherpa-kws-zipformer-gigaspeech.en',
        packRevision: 'kws-rev-2',
      },
      stt: { packId: 'whisper.en', packRevision: 'stt-rev-3' },
      tts: {
        packId: 'piper.en',
        packRevision: 'pack-rev-4',
        voiceId: 'standard:piper.en:ava',
        voiceRevision: 'voice-rev-5',
      },
      wakePhrase: {
        phraseId: 'hey-aurora.en',
        phrase: 'Hey Aurora',
        language: 'en',
        revision: expect.stringMatching(/^wakephrase-v1-[a-z0-9]{7,}$/u),
      },
    })
    const text = visibleText(container)
    expect(text).toContain('Wake phrase updated.')
    expect(text).not.toContain('sherpa-kws-zipformer-gigaspeech.en')
    expect(text).not.toContain('kws-rev-2')
    assertNoForbiddenCopy(text)
    await unmount()
  })
})

function voiceClient(overrides: {
  capabilities?: Capabilities
  voices?: Voice[]
  profiles?: Profile[]
  languagePacks?: LanguagePack[]
  getCapabilities?: ReturnType<typeof vi.fn>
  listVoices?: ReturnType<typeof vi.fn>
  listVoiceProfiles?: ReturnType<typeof vi.fn>
  adminExecute?: ReturnType<typeof vi.fn>
  installVoiceProfile?: ReturnType<typeof vi.fn>
  removeVoiceProfile?: ReturnType<typeof vi.fn>
  setDefaultVoice?: ReturnType<typeof vi.fn>
  deleteVoiceProfile?: ReturnType<typeof vi.fn>
  exportVoiceProfile?: ReturnType<typeof vi.fn>
  importVoiceProfile?: ReturnType<typeof vi.fn>
} = {}): AuroraClient {
  const getCapabilities = overrides.getCapabilities ?? vi.fn(async () => ({ ok: true, data: { capabilities: overrides.capabilities ?? capabilities() } }))
  const listVoices = overrides.listVoices ?? vi.fn(async () => ({ ok: true, data: { voices: overrides.voices ?? [voice()] } }))
  const directVoiceManageCall = vi.fn(async () => {
    throw new Error('Direct voice management call bypassed review')
  })
  const listVoiceProfiles = overrides.listVoiceProfiles ?? directVoiceManageCall
  const installVoiceProfile = overrides.installVoiceProfile ?? directVoiceManageCall
  const removeVoiceProfile = overrides.removeVoiceProfile ?? directVoiceManageCall
  const setDefaultVoice = overrides.setDefaultVoice ?? directVoiceManageCall
  const deleteVoiceProfile = overrides.deleteVoiceProfile ?? directVoiceManageCall
  const exportVoiceProfile = overrides.exportVoiceProfile ?? directVoiceManageCall
  const importVoiceProfile = overrides.importVoiceProfile ?? directVoiceManageCall
  const adminExecute = overrides.adminExecute ?? vi.fn(async (input: { methodId: string }) => {
    if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: overrides.profiles ?? [] })
    if (input.methodId === 'TTS.ListLanguagePacks') return adminResult({ packs: overrides.languagePacks ?? [] })
    if (input.methodId === 'TTS.InstallVoiceProfile') return adminResult(installResult('installed'))
    if (input.methodId === 'TTS.RemoveVoiceProfile') return adminResult(mutationResult<RemoveStatus>('removed'))
    if (input.methodId === 'TTS.SetDefaultVoice') return adminResult(mutationResult<DefaultStatus>('activated'))
    if (input.methodId === 'TTS.DeleteVoiceProfile') return adminResult(mutationResult<DeleteStatus>('deleted', 'clone:11111111-1111-4111-8111-111111111111'))
    throw new Error(`Unexpected action: ${input.methodId}`)
  })
  return {
    speech: {
      tts: {
        getCapabilities,
        listVoices,
        listVoiceProfiles,
        installVoiceProfile,
        removeVoiceProfile,
        setDefaultVoice,
        deleteVoiceProfile,
        exportVoiceProfile,
        importVoiceProfile
      }
    },
    admin: {
      execute: adminExecute
    },
    config: {
      getSchemaMetadata: async () => ({ ok: true, data: { fields: [], secrets_redacted: true } }),
      applyChange: async () => ({ ok: true, data: { success: true } })
    },
    memory: {
      listNamespaces: async () => ({ ok: true, data: { namespaces: [] } }),
      listMessages: async () => ({ ok: true, data: { conversations: [] } })
    },
    capabilities: {
      listCatalog: async () => ({ ok: true, data: capabilityGraphCatalogFixture })
    },
    routes: {
      evaluatePolicy: async () => ({ decision: 'allowed', allowed: true, availability: 'available-local', blockers: [] })
    }
  } as unknown as AuroraClient
}

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    contract_revision: 'aurora-tts-capabilities-v1',
    ready: true,
    model_status: 'ready',
    ready_languages: ['en'],
    supported_language_pack_ids: ['en_pack'],
    installed_language_pack_ids: ['en_pack'],
    active_language_pack_id: 'en_pack',
    default_language_pack_id: 'en_pack',
    language_packs: [languagePack()],
    resident_language_pack_ids: ['en_pack'],
    resident_language_packs: [{ pack_id: 'en_pack', ready_languages: ['en'] }],
    resident_base_model_count: 1,
    max_resident_base_models: 1,
    output_formats: ['wav'],
    sample_rates: [24000],
    streaming: true,
    cancellation: true,
    cloning: false,
    engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
    ...overrides
  }
}

function languagePack(overrides: Partial<LanguagePack> = {}): LanguagePack {
  return {
    pack_id: 'en_pack',
    display_name: 'English',
    revision: 'pack-rev-1',
    languages: ['en'],
    ready_languages: ['en'],
    installed: true,
    ready: true,
    active: false,
    default: false,
    downloadable: true,
    compatible_engine: true,
    ...overrides
  }
}

function voice(overrides: Partial<Voice> = {}): Voice {
  return {
    voice_id: 'standard:en_pack:ava',
    display_name: 'Ava',
    kind: 'standard',
    preview_available: false,
    ready: true,
    revision: 'rev-1',
    compatible_language_pack_ids: ['en_pack'],
    selection_mode: 'active_only',
    visible_scope: 'local',
    ...overrides
  }
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    voice_id: 'standard:en_pack:ava',
    display_name: 'Ava',
    kind: 'standard',
    active: false,
    default: false,
    enabled: true,
    installed: true,
    ready: true,
    retained_source: false,
    revision: 'rev-1',
    visibility: 'private',
    compatible_language_pack_ids: ['en_pack'],
    ...overrides
  }
}

function installResult(status: InstallStatus): InstallOutput {
  return {
    status,
    voice_id: 'standard:en_pack:ava',
    revision: status === 'installed' ? 'rev-2' : null,
    idempotent: false
  }
}

function mutationResult<TStatus extends string>(status: TStatus, voiceId = 'standard:en_pack:ava'): MutationOutput<TStatus> {
  return {
    status,
    voice_id: voiceId,
    revision: status === 'rejected' || status === 'not_found' ? null : 'rev-2',
    idempotent: false,
    correlation_id: 'OP-123'
  }
}

function cloneTransferBundle(overrides: Partial<CloneTransferBundle> = {}): CloneTransferBundle {
  return {
    bundle_type: 'aurora-cloned-tts-voice-state',
    schema_version: 1,
    voice_id: 'clone:11111111-1111-4111-8111-111111111111',
    display_name: 'Dina',
    artifact_revision: 'clone-rev-a',
    artifact_format: 'safetensors',
    artifact_data_base64: 'ZGVyaXZlZC1zdGF0ZQ==',
    artifact_sha256: '2f6b3cf0253d17cf2fb3161e0ff8c98bc0789ec0ff7d9f4880568e680883d1ec',
    artifact_size_bytes: 13,
    compatibility_group: 'pockettts-v1',
    language_bundle: 'en_pack',
    runtime_target: 'pockettts',
    ...overrides,
  }
}

function adminResult<TData>(data: TData) {
  return {
    draft: {
      action_id: 'admin-action-1',
      nonce: 'nonce-1',
      digest: 'digest-1',
      method_id: 'TTS.ListVoiceProfiles',
      affected_resources: [],
      required_phrase: 'CONFIRM',
      required_reason: true,
      required_reauth: true,
      expires_at: '2026-08-12T00:00:00.000Z',
      expires_in_seconds: 120,
      confirmation_headers: {
        action_id: 'X-Aurora-AdminAction-Id',
        confirmation_token: 'X-Aurora-AdminAction-Token',
        digest: 'X-Aurora-AdminAction-Digest'
      }
    },
    confirmation: {
      action_id: 'admin-action-1',
      confirmation_token: 'token-1',
      digest: 'digest-1',
      confirmed: true,
      expires_at: '2026-08-12T00:00:00.000Z',
      audit_receipt: 'receipt-1',
      confirmation_headers: {
        action_id: 'X-Aurora-AdminAction-Id',
        confirmation_token: 'X-Aurora-AdminAction-Token',
        digest: 'X-Aurora-AdminAction-Digest'
      }
    },
    data
  }
}

async function renderVoiceSettings(client: AuroraClient, props: Partial<Omit<VoiceSettingsViewProps, 'client'>> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<VoiceSettingsView client={client} {...props} />)
  })
  await flushReactWork()
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

function meshVoiceRuntimeProfile(): AuroraRuntimeProfileV2 {
  return {
    version: 2,
    id: 'voice-runtime',
    label: 'This Aurora',
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    localNode: {
      nodeName: 'This Aurora',
      stablePeerId: 'voice-peer',
      enabledCapabilityPacks: ['foreground-voice'],
      localSpeechPackState: 'ready',
      meshMembership: {
        signalingUrl: 'wss://signal.example.test/mqtt',
        webrtcProfile: {
          mode: 'webrtc-only',
          appId: 'aurora',
          room: 'voice-room',
          roomSecretRef: 'voice-room-secret',
          signalingBrokers: ['wss://signal.example.test/mqtt'],
        },
      },
    },
  }
}

function browserCatalogSurfaceProfile(): NonNullable<VoiceSettingsViewProps['surfaceProfile']> {
  return {
    physicalKind: 'hosted-web',
    kind: 'web',
    legacyKind: 'web',
    deploymentKind: 'web',
    label: 'Web',
    isDesktop: false,
    isMobile: false,
    isAndroid: false,
    isIos: false,
    usesLocalSidecar: false,
    usesNativeShell: false,
    supportsDesktopCommands: false,
    supportsMobileNative: false,
    supportsIosOnly: false,
    supportsAndroidOnly: false,
    supportsNativeWebRtcBridge: false,
    isWebThin: true,
    supportsWebRtcThin: false,
    prefersWebRtcTransport: false,
    trustsNativeWebViewOrigin: false,
    canManageLocalServiceConfiguration: false,
    nodeMode: 'mesh-node',
    runtimeTier: 'lightweight-ts',
    ownsLocalNodeState: true,
    isRemoteConsole: false,
    usesBrowserVoiceRuntime: true,
    localSpeechPack: {
      state: 'downloading',
      availabilityState: 'pending',
      label: 'Speech downloads',
      detail: 'Speech choices can be added on this device.',
      blockers: [],
      canRunLocalVad: false,
      canRunLocalKws: false,
      canRunLocalStt: false,
      canRunLocalTts: false,
    },
    voiceCapture: {
      focusedPushToTalkOwner: 'webview-focused',
      wakewordOwner: 'webview-focused',
      wakewordRequiresFocus: true,
      canUseWebViewVisualizer: true,
      avoidCoordinatorPushToTalk: true,
      usesBrowserVoiceRuntime: true,
      detail: 'Speech choices can be added on this device.',
    },
    meshPeerBudget: {
      foregroundPeerLimit: null,
      backgroundPeerLimit: null,
      backgroundStandbyReason: 'connection_budget',
    },
  }
}

function remoteVoiceRuntimeProfile(): AuroraRuntimeProfileV2 {
  return {
    version: 2,
    id: 'remote-voice-runtime',
    label: 'Home Aurora',
    nodeMode: 'remote-console',
    runtimeTier: 'none',
    homeConnection: {
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://home.example.test',
      signalingUrl: 'wss://signal.example.test/mqtt',
    },
    localNode: {
      nodeName: 'This browser',
      stablePeerId: 'remote-peer',
      enabledCapabilityPacks: [],
      localSpeechPackState: 'ready',
    },
  }
}

async function loadManagedVoices(container: HTMLElement): Promise<void> {
  await unlockVoiceManagement(container)
  await act(async () => {
    buttonByText(container, 'Show available voices').dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flushReactWork()
}

async function unlockVoiceManagement(container: HTMLElement): Promise<void> {
  const checkbox = container.querySelector('input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing voice change confirmation')
  await act(async () => {
    checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flushReactWork()
}

function webSnapshot(): AuroraShellSnapshot {
  const graph = buildCapabilityGraph({
    catalog: capabilityGraphCatalogFixture,
    registry: gatewayRegistryFixture,
    nativeManifest: null,
    transportKind: 'http'
  })
  return snapshotFromGraph('http', graph, null)
}

function availableRoute(snapshot: AuroraShellSnapshot, id: string): RouteAvailability {
  return {
    ...snapshot.routes.find((route) => route.item.id === id)!,
    disabled: false,
    state: 'available-local',
    blockers: [],
    explanation: 'Ready'
  }
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  return button
}

function buttonsByText(container: HTMLElement, label: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((candidate) => candidate.textContent?.trim() === label)
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new Error('Missing input value setter')
  setter.call(input, value)
}

function textFile(text: string, name: string): File {
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: vi.fn(async () => new TextEncoder().encode(text).buffer),
  })
  return file
}

async function setFileInput(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flushReactWork()
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input')).find((candidate) => candidate.getAttribute('aria-label') === label)
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`)
  return input
}

function visibleText(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/gu, ' ').trim()
}

function assertNoForbiddenCopy(value: string): void {
  expect(findForbiddenProductionCopyTerms(value).map((term) => term.id), value).toEqual([])
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

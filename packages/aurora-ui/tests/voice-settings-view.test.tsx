// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
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
}

interface LanguagePack {
  pack_id: string
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
    const adminExecute = vi.fn(async (input: { methodId: string }) => (
      input.methodId === 'TTS.ListVoiceProfiles'
        ? adminResult({ profiles: [profile({ installed: false, ready: false })] })
        : adminResult(installResult('installed'))
    ))
    const client = voiceClient({
      installVoiceProfile,
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client)

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
      if (input.methodId === 'TTS.ListLanguagePacks') return adminResult({ language_packs: [] })
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
      if (input.methodId === 'TTS.ListLanguagePacks') return Promise.resolve(adminResult({ language_packs: [] }))
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
    const adminExecute = vi.fn(async (input: { methodId: string }) => (
      input.methodId === 'TTS.ListVoiceProfiles'
        ? adminResult({ profiles: [profile({ installed: false, ready: false })] })
        : adminResult(installResult('rejected'))
    ))
    const client = voiceClient({
      adminExecute
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await loadManagedVoices(container)
    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    const text = visibleText(container)
    expect(text).toContain('Voice was not added. Try again.')
    expect(text).not.toContain('standard:en_pack:ava')
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

  it('sets the default voice with the expected SDK payload and refreshes on success', async () => {
    const setDefaultVoice = vi.fn()
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
    const { container, unmount } = await renderVoiceSettings(client)

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
      if (input.methodId === 'TTS.ListLanguagePacks') return Promise.resolve(adminResult({ language_packs: [] }))
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

  it('wires the shared Settings voice tab', () => {
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

    expect(markup).toContain('Voice')
    expect(markup).toContain('General')
    expect(markup).toContain('Configuration')
    expect(markup).toContain('Advanced')
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
      if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: [profile({ installed: false, ready: false, compatible_language_pack_ids: ['pt-BR-local'] })] })
      if (input.methodId === 'TTS.ListLanguagePacks') {
        return adminResult({
          language_packs: [
            languagePack({
              pack_id: 'pt-BR-local',
              display_name: 'Brazilian Portuguese',
              languages: ['pt-BR'],
              ready_languages: ['pt-BR'],
              installed: false,
              ready: false,
              active: false,
              default: false,
              downloadable: true,
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
        supported_language_pack_ids: ['pt-BR-local'],
        installed_language_pack_ids: [],
        resident_language_pack_ids: [],
        resident_language_packs: [],
        language_packs: [languagePack({ pack_id: 'pt-BR-local', languages: ['pt-BR'], ready_languages: ['pt-BR'], installed: false, ready: false, active: false, default: false })],
        engine_capabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
      voices: [voice({ compatible_language_pack_ids: ['pt-BR-local'], ready: false })],
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
        voice_id: 'standard:en_pack:ava',
        expected_revision: 'rev-1',
        operation_id: expect.stringMatching(/^voice-install-/u)
      }),
      reason: 'Add spoken reply voice: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profile:standard:en_pack:ava'],
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
  const adminExecute = overrides.adminExecute ?? vi.fn(async (input: { methodId: string }) => {
    if (input.methodId === 'TTS.ListVoiceProfiles') return adminResult({ profiles: overrides.profiles ?? [] })
    if (input.methodId === 'TTS.ListLanguagePacks') return adminResult({ language_packs: overrides.languagePacks ?? [] })
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
        deleteVoiceProfile
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

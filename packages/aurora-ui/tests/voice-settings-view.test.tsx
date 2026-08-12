// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
import { VoiceSettingsView } from '../src/voice-settings-view'
import { SettingsView } from '../src/settings-view'
import { findForbiddenProductionCopyTerms } from '../src/product-copy-forbidden-terms'
import type { AuroraShellSnapshot, RouteAvailability } from '../src/shell-data'
import { buildCapabilityGraph, capabilityGraphCatalogFixture, gatewayRegistryFixture } from '@aurora/client'
import { snapshotFromGraph } from '../src/shell-data'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SpeechLanguage = 'de' | 'en' | 'es' | 'fr' | 'it' | 'ja' | 'ko' | 'pt' | 'zh'
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
  resident_language_pack_ids: string[]
  resident_language_packs: Array<{ pack_id: string; ready_languages: SpeechLanguage[] }>
  resident_base_model_count: number
  max_resident_base_models: number
  output_formats: string[]
  sample_rates: number[]
  streaming: boolean
  cancellation: boolean
  cloning: boolean
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
    const client = voiceClient({
      installVoiceProfile,
      listVoiceProfiles: vi.fn(async () => ({ ok: false, error: { code: 'permission_denied', message: 'TTS.manage denied raw provider manifest' } }))
    })
    const { container, unmount } = await renderVoiceSettings(client)

    expect(client.speech.tts.getCapabilities).toHaveBeenCalledTimes(1)
    expect(client.speech.tts.listVoices).toHaveBeenCalledTimes(1)
    expect(client.speech.tts.listVoiceProfiles).toHaveBeenCalledTimes(1)
    expect(installVoiceProfile).not.toHaveBeenCalled()

    const text = visibleText(container)
    expect(text).toContain('English')
    expect(text).toContain('Ava')
    expect(text).toContain('Available voices could not be loaded. Review access and try again.')
    expect(text).not.toContain('standard:en_pack:ava')
    expect(text).not.toContain('en_pack')
    assertNoForbiddenCopy(text)
    await unmount()
  })

  it('adds a voice only after an explicit click', async () => {
    const installVoiceProfile = vi.fn(async () => ({ ok: true, data: installResult('installed') }))
    const client = voiceClient({
      installVoiceProfile,
      profiles: [profile({ installed: false, ready: false })]
    })
    const { container, unmount } = await renderVoiceSettings(client)

    expect(installVoiceProfile).not.toHaveBeenCalled()
    const button = buttonByText(container, 'Add voice')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(installVoiceProfile).toHaveBeenCalledTimes(1)
    expect(installVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      voice_id: 'standard:en_pack:ava',
      expected_revision: 'rev-1'
    }))
    expect(visibleText(container)).toContain('Voice added.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('uses distinct fallback operation IDs for sequential installs', async () => {
    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true })
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(123456)
    const operationIds: string[] = []
    const installVoiceProfile = vi.fn(async (input: { operation_id: string }) => {
      operationIds.push(input.operation_id)
      return { ok: true, data: installResult('installed') }
    })
    const client = voiceClient({
      installVoiceProfile,
      profiles: [profile({ installed: false, ready: false })]
    })
    let unmount: (() => Promise<void>) | null = null

    try {
      const rendered = await renderVoiceSettings(client)
      unmount = rendered.unmount
      const { container } = rendered
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
    const pendingInstall = deferred<{ ok: true, data: InstallOutput }>()
    const installVoiceProfile = vi.fn(() => pendingInstall.promise)
    const client = voiceClient({
      installVoiceProfile,
      profiles: [profile({ installed: false, ready: false })]
    })
    const { container, unmount } = await renderVoiceSettings(client)

    await act(async () => {
      buttonByText(container, 'Add voice').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(buttonByText(container, 'Adding').disabled).toBe(true)
    await act(async () => {
      buttonByText(container, 'Adding').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(installVoiceProfile).toHaveBeenCalledTimes(1)
    pendingInstall.resolve({ ok: true, data: installResult('installed') })
    await flushReactWork()
    await unmount()
  })

  it('maps install outcomes without exposing returned identifiers', async () => {
    const installVoiceProfile = vi.fn(async () => ({ ok: true, data: installResult('rejected') }))
    const client = voiceClient({
      installVoiceProfile,
      profiles: [profile({ installed: false, ready: false })]
    })
    const { container, unmount } = await renderVoiceSettings(client)

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
    const setDefaultVoice = vi.fn(async () => ({ ok: true, data: mutationResult<DefaultStatus>('activated') }))
    const listVoiceProfiles = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { profiles: [profile({ default: false, ready: true, installed: true })] } })
      .mockResolvedValue({ ok: true, data: { profiles: [profile({ default: true, active: true, ready: true, installed: true })] } })
    const client = voiceClient({ setDefaultVoice, listVoiceProfiles })
    const { container, unmount } = await renderVoiceSettings(client)

    await act(async () => {
      buttonByText(container, 'Use by default').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(setDefaultVoice).toHaveBeenCalledTimes(1)
    expect(setDefaultVoice).toHaveBeenCalledWith(expect.objectContaining({
      voice_id: 'standard:en_pack:ava',
      expected_revision: 'rev-1',
      operation_id: expect.stringMatching(/^voice-default-/u)
    }))
    expect(listVoiceProfiles).toHaveBeenCalledTimes(2)
    expect(visibleText(container)).toContain('Voice choice updated.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('does not render operation identifiers from failed default changes', async () => {
    const setDefaultVoice = vi.fn(async () => ({
      ok: false,
      error: { code: 'transport_loss', message: 'operation_id voice-default-secret correlation_id OP-123 failed' }
    }))
    const client = voiceClient({ setDefaultVoice, profiles: [profile({ default: false, ready: true, installed: true })] })
    const { container, unmount } = await renderVoiceSettings(client)

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
    const removeVoiceProfile = vi.fn(async () => ({ ok: true, data: mutationResult<RemoveStatus>('removed') }))
    const client = voiceClient({ removeVoiceProfile, profiles: [profile({ installed: true, ready: true, default: false, active: false })] })
    const { container, unmount } = await renderVoiceSettings(client)

    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(visibleText(document.body)).toContain('Remove voice?')
    await act(async () => {
      buttonByText(document.body, 'Cancel').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()
    expect(removeVoiceProfile).not.toHaveBeenCalled()

    await act(async () => {
      buttonByText(container, 'Remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(removeVoiceProfile).toHaveBeenCalledTimes(1)
    expect(removeVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      voice_id: 'standard:en_pack:ava',
      expected_revision: 'rev-1',
      operation_id: expect.stringMatching(/^voice-remove-/u)
    }))
    expect(visibleText(container)).toContain('Voice removed.')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('prevents duplicate confirmed removal while the request is pending', async () => {
    const pendingRemove = deferred<{ ok: true, data: MutationOutput<RemoveStatus> }>()
    const removeVoiceProfile = vi.fn(() => pendingRemove.promise)
    const client = voiceClient({ removeVoiceProfile, profiles: [profile({ installed: true, ready: true, default: false, active: false })] })
    const { container, unmount } = await renderVoiceSettings(client)

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

    expect(removeVoiceProfile).toHaveBeenCalledTimes(1)
    pendingRemove.resolve({ ok: true, data: mutationResult('removed') })
    await flushReactWork()
    await unmount()
  })

  it('deletes only allowed cloned profiles after confirmation and refreshes', async () => {
    const deleteVoiceProfile = vi.fn(async () => ({ ok: true, data: mutationResult<DeleteStatus>('deleted', 'clone:11111111-1111-4111-8111-111111111111') }))
    const listVoiceProfiles = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          profiles: [
            profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true }),
            profile({ display_name: 'Eli', voice_id: 'clone:22222222-2222-4222-8222-222222222222', kind: 'cloned', installed: true, ready: true, default: true, active: true, retained_source: true })
          ]
        }
      })
      .mockResolvedValue({ ok: true, data: { profiles: [] } })
    const client = voiceClient({ deleteVoiceProfile, listVoiceProfiles })
    const { container, unmount } = await renderVoiceSettings(client)

    expect(buttonsByText(container, 'Delete')).toHaveLength(1)
    await act(async () => {
      buttonByText(container, 'Delete').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(visibleText(document.body)).toContain('Delete voice?')
    await act(async () => {
      buttonByText(document.body, 'Confirm').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushReactWork()

    expect(deleteVoiceProfile).toHaveBeenCalledTimes(1)
    expect(deleteVoiceProfile).toHaveBeenCalledWith(expect.objectContaining({
      voice_id: 'clone:11111111-1111-4111-8111-111111111111',
      expected_revision: 'rev-1',
      operation_id: expect.stringMatching(/^voice-delete-/u)
    }))
    expect(listVoiceProfiles).toHaveBeenCalledTimes(2)
    expect(visibleText(container)).toContain('Voice deleted.')
    expect(visibleText(container)).not.toContain('11111111-1111-4111-8111-111111111111')
    assertNoForbiddenCopy(visibleText(container))
    await unmount()
  })

  it('keeps failure copy clean for remove and delete results', async () => {
    const removeVoiceProfile = vi.fn(async () => ({ ok: true, data: mutationResult<RemoveStatus>('rejected') }))
    const deleteVoiceProfile = vi.fn(async () => ({ ok: true, data: mutationResult<DeleteStatus>('rejected', 'clone:11111111-1111-4111-8111-111111111111') }))
    const client = voiceClient({
      removeVoiceProfile,
      deleteVoiceProfile,
      profiles: [
        profile({ display_name: 'Ava', voice_id: 'standard:en_pack:ava', installed: true, ready: true, default: false, active: false }),
        profile({ display_name: 'Dina', voice_id: 'clone:11111111-1111-4111-8111-111111111111', kind: 'cloned', installed: true, ready: true, default: false, active: false, retained_source: true })
      ]
    })
    const { container, unmount } = await renderVoiceSettings(client)

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
    const text = visibleText(container)

    expect(text).toContain('Voices available to Aurora')
    expect(text).toContain('Can be added for spoken replies.')
    expect(text).not.toMatch(/\b(?:this device|on this device|kept on|stored|local storage|saved voices|saved voice)\b/iu)
    assertNoForbiddenCopy(text)
    await unmount()
  })
})

function voiceClient(overrides: {
  capabilities?: Capabilities
  voices?: Voice[]
  profiles?: Profile[]
  getCapabilities?: ReturnType<typeof vi.fn>
  listVoices?: ReturnType<typeof vi.fn>
  listVoiceProfiles?: ReturnType<typeof vi.fn>
  installVoiceProfile?: ReturnType<typeof vi.fn>
  removeVoiceProfile?: ReturnType<typeof vi.fn>
  setDefaultVoice?: ReturnType<typeof vi.fn>
  deleteVoiceProfile?: ReturnType<typeof vi.fn>
} = {}): AuroraClient {
  const getCapabilities = overrides.getCapabilities ?? vi.fn(async () => ({ ok: true, data: { capabilities: overrides.capabilities ?? capabilities() } }))
  const listVoices = overrides.listVoices ?? vi.fn(async () => ({ ok: true, data: { voices: overrides.voices ?? [voice()] } }))
  const listVoiceProfiles = overrides.listVoiceProfiles ?? vi.fn(async () => ({ ok: true, data: { profiles: overrides.profiles ?? [] } }))
  const installVoiceProfile = overrides.installVoiceProfile ?? vi.fn(async () => ({ ok: true, data: installResult('installed') }))
  const removeVoiceProfile = overrides.removeVoiceProfile ?? vi.fn(async () => ({ ok: true, data: mutationResult<RemoveStatus>('removed') }))
  const setDefaultVoice = overrides.setDefaultVoice ?? vi.fn(async () => ({ ok: true, data: mutationResult<DefaultStatus>('activated') }))
  const deleteVoiceProfile = overrides.deleteVoiceProfile ?? vi.fn(async () => ({ ok: true, data: mutationResult<DeleteStatus>('deleted', 'clone:11111111-1111-4111-8111-111111111111') }))
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
    resident_language_pack_ids: ['en_pack'],
    resident_language_packs: [{ pack_id: 'en_pack', ready_languages: ['en'] }],
    resident_base_model_count: 1,
    max_resident_base_models: 1,
    output_formats: ['wav'],
    sample_rates: [24000],
    streaming: true,
    cancellation: true,
    cloning: false,
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

async function renderVoiceSettings(client: AuroraClient) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<VoiceSettingsView client={client} />)
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

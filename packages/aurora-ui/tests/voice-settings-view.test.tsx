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

describe('VoiceSettingsView', () => {
  it('loads voice discovery without mutating and maps unavailable saved voices to product copy', async () => {
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
    expect(text).toContain('Saved voices could not be loaded. Review access and try again.')
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
    expect(text).toContain('Saved voice 1')
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
})

function voiceClient(overrides: {
  capabilities?: Capabilities
  voices?: Voice[]
  profiles?: Profile[]
  getCapabilities?: ReturnType<typeof vi.fn>
  listVoices?: ReturnType<typeof vi.fn>
  listVoiceProfiles?: ReturnType<typeof vi.fn>
  installVoiceProfile?: ReturnType<typeof vi.fn>
} = {}): AuroraClient {
  const getCapabilities = overrides.getCapabilities ?? vi.fn(async () => ({ ok: true, data: { capabilities: overrides.capabilities ?? capabilities() } }))
  const listVoices = overrides.listVoices ?? vi.fn(async () => ({ ok: true, data: { voices: overrides.voices ?? [voice()] } }))
  const listVoiceProfiles = overrides.listVoiceProfiles ?? vi.fn(async () => ({ ok: true, data: { profiles: overrides.profiles ?? [] } }))
  const installVoiceProfile = overrides.installVoiceProfile ?? vi.fn(async () => ({ ok: true, data: installResult('installed') }))
  return {
    speech: {
      tts: {
        getCapabilities,
        listVoices,
        listVoiceProfiles,
        installVoiceProfile
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

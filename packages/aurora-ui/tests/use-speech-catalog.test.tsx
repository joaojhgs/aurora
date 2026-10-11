// @vitest-environment jsdom
import { useEffect, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import { AuroraQueryProvider } from '../src/query'
import { useSpeechCatalog, type SpeechCatalogState } from '../src/use-speech-catalog'
import type { AuroraSurfaceProfile } from '../src/platform-surface'

const roots: Root[] = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('useSpeechCatalog', () => {
  it('loads the server speech catalog without requiring managed-voice access', async () => {
    const client = speechClient()
    const states: SpeechCatalogState[] = []

    render(<SpeechCatalogProbe options={baseOptions({ client })} onState={(state) => states.push(state)} />)
    await vi.waitFor(async () => {
      await flushReactWork()
      expect(latestCatalogState(states).state.loadState).toBe('ready')
    })

    expect(client.speech.tts.getCapabilities).toHaveBeenCalledTimes(1)
    expect(client.speech.tts.listVoices).toHaveBeenCalledTimes(1)
    expect(client.admin.execute).not.toHaveBeenCalled()
    expect(latestCatalogState(states).state.loadState).toBe('ready')
    expect(latestCatalogState(states).state.voices).toEqual([{ voice_id: 'voice-1', display_name: 'Ava', ready: true }])
  })

  it('loads managed profiles and language packs only after explicit admin readiness', async () => {
    const adminExecute = vi.fn(async (input: { methodId: string }) => {
      if (input.methodId === 'TTS.ListVoiceProfiles') {
        return { data: { profiles: [{ voice_id: 'voice-1', display_name: 'Ava', revision: 'rev-1', kind: 'standard' }] } }
      }
      return { data: { packs: [{ pack_id: 'en', display_name: 'English', voices: [] }] } }
    })
    const client = speechClient({ adminExecute })
    const states: SpeechCatalogState[] = []

    render(<SpeechCatalogProbe options={baseOptions({ client, adminActionReady: true })} onState={(state) => states.push(state)} />)
    await flushReactWork()
    await act(async () => {
      await latestCatalogState(states).loadManagedProfiles()
    })
    await flushReactWork()

    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.ListVoiceProfiles',
      payload: { include_unavailable: true },
      reason: 'Load available voice settings: Manage spoken reply voices',
      reauthConfirmed: true,
      affectedResources: ['voice-profiles'],
      path: '/api/TTS/ListVoiceProfiles',
    }))
    expect(adminExecute).toHaveBeenCalledWith(expect.objectContaining({
      methodId: 'TTS.ListLanguagePacks',
      affectedResources: ['voice-language-downloads'],
    }))
    expect(latestCatalogState(states).state.managementState).toBe('ready')
    expect(latestCatalogState(states).state.languageCatalogState).toBe('ready')
  })

  it('loads browser speech catalog items and reference profiles when local speech can be managed', async () => {
    const listCatalog = vi.fn(async () => ({
      state: 'ready' as const,
      items: [{ task: 'tts', packId: 'pack-1', displayName: 'Local voice' }],
    }))
    const listReferenceProfiles = vi.fn(async () => [{ id: 'ref-1', label: 'Sample' }])
    const states: SpeechCatalogState[] = []

    render(
      <SpeechCatalogProbe
        options={baseOptions({
          localSpeechCatalog: {
            available: true,
            listCatalog,
            listReferenceProfiles,
            select: vi.fn(),
          } as never,
          onLocalSpeechSelectionConfirmed: vi.fn(),
          surfaceProfile: localSpeechSurface(),
        })}
        onState={(state) => states.push(state)}
      />,
    )
    await flushReactWork()

    expect(listCatalog).toHaveBeenCalledTimes(1)
    expect(listReferenceProfiles).toHaveBeenCalledTimes(1)
    expect(latestCatalogState(states).state.browserCatalogState).toBe('ready')
    expect(latestCatalogState(states).browserCatalogItems).toHaveLength(1)
    expect(latestCatalogState(states).referenceProfiles).toEqual([{ id: 'ref-1', label: 'Sample' }])
  })
})

function latestCatalogState(states: readonly SpeechCatalogState[]): SpeechCatalogState {
  const state = states[states.length - 1]
  if (!state) {
    throw new Error('Expected useSpeechCatalog to publish state.')
  }
  return state
}

function SpeechCatalogProbe({
  options,
  onState,
}: {
  options: Parameters<typeof useSpeechCatalog>[0]
  onState: (state: SpeechCatalogState) => void
}) {
  return (
    <AuroraQueryProvider client={options.client} surfaceProfile={options.surfaceProfile}>
      <SpeechCatalogContent options={options} onState={onState} />
    </AuroraQueryProvider>
  )
}

function SpeechCatalogContent({ options, onState }: {
  options: Parameters<typeof useSpeechCatalog>[0]
  onState: (state: SpeechCatalogState) => void
}) {
  const state = useSpeechCatalog(options)
  useEffect(() => {
    onState(state)
  }, [onState, state])
  return null
}

function render(element: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(element))
  return { container, root }
}

async function flushReactWork() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function baseOptions(overrides: Partial<Parameters<typeof useSpeechCatalog>[0]> = {}): Parameters<typeof useSpeechCatalog>[0] {
  return {
    client: speechClient(),
    runtimeProfile: null,
    surfaceProfile: null,
    localSpeechCatalog: null,
    onLocalSpeechSelectionConfirmed: undefined,
    adminActionReady: false,
    adminReasonValue: 'Manage spoken reply voices',
    adminReviewConfirmed: true,
    ...overrides,
  }
}

function speechClient(overrides: { adminExecute?: ReturnType<typeof vi.fn> } = {}): AuroraClient {
  // Keep the real auth lifecycle used by the query scope while stubbing speech calls.
  return Object.assign(new AuroraClient({ transport: new MockAuroraTransport() }), {
    speech: {
      tts: {
        getCapabilities: vi.fn(async () => ({ ok: true, data: { capabilities: { ready: true, ready_languages: ['en'] } } })),
        listVoices: vi.fn(async () => ({ ok: true, data: { voices: [{ voice_id: 'voice-1', display_name: 'Ava', ready: true }] } })),
      },
    },
    admin: {
      execute: overrides.adminExecute ?? vi.fn(),
    },
  }) as unknown as AuroraClient
}

function localSpeechSurface(): AuroraSurfaceProfile {
  return {
    usesNativeShell: true,
    usesBrowserVoiceRuntime: false,
    supportsMobileNative: false,
    legacyKind: 'mock',
    localSpeechPack: {
      canRunLocalKws: true,
    },
  } as AuroraSurfaceProfile
}

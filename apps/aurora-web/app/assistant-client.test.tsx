// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuroraClient, MockAuroraTransport } from '@aurora/client'
import { getAuroraSurfaceProfile, loadingShellSnapshot, type AssistantVoiceRoutes, type RouteAvailability } from '@aurora/ui'
import { AssistantClientPage } from './assistant-client'
import { BrowserShellRuntimeProvider } from './browser-shell-runtime'
import type { AuroraBrowserRuntime } from './aurora-client'

const assistantViewMock = vi.hoisted(() =>
  vi.fn((props: Record<string, unknown>, _context?: unknown) => <div data-testid="assistant-view" />),
)

vi.mock('@aurora/ui', async (importActual) => ({
  ...(await importActual<typeof import('@aurora/ui')>()),
  AssistantView: assistantViewMock,
}))

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  assistantViewMock.mockClear()
})

describe('AssistantClientPage', () => {
  it('forwards hosted assistant voice route policy and consent state to AssistantView', async () => {
    const route = routeAvailability('assistant', 'Orchestrator.ExternalUserInput', 'available-local')
    const initialVoiceRoutes = voiceRoutes('studio-peer')
    const freshVoiceRoutes = voiceRoutes('lab-peer')
    const loadingVoiceRoutes = voiceRoutes('loading-peer')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider
          runtime={fakeRuntime()}
          snapshot={{
            ...loadingShellSnapshot,
            routes: [route],
            assistantVoiceRoutes: loadingVoiceRoutes,
          }}
        >
          <AssistantClientPage route={route} voiceRoutes={initialVoiceRoutes} />
        </BrowserShellRuntimeProvider>,
      )
      await Promise.resolve()
    })

    expect(assistantViewMock).toHaveBeenCalledWith(expect.objectContaining({
      route,
      voiceRoutes: initialVoiceRoutes,
      executionHost: 'connected-device',
    }), undefined)
    expect((assistantViewMock.mock.calls.at(-1)?.[0] as {
      voiceRoutes: AssistantVoiceRoutes
    }).voiceRoutes.transcription.candidateProviders[0]).toEqual(expect.objectContaining({
      peerId: 'studio-peer',
      providerId: 'remote:studio-peer:Transcription',
    }))
    await act(async () => {
      root.render(
        <BrowserShellRuntimeProvider
          runtime={fakeRuntime()}
          snapshot={{
            ...loadingShellSnapshot,
            loadState: 'ready',
            routes: [route],
            assistantVoiceRoutes: freshVoiceRoutes,
          }}
        >
          <AssistantClientPage route={route} voiceRoutes={initialVoiceRoutes} />
        </BrowserShellRuntimeProvider>,
      )
      await Promise.resolve()
    })

    const forwardedProps = assistantViewMock.mock.calls.at(-1)?.[0] as {
      voiceRoutes: AssistantVoiceRoutes
    } | undefined
    expect(forwardedProps?.voiceRoutes).toBe(freshVoiceRoutes)
    expect(forwardedProps?.voiceRoutes.transcription.candidateProviders[0]).toEqual(expect.objectContaining({
      peerId: 'lab-peer',
      providerId: 'remote:lab-peer:Transcription',
      serviceInstanceId: 'remote:lab-peer:Transcription',
      selectable: true,
    }))
  })
})

function voiceRoutes(peerId: string): AssistantVoiceRoutes {
  return {
    transcription: routeAvailability('voice-transcription', 'Transcription.Transcribe', 'available-remote', {
      peerId,
      providerId: `remote:${peerId}:Transcription`,
      serviceInstanceId: `remote:${peerId}:Transcription`,
      privacyClass: 'raw-audio',
    }),
    wakeProcess: routeAvailability('voice-wake-process', 'WakeWord.ProcessAudio', 'available-remote', {
      peerId,
      providerId: `remote:${peerId}:WakeWord`,
      serviceInstanceId: `remote:${peerId}:WakeWord`,
      privacyClass: 'raw-audio',
    }),
    wakeControl: routeAvailability('voice-wake-control', 'WakeWord.Control', 'available-local', {
      privacyClass: 'raw-audio',
    }),
    ttsSynthesize: routeAvailability('voice-tts-synthesize', 'TTS.Synthesize', 'available-remote', {
      peerId,
      providerId: `remote:${peerId}:TTS`,
      serviceInstanceId: `remote:${peerId}:TTS`,
      privacyClass: 'personal',
    }),
    ttsStop: routeAvailability('voice-tts-stop', 'TTS.Stop', 'available-local', {
      privacyClass: 'personal',
    }),
  }
}

function fakeRuntime(): AuroraBrowserRuntime {
  const client = new AuroraClient({ transport: new MockAuroraTransport({ fixtures: false }) })
  return {
    client,
    peer: { snapshot: () => ({ status: 'authorized' }), subscribe: () => () => undefined },
    mode: 'webrtc-only',
    surface: getAuroraSurfaceProfile({ runtimeMode: 'web-thin', transportKind: 'mesh' }),
    features: {
      requestedNodeRole: 'remote-console',
      activeNodeRole: 'remote-console',
      meshNodeRuntimeEnabled: false,
      localToolProviderEnabled: false,
      lightweightOrchestratorEnabled: false,
      usesBrowserVoiceRuntime: true,
    },
    localData: null,
    localToolProvider: null,
    localAssistant: null,
    localNodeProviderStatus: {
      available: false,
      state: 'unavailable',
      productMessage: 'This device is unavailable.',
      registeredFeatureCount: 0,
      localDataWritable: false,
    },
    localFeatureSharing: null,
    close: async () => undefined,
  } as unknown as AuroraBrowserRuntime
}

function routeAvailability(
  id: string,
  capabilityMethod: string,
  state: RouteAvailability['state'],
  policy: {
    peerId?: string
    providerId?: string
    serviceInstanceId?: string
    privacyClass?: RouteAvailability['item']['privacyClass']
  } = {},
): RouteAvailability {
  const candidate = policy.providerId
    ? [{
        id: policy.providerId,
        providerId: policy.providerId,
        providerKind: 'remote',
        peerId: policy.peerId ?? null,
        nodeName: policy.peerId ?? null,
        serviceInstanceId: policy.serviceInstanceId,
        label: 'Studio peer',
        state,
        selectable: true,
        reason: 'available',
        requiredAction: null,
      }]
    : []
  return {
    item: {
      id,
      label: id,
      href: `/${id}`,
      capabilityModule: capabilityMethod.split('.')[0] ?? 'Gateway',
      capabilityMethod,
      methodType: 'use',
      fallbackState: 'unsupported',
      expectedTask: 'Use Aurora',
      privacyClass: policy.privacyClass ?? 'personal',
    },
    state,
    disabled: false,
    explanation: 'Aurora checked this route.',
    blockers: [],
    repairActions: [],
    evidenceSources: ['capability_catalog'],
    providerLabel: policy.peerId ? 'Studio peer' : 'This device',
    candidateProviders: candidate,
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    requiresAdminAction: false,
  }
}

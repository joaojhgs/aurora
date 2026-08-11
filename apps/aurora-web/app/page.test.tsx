import { describe, expect, it, vi } from 'vitest'
import { loadingShellSnapshot, type AuroraShellSnapshot, type RouteAvailability } from '@aurora/ui'
import Page from './page'

const snapshotRef = vi.hoisted(() => ({
  current: null as AuroraShellSnapshot | null,
}))

vi.mock('./shell-state', () => ({
  getShellSnapshot: async () => {
    if (!snapshotRef.current) throw new Error('missing shell snapshot')
    return snapshotRef.current
  },
}))

describe('assistant page route wiring', () => {
  it('passes canonical assistant voice routes from the shell snapshot into the hosted assistant page', async () => {
    const assistantRoute = routeAvailability('assistant', 'Orchestrator.ExternalUserInput', 'available-local')
    const voiceRoutes = {
      transcription: routeAvailability('voice-transcription', 'Transcription.Transcribe', 'available-remote', {
        peerId: 'studio-peer',
        providerId: 'remote:studio-peer:Transcription',
        serviceInstanceId: 'remote:studio-peer:Transcription',
        privacyClass: 'raw-audio',
      }),
      wakeProcess: routeAvailability('voice-wake-process', 'WakeWord.ProcessAudio', 'available-remote', {
        peerId: 'studio-peer',
        providerId: 'remote:studio-peer:WakeWord',
        serviceInstanceId: 'remote:studio-peer:WakeWord',
        privacyClass: 'raw-audio',
      }),
      wakeControl: routeAvailability('voice-wake-control', 'WakeWord.Control', 'available-local', {
        privacyClass: 'raw-audio',
      }),
      ttsSynthesize: routeAvailability('voice-tts-synthesize', 'TTS.Synthesize', 'available-remote', {
        peerId: 'studio-peer',
        providerId: 'remote:studio-peer:TTS',
        serviceInstanceId: 'remote:studio-peer:TTS',
        privacyClass: 'personal',
      }),
      ttsStop: routeAvailability('voice-tts-stop', 'TTS.Stop', 'available-local', {
        privacyClass: 'personal',
      }),
    }
    snapshotRef.current = {
      ...loadingShellSnapshot,
      routes: [assistantRoute],
      assistantVoiceRoutes: voiceRoutes,
      assistantCancellationRoute: routeAvailability('assistant-cancel', 'Orchestrator.Interrupt', 'available-local'),
    }

    const element = await Page()
    const children = Array.isArray(element.props.children)
      ? element.props.children
      : [element.props.children]
    const assistantElement = children[0]

    expect(assistantElement.props.route).toBe(assistantRoute)
    expect(assistantElement.props.voiceRoutes).toBe(voiceRoutes)
    expect(assistantElement.props.voiceRoutes.transcription.candidateProviders[0]).toEqual(expect.objectContaining({
      peerId: 'studio-peer',
      providerId: 'remote:studio-peer:Transcription',
      serviceInstanceId: 'remote:studio-peer:Transcription',
      selectable: true,
    }))
  })
})

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

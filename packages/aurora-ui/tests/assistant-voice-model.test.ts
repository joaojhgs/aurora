import { describe, expect, it } from 'vitest'

import type { VoiceRuntimeEvent } from '@aurora/client'

import {
  buildAssistantVoiceModel,
  type BuildAssistantVoiceModelInput
} from '../src/assistant-voice-model'
import { missingVoiceRoute, nativeWakeAvailability } from '../src/assistant-voice-model-helpers'
import { getAuroraSurfaceProfile } from '../src/platform-surface'
import type { AssistantVoiceRoutes, RouteAvailability } from '../src/shell-data'

describe('assistant voice model extraction', () => {
  it('builds the connected voice model with the same remote consent and event evidence semantics', () => {
    const routes = remoteVoiceRoutes('peer-a')
    const model = buildAssistantVoiceModel({
      ...baseInput(),
      voiceRoutes: routes,
      captureStatus: 'listening',
      consentGranted: false,
      voiceEvents: [voiceEvent('transcription_partial', 'listening'), voiceEvent('audio_disconnected', 'disconnected')]
    })

    expect(model.remoteAudioRoute).toBe(routes.transcription)
    expect(model.routeSheetRoute).toBe(routes.transcription)
    expect(model.targetLabel).toBe('Connected device peer-a')
    expect(model.chips.find((chip) => chip.id === 'remote-processing')).toEqual(expect.objectContaining({
      state: 'available-remote',
      detail: 'Session consent is required before audio leaves this device.'
    }))
    expect(model.controls.find((control) => control.id === 'remote-consent')).toEqual(expect.objectContaining({
      label: 'Grant session consent',
      state: 'privacy-blocked',
      enabled: true
    }))
    expect(model.controls.find((control) => control.id === 'remote-transcription')).toEqual(expect.objectContaining({
      state: 'privacy-blocked',
      reason: 'Grant session consent before sharing microphone audio with a connected device.'
    }))
    expect(model.events.find((event) => event.id === 'partial')).toEqual(expect.objectContaining({
      state: 'available-local',
      detail: 'Aurora is hearing speech.'
    }))
    expect(model.events.find((event) => event.id === 'peer-disconnect')).toEqual(expect.objectContaining({
      state: 'stale',
      detail: 'A connected device stopped responding.'
    }))
  })

  it('selects desktop native wake routes when desktop wake is ready', () => {
    const model = buildAssistantVoiceModel({
      ...baseInput(),
      surfaceProfile: getAuroraSurfaceProfile({ runtimeMode: 'desktop-local', transportKind: 'tauri-local', nativeVoicePresent: true, nativeVoiceAvailable: true, nativeWakewordAvailable: true }),
      nativeDesktopVoiceStatus: {
        available: true,
        phase: 'idle',
        generation: null,
        backgroundEligible: true,
        connection: 'this_device',
        reasonCode: null,
        redacted: true
      },
      nativeDesktopBackgroundWakeActive: true,
      nativeAvailable: true,
      nativeCapabilities: [{ name: 'microphone', enabled: true }]
    })

    expect(model.routeSheetRoute.item.id).toBe('native-desktop-wake')
    expect(model.chips.find((chip) => chip.id === 'wake')).toEqual(expect.objectContaining({
      state: 'available-local',
      providerLabel: 'This device',
      detail: 'Hands-free voice is ready on this device.'
    }))
    expect(model.controls.find((control) => control.id === 'wakeword')).toEqual(expect.objectContaining({
      enabled: true,
      reason: 'Ready'
    }))
    expect(model.controls.find((control) => control.id === 'background-wake')).toEqual(expect.objectContaining({
      label: 'Stop hands-free',
      state: 'pending',
      reason: 'Hands-free voice is listening on this device.'
    }))
  })

  it('keeps mobile wake focused on the centralized surface profile contract', () => {
    const model = buildAssistantVoiceModel({
      ...baseInput(),
      client: client('native-mobile'),
      nativePlatform: 'Android',
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'android',
        transportKind: 'native-mobile',
        nativePlatform: 'Android',
        nativeVoiceAvailable: true,
        nativeWakewordAvailable: true,
        localSpeechPackState: 'ready',
        localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true }
      }),
      nativeMobileBackgroundWakeSupported: true,
      nativeMobileBackgroundWakeActive: false,
      captureStatus: 'no-device'
    })

    expect(model.routeSheetRoute.item.id).toBe('native-mobile-wake')
    expect(model.controls.find((control) => control.id === 'push-to-talk')).toEqual(expect.objectContaining({
      state: 'pending',
      enabled: true
    }))
    expect(model.controls.find((control) => control.id === 'background-wake')).toEqual(expect.objectContaining({
      label: 'Hands-free',
      state: 'available-local',
      enabled: true
    }))
  })

  it('preserves missing route fallback shape for parent migration', () => {
    const route = missingVoiceRoute('voice-transcription', 'Connected speech', 'Transcription.Transcribe', 'raw-audio')
    const unavailableWake = nativeWakeAvailability(false, {
      id: 'native-mobile-wake',
      label: 'Mobile hands-free voice',
      unavailableBlocker: 'native_mobile_wake_unavailable'
    })

    expect(route).toEqual(expect.objectContaining({
      state: 'unsupported',
      providerLabel: 'Not available',
      disabled: true,
      routeable: false,
      blockers: ['capability_not_advertised'],
      evidenceSources: ['missing voice route']
    }))
    expect(route.item).toEqual(expect.objectContaining({
      capabilityModule: 'Transcription',
      capabilityMethod: 'Transcribe',
      privacyClass: 'raw-audio'
    }))
    expect(unavailableWake).toEqual(expect.objectContaining({
      providerLabel: 'This device',
      blockers: ['native_mobile_wake_unavailable'],
      evidenceSources: ['device_voice_status']
    }))
  })
})

function baseInput(): BuildAssistantVoiceModelInput {
  return {
    client: client('fetch'),
    route: route('assistant', 'Assistant'),
    captureStatus: 'idle',
    consentGranted: true,
    surfaceProfile: getAuroraSurfaceProfile({ runtimeMode: 'web', transportKind: 'fetch' })
  }
}

function client(kind: string): BuildAssistantVoiceModelInput['client'] {
  return { transport: { kind } } as BuildAssistantVoiceModelInput['client']
}

function remoteVoiceRoutes(peerId: string): AssistantVoiceRoutes {
  return {
    transcription: route('voice-transcription', 'Connected speech', 'available-remote', `Connected device ${peerId}`),
    wakeProcess: route('voice-wake-process', 'Wake audio processing', 'unsupported', 'Not available', true),
    wakeControl: route('voice-wake-control', 'Wake foreground control', 'unsupported', 'Not available', true),
    ttsSynthesize: route('voice-tts-synthesize', 'Spoken replies', 'available-remote', `Connected device ${peerId}`, false, 'personal'),
    ttsStop: route('voice-tts-stop', 'Stop spoken replies', 'available-local', 'This device', false, 'personal')
  }
}

function route(
  id: string,
  label: string,
  state: RouteAvailability['state'] = 'available-local',
  providerLabel = 'This device',
  disabled = false,
  privacyClass: RouteAvailability['item']['privacyClass'] = 'raw-audio'
): RouteAvailability {
  const [capabilityModule, capabilityMethod] = id.includes('tts') ? ['TTS', 'Synthesize'] : ['Transcription', 'Transcribe']
  return {
    item: {
      id,
      label,
      href: '/',
      capabilityModule,
      capabilityMethod,
      capabilityFeatureId: id,
      methodType: 'use',
      privacyClass,
      fallbackState: 'unsupported',
      adminGated: false,
      expectedTask: 'voice'
    } as RouteAvailability['item'],
    state,
    explanation: `${label} ${state}`,
    providerLabel,
    blockers: disabled ? ['capability_not_advertised'] : [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [id],
    selectorRequired: false,
    approvalRequired: false,
    routeable: !disabled,
    disabled,
    requiresAdminAction: false
  }
}

function voiceEvent(kind: VoiceRuntimeEvent['kind'], state: VoiceRuntimeEvent['state']): VoiceRuntimeEvent {
  return {
    id: `${kind}-${state}`,
    kind,
    topic: null,
    sessionId: 'voice-session',
    correlationId: null,
    sourcePeerId: 'local',
    targetPeerId: null,
    targetDeviceId: null,
    consentDecision: null,
    policyDecisionId: null,
    privacyClass: 'raw-audio',
    state,
    text: null,
    level: null,
    peak: null,
    bars: null,
    reason: null,
    redacted: false,
    occurredAt: '2026-01-01T00:00:00.000Z',
    audit: {} as VoiceRuntimeEvent['audit'],
    raw: {}
  }
}

import type { AuroraClient, VoiceRuntimeEvent } from '@aurora/client'

import {
  browserCaptureAvailability,
  missingVoiceRoute,
  nativeCaptureState,
  nativeWakeAction,
  nativeWakeAvailability,
  pushToTalkControlState,
  remoteAudioRouteFor,
  voiceAction,
  voiceChip,
  wakeDetail,
  waveformBars
} from './assistant-voice-model-helpers'
import { voiceEventRows } from './assistant-voice-events'

import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from './platform-surface'
import type { NativeDesktopVoiceStatus } from './native-desktop-voice'
import type { AssistantVoiceRoutes, RouteAvailability } from './shell-data'

export type VoiceCaptureStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'permission-denied' | 'no-device' | 'error'

export interface VoiceCapabilityChip {
  id: string
  label: string
  state: RouteAvailability['state']
  privacyClass: 'public' | 'personal' | 'sensitive' | 'secret' | 'raw-audio' | 'credential' | 'admin-critical'
  providerLabel: string
  detail: string
  blockers: string[]
  evidence: string[]
}

export interface VoiceControlModel {
  id: string
  label: string
  state: RouteAvailability['state']
  enabled: boolean
  reason: string
  route: RouteAvailability | null
}

export interface VoiceEventRow {
  id: string
  label: string
  state: RouteAvailability['state']
  detail: string
}

export interface AssistantVoiceModel {
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  privacyClass: 'raw-audio'
  retentionPolicy: string
  sessionTtl: string
  transport: string
  platformTruth: string
  visualizerSourceLabel: string
  targetLabel: string
  chips: VoiceCapabilityChip[]
  controls: VoiceControlModel[]
  events: VoiceEventRow[]
  routeSheetRoute: RouteAvailability
  remoteAudioRoute: RouteAvailability
  transcriptionRoute: RouteAvailability
  speechRoute: RouteAvailability
  waveformBars: number[]
}

export interface BuildAssistantVoiceModelInput {
  client: Pick<AuroraClient, 'transport'>
  route: RouteAvailability
  voiceRoutes?: AssistantVoiceRoutes | undefined
  nativePlatform?: string | undefined
  nativeAvailable?: boolean | undefined
  nativePermissions?: Array<{ name: string; granted: boolean }> | undefined
  nativeCapabilities?: Array<{ name: string; enabled: boolean }> | undefined
  surfaceProfile?: AuroraSurfaceProfile | undefined
  captureStatus: VoiceCaptureStatus
  consentGranted: boolean
  nativeDesktopVoiceStatus?: NativeDesktopVoiceStatus | null | undefined
  nativeDesktopBackgroundWakeActive?: boolean | undefined
  nativeMobileBackgroundWakeActive?: boolean | undefined
  nativeMobileBackgroundWakeSupported?: boolean | undefined
  voiceEvents?: VoiceRuntimeEvent[] | undefined
  waveformBars?: number[] | undefined
}

export function buildAssistantVoiceModel(input: BuildAssistantVoiceModelInput): AssistantVoiceModel {
  const transcription = input.voiceRoutes?.transcription ?? missingVoiceRoute('voice-transcription', 'Connected speech', 'Transcription.Transcribe', 'raw-audio')
  const wakeProcess = input.voiceRoutes?.wakeProcess ?? missingVoiceRoute('voice-wake-process', 'Wake audio processing', 'WakeWord.ProcessAudio', 'raw-audio')
  const wakeControl = input.voiceRoutes?.wakeControl ?? missingVoiceRoute('voice-wake-control', 'Wake foreground control', 'WakeWord.Control', 'raw-audio')
  const ttsSynthesize = input.voiceRoutes?.ttsSynthesize ?? missingVoiceRoute('voice-tts-synthesize', 'Spoken replies', 'TTS.Synthesize', 'personal')
  const ttsStop = input.voiceRoutes?.ttsStop ?? missingVoiceRoute('voice-tts-stop', 'Stop spoken replies', 'TTS.Stop', 'personal')
  const nativeCapture = nativeCaptureState(input.nativeAvailable ?? false, input.nativePlatform ?? 'not available', input.nativePermissions ?? [], input.nativeCapabilities ?? [])
  const surfaceProfile = input.surfaceProfile ?? getAuroraSurfaceProfile({
    runtimeMode: input.client.transport.kind === 'tauri-local' ? 'desktop-local' : input.client.transport.kind === 'native-mobile' ? 'mobile' : undefined,
    transportKind: input.client.transport.kind,
    nativePlatform: input.nativePlatform
  })
  const browserCaptureState = browserCaptureAvailability(surfaceProfile, input.captureStatus)
  const remoteAudioRoute = remoteAudioRouteFor(transcription, wakeProcess)
  const localSpeechPack = surfaceProfile.localSpeechPack
  const nativeDesktopWakeReady = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop'
    && input.nativeDesktopVoiceStatus?.available === true
    && input.nativeDesktopVoiceStatus.backgroundEligible === true
  const nativeMobileWakeReady = surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'mobile-native'
    && surfaceProfile.voiceCapture.wakewordOwner === 'mobile-native'
    && input.nativeMobileBackgroundWakeSupported === true
  const nativeDesktopWakeRoute = nativeWakeAvailability(nativeDesktopWakeReady, {
    id: 'native-desktop-wake',
    label: 'Desktop wake voice',
    unavailableBlocker: 'native_desktop_wake_unavailable'
  })
  const nativeMobileWakeRoute = nativeWakeAvailability(nativeMobileWakeReady, {
    id: 'native-mobile-wake',
    label: 'Mobile hands-free voice',
    unavailableBlocker: 'native_mobile_wake_unavailable'
  })
  const nativeWakeRoute = nativeDesktopWakeReady ? nativeDesktopWakeRoute : nativeMobileWakeRoute
  const backgroundWakeActive = input.nativeDesktopBackgroundWakeActive === true || input.nativeMobileBackgroundWakeActive === true

  return {
    captureStatus: input.captureStatus,
    consentGranted: input.consentGranted,
    privacyClass: 'raw-audio',
    retentionPolicy: remoteAudioRoute.disabled
      ? 'Not stored because speech help is unavailable.'
      : 'The connected device controls whether audio is saved.',
    sessionTtl: input.consentGranted ? 'Until you leave or turn off access.' : 'Not allowed.',
    transport: input.client.transport.kind,
    platformTruth: 'This device microphone is used while Aurora is open.',
    visualizerSourceLabel: 'This device microphone',
    targetLabel: remoteAudioRoute.providerLabel,
    chips: [
      {
        id: 'browser-capture',
        label: 'Device microphone',
        state: browserCaptureState.state,
        privacyClass: 'raw-audio',
        providerLabel: browserCaptureState.providerLabel,
        detail: browserCaptureState.detail,
        blockers: browserCaptureState.blockers,
        evidence: ['device_voice_status']
      },
      {
        id: 'local-speech-pack',
        label: localSpeechPack.label,
        state: localSpeechPack.availabilityState === 'ready' ? 'available-local' : localSpeechPack.availabilityState,
        privacyClass: 'raw-audio',
        providerLabel: 'This device',
        detail: localSpeechPack.detail,
        blockers: localSpeechPack.blockers,
        evidence: ['local_speech_pack_state']
      },
      nativeCapture,
      voiceChip('remote-processing', 'Connected speech help', transcription, 'raw-audio', input.consentGranted
        ? 'Session consent is active for speech help.'
        : 'Session consent is required before audio leaves this device.'),
      nativeDesktopWakeReady || nativeMobileWakeReady
        ? voiceChip('wake', 'Wake and background', nativeWakeRoute, 'raw-audio', 'Hands-free voice is ready on this device.')
        : voiceChip(
          'wake',
          surfaceProfile.voiceCapture.wakewordRequiresFocus ? 'Wake while open' : 'Wake and background',
          wakeControl.disabled ? wakeProcess : wakeControl,
          'raw-audio',
          wakeDetail(input.nativePlatform ?? 'not available', wakeControl, wakeProcess)
        ),
      voiceChip('tts', 'Speech generation', ttsSynthesize, 'personal', 'Speech can be prepared before playback starts.'),
      voiceChip('playback', 'Local playback', ttsStop, 'personal', 'Playback stop/control is separate from remote synthesis.')
    ],
    controls: [
      {
        id: 'push-to-talk',
        label: input.captureStatus === 'listening' || input.captureStatus === 'processing' || input.captureStatus === 'speaking' ? 'Stop listening' : 'Push to talk',
        state: pushToTalkControlState(surfaceProfile, browserCaptureState.state),
        enabled: pushToTalkControlState(surfaceProfile, browserCaptureState.state) !== 'unsupported',
        reason: 'This device microphone is ready while Aurora is open.',
        route: null
      },
      {
        id: 'remote-consent',
        label: input.consentGranted ? 'Revoke audio consent' : 'Grant session consent',
        state: remoteAudioRoute.disabled ? remoteAudioRoute.state : input.consentGranted ? 'available-local' : 'privacy-blocked',
        enabled: !remoteAudioRoute.disabled || remoteAudioRoute.state === 'privacy-blocked',
        reason: input.consentGranted
          ? 'Consent can be revoked before starting another audio session.'
          : 'Required before microphone audio is shared with a connected device.',
        route: remoteAudioRoute
      },
      voiceAction('remote-transcription', 'Start speech capture', transcription, input.captureStatus, input.consentGranted),
      nativeDesktopWakeReady
        ? nativeWakeAction('wakeword', 'Wake foreground', nativeDesktopWakeRoute, false)
        : voiceAction('wakeword', 'Wake foreground', wakeControl.disabled ? wakeProcess : wakeControl, input.captureStatus, input.consentGranted),
      nativeWakeAction(
        'background-wake',
        backgroundWakeActive ? 'Stop hands-free' : 'Hands-free',
        nativeWakeRoute,
        backgroundWakeActive
      ),
      voiceAction('tts-synthesize', 'Synthesize speech', ttsSynthesize, input.captureStatus, input.consentGranted),
      voiceAction('playback-stop', 'Stop playback', ttsStop, input.captureStatus, input.consentGranted)
    ],
    events: voiceEventRows(input.captureStatus, transcription, input.voiceEvents ?? []),
    routeSheetRoute: nativeDesktopWakeReady || nativeMobileWakeReady ? nativeWakeRoute : remoteAudioRoute,
    remoteAudioRoute,
    transcriptionRoute: transcription,
    speechRoute: ttsSynthesize,
    waveformBars: input.waveformBars ?? waveformBars(input.captureStatus)
  }
}


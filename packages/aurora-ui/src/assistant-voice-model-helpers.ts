import type { AuroraSurfaceProfile } from './platform-surface'
import type { RouteAvailability } from './shell-data'
import { assistantRouteBlockerCopy } from './assistant-message'
import type { VoiceCapabilityChip, VoiceCaptureStatus, VoiceControlModel } from './assistant-voice-model'

export function missingVoiceRoute(
  id: string,
  label: string,
  capability: string,
  privacyClass: VoiceCapabilityChip['privacyClass']
): RouteAvailability {
  const [capabilityModule, capabilityMethod] = capability.split('.')
  const item = {
    id,
    label,
    href: '/',
    capabilityModule: capabilityModule ?? capability,
    capabilityMethod: capabilityMethod ?? capability,
    methodType: 'use' as const,
    privacyClass,
    fallbackState: 'unsupported' as const,
    adminGated: false,
    expectedTask: 'service contract'
  } as RouteAvailability['item']
  return {
    item,
    state: 'unsupported',
    explanation: 'Voice support is unavailable right now.',
    providerLabel: 'Not available',
    blockers: ['capability_not_advertised'],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['missing voice route'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: false,
    disabled: true,
    requiresAdminAction: false
  }
}

export function nativeWakeAvailability(
  ready: boolean,
  options: { id: string; label: string; unavailableBlocker: string }
): RouteAvailability {
  const route = missingVoiceRoute(options.id, options.label, 'WakeWord.Control', 'raw-audio')
  if (!ready) {
    return {
      ...route,
      providerLabel: 'This device',
      blockers: [options.unavailableBlocker],
      evidenceSources: ['device_voice_status']
    }
  }
  return {
    ...route,
    state: 'available-local',
    explanation: 'Hands-free voice is ready on this device.',
    providerLabel: 'This device',
    blockers: [],
    evidenceSources: ['device_voice_status'],
    routeable: true,
    disabled: false
  }
}

export function nativeCaptureState(
  nativeAvailable: boolean,
  nativePlatform: string,
  nativePermissions: Array<{ name: string; granted: boolean }>,
  nativeCapabilities: Array<{ name: string; enabled: boolean }>
): VoiceCapabilityChip {
  const permissionCandidates = nativePermissions.filter((entry) => voiceNativeKey(entry.name))
  const capabilityCandidates = nativeCapabilities.filter((entry) => voiceNativeKey(entry.name))
  const permission = permissionCandidates.find((entry) => !entry.granted) ?? permissionCandidates[0]
  const capability = capabilityCandidates.find((entry) => entry.enabled) ?? capabilityCandidates[0]
  const state = !nativeAvailable
    ? 'unsupported'
    : permission && !permission.granted
      ? 'privacy-blocked'
      : capability?.enabled
        ? 'available-local'
        : 'unsupported'
  return {
    id: 'native-capture',
    label: 'Device voice',
    state,
    privacyClass: 'raw-audio',
    providerLabel: nativeAvailable ? 'This device' : 'Not available',
    detail: state === 'available-local'
      ? 'This device reports microphone or voice capture support.'
      : state === 'privacy-blocked'
        ? nativePlatform.toLowerCase().includes('ios')
          ? 'iOS voice capture is blocked until microphone permission, audio consent, and a visible stop/revoke path are available.'
          : 'Device voice capture is blocked until microphone permission is granted.'
        : 'Device capture stays disabled until Aurora can confirm microphone support.',
    blockers: state === 'available-local' ? [] : [permission && !permission.granted ? 'device_permission_missing' : 'voice_capture_unavailable'],
    evidence: nativeAvailable ? ['device_voice_status'] : []
  }
}

function voiceNativeKey(name: string): boolean {
  const normalized = name.toLowerCase()
  return normalized.includes('microphone') || normalized.includes('voice') || normalized.includes('audio')
}


export function browserCaptureAvailability(
  surfaceProfile: AuroraSurfaceProfile,
  captureStatus: VoiceCaptureStatus
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  if (surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop') {
    return nativeDesktopCaptureAvailability(captureStatus)
  }
  if (surfaceProfile.kind === 'desktop-local') {
    return readyLocalCaptureAvailability(
      captureStatus,
      'This computer',
      'This device microphone is ready for focused voice capture.'
    )
  }
  if (surfaceProfile.isMobile) {
    return readyLocalCaptureAvailability(
      captureStatus,
      'This device',
      'This device microphone is ready while Aurora is open.'
    )
  }
  return browserMicrophoneCaptureAvailability(captureStatus)
}

function nativeDesktopCaptureAvailability(
  captureStatus: VoiceCaptureStatus
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  if (captureStatus === 'no-device') {
    return {
      state: 'unsupported',
      providerLabel: 'Desktop app',
      detail: 'Voice is unavailable in this desktop app.',
      blockers: ['desktop_voice_unavailable']
    }
  }
  if (captureStatus === 'error' || captureStatus === 'permission-denied') {
    return {
      state: captureStatus === 'permission-denied' ? 'denied' : 'degraded',
      providerLabel: 'Desktop app',
      detail: 'Voice could not start. Check this device and try again.',
      blockers: ['desktop_voice_error']
    }
  }
  return {
    state: isActiveCaptureStatus(captureStatus) ? 'available-local' : 'pending',
    providerLabel: 'Desktop app',
    detail: 'Voice is handled by the desktop app.',
    blockers: []
  }
}

function readyLocalCaptureAvailability(
  captureStatus: VoiceCaptureStatus,
  providerLabel: string,
  detail: string
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  return {
    state: isActiveCaptureStatus(captureStatus) ? 'available-local' : 'pending',
    providerLabel,
    detail,
    blockers: []
  }
}

function browserMicrophoneCaptureAvailability(
  captureStatus: VoiceCaptureStatus
): Pick<VoiceCapabilityChip, 'state' | 'providerLabel' | 'detail' | 'blockers'> {
  if (captureStatus === 'listening') {
    return {
      state: 'available-local',
      providerLabel: 'This device',
      detail: 'This device microphone is active.',
      blockers: []
    }
  }
  if (captureStatus === 'processing' || captureStatus === 'speaking') {
    return {
      state: 'available-local',
      providerLabel: 'This device',
      detail: captureStatus === 'processing'
        ? 'Captured audio is being processed.'
        : 'Assistant speech playback is active.',
      blockers: []
    }
  }
  if (captureStatus === 'permission-denied') {
    return {
      state: 'denied',
      providerLabel: 'This device',
      detail: 'Microphone permission was denied.',
      blockers: ['browser_microphone_permission_denied']
    }
  }
  if (captureStatus === 'no-device') {
    return {
      state: 'unsupported',
      providerLabel: 'This device',
      detail: 'This device did not expose a microphone.',
      blockers: ['browser_microphone_api_missing']
    }
  }
  if (captureStatus === 'error') {
    return {
      state: 'degraded',
      providerLabel: 'This device',
      detail: 'Microphone capture failed; retry or inspect device settings.',
      blockers: ['browser_microphone_error']
    }
  }
  return {
    state: 'pending',
    providerLabel: 'This device',
    detail: 'Local capture waits for the browser permission prompt.',
    blockers: []
  }
}

function isActiveCaptureStatus(captureStatus: VoiceCaptureStatus): boolean {
  return captureStatus === 'listening' || captureStatus === 'processing' || captureStatus === 'speaking'
}
export function pushToTalkControlState(
  surfaceProfile: AuroraSurfaceProfile,
  browserState: RouteAvailability['state']
): RouteAvailability['state'] {
  if (surfaceProfile.voiceCapture.focusedPushToTalkOwner === 'native-desktop') return browserState
  if (surfaceProfile.kind === 'desktop-local') return 'available-local'
  if (surfaceProfile.isMobile) return browserState === 'unsupported' ? 'pending' : browserState
  return browserState
}

export function voiceChip(
  id: string,
  label: string,
  route: RouteAvailability,
  privacyClass: VoiceCapabilityChip['privacyClass'],
  detail: string
): VoiceCapabilityChip {
  return {
    id,
    label,
    state: route.state,
    privacyClass,
    providerLabel: route.providerLabel,
    detail,
    blockers: route.blockers,
    evidence: route.evidenceSources
  }
}

export function wakeDetail(
  nativePlatform: string,
  wakeControl: RouteAvailability,
  wakeProcess: RouteAvailability
): string {
  if (nativePlatform.toLowerCase().includes('ios')) {
    return 'iOS voice controls stay available only while Aurora is open or started from system shortcuts.'
  }
  if (nativePlatform.toLowerCase().includes('android')) {
    return 'Android voice controls need this device to confirm foreground voice support.'
  }
  if (!wakeControl.disabled) return 'Foreground voice control is available on this device.'
  if (!wakeProcess.disabled) return 'Voice audio can be checked, but hands-free control is unavailable.'
  return 'Hands-free voice control is unavailable right now.'
}

export function remoteAudioRouteFor(...routes: RouteAvailability[]): RouteAvailability {
  return routes.find((route) => route.state === 'available-remote' || route.state === 'privacy-blocked')
    ?? routes.find((route) => !route.disabled)
    ?? routes[0]!
}

export function voiceAction(
  id: string,
  label: string,
  route: RouteAvailability,
  captureStatus: VoiceCaptureStatus,
  consentGranted: boolean
): VoiceControlModel {
  if (route.disabled) {
    return {
      id,
      label,
      state: route.state,
      enabled: false,
      reason: assistantRouteBlockerCopy(route),
      route
    }
  }
  if ((route.state === 'available-remote' || route.selectorRequired) && !consentGranted) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Grant session consent before sharing microphone audio with a connected device.',
      route
    }
  }
  if (route.selectorRequired) {
    return {
      id,
      label,
      state: 'privacy-blocked',
      enabled: false,
      reason: 'Choose a connected voice device before starting speech.',
      route
    }
  }
  if ((id === 'remote-transcription' || id === 'wakeword') && captureStatus !== 'listening') {
    return {
      id,
      label,
      state: 'pending',
      enabled: false,
      reason: 'Start local capture before creating an audio session.',
      route
    }
  }
  return {
    id,
    label,
    state: route.state,
    enabled: false,
    reason: 'Audio can start after this device confirms microphone access.',
    route
  }
}

export function nativeWakeAction(
  id: string,
  label: string,
  route: RouteAvailability,
  active: boolean
): VoiceControlModel {
  if (route.disabled) {
    return {
      id,
      label,
      state: route.state,
      enabled: false,
      reason: 'Hands-free voice needs a ready local speech pack on this device.',
      route
    }
  }
  return {
    id,
    label,
    state: active ? 'pending' : route.state,
    enabled: true,
    reason: active ? 'Hands-free voice is listening on this device.' : 'Ready',
    route
  }
}

export function waveformBars(captureStatus: VoiceCaptureStatus): number[] {
  if (captureStatus === 'listening') {
    return [24, 48, 72, 52, 84, 38, 64, 46, 76, 30, 58, 42]
  }
  if (captureStatus === 'processing') {
    return [32, 32, 36, 40, 46, 54, 62, 70, 58, 46, 38, 34]
  }
  if (captureStatus === 'speaking') {
    return [42, 70, 48, 82, 52, 88, 58, 76, 44, 64, 36, 56]
  }
  if (captureStatus === 'permission-denied' || captureStatus === 'error') {
    return [18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18]
  }
  return [12, 20, 14, 22, 16, 18, 12, 20, 14, 22, 16, 18]
}

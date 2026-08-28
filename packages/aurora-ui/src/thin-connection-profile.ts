import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import type { AuroraThinConnectionMode } from './connection-mode'
import {
  requiredProfileText,
  sanitizeRuntimeEndpoint,
  sanitizeWebRtcConnectionProfile,
} from './profile-sanitizer'
export * from './runtime-profile'

export interface ThinConnectionProfile {
  id: string
  label: string
  mode: AuroraThinConnectionMode
  gatewayUrl: string
  signalingUrl: string
  nodeName: string
  localStablePeerId: string
  webrtcProfile?: WebRtcPeerConnectionProfile | undefined
}

export interface ThinProfileDocument {
  version: 1
  activeProfileId: string | null
  profiles: ThinConnectionProfile[]
}

export function emptyThinProfileDocument(): ThinProfileDocument {
  return {
    version: 1,
    activeProfileId: null,
    profiles: [],
  }
}

export function activeThinConnectionProfile(
  document: ThinProfileDocument | null | undefined,
): ThinConnectionProfile | undefined {
  if (!document?.activeProfileId) return undefined
  return document.profiles.find((profile) => profile.id === document.activeProfileId)
}

export function isThinConnectionProfileConfigured(
  profile: ThinConnectionProfile | null | undefined,
): boolean {
  if (!profile) return false
  if (profile.mode !== 'webrtc-only' && !profile.gatewayUrl) return false
  if (profile.mode !== 'http-only' && !profile.webrtcProfile) return false
  return true
}

export function thinConnectionProfileWithManualAddress(
  profile: ThinConnectionProfile | undefined,
  address: string,
): ThinConnectionProfile {
  const gatewayUrl = address.trim()
  if (profile) {
    return {
      id: profile.id,
      label: profile.label,
      mode: 'http-only',
      gatewayUrl,
      signalingUrl: '',
      nodeName: profile.nodeName,
      localStablePeerId: profile.localStablePeerId,
    }
  }
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}`
  return {
    id: `profile-${suffix}`,
    label: 'Aurora address',
    mode: 'http-only',
    gatewayUrl,
    signalingUrl: '',
    nodeName: 'Aurora device',
    localStablePeerId: `aurora-thin-${suffix}`,
  }
}

export function sanitizeThinConnectionProfile(
  profile: ThinConnectionProfile,
): ThinConnectionProfile {
  const id = requiredText(profile.id, 'profile id', 96)
  const label = requiredText(profile.label, 'profile label', 120)
  const nodeName = requiredText(profile.nodeName, 'node name', 160)
  const localStablePeerId = requiredText(profile.localStablePeerId, 'stable peer id', 160)
  const mode = profile.mode
  if (mode !== 'http-only' && mode !== 'webrtc-only' && mode !== 'webrtc-preferred') {
    throw new Error('This connection option is not supported.')
  }
  const gatewayUrl = sanitizeRuntimeEndpoint(
    profile.gatewayUrl,
    'Gateway',
    new Set(['http:', 'https:']),
    'Thin-client',
  )
  const signalingUrl = sanitizeRuntimeEndpoint(
    profile.signalingUrl,
    'signaling',
    new Set(['ws:', 'wss:']),
    'Thin-client',
  )
  const webrtcProfile = profile.webrtcProfile
    ? sanitizeWebRtcProfile(profile.webrtcProfile, signalingUrl, mode)
    : undefined

  if (mode !== 'webrtc-only' && !gatewayUrl) {
    throw new Error('This connection needs a valid Aurora address.')
  }
  if (mode !== 'http-only' && !webrtcProfile) {
    throw new Error('This connection needs a saved Aurora invite.')
  }

  return {
    id,
    label,
    mode,
    gatewayUrl,
    signalingUrl: signalingUrl || webrtcProfile?.signalingBrokers[0] || '',
    nodeName,
    localStablePeerId,
    ...(webrtcProfile ? { webrtcProfile } : {}),
  }
}

export function serializeThinProfileDocument(document: ThinProfileDocument): string {
  const profiles = document.profiles.map(sanitizeThinConnectionProfile)
  if (document.activeProfileId === null) {
    if (profiles.length !== 0) {
      throw new Error('An unconfigured thin-client profile document must not contain profiles')
    }
  } else if (!profiles.some((profile) => profile.id === document.activeProfileId)) {
    throw new Error('Thin-client active profile must exist')
  }
  return JSON.stringify({
    version: 1,
    activeProfileId: document.activeProfileId,
    profiles,
  } satisfies ThinProfileDocument)
}

export function parseThinProfileDocument(
  value: string | null | undefined,
): ThinProfileDocument | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as {
      version?: unknown
      activeProfileId?: unknown
      profiles?: unknown
    }
    if (
      parsed.version !== 1
      || (parsed.activeProfileId !== null && typeof parsed.activeProfileId !== 'string')
      || !Array.isArray(parsed.profiles)
    ) {
      return null
    }
    const profiles = parsed.profiles.map((profile) =>
      sanitizeThinConnectionProfile(profile as ThinConnectionProfile),
    )
    if (parsed.activeProfileId === null) {
      return profiles.length === 0 ? emptyThinProfileDocument() : null
    }
    if (!profiles.some((profile) => profile.id === parsed.activeProfileId)) return null
    return {
      version: 1,
      activeProfileId: parsed.activeProfileId,
      profiles,
    }
  } catch {
    return null
  }
}

function sanitizeWebRtcProfile(
  value: WebRtcPeerConnectionProfile,
  signalingOverride: string,
  mode: AuroraThinConnectionMode,
): WebRtcPeerConnectionProfile {
  return sanitizeWebRtcConnectionProfile(value, signalingOverride, mode, {
    errorPrefix: 'Aurora connection',
    invalidProfileMessage: 'This connection needs a valid Aurora invite.',
  })
}

function requiredText(value: string, label: string, maxLength: number): string {
  return requiredProfileText(value, label, maxLength, 'Thin-client')
}

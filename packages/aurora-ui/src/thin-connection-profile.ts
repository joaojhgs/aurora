import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import type { AuroraThinConnectionMode } from './connection-mode'
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
    throw new Error('Thin-client connection mode is invalid')
  }
  const gatewayUrl = optionalRuntimeEndpoint(
    profile.gatewayUrl,
    'Gateway',
    new Set(['http:', 'https:']),
  )
  const signalingUrl = optionalRuntimeEndpoint(
    profile.signalingUrl,
    'signaling',
    new Set(['ws:', 'wss:']),
  )
  const webrtcProfile = profile.webrtcProfile
    ? sanitizeWebRtcProfile(profile.webrtcProfile, signalingUrl, mode)
    : undefined

  if (mode !== 'webrtc-only' && !gatewayUrl) {
    throw new Error(`${mode} requires an HTTP or HTTPS Gateway endpoint`)
  }
  if (mode !== 'http-only' && !webrtcProfile) {
    throw new Error(`${mode} requires an Aurora WebRTC invite`)
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
  const appId = requiredText(value.appId, 'WebRTC app id', 256)
  const room = requiredText(value.room, 'WebRTC room', 512)
  const roomSecretRef = requiredText(value.roomSecretRef, 'WebRTC room-secret reference', 1024)
  const configuredBrokers = signalingOverride
    ? [signalingOverride]
    : [...value.signalingBrokers]
  if (configuredBrokers.length === 0 || configuredBrokers.length > 16) {
    throw new Error('Thin-client WebRTC signaling broker list is invalid')
  }
  const signalingBrokers = configuredBrokers.map((broker) =>
    optionalRuntimeEndpoint(broker, 'signaling broker', new Set(['ws:', 'wss:'])),
  )
  const out: WebRtcPeerConnectionProfile = {
    mode: mode === 'webrtc-only' ? 'webrtc-only' : 'webrtc-preferred',
    appId,
    room,
    roomSecretRef,
    signalingBrokers,
  }
  copyOptionalText(value.expectedStablePeerId, out, 'expectedStablePeerId', 256)
  copyOptionalText(value.expectedSignalingPeerId, out, 'expectedSignalingPeerId', 256)
  copyOptionalText(value.nodeName, out, 'nodeName', 160)
  copyOptionalBoolean(value.production, out, 'production')
  copyOptionalBoolean(
    value.allowInsecureLoopbackSignaling,
    out,
    'allowInsecureLoopbackSignaling',
  )
  copyOptionalBoolean(value.requireAppLayerE2ee, out, 'requireAppLayerE2ee')
  const stunServers = sanitizeIceServers(value.stunServers, new Set(['stun:', 'stuns:']))
  const turnServers = sanitizeIceServers(value.turnServers, new Set(['turn:', 'turns:']))
  if (stunServers) out.stunServers = stunServers
  if (turnServers) out.turnServers = turnServers
  return out
}

function optionalRuntimeEndpoint(
  value: string,
  label: string,
  protocols: Set<string>,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (!protocols.has(url.protocol) || url.username || url.password) {
    throw new Error(
      `Thin-client ${label} must use ${[...protocols].join('/')} without embedded credentials`,
    )
  }
  if (url.hash) throw new Error(`Thin-client ${label} must not contain URL fragments`)
  for (const key of url.searchParams.keys()) {
    if (/(?:^|[_-])(?:access|refresh|api)?[_-]?(?:token|secret|password|credential|authorization|key)(?:$|[_-])/iu.test(key)) {
      throw new Error(`Thin-client ${label} must not store credentials in URL query parameters`)
    }
  }
  return url.toString().replace(/\/$/, '')
}

function sanitizeIceServers(
  values: readonly string[] | undefined,
  protocols: Set<string>,
): string[] | undefined {
  if (values === undefined) return undefined
  if (values.length > 16) throw new Error('Thin-client ICE server list is too large')
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error('Thin-client ICE server URL is invalid')
    const trimmed = value.trim()
    const protocol = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
    if (!protocols.has(protocol) || trimmed.length > 2048 || trimmed !== value) {
      throw new Error('Thin-client ICE server URL is invalid')
    }
    validateIceServerUrl(trimmed, protocol)
    return trimmed
  })
}

function validateIceServerUrl(value: string, protocol: string): void {
  const rest = value.slice(protocol.length)
  const queryIndex = rest.indexOf('?')
  const authority = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : ''
  if (authority.includes('@')) {
    throw new Error('Thin-client ICE server URL must not contain embedded credentials')
  }
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (/(?:^|[_-])(?:access|refresh|api)?[_-]?(?:token|secret|password|credential|authorization|key)(?:$|[_-])/iu.test(key)) {
      throw new Error('Thin-client ICE server URL must not store credentials in query parameters')
    }
  }
}

function requiredText(value: string, label: string, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`Thin-client ${label} is required`)
  }
  return trimmed
}

function copyOptionalText(
  value: string | undefined,
  target: WebRtcPeerConnectionProfile,
  key: 'expectedStablePeerId' | 'expectedSignalingPeerId' | 'nodeName',
  maxLength: number,
): void {
  if (value === undefined) return
  target[key] = requiredText(value, key, maxLength)
}

function copyOptionalBoolean(
  value: boolean | undefined,
  target: WebRtcPeerConnectionProfile,
  key: 'production' | 'allowInsecureLoopbackSignaling' | 'requireAppLayerE2ee',
): void {
  if (value !== undefined) target[key] = value
}

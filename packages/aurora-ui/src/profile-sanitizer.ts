import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'

type ProfileConnectionMode = 'http-only' | 'webrtc-only' | 'webrtc-preferred'

export type ProfileTextKey = 'expectedStablePeerId' | 'expectedSignalingPeerId' | 'nodeName'
export type ProfileBooleanKey = 'production' | 'allowInsecureLoopbackSignaling' | 'requireAppLayerE2ee'

interface WebRtcProfileSanitizerOptions {
  errorPrefix: string
  invalidProfileMessage: string
}

export function sanitizeWebRtcConnectionProfile(
  value: unknown,
  signalingOverride: string,
  mode: ProfileConnectionMode,
  options: WebRtcProfileSanitizerOptions,
): WebRtcPeerConnectionProfile {
  if (!isRecord(value)) throw new Error(options.invalidProfileMessage)
  const appId = requiredProfileText(value.appId, 'WebRTC app id', 256, options.errorPrefix)
  const room = requiredProfileText(value.room, 'WebRTC room', 512, options.errorPrefix)
  const roomSecretRef = requiredProfileText(value.roomSecretRef, 'WebRTC room-secret reference', 1024, options.errorPrefix)
  const configuredBrokers = signalingOverride
    ? [signalingOverride]
    : Array.isArray(value.signalingBrokers)
      ? [...value.signalingBrokers]
      : []
  if (configuredBrokers.length === 0 || configuredBrokers.length > 16) {
    throw new Error(`${options.errorPrefix} WebRTC signaling broker list is invalid`)
  }
  const signalingBrokers = configuredBrokers.map((broker) =>
    sanitizeRuntimeEndpoint(broker, 'signaling broker', new Set(['ws:', 'wss:']), options.errorPrefix),
  )
  const out: WebRtcPeerConnectionProfile = {
    mode: mode === 'webrtc-only' ? 'webrtc-only' : 'webrtc-preferred',
    appId,
    room,
    roomSecretRef,
    signalingBrokers,
  }
  copyOptionalProfileText(value.expectedStablePeerId, out, 'expectedStablePeerId', 256, options.errorPrefix)
  copyOptionalProfileText(value.expectedSignalingPeerId, out, 'expectedSignalingPeerId', 256, options.errorPrefix)
  copyOptionalProfileText(value.nodeName, out, 'nodeName', 160, options.errorPrefix)
  copyOptionalProfileBoolean(value.production, out, 'production', options.errorPrefix)
  copyOptionalProfileBoolean(value.allowInsecureLoopbackSignaling, out, 'allowInsecureLoopbackSignaling', options.errorPrefix)
  copyOptionalProfileBoolean(value.requireAppLayerE2ee, out, 'requireAppLayerE2ee', options.errorPrefix)
  const stunServers = sanitizeIceServers(value.stunServers, new Set(['stun:', 'stuns:']), options.errorPrefix)
  const turnServers = sanitizeIceServers(value.turnServers, new Set(['turn:', 'turns:']), options.errorPrefix)
  if (stunServers) out.stunServers = stunServers
  if (turnServers) out.turnServers = turnServers
  return out
}

export function sanitizeRuntimeEndpoint(
  value: unknown,
  label: string,
  protocols: Set<string>,
  errorPrefix: string,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (!protocols.has(url.protocol) || url.username || url.password) {
    throw new Error(
      `${errorPrefix} ${label} must use ${[...protocols].join('/')} without embedded credentials`,
    )
  }
  if (url.hash) throw new Error(`${errorPrefix} ${label} must not contain URL fragments`)
  for (const key of url.searchParams.keys()) {
    if (isSecretQueryParamName(key)) {
      throw new Error(`${errorPrefix} ${label} must not store credentials in URL query parameters`)
    }
  }
  return url.toString().replace(/\/$/, '')
}

export function requiredProfileText(
  value: unknown,
  label: string,
  maxLengthBytes: number,
  errorPrefix: string,
): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || utf8ByteLength(trimmed) > maxLengthBytes) {
    throw new Error(`${errorPrefix} ${label} is required`)
  }
  return trimmed
}

export function optionalProfileText(
  value: unknown,
  label: string,
  maxLengthBytes: number,
  errorPrefix: string,
): string | undefined {
  if (value === undefined) return undefined
  return requiredProfileText(value, label, maxLengthBytes, errorPrefix)
}

export function rejectSecretFields(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, [...path, String(index)]))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key) && !isAllowedSecretReferenceField(key)) {
      throw new Error(`Runtime profile must not contain secret field ${[...path, key].join('.')}`)
    }
    rejectSecretFields(child, [...path, key])
  }
}

export function isSecretFieldName(value: string): boolean {
  return /(?:token|secret|password|credential|authorization|bearer)/iu.test(value)
}

function isSecretQueryParamName(value: string): boolean {
  return /(?:token|secret|password|credential|authorization|bearer|key)/iu.test(value)
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeIceServers(
  values: unknown,
  protocols: Set<string>,
  errorPrefix: string,
): string[] | undefined {
  if (values === undefined) return undefined
  if (!Array.isArray(values) || values.length > 16) throw new Error(`${errorPrefix} ICE server list is invalid`)
  return values.map((value) => {
    if (typeof value !== 'string') throw new Error(`${errorPrefix} ICE server URL is invalid`)
    const trimmed = value.trim()
    const protocol = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
    if (!protocols.has(protocol) || utf8ByteLength(trimmed) > 2048 || trimmed !== value) {
      throw new Error(`${errorPrefix} ICE server URL is invalid`)
    }
    validateIceServerUrl(trimmed, protocol, errorPrefix)
    return trimmed
  })
}

function validateIceServerUrl(value: string, protocol: string, errorPrefix: string): void {
  const rest = value.slice(protocol.length)
  const queryIndex = rest.indexOf('?')
  const authority = queryIndex >= 0 ? rest.slice(0, queryIndex) : rest
  const query = queryIndex >= 0 ? rest.slice(queryIndex + 1) : ''
  if (authority.includes('@')) {
    throw new Error(`${errorPrefix} ICE server URL must not contain embedded credentials`)
  }
  const params = new URLSearchParams(query)
  for (const key of params.keys()) {
    if (isSecretQueryParamName(key)) {
      throw new Error(`${errorPrefix} ICE server URL must not store credentials in query parameters`)
    }
  }
}

function copyOptionalProfileText(
  value: unknown,
  target: WebRtcPeerConnectionProfile,
  key: ProfileTextKey,
  maxLengthBytes: number,
  errorPrefix: string,
): void {
  if (value === undefined) return
  target[key] = requiredProfileText(value, key, maxLengthBytes, errorPrefix)
}

function copyOptionalProfileBoolean(
  value: unknown,
  target: WebRtcPeerConnectionProfile,
  key: ProfileBooleanKey,
  errorPrefix: string,
): void {
  if (value !== undefined) {
    if (typeof value !== 'boolean') throw new Error(`${errorPrefix} ${key} is invalid`)
    target[key] = value
  }
}

function isAllowedSecretReferenceField(value: string): boolean {
  return value === 'roomSecretRef'
}

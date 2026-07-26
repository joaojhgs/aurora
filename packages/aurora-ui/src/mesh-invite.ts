import type { JsonObject } from '@aurora/client'

/**
 * Aurora mesh invites travel as a compact, URL-safe intent string instead of raw JSON so they
 * can be clicked, QR-scanned, or pasted and still open the native app through the `aurora://`
 * deep link scheme registered by the desktop and mobile shells.
 *
 * Format: `aurora://mesh/invite?i=amv1.<base64url(JSON payload)>`
 * The bare token (`amv1.…`) is also accepted anywhere inside pasted text, so forwarding the
 * link through chat apps that mangle URLs still works.
 */
export const MESH_INVITE_SCHEME = 'aurora'
export const MESH_INVITE_PATH = 'mesh/invite'
export const MESH_INVITE_TOKEN_PREFIX = 'amv1.'
export const MESH_INVITE_KIND = 'aurora.mesh.invite'

export interface MeshInvitePairing {
  code: string
  device_name?: string | null
  expires_at?: string | null
}

export interface MeshInviteSummary {
  nodeName: string
  peerId: string | null
  room: string
  signalingProvider: string
  brokerCount: number
  includesPassword: boolean
  pairingCode: string | null
  pairingExpiresAt: string | null
  generatedAt: string | null
}

export function encodeMeshInviteToken(payload: JsonObject): string {
  return `${MESH_INVITE_TOKEN_PREFIX}${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
}

export function encodeMeshInviteUrl(payload: JsonObject): string {
  return `${MESH_INVITE_SCHEME}://${MESH_INVITE_PATH}?i=${encodeMeshInviteToken(payload)}`
}

/**
 * Accepts a full `aurora://` URL, an https redirect URL carrying the token in query or hash,
 * a bare `amv1.` token pasted anywhere in the text, or (legacy) the raw invite JSON.
 */
export function decodeMeshInvite(text: string): JsonObject | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    const parsed = parseJsonObject(trimmed)
    return parsed && parsed.kind === MESH_INVITE_KIND ? parsed : null
  }
  const token = extractMeshInviteToken(trimmed)
  if (!token) return null
  const decoded = base64UrlToBytes(token.slice(MESH_INVITE_TOKEN_PREFIX.length))
  if (!decoded) return null
  const parsed = parseJsonObject(new TextDecoder().decode(decoded))
  return parsed && parsed.kind === MESH_INVITE_KIND ? parsed : null
}

export function extractMeshInviteToken(text: string): string | null {
  const candidate = /amv1\.[A-Za-z0-9_-]+/.exec(decodeURIComponentSafe(text)) ?? /amv1\.[A-Za-z0-9_-]+/.exec(text)
  return candidate?.[0] ?? null
}

export function isMeshInviteText(text: string): boolean {
  return decodeMeshInvite(text) !== null
}

export function meshInviteSummary(payload: JsonObject): MeshInviteSummary {
  const node = asObject(payload.node)
  const signaling = asObject(payload.signaling)
  const pairing = asObject(payload.pairing)
  const brokers = Array.isArray(signaling.mqtt_brokers) ? signaling.mqtt_brokers : []
  return {
    nodeName: asString(node.node_name) || 'Aurora node',
    peerId: asString(node.peer_id) || null,
    room: asString(signaling.room) || 'not shared',
    signalingProvider: asString(signaling.provider) || 'mqtt',
    brokerCount: brokers.length,
    includesPassword: typeof signaling.room_password === 'string' && signaling.room_password.length > 0,
    pairingCode: asString(pairing.code) || null,
    pairingExpiresAt: asString(pairing.expires_at) || null,
    generatedAt: asString(payload.generated_at) || null,
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseJsonObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonObject) : null
  } catch {
    return null
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    return null
  }
}

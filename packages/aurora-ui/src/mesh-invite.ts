import type { JsonObject } from '@aurora/client'

/**
 * Aurora mesh invites travel as a compact, URL-safe intent string instead of raw JSON so they
 * can be clicked, QR-scanned, or pasted and still open the native app through the `aurora://`
 * deep link scheme registered by the desktop and mobile shells.
 *
 * Format: `aurora://mesh/invite?i=amv2.<base64url(JSON payload)>`
 * The bare token (`amv2.…`) is also accepted anywhere inside pasted text, so forwarding the
 * link through chat apps that mangle URLs still works.
 *
 * Two token generations exist, and both are decoded forever:
 *
 * - `amv1.` — the original. Its `node.peer_id` named the single device the invite let you
 *   reach, which is why the runtime bound a session to exactly that peer.
 * - `amv2.` — current. The invite is for the **mesh**, not for one device: it carries the
 *   room, the brokers, the room secret and an `origin_peer_id` naming the device that issued
 *   it. The origin is pre-selected in Connect and is a starting point, not a restriction.
 *
 * An `amv1.` invite is read as `amv2.` with its `node.peer_id` treated as an origin *hint*,
 * so old links keep working and keep landing you on the device that shared them.
 */
export const MESH_INVITE_SCHEME = 'aurora'
export const MESH_INVITE_PATH = 'mesh/invite'
/** Legacy single-device token prefix. Still decoded, never emitted. */
export const MESH_INVITE_TOKEN_PREFIX_V1 = 'amv1.'
/** Current mesh-wide token prefix. */
export const MESH_INVITE_TOKEN_PREFIX_V2 = 'amv2.'
/** @deprecated Use {@link MESH_INVITE_TOKEN_PREFIX_V1}; kept so existing imports still resolve. */
export const MESH_INVITE_TOKEN_PREFIX = MESH_INVITE_TOKEN_PREFIX_V1
export const MESH_INVITE_TOKEN_PREFIXES = Object.freeze([
  MESH_INVITE_TOKEN_PREFIX_V1,
  MESH_INVITE_TOKEN_PREFIX_V2,
] as const)
export const MESH_INVITE_KIND = 'aurora.mesh.invite'
export const MESH_INVITE_VERSION_V1 = 1 as const
export const MESH_INVITE_VERSION_V2 = 2 as const
/** The generation this build emits. Decoding stays wider than emitting, permanently. */
export const MESH_INVITE_EMITTED_VERSION = MESH_INVITE_VERSION_V2

const MESH_INVITE_TOKEN_RE = /amv[12]\.[A-Za-z0-9_-]+/

export interface MeshInvitePairing {
  code: string
  device_name?: string | null
  expires_at?: string | null
}

/**
 * Where an invite's origin device id came from.
 *
 * `origin` — an `amv2.` invite said so explicitly.
 * `legacy-hint` — an `amv1.` invite's `node.peer_id`, which named the only reachable device
 *   under the old rules and is now read as a suggestion.
 * `none` — the invite named no device; the mesh is joined without a pre-selection.
 */
export type MeshInviteOriginSource = 'origin' | 'legacy-hint' | 'none'

export interface MeshInviteOrigin {
  peerId: string | null
  source: MeshInviteOriginSource
}

export interface MeshInviteSummary {
  nodeName: string
  /** @deprecated Reads the origin device id. Prefer {@link MeshInviteSummary.origin}. */
  peerId: string | null
  origin: MeshInviteOrigin
  version: number
  room: string
  signalingProvider: string
  brokerCount: number
  includesPassword: boolean
  pairingCode: string | null
  pairingExpiresAt: string | null
  generatedAt: string | null
}

function inviteVersion(payload: JsonObject): number {
  const version = payload.version
  return typeof version === 'number' && Number.isFinite(version) ? version : MESH_INVITE_VERSION_V1
}

function tokenPrefixFor(payload: JsonObject): string {
  return inviteVersion(payload) >= MESH_INVITE_VERSION_V2
    ? MESH_INVITE_TOKEN_PREFIX_V2
    : MESH_INVITE_TOKEN_PREFIX_V1
}

/**
 * Reads the device an invite came from.
 *
 * An `amv2.` invite carries `origin_peer_id`. An `amv1.` invite carries `node.peer_id`, which
 * used to be the only device the invite could reach; it is downgraded to a hint rather than
 * dropped, so an old link still pre-selects the device that shared it.
 */
export function meshInviteOrigin(payload: JsonObject): MeshInviteOrigin {
  const explicit = asString(payload.origin_peer_id)
  if (explicit) return { peerId: explicit, source: 'origin' }
  const legacy = asString(asObject(payload.node).peer_id)
  if (legacy) return { peerId: legacy, source: 'legacy-hint' }
  return { peerId: null, source: 'none' }
}

export function encodeMeshInviteToken(payload: JsonObject): string {
  return `${tokenPrefixFor(payload)}${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`
}

export function encodeMeshInviteUrl(payload: JsonObject): string {
  return `${MESH_INVITE_SCHEME}://${MESH_INVITE_PATH}?i=${encodeMeshInviteToken(payload)}`
}

/**
 * Accepts a full `aurora://` URL, an https redirect URL carrying the token in query or hash,
 * a bare `amv1.`/`amv2.` token pasted anywhere in the text, or (legacy) the raw invite JSON.
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
  const prefix = MESH_INVITE_TOKEN_PREFIXES.find((candidate) => token.startsWith(candidate))
  if (!prefix) return null
  const decoded = base64UrlToBytes(token.slice(prefix.length))
  if (!decoded) return null
  const parsed = parseJsonObject(new TextDecoder().decode(decoded))
  return parsed && parsed.kind === MESH_INVITE_KIND ? parsed : null
}

export function extractMeshInviteToken(text: string): string | null {
  const candidate =
    MESH_INVITE_TOKEN_RE.exec(decodeURIComponentSafe(text)) ?? MESH_INVITE_TOKEN_RE.exec(text)
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
  const origin = meshInviteOrigin(payload)
  return {
    nodeName: asString(node.node_name) || 'Invited Aurora device',
    peerId: origin.peerId,
    origin,
    version: inviteVersion(payload),
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

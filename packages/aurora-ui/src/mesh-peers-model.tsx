import { AUTH_METHODS, AuroraError, routePath, type AvailabilityState, type CapabilitySummary, type ConfigFieldMetadata, type DeviceResponse, type JsonObject, type JsonValue, type MeshPeerDiagnostic, type MeshPeerInfo, type MeshRouteDiagnostic, type MeshStatusResponse, type PendingPairingEntry, type WebRTCDiagnosticsResponse } from '@aurora/client'
import type { SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import { MESH_INVITE_VERSION_V2 } from './mesh-invite'
import { safeErrorCopy } from './product-copy'
import type { MeshDeviceRow, MeshLiveSessionRow, MeshPeerAdminAction, MeshPeerRow, MeshPeersSnapshot, MeshPendingRequestRow } from './mesh-peers-view'

export const meshConfigKeyPaths = ['services.gateway.mesh_network.enabled', 'services.gateway.mesh_network.node_name', 'services.gateway.mesh_network.version_policy', 'services.gateway.mesh_network.peer_selection', 'services.gateway.mesh_network.ping_interval_s', 'services.gateway.mesh_network.registry_announce_interval_s', 'services.gateway.mesh_network.stale_peer_timeout_s', 'services.gateway.mesh_network.remote_timeout_s', 'services.gateway.webrtc.enabled', 'services.gateway.webrtc.strategy', 'services.gateway.webrtc.app_id', 'services.gateway.webrtc.room', 'services.gateway.webrtc.password', 'services.gateway.webrtc.encrypt_signaling', 'services.gateway.webrtc.enable_app_layer_e2ee', 'services.gateway.webrtc.legacy_event_broadcast', 'services.gateway.webrtc.stun_servers', 'services.gateway.webrtc.turn_servers', 'services.gateway.signaling_mqtt.brokers', 'services.gateway.signaling_mqtt.topic_root', 'services.auth.enabled', 'services.auth.default_pairing_permissions', 'services.auth.webrtc_auth_timeout_seconds', 'services.auth.webrtc_pairing_timeout_seconds']

const PRODUCT_CONFIG_TITLES: Record<string, string> = {
  'services.auth.default_pairing_permissions': 'Default sharing',
  'services.auth.enabled': 'Device approvals',
  'services.auth.webrtc_auth_timeout_seconds': 'Access timeout',
  'services.auth.webrtc_pairing_timeout_seconds': 'Pairing timeout',
  'services.gateway.mesh_network.enabled': 'Device discovery',
  'services.gateway.mesh_network.node_name': 'Device name',
  'services.gateway.mesh_network.version_policy': 'Compatibility',
  'services.gateway.mesh_network.peer_selection': 'Device selection',
  'services.gateway.mesh_network.ping_interval_s': 'Speed check interval',
  'services.gateway.mesh_network.registry_announce_interval_s': 'Availability update interval',
  'services.gateway.mesh_network.stale_peer_timeout_s': 'Offline timeout',
  'services.gateway.mesh_network.remote_timeout_s': 'Request timeout',
  'services.gateway.signaling_mqtt.brokers': 'Invite service addresses',
  'services.gateway.signaling_mqtt.topic_root': 'Invite group',
  'services.gateway.webrtc.enabled': 'Direct device connections',
  'services.gateway.webrtc.strategy': 'Invite service',
  'services.gateway.webrtc.app_id': 'Aurora network name',
  'services.gateway.webrtc.room': 'Private invite room',
  'services.gateway.webrtc.password': 'Private invite secret',
  'services.gateway.webrtc.encrypt_signaling': 'Private invite visibility',
  'services.gateway.webrtc.enable_app_layer_e2ee': 'Extra message protection',
  'services.gateway.webrtc.legacy_event_broadcast': 'Older device support',
  'services.gateway.webrtc.stun_servers': 'Connection helpers',
  'services.gateway.webrtc.turn_servers': 'Relay helpers',
}

const PRODUCT_CONFIG_DESCRIPTIONS: Record<string, string> = {
  'services.auth.default_pairing_permissions': 'Features shared when you approve a new device.',
  'services.auth.enabled': 'Allow this device to review and approve other Aurora devices.',
  'services.auth.webrtc_auth_timeout_seconds': 'How long an approved connection can wait before access expires.',
  'services.auth.webrtc_pairing_timeout_seconds': 'How long a new pairing request remains available for review.',
  'services.gateway.mesh_network.enabled': 'Allow approved Aurora devices to find this device.',
  'services.gateway.mesh_network.node_name': 'Name shown to approved Aurora devices.',
  'services.gateway.mesh_network.version_policy': 'How Aurora handles devices on different versions.',
  'services.gateway.mesh_network.peer_selection': 'How Aurora chooses a device for a request.',
  'services.gateway.mesh_network.ping_interval_s': 'How often Aurora checks connection speed.',
  'services.gateway.mesh_network.registry_announce_interval_s': 'How often this device shares that it is available.',
  'services.gateway.mesh_network.stale_peer_timeout_s': 'How long Aurora waits before showing a quiet device as offline.',
  'services.gateway.mesh_network.remote_timeout_s': 'How long Aurora waits for another device to answer.',
  'services.gateway.signaling_mqtt.brokers': 'Private addresses used to exchange invitations.',
  'services.gateway.signaling_mqtt.topic_root': 'Private group name used by your Aurora devices.',
  'services.gateway.webrtc.enabled': 'Allow approved devices to connect directly when possible.',
  'services.gateway.webrtc.strategy': 'How Aurora prepares private device invitations.',
  'services.gateway.webrtc.app_id': 'Name that keeps your Aurora device invitations together.',
  'services.gateway.webrtc.room': 'Private room used while devices find each other.',
  'services.gateway.webrtc.password': 'Secret that protects the private invite room.',
  'services.gateway.webrtc.encrypt_signaling': 'Hide invitation presence from unrelated devices.',
  'services.gateway.webrtc.enable_app_layer_e2ee': 'Add another protection layer to messages between approved devices.',
  'services.gateway.webrtc.legacy_event_broadcast': 'Temporary compatibility for older approved devices.',
  'services.gateway.webrtc.stun_servers': 'Helpers used to find the best direct path.',
  'services.gateway.webrtc.turn_servers': 'Helpers used when devices need a relay.',
}

function titleForConfigKey(keyPath: string): string {
  const productTitle = PRODUCT_CONFIG_TITLES[keyPath]
  if (productTitle) return productTitle
  const last = keyPath.split('.').at(-1) ?? keyPath
  return last.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function descriptionForConfigKey(keyPath: string): string {
  const productDescription = PRODUCT_CONFIG_DESCRIPTIONS[keyPath]
  if (productDescription) return productDescription
  if (keyPath.includes('.mesh_network.')) return 'Device connection setting.'
  if (keyPath.includes('.webrtc.')) return 'Direct connection setting.'
  if (keyPath.includes('.signaling_mqtt.')) return 'Invite service setting.'
  return 'Pairing and authentication setting.'
}

function typeForConfigValue(value: JsonValue, keyPath: string): string {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (Array.isArray(value)) return 'list'
  if (keyPath.endsWith('.version_policy') || keyPath.endsWith('.peer_selection')) return 'choice'
  return 'string'
}

export function buildRuntimeConfigFields(status: MeshStatusResponse | null, diagnostics: WebRTCDiagnosticsResponse | null): ConfigFieldMetadata[] {
  return sortConfigFields([
    fallbackConfigField('services.gateway.mesh_network.enabled', titleForConfigKey('services.gateway.mesh_network.enabled'), descriptionForConfigKey('services.gateway.mesh_network.enabled'), 'boolean', status?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? null),
    fallbackConfigField('services.gateway.mesh_network.node_name', titleForConfigKey('services.gateway.mesh_network.node_name'), descriptionForConfigKey('services.gateway.mesh_network.node_name'), 'string', status?.local.node_name ?? diagnostics?.local_node_name ?? null),
    fallbackConfigField('services.gateway.mesh_network.version_policy', titleForConfigKey('services.gateway.mesh_network.version_policy'), descriptionForConfigKey('services.gateway.mesh_network.version_policy'), 'string', status?.local.version_policy ?? null),
    fallbackConfigField('services.gateway.mesh_network.peer_selection', titleForConfigKey('services.gateway.mesh_network.peer_selection'), descriptionForConfigKey('services.gateway.mesh_network.peer_selection'), 'string', status?.local.peer_selection ?? null),
    fallbackConfigField('services.gateway.webrtc.enabled', titleForConfigKey('services.gateway.webrtc.enabled'), descriptionForConfigKey('services.gateway.webrtc.enabled'), 'boolean', diagnostics?.enabled ?? status?.local.webrtc_started ?? null),
    fallbackConfigField('services.gateway.webrtc.strategy', titleForConfigKey('services.gateway.webrtc.strategy'), descriptionForConfigKey('services.gateway.webrtc.strategy'), 'string', diagnostics?.signaling.strategy ?? null),
    fallbackConfigField('services.gateway.webrtc.encrypt_signaling', titleForConfigKey('services.gateway.webrtc.encrypt_signaling'), descriptionForConfigKey('services.gateway.webrtc.encrypt_signaling'), 'boolean', diagnostics?.signaling.encrypted_presence ?? null),
    fallbackConfigField('services.gateway.webrtc.enable_app_layer_e2ee', titleForConfigKey('services.gateway.webrtc.enable_app_layer_e2ee'), descriptionForConfigKey('services.gateway.webrtc.enable_app_layer_e2ee'), 'boolean', diagnostics?.app_layer_e2ee_enabled ?? null),
    fallbackConfigField('services.gateway.webrtc.legacy_event_broadcast', titleForConfigKey('services.gateway.webrtc.legacy_event_broadcast'), descriptionForConfigKey('services.gateway.webrtc.legacy_event_broadcast'), 'boolean', null),
    fallbackConfigField('services.auth.webrtc_auth_timeout_seconds', titleForConfigKey('services.auth.webrtc_auth_timeout_seconds'), descriptionForConfigKey('services.auth.webrtc_auth_timeout_seconds'), 'integer', diagnostics?.auth_timeout_seconds ?? null),
    fallbackConfigField('services.auth.webrtc_pairing_timeout_seconds', titleForConfigKey('services.auth.webrtc_pairing_timeout_seconds'), descriptionForConfigKey('services.auth.webrtc_pairing_timeout_seconds'), 'integer', diagnostics?.pairing_timeout_seconds ?? null),
  ])
}

export function isPendingPairing(entry: PendingPairingEntry): boolean {
  return entry.status.toLowerCase() === 'pending'
}

function fallbackConfigField(keyPath: string, title: string, description: string, type: string, value: JsonValue, editable = false): ConfigFieldMetadata {
  return {
    key_path: keyPath,
    title,
    description,
    type,
    default: value,
    current_value: value,
    source_layer: editable ? 'user' : 'service',
    secret: false,
    reload_required: true,
    restart_required: false,
    affected_services: ['device connections'],
    constraints: {},
    choices: null,
  }
}

export function sortConfigFields(fields: ConfigFieldMetadata[]): ConfigFieldMetadata[] {
  return [...fields].sort((a, b) => meshConfigKeyPaths.indexOf(a.key_path) - meshConfigKeyPaths.indexOf(b.key_path))
}

export function groupConfigFields(fields: ConfigFieldMetadata[]): Record<string, ConfigFieldMetadata[]> {
  const groups: Record<string, ConfigFieldMetadata[]> = {}
  for (const field of fields) {
    const group = field.key_path.includes('.mesh_network.') ? 'Mesh network' : field.key_path.includes('.webrtc.') ? 'Direct connections' : field.key_path.includes('.signaling_mqtt.') ? 'Invite service' : 'Pairing and access'
    groups[group] = [...(groups[group] ?? []), field]
  }
  return groups
}

function normalizedConfigType(field: ConfigFieldMetadata): string {
  return field.type.toLowerCase()
}

export function isBooleanConfigField(field: ConfigFieldMetadata): boolean {
  return ['bool', 'boolean'].includes(normalizedConfigType(field))
}

export function isArrayConfigField(field: ConfigFieldMetadata): boolean {
  return ['array', 'list'].includes(normalizedConfigType(field))
}

export function isNumberConfigField(field: ConfigFieldMetadata): boolean {
  return ['integer', 'int', 'number', 'float'].includes(normalizedConfigType(field))
}

export function stringifyConfigValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.join('\n')
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

export function parseConfigValue(field: ConfigFieldMetadata, value: string): JsonValue {
  if (isBooleanConfigField(field)) return value === 'true'
  if (['integer', 'int'].includes(normalizedConfigType(field))) return Number.parseInt(value || '0', 10)
  if (['number', 'float'].includes(normalizedConfigType(field))) return Number(value || '0')
  if (isArrayConfigField(field))
    return value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  return value
}

export function productConfigTitle(field: ConfigFieldMetadata): string {
  return field.title && !hasInternalCopy(field.title)
    ? field.title
    : titleForConfigKey(field.key_path)
}

export function productConfigDescription(field: ConfigFieldMetadata): string {
  return field.description && !hasInternalCopy(field.description)
    ? field.description
    : descriptionForConfigKey(field.key_path)
}

export interface MeshInviteReadiness {
  ready: boolean
  reason: string
}

export function meshInviteReadiness(snapshot: MeshPeersSnapshot): MeshInviteReadiness {
  const fields = snapshot.config.fields
  const appId = snapshot.inviteConfig?.app_id.trim() ?? ''
  const room = snapshot.inviteConfig?.room.trim() ?? ''
  const password = snapshot.inviteConfig?.room_password.trim() ?? ''
  const meshEnabled = configBoolean(fields, 'services.gateway.mesh_network.enabled', snapshot.meshEnabled)
  const webrtcEnabled = configBoolean(fields, 'services.gateway.webrtc.enabled', snapshot.webrtcStarted)
  const signalingEncrypted = configBoolean(fields, 'services.gateway.webrtc.encrypt_signaling', false)
  const appLayerE2ee = configBoolean(fields, 'services.gateway.webrtc.enable_app_layer_e2ee', false)
  if (!meshEnabled) return { ready: false, reason: 'Enable mesh networking. Aurora will prepare a private invite for this device.' }
  if (!webrtcEnabled) return { ready: false, reason: 'Direct connections are being enabled. Wait for secure startup to complete.' }
  if (!signalingEncrypted || !appLayerE2ee) return { ready: false, reason: 'Private invite protection must be ready before creating an invite.' }
  if (!appId || appId.toLowerCase() === 'aurora') return { ready: false, reason: 'Aurora is preparing a unique invite identity.' }
  if (!room || room.toLowerCase() === 'default') return { ready: false, reason: 'Aurora is preparing a private invite channel.' }
  if (!password || password === '[REDACTED]') return { ready: false, reason: 'Aurora is loading private invite details.' }
  if (!snapshot.webrtcStarted || !snapshot.meshStarted) return { ready: false, reason: 'Secure credentials are ready; wait for device connections to finish starting.' }
  return { ready: true, reason: 'Secure mesh invite is ready.' }
}

export function buildMeshInvitePayload(snapshot: MeshPeersSnapshot): JsonObject {
  const readiness = meshInviteReadiness(snapshot)
  if (!readiness.ready) throw new Error(readiness.reason)
  const fields = snapshot.config.fields
  const inviteConfig = snapshot.inviteConfig
  if (!inviteConfig) throw new Error('Admin-gated mesh invite credentials are unavailable.')
  const payload: JsonObject = {
    kind: 'aurora.mesh.invite',
    version: MESH_INVITE_VERSION_V2,
    generated_at: new Date().toISOString(),
    // The invite is for the mesh, not for one device. `origin_peer_id` names the
    // device that shared it so Connect can pre-select it; it does not restrict
    // which devices the invite can reach. Older `amv1` invites carried this as
    // `node.peer_id`, which did restrict it, and is read as a hint on decode.
    origin_peer_id: snapshot.localPeerId,
    node: {
      node_name: configString(fields, 'services.gateway.mesh_network.node_name') || snapshot.localNodeName,
    },
    mesh: {
      enabled: configBoolean(fields, 'services.gateway.mesh_network.enabled', snapshot.meshEnabled),
      version_policy: configString(fields, 'services.gateway.mesh_network.version_policy'),
      peer_selection: configString(fields, 'services.gateway.mesh_network.peer_selection'),
    },
    signaling: {
      provider: configString(fields, 'services.gateway.webrtc.strategy'),
      app_id: inviteConfig.app_id.trim(),
      room: inviteConfig.room.trim(),
      room_password: inviteConfig.room_password.trim(),
      encrypt_signaling: configBoolean(fields, 'services.gateway.webrtc.encrypt_signaling', false),
      mqtt_brokers: configArray(fields, 'services.gateway.signaling_mqtt.brokers'),
      mqtt_topic_root: configString(fields, 'services.gateway.signaling_mqtt.topic_root'),
    },
    webrtc: {
      enabled: configBoolean(fields, 'services.gateway.webrtc.enabled', snapshot.webrtcStarted),
      app_layer_e2ee: configBoolean(fields, 'services.gateway.webrtc.enable_app_layer_e2ee', false),
      stun_servers: configArray(fields, 'services.gateway.webrtc.stun_servers'),
      turn_servers: configArray(fields, 'services.gateway.webrtc.turn_servers'),
    },
    auth: {
      default_pairing_permissions: configArray(fields, 'services.auth.default_pairing_permissions'),
      auth_timeout_seconds: configNumber(fields, 'services.auth.webrtc_auth_timeout_seconds'),
      pairing_timeout_seconds: configNumber(fields, 'services.auth.webrtc_pairing_timeout_seconds'),
    },
    note: 'Open this invite on another Aurora device, or paste it into Mesh -> Connect device -> Join from an invite.',
  }
  return payload
}

export function configField(fields: ConfigFieldMetadata[], keyPath: string): ConfigFieldMetadata | null {
  return fields.find((field) => field.key_path === keyPath) ?? null
}

function configString(fields: ConfigFieldMetadata[], keyPath: string): string {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

export function configBoolean(fields: ConfigFieldMetadata[], keyPath: string, fallback: boolean): boolean {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'boolean' ? value : fallback
}

function configNumber(fields: ConfigFieldMetadata[], keyPath: string): number | null {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'number' ? value : null
}

export function configArray(fields: ConfigFieldMetadata[], keyPath: string): string[] {
  const value = configField(fields, keyPath)?.current_value
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []
}

export function peerInitials(value: string): string {
  const parts = value.split(/\s+/).filter(Boolean)
  return (parts[0]?.[0] ?? 'M').concat(parts[1]?.[0] ?? '').toUpperCase()
}

export function buildMeshLiveSessionRows(diagnostics: WebRTCDiagnosticsResponse | null, status: MeshStatusResponse | null, persistedPeers: MeshPeerInfo[]): MeshLiveSessionRow[] {
  return (diagnostics?.peers ?? []).map((session) => {
    const runtime = status?.peers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    const persisted = persistedPeers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    return {
      sessionId: session.signaling_peer_id,
      stablePeerId: session.stable_peer_id,
      nodeName: session.node_name || runtime?.node_name || persisted?.node_name || 'Unnamed WebRTC session',
      pairingSessionId: session.pairing_session_id ?? null,
      verificationCode: session.verification_code ?? null,
      state: liveSessionState(session, runtime, persisted),
      connectionState: session.connection_state,
      iceState: session.ice_connection_state,
      dataChannelState: session.data_channel_state,
      authState: session.auth_state,
      latencyMs: session.rtt_ms ?? runtime?.latency_ms ?? null,
      identitySource: session.identity_source,
      permissions: `${session.effective_permission_count} effective permissions${session.is_admin ? '; admin principal' : ''}`,
      pairingState: [session.pairing_active ? 'pairing active' : null, session.auth_timeout_pending ? 'auth timeout pending' : null, session.pending_pairing_task ? 'pending pairing work' : null].filter(Boolean).join('; ') || 'no pairing work reported',
      linkedPeerState: persisted ? trustPairLabel(persisted.outbound_status, persisted.inbound_status) : runtime ? productConnectionState(runtime.status) : 'No saved device record',
      evidenceSource: 'Gateway.GetWebRTCDiagnostics',
    }
  })
}

export function buildMeshDeviceRows(devices: DeviceResponse[], peers: MeshPeerRow[], sessions: MeshLiveSessionRow[]): MeshDeviceRow[] {
  return devices.map((device) => {
    const linkedPeer = matchDevicePeer(device, peers, sessions)
    return {
      deviceId: device.id,
      name: device.name,
      principalId: device.user_id ?? null,
      state: device.is_trusted ? 'available-local' : 'denied',
      trustLabel: device.is_trusted ? 'Trusted by Aurora' : 'Not trusted yet',
      linkedPeerId: linkedPeer?.peerId ?? null,
      linkedPeerLabel: linkedPeer ? `${linkedPeer.nodeName} (${linkedPeer.source})` : 'not linked to a device by service status',
      lastSeen: device.last_seen ?? null,
      evidenceSource: 'Auth.ListDevices',
    }
  })
}

function matchDevicePeer(device: DeviceResponse, peers: MeshPeerRow[], sessions: MeshLiveSessionRow[]): { peerId: string; nodeName: string; source: string } | null {
  const fields = [device.id, device.name, device.user_id ?? ''].map(normalizedMatchText).filter(Boolean)
  for (const session of sessions) {
    const sessionTokens = [session.stablePeerId, session.nodeName, session.sessionId].map(normalizedMatchText)
    if (sessionTokens.some((token) => token && fields.some((field) => field.includes(token) || token.includes(field)))) {
      return {
        peerId: session.stablePeerId,
        nodeName: session.nodeName,
        source: 'Active connection',
      }
    }
  }
  for (const peer of peers) {
    const peerTokens = [peer.peerId, peer.nodeName].map(normalizedMatchText)
    if (peerTokens.some((token) => token && fields.some((field) => field.includes(token) || token.includes(field)))) {
      return {
        peerId: peer.peerId,
        nodeName: peer.nodeName,
        source: 'persisted peer record',
      }
    }
  }
  return null
}

export function buildMeshPeerRows(input: { persistedPeers: MeshPeerInfo[]; pendingPairings: PendingPairingEntry[]; status: MeshStatusResponse | null; diagnostics: WebRTCDiagnosticsResponse | null; mutationCapability: CapabilitySummary | null }): MeshPeerRow[] {
  const runtimeByPeer = new Map(input.status?.peers.map((peer) => [peer.peer_id, peer]) ?? [])
  const pairingByPeer = new Map(input.pendingPairings.filter((entry) => entry.remote_peer_id).map((entry) => [entry.remote_peer_id, entry]))
  const peerIds = new Set<string>([...input.persistedPeers.map((peer) => peer.peer_id), ...runtimeByPeer.keys(), ...pairingByPeer.keys()])
  return [...peerIds].sort().map((peerId) => {
    const persisted = input.persistedPeers.find((peer) => peer.peer_id === peerId) ?? null
    const runtime = runtimeByPeer.get(peerId) ?? null
    const pairing = pairingByPeer.get(peerId) ?? null
    return buildMeshPeerRow(peerId, persisted, runtime, pairing, input.status?.routes ?? [], input.diagnostics, input.mutationCapability)
  })
}

export function buildMeshPendingRequestRows(input: { persistedPeers: MeshPeerInfo[]; pendingPairings: PendingPairingEntry[]; status: MeshStatusResponse | null; diagnostics: WebRTCDiagnosticsResponse | null; mutationCapability: CapabilitySummary | null }): MeshPendingRequestRow[] {
  const runtimeByPeer = new Map(input.status?.peers.map((peer) => [peer.peer_id, peer]) ?? [])
  return input.pendingPairings.map((pairing) => {
    const peerId = pairing.remote_peer_id || `pairing:${pairing.request_id}`
    const persisted = input.persistedPeers.find((peer) => peer.peer_id === peerId) ?? null
    const runtime = runtimeByPeer.get(peerId) ?? null
    return {
      ...buildMeshPeerRow(peerId, persisted, runtime, pairing, input.status?.routes ?? [], input.diagnostics, input.mutationCapability),
      pendingPairing: pairing,
    }
  })
}

function liveSessionState(session: WebRTCDiagnosticsResponse['peers'][number], runtime: MeshPeerDiagnostic | null, persisted: MeshPeerInfo | null): AvailabilityState {
  if (session.auth_state === 'denied' || session.auth_state === 'failed') return 'denied'
  if (runtime?.status === 'stale') return 'stale'
  if (session.connection_state === 'connected' && session.data_channel_state === 'open' && session.auth_state === 'authenticated') {
    return persisted?.outbound_status === 'approved' || runtime?.status === 'authenticated' ? 'available-remote' : 'pending'
  }
  if (session.pairing_active || session.pending_pairing_task || session.auth_timeout_pending) return 'pending'
  if (session.connection_state === 'disconnected' || session.ice_connection_state === 'failed') return 'stale'
  return 'degraded'
}

function normalizedMatchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function cleanupReason(peer: MeshPeerRow): string | null {
  const text = `${peer.nodeName} ${peer.roomName} ${peer.peerId}`.toLowerCase()
  if (peer.outboundStatus === 'removed') return 'Removed peer trust record should be reviewed for cleanup'
  if (peer.lifecycleState === 'stale' || peer.connectionStatus.includes('disconnected') || peer.routeQuality.toLowerCase().includes('stale')) {
    return 'Inactive peer should be reviewed before cleanup'
  }
  if (/\b(dev|test|lab|demo|demo)\b/.test(text)) return 'Dev/test peer should be retired when no longer needed'
  return null
}

function buildMeshPeerRow(peerId: string, persisted: MeshPeerInfo | null, runtime: MeshPeerDiagnostic | null, pairing: PendingPairingEntry | null, routes: MeshRouteDiagnostic[], diagnostics: WebRTCDiagnosticsResponse | null, mutationCapability: CapabilitySummary | null): MeshPeerRow {
  const outboundStatus = persisted?.outbound_status ?? pairing?.status ?? 'unknown'
  const inboundStatus = persisted?.inbound_status ?? 'unknown'
  const trustState = trustStateFor(outboundStatus, inboundStatus)
  const lifecycleState = lifecycleStateFor(runtime?.status, persisted?.connection_status)
  const services = runtime?.services.map((service) => `${service.module}@${service.version || 'unknown'}`) ?? []
  const routeQuality = routeQualityFor(peerId, routes)
  const compatibility = compatibilityFor(runtime)
  const canMutate = mutationCapability ? ['available-local', 'available-remote', 'degraded'].includes(mutationCapability.availability) : true
  const base: Omit<MeshPeerRow, 'approveAction' | 'denyAction' | 'removeAction'> = {
    peerId,
    nodeName: persisted?.node_name || runtime?.node_name || pairing?.remote_node_name || pairing?.device_name || 'Unnamed device',
    roomName: persisted?.room_name ?? 'not reported',
    lifecycleState,
    lifecycleLabel: productConnectionState(runtime?.status ?? persisted?.connection_status ?? 'No recent status'),
    trustState,
    trustLabel: trustPairLabel(outboundStatus, inboundStatus),
    outboundStatus,
    inboundStatus,
    connectionStatus: persisted?.connection_status ?? webrtcConnectionFor(peerId, diagnostics) ?? 'not reported',
    fingerprint: peerId,
    permissions: persisted?.outbound_permissions ?? pairing?.granted_permissions ?? [],
    inboundPermissions: persisted?.inbound_permissions ?? [],
    latencyMs: runtime?.latency_ms ?? webrtcLatencyFor(peerId, diagnostics),
    routeQuality,
    compatibility,
    serviceCount: runtime?.services.length ?? 0,
    services,
    lastSeen: persisted?.last_seen_at ?? null,
    lastEvidenceSource: evidenceFor(persisted, runtime, pairing, diagnostics),
    pendingPairing: pairing ?? null,
  }
  return {
    ...base,
    approveAction:
      canMutate && outboundStatus !== 'approved'
        ? buildMeshPeerAdminAction(base, 'approve', {
            reason: 'Approve device',
            permissions: base.permissions.join(', '),
          })
        : null,
    denyAction: canMutate && outboundStatus !== 'denied' ? buildMeshPeerAdminAction(base, 'deny', { reason: 'Deny device' }) : null,
    removeAction:
      canMutate && outboundStatus !== 'removed'
        ? buildMeshPeerAdminAction(base, 'remove', {
            reason: 'Remove device',
            revokeToken: true,
          })
        : null,
  }
}

export function buildMeshPeerAdminAction(
  peer: Pick<MeshPeerRow, 'peerId' | 'nodeName'> & { pendingPairing?: PendingPairingEntry | null },
  action: 'approve' | 'deny' | 'remove',
  input: {
    reason: string
    permissions?: string
    revokeToken?: boolean
    reauthConfirmed?: boolean
  },
): MeshPeerAdminAction | null {
  const reason = input.reason.trim() || `${action} device ${peer.peerId}`
  if (action !== 'remove' && peer.pendingPairing) {
    if (!peer.pendingPairing.code.trim()) return null
    const affectedResources = [
      `pairing:${peer.pendingPairing.request_id}`,
      peer.pendingPairing.remote_peer_id ? `peer:${peer.pendingPairing.remote_peer_id}` : null,
      peer.pendingPairing.device_name ? `device:${peer.pendingPairing.device_name}` : null,
    ].filter((value): value is string => Boolean(value))
    if (action === 'approve') {
      const permissions = parseMeshPermissionList(input.permissions ?? '')
      return {
        methodId: AUTH_METHODS.pairingApprove,
        payload: {
          code: peer.pendingPairing.code,
          permissions,
          is_admin: permissions?.includes('*') ?? false,
        },
        reason,
        reauthConfirmed: Boolean(input.reauthConfirmed),
        affectedResources,
        path: routePath('Auth', 'PairingApprove'),
      }
    }
    return {
      methodId: AUTH_METHODS.pairingDeny,
      payload: { code: peer.pendingPairing.code, reason },
      reason,
      reauthConfirmed: Boolean(input.reauthConfirmed),
      affectedResources,
      path: routePath('Auth', 'PairingDeny'),
    }
  }
  if (action === 'approve') {
    return {
      methodId: AUTH_METHODS.meshApprovePeer,
      payload: {
        peer_id: peer.peerId,
        permissions: parseMeshPermissionList(input.permissions ?? '') ?? [],
      },
      reason,
      reauthConfirmed: Boolean(input.reauthConfirmed),
      affectedResources: [`mesh-peer:${peer.peerId}`, `peer:${peer.nodeName}`],
      path: routePath('Auth', 'MeshApprovePeer'),
    }
  }
  if (action === 'deny') {
    return {
      methodId: AUTH_METHODS.meshDenyPeer,
      payload: { peer_id: peer.peerId },
      reason,
      reauthConfirmed: Boolean(input.reauthConfirmed),
      affectedResources: [`mesh-peer:${peer.peerId}`],
      path: routePath('Auth', 'MeshDenyPeer'),
    }
  }
  return {
    methodId: AUTH_METHODS.meshRemovePeer,
    payload: { peer_id: peer.peerId, revoke_token: input.revokeToken ?? true },
    reason,
    reauthConfirmed: Boolean(input.reauthConfirmed),
    affectedResources: [`mesh-peer:${peer.peerId}`],
    path: routePath('Auth', 'MeshRemovePeer'),
  }
}

export function meshPeerScopesEditable(
  peer: Pick<MeshPeerRow, 'pendingPairing' | 'trustState'>,
): boolean {
  return !peer.pendingPairing && peer.trustState !== 'pending'
}

/** Build a scopes-only mutation without allowing that path to approve a pending request. */
export function buildMeshScopesAdminAction(
  peer: MeshPeerRow,
  permissions: string[],
): MeshPeerAdminAction | null {
  if (!meshPeerScopesEditable(peer)) return null
  return {
    methodId: AUTH_METHODS.meshUpdatePeerPermissions,
    payload: {
      peer_id: peer.peerId,
      permissions,
    },
    reason: `Update scopes for ${peer.nodeName}`,
    reauthConfirmed: true,
    affectedResources: [`mesh-peer:${peer.peerId}`, `peer:${peer.nodeName}`],
    path: routePath('Auth', 'MeshUpdatePeerPermissions'),
  }
}

export function meshPeerActionIdentity(peer: Pick<MeshPeerRow, 'peerId' | 'pendingPairing'>): string {
  return peer.pendingPairing?.request_id || peer.peerId
}

export function parseMeshPermissionList(value: string): string[] | null {
  const permissions = value
    .split(/[\s,]+/)
    .map((permission) => permission.trim())
    .filter(Boolean)
  return permissions.length > 0 ? permissions : null
}

export function meshPeerErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) {
    return meshSafeErrorTitle(error)
  }
  return meshSafeErrorTitle(error)
}

export function meshSafeErrorTitle(error: unknown): string {
  return safeErrorCopy(error).title
}

function hasInternalCopy(value: string): boolean {
  return /\b(?:webrtc|gateway|transport|runtime|manifest|config|preview|schema|contract|fallback|provider|consumer|hybrid|sqlite|indexeddb|opfs|sidecar|thin|datachannel|signaling|room password)\b|(?:services|auth|gateway|config)\.[a-z0-9_.]+/iu.test(value)
}

export function sanitizeMeshDetail(value: string, fallback = 'Check this device, then refresh.'): string {
  const trimmed = value.trim()
  if (!trimmed) return fallback
  if (hasInternalCopy(trimmed)) return fallback
  return trimmed
}

function trustPairLabel(outbound: string, inbound: string): string {
  if (outbound === 'approved' && inbound === 'approved') return 'Approved both ways'
  if (outbound === 'approved') return 'This device approved'
  if (inbound === 'approved') return 'Other device approved'
  if (outbound === 'pending' || inbound === 'pending') return 'Review needed'
  if (outbound === 'denied' || inbound === 'denied') return 'Not allowed'
  if (outbound === 'removed' || inbound === 'removed') return 'Removed'
  return 'Not set up'
}

export function productConnectionState(value: string): string {
  if (/denied|failed|error|closed|stale|timeout|disconnected/iu.test(value)) return 'Needs attention'
  if (/pending|pairing|connecting/iu.test(value)) return 'Waiting'
  if (/authorized|authenticated|approved|\bconnected\b|ready/iu.test(value)) return 'Ready'
  return 'Checking'
}

export function connectionRoundTripTimeMs(
  evidence: SelectedCandidatePairEvidence | null | undefined,
): number | null {
  const value = evidence?.roundTripTimeMs
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function isExpectedOfflineTransportMessage(value: string): boolean {
  return /webrtc mesh transport is not connected|transport datachannel not connected/i.test(value)
}

function MeshFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function fixtureEvidence(value: string): string {
  return `${value} (sample data)`
}

export function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok ? (result.value.data ?? null) : null
}

export function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

export function skippedMeshAuthRead<T>(): Promise<{ ok: true; data?: T }> {
  return Promise.resolve({ ok: true })
}

export function withUiTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} did not respond within ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

export function failureMessage(label: string, result: PromiseSettledResult<unknown>, optional = false): string | null {
  if (result.status === 'fulfilled') {
    const value = result.value as { ok?: boolean; error?: unknown } | undefined
    if (value?.ok === false) return `${label}: ${meshPeerErrorMessage(value.error)}`
    return null
  }
  return optional ? `${label} unavailable: ${meshPeerErrorMessage(result.reason)}` : `${label}: ${meshPeerErrorMessage(result.reason)}`
}

export function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  const error = result.status === 'fulfilled' ? (result.value as { ok?: boolean; error?: unknown }).error : result.reason
  return error instanceof AuroraError && (error.code === 'permission' || error.code === 'auth')
}

export function capabilityFor(methodId: string, capabilities: CapabilitySummary[]): CapabilitySummary | null {
  return capabilities.find((capability) => capability.busTopic === methodId || capability.id === methodId) ?? null
}

export function firstCapability(methodIds: string[], capabilities: CapabilitySummary[]): CapabilitySummary | null {
  for (const methodId of methodIds) {
    const capability = capabilityFor(methodId, capabilities)
    if (capability) return capability
  }
  return null
}

export function stateFromCapability(capability: CapabilitySummary | null, fallback: AvailabilityState): AvailabilityState {
  return capability?.availability ?? fallback
}

export function capabilityReason(capability: CapabilitySummary | null, fallback: string): string {
  if (!capability) return fallback
  const blockers = capability.routeBlockers.length > 0 ? ` blockers=${capability.routeBlockers.join(',')}` : ''
  return `${capability.busTopic ?? capability.id} is ${capability.availability}.${blockers}`
}

function trustStateFor(outbound: string, inbound: string): AvailabilityState {
  if (outbound === 'approved' && inbound === 'approved') return 'available-remote'
  if (outbound === 'approved') return 'available-local'
  if (outbound === 'denied' || inbound === 'denied') return 'denied'
  if (outbound === 'removed') return 'unsupported'
  if (outbound === 'pending' || inbound === 'pending') return 'pending'
  return 'degraded'
}

function lifecycleStateFor(runtimeStatus: string | undefined, connectionStatus: string | undefined): AvailabilityState {
  if (runtimeStatus === 'stale') return 'stale'
  if (runtimeStatus === 'negotiated' || runtimeStatus === 'authenticated') return 'available-remote'
  if (runtimeStatus === 'connected' || connectionStatus === 'connected') return 'pending'
  if (connectionStatus === 'disconnected') return 'stale'
  return 'degraded'
}

function routeQualityFor(peerId: string, routes: MeshRouteDiagnostic[]): string {
  const selected = routes.filter((route) => route.decision_peer_id === peerId)
  const candidates = routes.flatMap((route) => route.providers.filter((provider) => provider.peer_id === peerId))
  if (selected.length > 0) return selected.map((route) => `${route.module}: ${route.decision_target} ${route.reason}`).join('; ')
  if (candidates.length > 0) return candidates.map((candidate) => `${candidate.reason_code || 'candidate'} ${candidate.reason}`).join('; ')
  return 'no route status'
}

function compatibilityFor(peer: MeshPeerDiagnostic | null): string {
  if (!peer) return 'No compatibility status'
  const c = peer.compatibility
  const failures = [...c.local_incompatible, ...c.remote_incompatible]
  if (failures.length > 0) return `incompatible: ${failures.join(', ')}`
  const compatible = [...c.local_compatible, ...c.remote_compatible]
  return compatible.length > 0 ? `compatible: ${compatible.join(', ')}` : 'no compatible services reported'
}

function webrtcConnectionFor(peerId: string, diagnostics: WebRTCDiagnosticsResponse | null): string | null {
  const peer = diagnostics?.peers.find((candidate) => candidate.stable_peer_id === peerId)
  return peer ? `${peer.connection_state}/${peer.data_channel_state}/${peer.auth_state}` : null
}

function webrtcLatencyFor(peerId: string, diagnostics: WebRTCDiagnosticsResponse | null): number | null {
  return diagnostics?.peers.find((candidate) => candidate.stable_peer_id === peerId)?.rtt_ms ?? null
}

export function MeshVerificationCode({ value }: { value: string | null | undefined }) {
  const normalized = value?.trim().replace(/[\s-]+/g, '').toUpperCase() ?? ''
  if (!normalized) return <span className="font-mono text-sm text-muted-foreground">not reported</span>
  const formatted = normalized.length <= 4 ? normalized : normalized.match(/.{1,4}/g)?.join(' ') ?? normalized
  return (
    <code className="font-mono text-[15px] tracking-[0.12em]" aria-label={`Verification code ${normalized}`}>
      {formatted}
    </code>
  )
}

function evidenceFor(persisted: MeshPeerInfo | null, runtime: MeshPeerDiagnostic | null, pairing: PendingPairingEntry | null, diagnostics: WebRTCDiagnosticsResponse | null): string {
  const sources = [persisted ? 'Auth.MeshListPeers' : null, runtime ? 'Gateway.GetMeshStatus' : null, pairing ? 'Auth.ListPendingPairings' : null, diagnostics?.peers.some((peer) => peer.stable_peer_id === (persisted?.peer_id ?? runtime?.peer_id ?? pairing?.remote_peer_id)) ? 'Gateway.GetWebRTCDiagnostics' : null].filter(Boolean)
  return sources.join(', ') || 'no service status'
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const deltaMs = timestamp - Date.now()
  const past = deltaMs < 0
  const abs = Math.abs(deltaMs)
  const minutes = Math.round(abs / 60_000)
  if (minutes < 1) return past ? 'just now' : 'in <1 min'
  if (minutes < 60) return past ? `${minutes} min ago` : `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`
  const days = Math.round(hours / 24)
  return past ? `${days}d ago` : `in ${days}d`
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'not reported'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

import { AUTH_METHODS, AuroraError, GATEWAY_METHODS, routePath, summarizeCapabilities, type AuroraClient, type AvailabilityState, type CapabilitySummary, type ConfigSchemaMetadataResponse, type DeviceListResponse, type JsonObject, type JsonValue, type ListPendingPairingsResponse, type MeshInviteConfigResponse, type MeshPeerListResponse, type MeshStatusResponse, type WebRTCDiagnosticsResponse } from '@aurora/client'
import type { MeshPeerRosterSnapshot, PeerConnectionSnapshot, SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import { isBrowserWebRtcConfigured, isBrowserWebRtcConnected, type BrowserWebRtcPeerController, type BrowserWebRtcSnapshot } from './web-thin-runtime'
import type { LocalDeviceFeature, LocalFeatureSharingPort, LocalFeatureSharingSnapshot } from './local-feature-sharing'
import { localFeatureIdsForServicePermissions, localServicePermissionCatalog, localShareableServiceScopes } from './local-feature-sharing'
import type { RouteAvailability } from './shell-data'
import { PRODUCT_COPY } from './product-copy'
import { presentableSignal } from './status-badges'
import type { LocalMeshNodeIdentity, MeshConfigChange, MeshConfigSnapshot, MeshDeviceRow, MeshLiveSessionRow, MeshPeerAdminAction, MeshPeerRow, MeshPeersLoadState, MeshPeersSnapshot, MeshPeersSnapshotOptions, MeshPendingRequestRow } from './mesh-peers-view'
import {
  buildMeshDeviceRows,
  buildMeshLiveSessionRows,
  buildMeshPeerRows,
  buildMeshPendingRequestRows,
  buildRuntimeConfigFields,
  capabilityFor,
  uniqueStrings,
  isPendingPairing,
  isExpectedOfflineTransportMessage,
  connectionRoundTripTimeMs,
  configBoolean,
  capabilityReason,
  failureMessage,
  firstCapability,
  isDeniedFailure,
  meshPeerErrorMessage,
  meshSafeErrorTitle,
  responseDataOrNull,
  skippedMeshAuthRead,
  sortConfigFields,
  meshConfigKeyPaths,
  stateFromCapability,
  valueOrNull,
  withUiTimeout,
} from './mesh-peers-sections'

const MESH_PRIMARY_READ_TIMEOUT_MS = 8_000
const MESH_OPTIONAL_READ_TIMEOUT_MS = 5_000

const loadingSnapshot: MeshPeersSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  localPeerId: null,
  localNodeName: 'Checking connection',
  meshEnabled: false,
  meshStarted: false,
  webrtcStarted: false,
  inviteConfig: null,
  secretsRedacted: true,
  peers: [],
  pendingRequests: [],
  liveSessions: [],
  devices: [],
  pendingCount: 0,
  approvedCount: 0,
  deniedCount: 0,
  removedCount: 0,
  runtimePeerCount: 0,
  liveSessionCount: 0,
  deviceCount: 0,
  routeCount: 0,
  compatibilityFailures: [],
  listState: 'pending',
  listReason: 'Loading devices and pending requests through Aurora.',
  statusState: 'pending',
  statusReason: 'Loading mesh status through Aurora.',
  mutationState: 'pending',
  mutationReason: 'Loading device management capabilities.',
  config: {
    fields: [],
    state: 'pending',
    reason: 'Loading mesh settings.',
    secretsRedacted: true,
    editable: false,
    warnings: [],
  },
  warnings: [],
  error: null,
  evidenceSource: 'pending Aurora service calls',
  transportKind: 'pending',
  fixtureOnly: false,
}

/** Config changes a joining device applies from a mesh invite so it lands in the same signaling room. */
export function meshInviteConfigChanges(invite: JsonObject): { key_path: string; value: JsonValue }[] {
  const mesh = jsonObjectAt(invite, 'mesh')
  const signaling = jsonObjectAt(invite, 'signaling')
  const webrtc = jsonObjectAt(invite, 'webrtc')
  const appId = nonEmptyString(signaling.app_id)
  const room = nonEmptyString(signaling.room)
  const roomPassword = nonEmptyString(signaling.room_password)
  if (!appId || !room || !roomPassword) {
    throw new Error('This invite is incomplete. Ask the sender for a new invite.')
  }
  const changes: { key_path: string; value: JsonValue }[] = []
  const push = (key_path: string, value: JsonValue | undefined) => {
    if (value !== undefined) changes.push({ key_path, value })
  }
  push('services.auth.enabled', true)
  push('services.gateway.webrtc.strategy', nonEmptyString(signaling.provider))
  push('services.gateway.webrtc.app_id', appId)
  push('services.gateway.webrtc.room', room)
  push('services.gateway.webrtc.password', roomPassword)
  push('services.gateway.webrtc.encrypt_signaling', typeof signaling.encrypt_signaling === 'boolean' ? signaling.encrypt_signaling : undefined)
  push('services.gateway.webrtc.enable_app_layer_e2ee', typeof webrtc.app_layer_e2ee === 'boolean' ? webrtc.app_layer_e2ee : undefined)
  push('services.gateway.webrtc.stun_servers', nonEmptyStringArray(webrtc.stun_servers))
  push('services.gateway.webrtc.turn_servers', nonEmptyStringArray(webrtc.turn_servers))
  push('services.gateway.signaling_mqtt.brokers', nonEmptyStringArray(signaling.mqtt_brokers))
  push('services.gateway.signaling_mqtt.topic_root', nonEmptyString(signaling.mqtt_topic_root))
  push('services.gateway.mesh_network.enabled', mesh.enabled === false ? undefined : true)
  push('services.gateway.webrtc.enabled', webrtc.enabled === false ? undefined : true)
  return changes
}

export async function commitMeshConfigChangeSet(
  client: AuroraClient,
  changes: { key_path: string; value: JsonValue }[],
  reason: string,
  invalidFallback: string,
): Promise<string[]> {
  const diff = await client.config.previewDiff({ changes })
  if (!diff.ok || !diff.data?.valid) {
    throw new Error(diff.ok ? diff.data?.errors.join('; ') || invalidFallback : meshPeerErrorMessage(diff.error))
  }
  if (typeof diff.data.base_revision !== 'number' || !diff.data.preview_token) {
    throw new Error('Aurora could not confirm that save. Refresh and review before saving again.')
  }
  const impact = await client.config.previewReloadImpact({ changes })
  if (!impact.ok) {
    throw new Error(meshPeerErrorMessage(impact.error))
  }
  const committed = await client.config.commitChangeSet({
    request: {
      changes,
      base_revision: diff.data.base_revision,
      preview_token: diff.data.preview_token,
    },
    reason,
    reauthConfirmed: true,
  })
  if (!committed.data.success) {
    const failure = committed.data.error_code === 'config_revision_conflict'
      ? 'Settings changed since review. Refresh and review before saving again.'
      : meshSafeErrorTitle(committed.data.error || committed.data.error_code || 'Aurora could not save those changes.')
    throw new Error(failure)
  }
  return committed.data.changed_paths
}

/** Stop all mesh/WebRTC publication before changing a room invite in place. */
export function meshInviteQuiesceChanges(): { key_path: string; value: JsonValue }[] {
  return [
    { key_path: 'services.gateway.mesh_network.enabled', value: false },
    { key_path: 'services.gateway.webrtc.enabled', value: false },
  ]
}

export async function prepareLocalFeatureSharingApproval(
  port: LocalFeatureSharingPort,
  featureIds: readonly string[],
): Promise<string[]> {
  if (!Array.isArray(featureIds) || featureIds.length > 128) {
    throw new Error('The selected device features could not be approved. Review the selection and try again.')
  }
  const requested = new Set(featureIds.map((featureId) => featureId.trim()).filter(Boolean))
  const snapshot = await port.load()
  const availableFeatures = filterPairingFeatures(snapshot.features)
  const available = new Map(availableFeatures.map((feature) => [feature.id, feature]))
  for (const featureId of requested) {
    const feature = available.get(featureId)
    if (!feature?.available) {
      throw new Error('One of the selected device features is no longer available. Review the selection and try again.')
    }
  }
  const selected = availableFeatures
    .filter((feature) => requested.has(feature.id))
    .map((feature) => feature.id)
  for (const featureId of selected) {
    if (!available.get(featureId)?.enabled) await port.setFeatureEnabled(featureId, true)
  }
  return selected
}

export function filterPairingFeatures(
  features: readonly LocalDeviceFeature[],
): readonly LocalDeviceFeature[] {
  return features.filter((feature) => feature.available)
}

function jsonObjectAt(value: JsonObject, key: string): JsonObject {
  const nested = value[key]
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested) ? (nested as JsonObject) : {}
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

export async function buildMeshPeersSnapshot(
  client: AuroraClient,
  route: RouteAvailability,
  options: MeshPeersSnapshotOptions = {},
): Promise<MeshPeersSnapshot> {
  const canManageLocalServiceConfiguration = options.canManageLocalServiceConfiguration ?? true
  const signal = (options as MeshPeersSnapshotOptions & { signal?: AbortSignal }).signal
  throwIfAborted(signal)
  const [statusResult, diagnosticsResult, catalogResult, configResult, inviteConfigResult] = await Promise.allSettled([
    client.requestResult<MeshStatusResponse, JsonObject>(
      GATEWAY_METHODS.getMeshStatus,
      {},
      {
        path: routePath('Gateway', 'GetMeshStatus'),
        timeoutMs: MESH_PRIMARY_READ_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    ),
    client.request<WebRTCDiagnosticsResponse, JsonObject>(
      GATEWAY_METHODS.getWebRTCDiagnostics,
      {},
      {
        path: routePath('Gateway', 'GetWebRTCDiagnostics'),
        timeoutMs: MESH_PRIMARY_READ_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    ),
    withUiTimeout(
      client.capabilities.listCatalog({
        include_unavailable: true,
        include_internal: true,
      }, signal ? { signal } : {}),
      MESH_PRIMARY_READ_TIMEOUT_MS,
      'capability catalog',
    ),
    canManageLocalServiceConfiguration
      ? client.config.getSchemaMetadata({ include_values: true }, signal ? { signal } : {})
      : skippedMeshAuthRead<ConfigSchemaMetadataResponse>(),
    canManageLocalServiceConfiguration
      ? client.requestResult<MeshInviteConfigResponse, JsonObject>(
          GATEWAY_METHODS.getMeshInviteConfig,
          {},
          {
            path: routePath('Gateway', 'GetMeshInviteConfig'),
            timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        )
      : skippedMeshAuthRead<MeshInviteConfigResponse>(),
  ])
  throwIfAborted(signal)

  const statusResponse = responseDataOrNull(statusResult)
  const diagnostics = valueOrNull(diagnosticsResult)
  const catalog = valueOrNull(catalogResult)
  const configResponse = responseDataOrNull(configResult)
  const inviteConfig = responseDataOrNull(inviteConfigResult)
  const authEnabled = configBoolean(configResponse?.fields ?? [], 'services.auth.enabled', false)
  const authReadsReady = authEnabled || statusResponse?.local.mesh_started === true
  const authSnapshot = client.auth.snapshot()
  const adminAuthReadsReady = authReadsReady && (
    authSnapshot.isAdmin
    || client.permissions.has('Auth.manage', 'manage')
    || (!authSnapshot.isAuthenticated && client.transport.kind !== 'mesh')
  )
  const [peersResult, pairingsResult, devicesResult] = await Promise.allSettled([
    authReadsReady
      ? client.requestResult<MeshPeerListResponse, JsonObject>(
          AUTH_METHODS.meshListPeers,
          { include_disconnected: true },
          {
            path: routePath('Auth', 'MeshListPeers'),
            timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        )
      : skippedMeshAuthRead<MeshPeerListResponse>(),
    adminAuthReadsReady
      ? client.requestResult<ListPendingPairingsResponse, JsonObject>(
          AUTH_METHODS.listPendingPairings,
          { include_non_pending: true },
          {
            path: routePath('Auth', 'ListPendingPairings'),
            timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        )
      : skippedMeshAuthRead<ListPendingPairingsResponse>(),
    adminAuthReadsReady
      ? client.requestResult<DeviceListResponse, JsonObject>(
          AUTH_METHODS.listDevices,
          {},
          {
            path: routePath('Auth', 'ListDevices'),
            timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          },
        )
      : skippedMeshAuthRead<DeviceListResponse>(),
  ])
  throwIfAborted(signal)

  const peersResponse = responseDataOrNull(peersResult)
  const pairingsResponse = responseDataOrNull(pairingsResult)
  const devicesResponse = responseDataOrNull(devicesResult)
  const summaries = catalog ? summarizeCapabilities(catalog) : []
  const listCapability = capabilityFor(AUTH_METHODS.meshListPeers, summaries)
  const statusCapability = capabilityFor(GATEWAY_METHODS.getMeshStatus, summaries)
  const mutationCapability = firstCapability([AUTH_METHODS.meshApprovePeer, AUTH_METHODS.meshDenyPeer, AUTH_METHODS.meshRemovePeer], summaries)
  const metadataFields = sortConfigFields((configResponse?.fields ?? []).filter((field) => meshConfigKeyPaths.includes(field.key_path)))
  const hasEditableConfigMetadata = metadataFields.length > 0
  const configFields = metadataFields.length > 0 ? metadataFields : buildRuntimeConfigFields(statusResponse, diagnostics)
  const configWarning = failureMessage('mesh configuration', configResult, true)
  const failures = [failureMessage('connection status', statusResult), failureMessage('devices', peersResult), failureMessage('pairing queue', pairingsResult, true), failureMessage('connection details', diagnosticsResult, true), failureMessage('authorized devices', devicesResult, true), failureMessage('capability catalog', catalogResult), configWarning, failureMessage('invite credentials', inviteConfigResult, true)].filter((message): message is string => Boolean(message))
  const denied = [statusResult, peersResult, catalogResult].some(isDeniedFailure)

  if (route.disabled || (!statusResponse && !peersResponse && !catalog)) {
    const message = route.disabled ? `Capability unavailable: ${presentableSignal(route.explanation)}` : 'Mesh peer lifecycle SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      inviteConfig,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: stateFromCapability(listCapability, denied ? 'denied' : 'unsupported'),
      statusState: stateFromCapability(statusCapability, denied ? 'denied' : 'unsupported'),
      mutationState: stateFromCapability(mutationCapability, denied ? 'denied' : 'unsupported'),
      config: {
        fields: configFields,
        state: configFields.length > 0 ? 'degraded' : 'unsupported',
        reason: configFields.length > 0 ? 'Connection settings are visible, but device lifecycle is unavailable.' : message,
        secretsRedacted: configResponse?.secrets_redacted ?? true,
        editable: false,
        warnings: configWarning ? [configWarning] : [],
      },
      listReason: message,
      statusReason: message,
      mutationReason: route.requiresAdminAction ? 'Device management is not available for this route.' : message,
      warnings: failures,
      error: message,
      evidenceSource: route.disabled ? route.providerLabel : 'Aurora request error',
      transportKind: client.transport.kind,
      fixtureOnly: client.transport.kind === 'mock',
    }
  }

  const pendingPairings = pairingsResponse?.pairings.filter(isPendingPairing) ?? []
  const peerRowInput = {
    persistedPeers: peersResponse?.peers ?? [],
    pendingPairings,
    status: statusResponse,
    diagnostics,
    mutationCapability,
  }
  const rows = buildMeshPeerRows(peerRowInput)
  const pendingRequests = buildMeshPendingRequestRows(peerRowInput)
  const liveSessions = buildMeshLiveSessionRows(diagnostics, statusResponse, peersResponse?.peers ?? [])
  const devices = buildMeshDeviceRows(devicesResponse?.devices ?? [], rows, liveSessions)
  const loadState: MeshPeersLoadState = denied ? 'denied' : rows.length === 0 && pendingRequests.length === 0 && liveSessions.length === 0 && devices.length === 0 ? 'empty' : failures.length > 0 ? 'degraded' : 'ready'

  return {
    loadState,
    generatedAt: catalog?.generated_at ?? null,
    localPeerId: statusResponse?.local.peer_id ?? diagnostics?.local_mesh_peer_id ?? catalog?.local_peer_id ?? null,
    localNodeName: statusResponse?.local.node_name || diagnostics?.local_node_name || catalog?.local_node_name || 'This device',
    meshEnabled: statusResponse?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? false,
    meshStarted: statusResponse?.local.mesh_started ?? false,
    webrtcStarted: statusResponse?.local.webrtc_started ?? diagnostics?.started ?? false,
    inviteConfig,
    secretsRedacted: statusResponse?.secrets_redacted ?? catalog?.secrets_redacted ?? configResponse?.secrets_redacted ?? true,
    peers: rows,
    pendingRequests,
    liveSessions,
    devices,
    pendingCount: pendingRequests.length,
    approvedCount: rows.filter((peer) => peer.trustState === 'available-local' || peer.trustState === 'available-remote').length,
    deniedCount: rows.filter((peer) => peer.trustState === 'denied').length,
    removedCount: rows.filter((peer) => peer.outboundStatus === 'removed').length,
    runtimePeerCount: statusResponse?.peers.length ?? 0,
    liveSessionCount: liveSessions.length,
    deviceCount: devices.length,
    routeCount: statusResponse?.routes.length ?? 0,
    compatibilityFailures: statusResponse?.compatibility_failures.map((item) => `${item.peer_id} ${item.module} ${item.direction}: ${item.reason}`) ?? [],
    listState: stateFromCapability(listCapability, peersResponse ? 'available-local' : 'degraded'),
    listReason: capabilityReason(listCapability, 'Auth.MeshListPeers returned persisted trust records.'),
    statusState: stateFromCapability(statusCapability, statusResponse ? 'available-local' : 'degraded'),
    statusReason: capabilityReason(statusCapability, 'Gateway.GetMeshStatus returned mesh runtime details.'),
    mutationState: stateFromCapability(mutationCapability, mutationCapability ? mutationCapability.availability : 'unsupported'),
    mutationReason: capabilityReason(mutationCapability, 'Device management actions are available.'),
    config: {
      fields: configFields,
      state: hasEditableConfigMetadata ? 'available-local' : configFields.length > 0 ? 'degraded' : 'unsupported',
      reason: hasEditableConfigMetadata ? 'Connection settings loaded.' : 'Connection settings are visible, but editing is unavailable.',
      secretsRedacted: configResponse?.secrets_redacted ?? true,
      editable: hasEditableConfigMetadata,
      warnings: configWarning ? [configWarning] : [],
    },
    warnings: failures,
    error: denied ? 'Mesh access was denied.' : null,
    evidenceSource: client.transport.kind === 'mock' ? 'Sample data' : 'Aurora mesh and device responses',
    transportKind: client.transport.kind,
    fixtureOnly: client.transport.kind === 'mock',
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('Mesh peers request was cancelled', 'AbortError')
  }
}

/**
 * Project the local thin transport into the normal Mesh model. A saved invite
 * represents enabled mesh membership even when its expected peer is offline;
 * remote data is retained as stale instead of being replaced with an empty
 * service-unavailable page.
 */
export function reconcileMeshPeersWithThinPeer(
  next: MeshPeersSnapshot,
  thinPeer: BrowserWebRtcSnapshot | null | undefined,
  previous?: MeshPeersSnapshot | null,
  connectionEvidence?: SelectedCandidatePairEvidence | null,
): MeshPeersSnapshot {
  if (!isBrowserWebRtcConfigured(thinPeer)) return next

  const connected = isBrowserWebRtcConnected(thinPeer)
  const previousHasRemoteEvidence = Boolean(
    previous
    && previous.loadState !== 'loading'
    && previous.loadState !== 'service-unavailable'
    && previous.loadState !== 'error'
    && previous.loadState !== 'denied',
  )
  const remoteUnavailable =
    next.loadState === 'service-unavailable'
    || next.loadState === 'error'
  const base = remoteUnavailable && previousHasRemoteEvidence
    ? {
        ...previous!,
        warnings: uniqueStrings([
          ...previous!.warnings,
          ...next.warnings,
        ]),
      }
    : next
  const peerId = thinPeer.expectedStablePeerId!
  const nodeName = thinPeer.nodeName?.trim() || 'Invited Aurora device'
  const peerState: AvailabilityState = connected
    ? 'available-remote'
    : thinPeer.status === 'pairing'
      ? 'pending'
      : 'stale'
  const connectionStatus = connected ? 'connected' : 'offline'
  const measuredLatencyMs = connected
    ? connectionRoundTripTimeMs(connectionEvidence)
    : null
  const existingPeer = base.peers.find((peer) => peer.peerId === peerId)
  const projectedPeer: MeshPeerRow = existingPeer
    ? {
        ...existingPeer,
        nodeName: existingPeer.nodeName || nodeName,
        lifecycleState: peerState,
        lifecycleLabel: connected
          ? 'Approved device'
          : 'Saved device is offline',
        connectionStatus,
        latencyMs: measuredLatencyMs ?? existingPeer.latencyMs,
        lastSeen: thinPeer.updatedAt,
        lastEvidenceSource: 'Saved device profile',
      }
    : {
        peerId,
        nodeName,
        roomName: 'saved invite profile',
        lifecycleState: peerState,
        lifecycleLabel: connected
          ? 'Approved device'
          : 'Saved device is offline',
        trustState: connected ? 'available-remote' : peerState,
        trustLabel: connected
          ? 'Approved device'
          : 'Saved device identity; live trust state unavailable while offline',
        outboundStatus: connected ? 'approved' : 'saved',
        inboundStatus: connected ? 'approved' : 'unknown',
        connectionStatus,
        fingerprint: peerId,
        permissions: [],
        inboundPermissions: [],
        latencyMs: measuredLatencyMs,
        routeQuality: connected ? 'connected' : 'offline',
        compatibility: 'checked again on reconnect',
        serviceCount: 0,
        services: [],
        lastSeen: thinPeer.updatedAt,
        lastEvidenceSource: 'Saved device profile',
        pendingPairing: null,
        approveAction: null,
        denyAction: null,
        removeAction: null,
      }
  const peers = [
    ...base.peers.filter((peer) => peer.peerId !== peerId),
    projectedPeer,
  ]
  const warnings = uniqueStrings([
    ...base.warnings.filter((warning) => !isExpectedOfflineTransportMessage(warning)),
    ...(!connected
      ? [`${nodeName} is offline. Saved devices and last-known services stay visible until a trusted connection returns.`]
      : []),
  ])

  return {
    ...base,
    loadState: base.loadState === 'denied'
      ? 'denied'
      : connected && !remoteUnavailable
        ? base.loadState
        : 'degraded',
    meshEnabled: true,
    meshStarted: true,
    webrtcStarted: true,
    peers,
    approvedCount: peers.filter((peer) =>
      peer.trustState === 'available-local'
      || peer.trustState === 'available-remote',
    ).length,
    listState: connected
      ? base.listState
      : base.peers.length > 0
        ? 'stale'
        : peerState,
    listReason: connected
      ? base.listReason
      : `Saved peer ${nodeName} is offline; retained peer and capability metadata is stale until reconnect.`,
    statusState: connected ? base.statusState : 'degraded',
    statusReason: connected
      ? base.statusReason
      : 'Aurora is retrying the saved device.',
    warnings,
    error: base.loadState === 'denied' ? base.error : null,
    evidenceSource: remoteUnavailable
      ? 'Saved device profile'
      : 'Aurora mesh and device responses',
  }
}

export function buildLocalMeshNodeSnapshot({
  localNode,
  thinPeer,
  peerRoster,
  connectionEvidence,
  connectionEvidenceByPeer,
  featureSharing,
  sharingAvailable,
}: {
  localNode?: LocalMeshNodeIdentity | undefined
  thinPeer?: BrowserWebRtcSnapshot | null | undefined
  peerRoster?: MeshPeerRosterSnapshot | null | undefined
  connectionEvidence?: SelectedCandidatePairEvidence | null | undefined
  connectionEvidenceByPeer?: ReadonlyMap<string, SelectedCandidatePairEvidence> | undefined
  featureSharing?: LocalFeatureSharingSnapshot | null | undefined
  sharingAvailable?: boolean
}): MeshPeersSnapshot {
  const rosterPeers = peerRoster?.peers ?? []
  const authorizedRosterPeers = rosterPeers.filter((entry) => entry.snapshot.state === 'authorized')
  const configured = isBrowserWebRtcConfigured(thinPeer) || rosterPeers.length > 0
  const connected = authorizedRosterPeers.length > 0 || isBrowserWebRtcConnected(thinPeer)
  const expectedPeerId = configured ? thinPeer?.expectedStablePeerId ?? null : null
  const featureById = new Map((featureSharing?.features ?? []).map((feature) => [feature.id, feature]))
  const approvedDevices = featureSharing?.approvedDevices ?? []
  const serviceScopes = featureSharing ? localShareableServiceScopes(featureSharing) : []
  const latencyMs = connected ? connectionRoundTripTimeMs(connectionEvidence) : null
  const latencyForPeer = (peerId: string) => connectionRoundTripTimeMs(connectionEvidenceByPeer?.get(peerId))
    ?? (peerId === (peerRoster?.primaryPeerId ?? expectedPeerId) ? latencyMs : null)
  const rows = new Map<string, MeshPeerRow>()
  const rosterByPeerId = new Map(rosterPeers.map((entry) => [entry.peerId, entry]))
  const primaryPeerId = peerRoster?.primaryPeerId ?? expectedPeerId

  for (const approved of approvedDevices) {
    const rosterEntry = rosterByPeerId.get(approved.peerId)
    const isCurrent = approved.peerId === primaryPeerId
    const peerConnected = rosterEntry?.snapshot.state === 'authorized'
      || (rosterPeers.length === 0 && approved.peerId === expectedPeerId && connected)
    const grantedFeatures = approved.featureIds
      .map((featureId) => featureById.get(featureId))
      .filter((feature): feature is LocalDeviceFeature => Boolean(feature?.available && feature.enabled))
    const grantedFeatureIds = new Set(grantedFeatures.map((feature) => feature.id))
    const grantedServices = serviceScopes.filter((scope) =>
      scope.featureIds.some((featureId) => grantedFeatureIds.has(featureId)),
    )
    const permissions = grantedServices.map((scope) => scope.permissionId)
    rows.set(approved.peerId, localMeshPeerRow({
      peerId: approved.peerId,
      nodeName: rosterEntry?.nodeName?.trim()
        || rosterEntry?.snapshot.nodeName?.trim()
        || (isCurrent ? thinPeer?.nodeName?.trim() : '')
        || approved.peerLabel,
      connected: peerConnected,
      updatedAt: rosterEntry?.snapshot.updatedAt ?? (isCurrent ? thinPeer?.updatedAt ?? null : null),
      latencyMs: peerConnected ? latencyForPeer(approved.peerId) : null,
      permissions,
      services: grantedServices.map((scope) => scope.label),
    }))
  }

  for (const entry of authorizedRosterPeers) {
    if (rows.has(entry.peerId)) continue
    rows.set(entry.peerId, localMeshPeerRow({
      peerId: entry.peerId,
      nodeName: entry.nodeName?.trim() || entry.snapshot.nodeName?.trim() || 'Connected Aurora device',
      connected: true,
      updatedAt: entry.snapshot.updatedAt,
      latencyMs: latencyForPeer(entry.peerId),
      permissions: [],
      services: [],
    }))
  }

  if (expectedPeerId && !thinPeer?.pairingSessionId && !rows.has(expectedPeerId)) {
    rows.set(expectedPeerId, localMeshPeerRow({
      peerId: expectedPeerId,
      nodeName: thinPeer?.nodeName?.trim() || 'Connected Aurora device',
      connected,
      updatedAt: thinPeer?.updatedAt ?? null,
      latencyMs,
      permissions: [],
      services: [],
    }))
  }

  const peers = [...rows.values()].sort((left, right) => left.nodeName.localeCompare(right.nodeName) || left.peerId.localeCompare(right.peerId))
  const liveSessions = authorizedRosterPeers.length > 0
    ? authorizedRosterPeers.map((entry) => localMeshSessionRow({
        peerId: entry.peerId,
        nodeName: entry.nodeName,
        snapshot: entry.snapshot,
        latencyMs: latencyForPeer(entry.peerId),
      }))
    : connected && expectedPeerId
      ? [localMeshSessionRow({
          peerId: expectedPeerId,
          nodeName: thinPeer?.nodeName,
          snapshot: {
            icePathCategory: thinPeer!.icePathCategory,
            updatedAt: thinPeer!.updatedAt,
            ...(thinPeer?.nodeName ? { nodeName: thinPeer.nodeName } : {}),
            ...(thinPeer?.pairingSessionId
              ? {
                  pendingPairing: {
                    sessionId: thinPeer.pairingSessionId,
                    verificationCode: thinPeer.pairingVerificationCode ?? '',
                    remoteStablePeerId: expectedPeerId,
                    remoteNodeName: thinPeer.nodeName ?? '',
                  },
                }
              : {}),
          },
          latencyMs,
        })]
      : []
  const localNodeName = localNode?.nodeName.trim() || 'This device'
  const sharingUnavailable = sharingAvailable === true && featureSharing == null
  const warnings = sharingUnavailable
    ? ['Sharing choices are unavailable right now. Try refreshing this page.']
    : []
  return {
    ...loadingSnapshot,
    loadState: sharingUnavailable || (configured && !connected) ? 'degraded' : peers.length === 0 ? 'empty' : 'ready',
    generatedAt: new Date().toISOString(),
    localPeerId: localNode?.peerId ?? null,
    localNodeName,
    meshEnabled: configured,
    meshStarted: configured,
    webrtcStarted: connected,
    peers,
    pendingRequests: [],
    liveSessions,
    devices: [],
    pendingCount: rosterPeers.filter((entry) => Boolean(entry.snapshot.pendingPairing)).length
      || (thinPeer?.pairingSessionId ? 1 : 0),
    approvedCount: peers.filter((peer) => peer.trustState === 'available-local' || peer.trustState === 'available-remote').length,
    deniedCount: 0,
    removedCount: 0,
    runtimePeerCount: peers.length,
    liveSessionCount: liveSessions.length,
    deviceCount: peers.length,
    routeCount: liveSessions.length,
    compatibilityFailures: [],
    listState: sharingUnavailable ? 'degraded' : peers.length === 0 ? 'available-local' : connected ? 'available-remote' : 'stale',
    listReason: sharingUnavailable
      ? 'Sharing choices are unavailable right now.'
      : peers.length === 0
        ? 'No approved devices are saved on this device.'
        : 'Approved devices saved on this device.',
    statusState: connected ? 'available-remote' : configured ? 'degraded' : 'available-local',
    statusReason: connected ? 'A direct device connection is active.' : configured ? 'Aurora is retrying the saved device.' : 'No direct device connection is configured.',
    mutationState: sharingAvailable ? 'available-local' : 'unsupported',
    mutationReason: sharingAvailable ? 'Sharing choices are stored on this device.' : 'Sharing choices are unavailable on this device.',
    config: {
      fields: [],
      state: 'unsupported',
      reason: 'Connection settings are managed in this device profile.',
      secretsRedacted: true,
      editable: false,
      warnings: [],
    },
    warnings,
    error: null,
    evidenceSource: 'This device and its direct connections',
    transportKind: 'mesh',
    fixtureOnly: false,
  }
}

function localMeshPeerRow({
  peerId,
  nodeName,
  connected,
  updatedAt,
  latencyMs,
  permissions,
  services,
}: {
  peerId: string
  nodeName: string
  connected: boolean
  updatedAt: string | null
  latencyMs: number | null
  permissions: string[]
  services: string[]
}): MeshPeerRow {
  return {
    peerId,
    nodeName: nodeName.trim() || 'Approved device',
    roomName: 'direct device connection',
    lifecycleState: connected ? 'available-remote' : 'stale',
    lifecycleLabel: connected ? 'Approved device' : 'Saved device is offline',
    trustState: connected ? 'available-remote' : 'stale',
    trustLabel: connected ? 'Approved device' : 'Approved device; currently offline',
    outboundStatus: 'approved',
    inboundStatus: permissions.length > 0 ? 'approved' : 'not shared',
    connectionStatus: connected ? 'connected' : 'offline',
    fingerprint: peerId,
    permissions,
    inboundPermissions: permissions,
    latencyMs,
    routeQuality: connected ? 'connected' : 'offline',
    compatibility: connected ? 'compatible' : 'checked again on reconnect',
    serviceCount: services.length,
    services,
    lastSeen: updatedAt,
    lastEvidenceSource: 'Saved on this device',
    pendingPairing: null,
    approveAction: null,
    denyAction: null,
    removeAction: null,
  }
}

function localMeshSessionRow({
  peerId,
  nodeName,
  snapshot,
  latencyMs,
}: {
  peerId: string
  nodeName?: string | undefined
  snapshot: Pick<PeerConnectionSnapshot, 'icePathCategory' | 'pendingPairing' | 'updatedAt'> & { nodeName?: string | undefined }
  latencyMs: number | null
}): MeshLiveSessionRow {
  const pendingPairing = snapshot.pendingPairing
  return {
    sessionId: `direct:${peerId}`,
    stablePeerId: peerId,
    nodeName: nodeName?.trim() || snapshot.nodeName?.trim() || 'Connected Aurora device',
    pairingSessionId: pendingPairing?.sessionId ?? null,
    verificationCode: pendingPairing?.verificationCode ?? null,
    state: 'available-remote',
    connectionState: 'connected',
    iceState: snapshot.icePathCategory,
    dataChannelState: 'connected',
    authState: 'approved',
    latencyMs,
    identitySource: 'Saved device identity',
    permissions: 'Approved connection',
    pairingState: pendingPairing ? 'Waiting for approval' : 'Complete',
    linkedPeerState: 'Linked',
    evidenceSource: 'Direct connection',
  }
}

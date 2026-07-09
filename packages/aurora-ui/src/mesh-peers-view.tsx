'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, GitBranch, KeyRound, LockKeyhole, Network, QrCode, RadioTower, RefreshCw, Router, Settings2, ShieldCheck, Signal, UsersRound, Wifi } from 'lucide-react'
import { AUTH_METHODS, AuroraError, GATEWAY_METHODS, routePath, summarizeCapabilities, type AuroraClient, type AuthPairingConnectResponse, type AuthPairingStartResponse, type AvailabilityState, type CapabilitySummary, type ConfigFieldMetadata, type DeviceListResponse, type DeviceResponse, type JsonObject, type JsonValue, type ListPendingPairingsResponse, type MeshPeerListResponse, type MeshPeerDiagnostic, type MeshPeerInfo, type MeshRouteDiagnostic, type MeshStatusResponse, type PendingPairingEntry, type PermissionCatalogEntry, type WebRTCDiagnosticsResponse } from '@aurora/client'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Checkbox } from '#components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { Progress } from '#components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '#components/ui/sheet'
import { Skeleton } from '#components/ui/skeleton'
import { Switch } from '#components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs'
import { Textarea } from '#components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { PermissionEditorTable, ROLE_TEMPLATES, matchRoleTemplate } from './shared-components'
import { presentableSignal } from './status-badges'
import type { RouteAvailability } from './shell-data'

export type MeshPeersLoadState = 'loading' | 'ready' | 'empty' | 'degraded' | 'denied' | 'service-unavailable' | 'error'

export interface MeshPeerAdminAction {
  methodId: typeof AUTH_METHODS.meshApprovePeer | typeof AUTH_METHODS.meshDenyPeer | typeof AUTH_METHODS.meshRemovePeer
  payload: JsonObject
  reason: string
  reauthConfirmed: boolean
  affectedResources: string[]
  path: string
}

export interface MeshPeerRow {
  peerId: string
  nodeName: string
  roomName: string
  lifecycleState: AvailabilityState
  lifecycleLabel: string
  trustState: AvailabilityState
  trustLabel: string
  outboundStatus: string
  inboundStatus: string
  connectionStatus: string
  fingerprint: string
  permissions: string[]
  inboundPermissions: string[]
  latencyMs: number | null
  routeQuality: string
  compatibility: string
  serviceCount: number
  services: string[]
  lastSeen: string | null
  lastEvidenceSource: string
  pendingPairing: PendingPairingEntry | null
  approveAction: MeshPeerAdminAction | null
  denyAction: MeshPeerAdminAction | null
  removeAction: MeshPeerAdminAction | null
}

export interface MeshLiveSessionRow {
  sessionId: string
  stablePeerId: string
  nodeName: string
  state: AvailabilityState
  connectionState: string
  iceState: string
  dataChannelState: string
  authState: string
  latencyMs: number | null
  identitySource: string
  permissions: string
  pairingState: string
  linkedPeerState: string
  evidenceSource: string
}

export interface MeshDeviceRow {
  deviceId: string
  name: string
  principalId: string | null
  state: AvailabilityState
  trustLabel: string
  linkedPeerId: string | null
  linkedPeerLabel: string
  lastSeen: string | null
  evidenceSource: string
}

export interface MeshConfigChange {
  keyPath: string
  value: JsonValue
}

export interface MeshConfigSnapshot {
  fields: ConfigFieldMetadata[]
  state: AvailabilityState
  reason: string
  secretsRedacted: boolean
  editable: boolean
  warnings: string[]
}

export interface MeshPeersSnapshot {
  loadState: MeshPeersLoadState
  generatedAt: string | null
  localPeerId: string | null
  localNodeName: string
  meshEnabled: boolean
  meshStarted: boolean
  webrtcStarted: boolean
  secretsRedacted: boolean
  peers: MeshPeerRow[]
  liveSessions: MeshLiveSessionRow[]
  devices: MeshDeviceRow[]
  pendingCount: number
  approvedCount: number
  deniedCount: number
  removedCount: number
  runtimePeerCount: number
  liveSessionCount: number
  deviceCount: number
  routeCount: number
  compatibilityFailures: string[]
  listState: AvailabilityState
  listReason: string
  statusState: AvailabilityState
  statusReason: string
  mutationState: AvailabilityState
  mutationReason: string
  config: MeshConfigSnapshot
  warnings: string[]
  error: string | null
  evidenceSource: string
  transportKind: string
  fixtureOnly: boolean
}

export interface MeshPeersResourceProps {
  client: AuroraClient
  route: RouteAvailability
}

export interface MeshPeersViewProps {
  snapshot: MeshPeersSnapshot
  route: RouteAvailability
  permissions?: string
  revokeToken?: boolean
  pendingPeerId?: string | null
  optimisticPeerId?: string | null
  mutationError?: string | null
  configPendingKey?: string | null
  configMutationError?: string | null
  onPermissionsChange?: (value: string) => void
  onRevokeTokenChange?: (value: boolean) => void
  onRefresh?: () => void
  onApprovePeer?: (peer: MeshPeerRow) => void
  onDenyPeer?: (peer: MeshPeerRow) => void
  onRemovePeer?: (peer: MeshPeerRow) => void
  onConfigChange?: (changes: MeshConfigChange[]) => void
  onCreatePairingCode?: (input: MeshPairingStartInput) => void
  onConnectPairingCode?: (code: string) => void
  onSaveScopes?: (peer: MeshPeerRow, permissions: string[]) => void
  pairingOperation?: MeshPairingOperation
}

export interface MeshPairingStartInput {
  deviceName: string
  remotePeerId?: string
  remoteNodeName?: string
}

export interface MeshPairingOperation {
  pending: boolean
  error: string | null
  created: AuthPairingStartResponse | null
  connected: AuthPairingConnectResponse | null
}

const meshConfigKeyPaths = ['services.gateway.mesh_network.enabled', 'services.gateway.mesh_network.node_name', 'services.gateway.mesh_network.version_policy', 'services.gateway.mesh_network.peer_selection', 'services.gateway.mesh_network.ping_interval_s', 'services.gateway.mesh_network.registry_announce_interval_s', 'services.gateway.mesh_network.stale_peer_timeout_s', 'services.gateway.mesh_network.remote_timeout_s', 'services.gateway.webrtc.enabled', 'services.gateway.webrtc.strategy', 'services.gateway.webrtc.app_id', 'services.gateway.webrtc.room', 'services.gateway.webrtc.password', 'services.gateway.webrtc.encrypt_signaling', 'services.gateway.webrtc.enable_app_layer_e2ee', 'services.gateway.webrtc.stun_servers', 'services.gateway.webrtc.turn_servers', 'services.gateway.signaling_mqtt.brokers', 'services.gateway.signaling_mqtt.topic_root', 'services.auth.default_pairing_permissions', 'services.auth.webrtc_auth_timeout_seconds', 'services.auth.webrtc_pairing_timeout_seconds']

const MESH_PRIMARY_READ_TIMEOUT_MS = 8_000
const MESH_OPTIONAL_READ_TIMEOUT_MS = 5_000

const loadingSnapshot: MeshPeersSnapshot = {
  loadState: 'loading',
  generatedAt: null,
  localPeerId: null,
  localNodeName: 'Loading Aurora mesh',
  meshEnabled: false,
  meshStarted: false,
  webrtcStarted: false,
  secretsRedacted: true,
  peers: [],
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
  listReason: 'Loading mesh peers, pending requests, WebRTC state, and capability catalog through Aurora.',
  statusState: 'pending',
  statusReason: 'Loading Gateway.GetMeshStatus through Aurora.',
  mutationState: 'pending',
  mutationReason: 'Loading Auth mesh peer manage capabilities.',
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

export function MeshPeersResource({ client, route }: MeshPeersResourceProps) {
  const [snapshot, setSnapshot] = useState<MeshPeersSnapshot>(loadingSnapshot)
  const [permissions, setPermissions] = useState('Gateway.use')
  const [revokeToken, setRevokeToken] = useState(true)
  const [pendingPeerId, setPendingPeerId] = useState<string | null>(null)
  const [optimisticPeerId, setOptimisticPeerId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [configPendingKey, setConfigPendingKey] = useState<string | null>(null)
  const [configMutationError, setConfigMutationError] = useState<string | null>(null)
  const [pairingOperation, setPairingOperation] = useState<MeshPairingOperation>({
    pending: false,
    error: null,
    created: null,
    connected: null,
  })

  const loadPeers = useCallback(async () => {
    setSnapshot(loadingSnapshot)
    const next = await buildMeshPeersSnapshot(client, route)
    setSnapshot(next)
  }, [client, route])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void buildMeshPeersSnapshot(client, route).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    return () => {
      cancelled = true
    }
  }, [client, route])

  const runAction = useCallback(
    async (peer: MeshPeerRow, kind: 'approve' | 'deny' | 'remove') => {
      const action =
        kind === 'approve'
          ? buildMeshPeerAdminAction(peer, 'approve', {
              reason: `Approve ${peer.nodeName}`,
              permissions,
              reauthConfirmed: true,
            })
          : kind === 'deny'
            ? buildMeshPeerAdminAction(peer, 'deny', {
                reason: `Deny ${peer.nodeName}`,
                reauthConfirmed: true,
              })
            : buildMeshPeerAdminAction(peer, 'remove', {
                reason: `Remove ${peer.nodeName}`,
                revokeToken,
                reauthConfirmed: true,
              })
      if (!action) return
      setPendingPeerId(peer.peerId)
      setOptimisticPeerId(peer.peerId)
      setMutationError(null)
      try {
        await client.admin.execute(action)
        await loadPeers()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        setPendingPeerId(null)
        setOptimisticPeerId(null)
      }
    },
    [client.admin, loadPeers, permissions, revokeToken],
  )

  const runConfigChange = useCallback(
    async (changes: MeshConfigChange[]) => {
      if (changes.length === 0) return
      setConfigPendingKey('__batch__')
      setConfigMutationError(null)
      try {
        const configChanges = changes.map((change) => ({
          key_path: change.keyPath,
          value: change.value,
        }))
        const diff = await client.config.previewDiff({
          changes: configChanges,
        })
        if (!diff.ok || !diff.data?.valid) {
          throw new Error(diff.ok ? diff.data?.errors.join('; ') || 'Config change was not valid.' : meshPeerErrorMessage(diff.error))
        }
        await client.config.previewReloadImpact({ changes: configChanges })
        for (const change of configChanges) {
          setConfigPendingKey(change.key_path)
          await client.config.applyChange({
            change,
            reason: `Update mesh configuration ${change.key_path}`,
            reauthConfirmed: true,
          })
        }
        await loadPeers()
      } catch (error) {
        setConfigMutationError(meshPeerErrorMessage(error))
      } finally {
        setConfigPendingKey(null)
      }
    },
    [client.config, loadPeers],
  )

  const createPairingCode = useCallback(
    async (input: MeshPairingStartInput) => {
      const deviceName = input.deviceName.trim()
      if (!deviceName) {
        setPairingOperation((current) => ({
          ...current,
          error: 'Enter a device name before creating a pairing code.',
        }))
        return
      }
      setPairingOperation({
        pending: true,
        error: null,
        created: null,
        connected: null,
      })
      try {
        const payload = { device_name: deviceName } as {
          device_name: string
          remote_peer_id?: string
          remote_node_name?: string
        }
        const remotePeerId = input.remotePeerId?.trim()
        const remoteNodeName = input.remoteNodeName?.trim()
        if (remotePeerId) payload.remote_peer_id = remotePeerId
        if (remoteNodeName) payload.remote_node_name = remoteNodeName
        const result = await client.authApi.pairingStart(payload)
        if (!result.ok || !result.data) throw new Error(result.ok ? 'Pairing code was not returned by Auth.PairingStart.' : meshPeerErrorMessage(result.error))
        setPairingOperation({
          pending: false,
          error: null,
          created: result.data,
          connected: null,
        })
        await loadPeers()
      } catch (error) {
        setPairingOperation({
          pending: false,
          error: meshPeerErrorMessage(error),
          created: null,
          connected: null,
        })
      }
    },
    [client.authApi, loadPeers],
  )

  const connectPairingCode = useCallback(
    async (code: string) => {
      const normalizedCode = code.trim()
      if (!normalizedCode) {
        setPairingOperation((current) => ({
          ...current,
          error: 'Enter the peer pairing code before connecting.',
        }))
        return
      }
      setPairingOperation({
        pending: true,
        error: null,
        created: null,
        connected: null,
      })
      try {
        const result = await client.authApi.pairingConnect({
          code: normalizedCode,
        })
        if (!result.ok || !result.data) throw new Error(result.ok ? 'Pairing request was not returned by Auth.PairingConnect.' : meshPeerErrorMessage(result.error))
        setPairingOperation({
          pending: false,
          error: null,
          created: null,
          connected: result.data,
        })
        await loadPeers()
      } catch (error) {
        setPairingOperation({
          pending: false,
          error: meshPeerErrorMessage(error),
          created: null,
          connected: null,
        })
      }
    },
    [client.authApi, loadPeers],
  )

  const saveScopes = useCallback(
    async (peer: MeshPeerRow, nextPermissions: string[]) => {
      const action = buildMeshPeerAdminAction(peer, 'approve', {
        reason: `Update scopes for ${peer.nodeName}`,
        permissions: nextPermissions.join(', '),
        reauthConfirmed: true,
      })
      if (!action) return
      setPendingPeerId(peer.peerId)
      setOptimisticPeerId(peer.peerId)
      setMutationError(null)
      try {
        await client.admin.execute(action)
        await loadPeers()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        setPendingPeerId(null)
        setOptimisticPeerId(null)
      }
    },
    [client.admin, loadPeers],
  )

  return <MeshPeersView snapshot={snapshot} route={route} permissions={permissions} revokeToken={revokeToken} pendingPeerId={pendingPeerId} optimisticPeerId={optimisticPeerId} mutationError={mutationError} configPendingKey={configPendingKey} configMutationError={configMutationError} onPermissionsChange={setPermissions} onRevokeTokenChange={setRevokeToken} onRefresh={loadPeers} onApprovePeer={(peer) => runAction(peer, 'approve')} onDenyPeer={(peer) => runAction(peer, 'deny')} onRemovePeer={(peer) => runAction(peer, 'remove')} onConfigChange={runConfigChange} onCreatePairingCode={createPairingCode} onConnectPairingCode={connectPairingCode} onSaveScopes={saveScopes} pairingOperation={pairingOperation} />
}

export async function buildMeshPeersSnapshot(client: AuroraClient, route: RouteAvailability): Promise<MeshPeersSnapshot> {
  const [statusResult, peersResult, pairingsResult, diagnosticsResult, devicesResult, catalogResult, configResult, configValuesResult] = await Promise.allSettled([
    client.requestResult<MeshStatusResponse, JsonObject>(
      GATEWAY_METHODS.getMeshStatus,
      {},
      {
        path: routePath('Gateway', 'GetMeshStatus'),
        timeoutMs: MESH_PRIMARY_READ_TIMEOUT_MS,
      },
    ),
    client.requestResult<MeshPeerListResponse, JsonObject>(
      AUTH_METHODS.meshListPeers,
      { include_disconnected: true },
      {
        path: routePath('Auth', 'MeshListPeers'),
        timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
      },
    ),
    client.requestResult<ListPendingPairingsResponse, JsonObject>(
      AUTH_METHODS.listPendingPairings,
      { include_non_pending: true },
      {
        path: routePath('Auth', 'ListPendingPairings'),
        timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
      },
    ),
    client.request<WebRTCDiagnosticsResponse, JsonObject>(
      GATEWAY_METHODS.getWebRTCDiagnostics,
      {},
      {
        path: routePath('Gateway', 'GetWebRTCDiagnostics'),
        timeoutMs: MESH_PRIMARY_READ_TIMEOUT_MS,
      },
    ),
    client.requestResult<DeviceListResponse, JsonObject>(
      AUTH_METHODS.listDevices,
      {},
      {
        path: routePath('Auth', 'ListDevices'),
        timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
      },
    ),
    withUiTimeout(
      client.capabilities.listCatalog({
        include_unavailable: true,
        include_internal: true,
      }),
      MESH_PRIMARY_READ_TIMEOUT_MS,
      'capability catalog',
    ),
    client.config.getSchemaMetadata({ include_values: true }),
    client.config.get({ section: 'services' }),
  ])

  const statusResponse = responseDataOrNull(statusResult)
  const peersResponse = responseDataOrNull(peersResult)
  const pairingsResponse = responseDataOrNull(pairingsResult)
  const diagnostics = valueOrNull(diagnosticsResult)
  const devicesResponse = responseDataOrNull(devicesResult)
  const catalog = valueOrNull(catalogResult)
  const configResponse = responseDataOrNull(configResult)
  const configValuesResponse = responseDataOrNull(configValuesResult)
  const summaries = catalog ? summarizeCapabilities(catalog) : []
  const listCapability = capabilityFor(AUTH_METHODS.meshListPeers, summaries)
  const statusCapability = capabilityFor(GATEWAY_METHODS.getMeshStatus, summaries)
  const mutationCapability = firstCapability([AUTH_METHODS.meshApprovePeer, AUTH_METHODS.meshDenyPeer, AUTH_METHODS.meshRemovePeer], summaries)
  const metadataFields = sortConfigFields((configResponse?.fields ?? []).filter((field) => meshConfigKeyPaths.includes(field.key_path)))
  const valueFields = buildConfigValueFields(configValuesResponse?.config ?? null)
  const realConfigFields = mergeConfigFields(metadataFields, valueFields)
  const hasEditableConfigMetadata = metadataFields.length > 0
  const configFields = realConfigFields.length > 0 ? realConfigFields : buildRuntimeConfigFields(statusResponse, diagnostics)
  const configWarning = failureMessage('mesh configuration', configResult, true)
  const failures = [failureMessage('mesh status', statusResult), failureMessage('mesh peers', peersResult), failureMessage('pairing queue', pairingsResult, true), failureMessage('WebRTC diagnostics', diagnosticsResult, true), failureMessage('Auth devices', devicesResult, true), failureMessage('capability catalog', catalogResult), configWarning, failureMessage('mesh config values', configValuesResult, true)].filter((message): message is string => Boolean(message))
  const denied = [statusResult, peersResult, catalogResult].some(isDeniedFailure)

  if (route.disabled || (!statusResponse && !peersResponse && !catalog)) {
    const message = route.disabled ? `Capability unavailable: ${presentableSignal(route.explanation)}` : 'Mesh peer lifecycle SDK resources are unavailable.'
    return {
      ...loadingSnapshot,
      loadState: denied ? 'denied' : 'service-unavailable',
      listState: stateFromCapability(listCapability, denied ? 'denied' : 'unsupported'),
      statusState: stateFromCapability(statusCapability, denied ? 'denied' : 'unsupported'),
      mutationState: stateFromCapability(mutationCapability, denied ? 'denied' : 'unsupported'),
      config: {
        fields: configFields,
        state: configFields.length > 0 ? 'degraded' : 'unsupported',
        reason: configFields.length > 0 ? 'Mesh settings are visible, but peer lifecycle is unavailable.' : message,
        secretsRedacted: configResponse?.secrets_redacted ?? true,
        editable: false,
        warnings: configWarning ? [configWarning] : [],
      },
      listReason: message,
      statusReason: message,
      mutationReason: route.requiresAdminAction ? 'Peer management is not available for this route.' : message,
      warnings: failures,
      error: message,
      evidenceSource: route.disabled ? route.providerLabel : 'Aurora request error',
      transportKind: client.transport.kind,
      fixtureOnly: client.transport.kind === 'mock',
    }
  }

  const rows = buildMeshPeerRows({
    persistedPeers: peersResponse?.peers ?? [],
    pendingPairings: pairingsResponse?.pairings.filter(isPendingPairing) ?? [],
    status: statusResponse,
    diagnostics,
    mutationCapability,
  })
  const liveSessions = buildMeshLiveSessionRows(diagnostics, statusResponse, peersResponse?.peers ?? [])
  const devices = buildMeshDeviceRows(devicesResponse?.devices ?? [], rows, liveSessions)
  const loadState: MeshPeersLoadState = denied ? 'denied' : rows.length === 0 && liveSessions.length === 0 && devices.length === 0 ? 'empty' : failures.length > 0 ? 'degraded' : 'ready'

  return {
    loadState,
    generatedAt: catalog?.generated_at ?? null,
    localPeerId: statusResponse?.local.peer_id ?? diagnostics?.local_mesh_peer_id ?? catalog?.local_peer_id ?? null,
    localNodeName: statusResponse?.local.node_name || diagnostics?.local_node_name || catalog?.local_node_name || 'Aurora node',
    meshEnabled: statusResponse?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? false,
    meshStarted: statusResponse?.local.mesh_started ?? false,
    webrtcStarted: statusResponse?.local.webrtc_started ?? diagnostics?.started ?? false,
    secretsRedacted: statusResponse?.secrets_redacted ?? catalog?.secrets_redacted ?? configResponse?.secrets_redacted ?? true,
    peers: rows,
    liveSessions,
    devices,
    pendingCount: rows.filter((peer) => peer.trustState === 'pending').length,
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
    mutationReason: capabilityReason(mutationCapability, 'Auth mesh peer mutations are available.'),
    config: {
      fields: configFields,
      state: hasEditableConfigMetadata ? 'available-local' : configFields.length > 0 ? 'degraded' : 'unsupported',
      reason: hasEditableConfigMetadata ? 'Mesh configuration loaded.' : 'Mesh settings are visible, but editable metadata was not reported.',
      secretsRedacted: configResponse?.secrets_redacted ?? true,
      editable: hasEditableConfigMetadata,
      warnings: configWarning ? [configWarning] : [],
    },
    warnings: failures,
    error: denied ? 'Mesh peer lifecycle access was denied by Auth or Gateway.' : null,
    evidenceSource: client.transport.kind === 'mock' ? 'Local preview data is not live runtime state' : 'Aurora mesh, auth, gateway, device, config, and capability responses',
    transportKind: client.transport.kind,
    fixtureOnly: client.transport.kind === 'mock',
  }
}

export function MeshPeersView({
  snapshot,
  route,
  permissions = '',
  revokeToken = true,
  pendingPeerId = null,
  optimisticPeerId = null,
  mutationError = null,
  configPendingKey = null,
  configMutationError = null,
  pairingOperation = {
    pending: false,
    error: null,
    created: null,
    connected: null,
  },
  onPermissionsChange,
  onRevokeTokenChange,
  onRefresh,
  onApprovePeer,
  onDenyPeer,
  onRemovePeer,
  onConfigChange,
  onCreatePairingCode,
  onConnectPairingCode,
  onSaveScopes,
}: MeshPeersViewProps) {
  const [reviewPeerId, setReviewPeerId] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [includeInvitePassword, setIncludeInvitePassword] = useState(false)
  const [scopesPeerId, setScopesPeerId] = useState<string | null>(null)
  const connectedPeers = snapshot.peers.filter((peer) => peer.lifecycleState === 'available-remote' || peer.connectionStatus === 'connected')
  const pendingPeers = snapshot.peers.filter((peer) => peer.trustState === 'pending' || peer.pendingPairing)
  const reviewPeer = snapshot.peers.find((peer) => peer.peerId === reviewPeerId) ?? null
  const scopesPeer = snapshot.peers.find((peer) => peer.peerId === scopesPeerId) ?? null
  const controlsDisabled = route.disabled || snapshot.loadState === 'loading' || snapshot.loadState === 'denied'
  const mutationDisabled = controlsDisabled || Boolean(pendingPeerId) || !['available-local', 'available-remote', 'degraded'].includes(snapshot.mutationState)
  const invitePayload = useMemo(() => buildMeshInvitePayload(snapshot, includeInvitePassword), [includeInvitePassword, snapshot])
  const inviteText = useMemo(() => JSON.stringify(invitePayload, null, 2), [invitePayload])
  const meshEnabledField = configField(snapshot.config.fields, 'services.gateway.mesh_network.enabled')
  const meshEnabledChecked = configBoolean(snapshot.config.fields, 'services.gateway.mesh_network.enabled', snapshot.meshEnabled)
  const masterSwitchUnavailable = !meshEnabledField ? 'services.gateway.mesh_network.enabled was not reported by config metadata or runtime status.' : !snapshot.config.editable ? 'Config preview/apply metadata is unavailable; showing the last reported mesh state read-only.' : !onConfigChange ? 'Config mutation handler is unavailable in this surface.' : null
  const masterSwitchDisabled = controlsDisabled || Boolean(configPendingKey) || Boolean(masterSwitchUnavailable)

  return (
    <div className="flex flex-col gap-5" aria-labelledby="mesh-peers-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 id="mesh-peers-title" className="text-xl font-semibold tracking-tight">
            Mesh &amp; Peers
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">Peer trust, pairing and permissions. Peer-specific tools live on the Tools page.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onRefresh} disabled={controlsDisabled}>
            <RefreshCw data-icon="inline-start" /> Refresh
          </Button>
          <Button type="button" onClick={() => setInviteOpen(true)} disabled={controlsDisabled && snapshot.config.fields.length === 0}>
            <RadioTower data-icon="inline-start" /> Pair new device
          </Button>
        </div>
      </div>

      <div className="grid gap-2" aria-live="polite">
        {mutationError ? <p className="text-sm text-destructive">Peer action failed: {mutationError}</p> : null}
        {configMutationError ? <p className="text-sm text-destructive">Configuration update failed: {configMutationError}</p> : null}
        {pairingOperation.error ? <p className="text-sm text-destructive">Pairing action failed: {pairingOperation.error}</p> : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network /> Mesh networking
          </CardTitle>
          <CardDescription>
            Master switch for P2P mesh (<code>gateway.mesh_network.enabled</code>). Turning this off disconnects all peers.
          </CardDescription>
          <CardAction>
            <Switch
              aria-label="Mesh networking"
              checked={meshEnabledChecked}
              disabled={masterSwitchDisabled}
              onCheckedChange={(checked) =>
                onConfigChange?.([
                  {
                    keyPath: 'services.gateway.mesh_network.enabled',
                    value: Boolean(checked),
                  },
                ])
              }
            />
          </CardAction>
        </CardHeader>
        {masterSwitchUnavailable || configPendingKey ? (
          <CardContent className="flex flex-col gap-1">
            {masterSwitchUnavailable ? <p className="text-sm text-muted-foreground">Mesh toggle is read-only right now.</p> : null}
            {configPendingKey ? <p className="text-sm text-muted-foreground">Applying config through preview/apply…</p> : null}
          </CardContent>
        ) : null}
      </Card>

      <PendingRequestsTable peers={pendingPeers} pendingPeerId={pendingPeerId} onReview={setReviewPeerId} />
      <PeerCardGrid peers={snapshot.peers} pendingPeerId={pendingPeerId} optimisticPeerId={optimisticPeerId} onOpenScopes={setScopesPeerId} onReview={setReviewPeerId} />

      <MeshSettingsCard snapshot={snapshot} disabled={controlsDisabled} pendingKey={configPendingKey} onConfigChange={onConfigChange} />
      <MeshNetworkCard snapshot={snapshot} route={route} disabled={controlsDisabled} pendingKey={configPendingKey} onConfigChange={onConfigChange} />

      <PeerTable peers={snapshot.peers} pendingPeerId={pendingPeerId} optimisticPeerId={optimisticPeerId} mutationDisabled={mutationDisabled} onOpenScopes={setScopesPeerId} onApprove={onApprovePeer} onDeny={onDenyPeer} onRemove={onRemovePeer} />
      <RequestReviewDialog peer={reviewPeer} open={Boolean(reviewPeer)} disabled={mutationDisabled} pending={reviewPeer ? pendingPeerId === reviewPeer.peerId : false} permissions={permissions} onOpenChange={(open) => !open && setReviewPeerId(null)} onPermissionsChange={onPermissionsChange} onApprovePeer={onApprovePeer} onDenyPeer={onDenyPeer} />
      <PairNewDeviceDialog open={inviteOpen} snapshot={snapshot} includePassword={includeInvitePassword} inviteText={inviteText} operation={pairingOperation} onIncludePasswordChange={setIncludeInvitePassword} onCreatePairingCode={onCreatePairingCode} onConnectPairingCode={onConnectPairingCode} onOpenChange={setInviteOpen} />
      <ScopesDialog peer={scopesPeer} open={Boolean(scopesPeer)} disabled={mutationDisabled} pending={scopesPeer ? pendingPeerId === scopesPeer.peerId : false} onOpenChange={(open) => !open && setScopesPeerId(null)} onSave={onSaveScopes} />
    </div>
  )
}

function MeshStateBadge({ state }: { state: AvailabilityState | MeshPeersLoadState }) {
  return <Badge variant="outline">{meshStateLabel(state)}</Badge>
}

function meshStateLabel(state: AvailabilityState | MeshPeersLoadState): string {
  if (state === 'available-local') return 'Local'
  if (state === 'available-remote') return 'Remote'
  if (state === 'pending' || state === 'loading') return 'Pending'
  if (state === 'ready') return 'Ready'
  if (state === 'empty') return 'Ready'
  if (state === 'denied') return 'Needs approval'
  if (state === 'degraded' || state === 'stale' || state === 'error' || state === 'service-unavailable' || state === 'unsupported' || state === 'privacy-blocked') return 'Needs attention'
  return 'Status'
}

function MeshSummaryCards({ snapshot, connectedPeers, pendingPeers }: { snapshot: MeshPeersSnapshot; connectedPeers: number; pendingPeers: number }) {
  const items = [
    {
      label: 'Local node',
      value: snapshot.localNodeName,
      detail: snapshot.localPeerId ?? 'peer id not reported',
      icon: Network,
    },
    {
      label: 'Connected peers',
      value: String(connectedPeers),
      detail: `${snapshot.runtimePeerCount} runtime / ${snapshot.liveSessionCount} WebRTC sessions`,
      icon: UsersRound,
    },
    {
      label: 'Pending requests',
      value: String(pendingPeers),
      detail: `${snapshot.approvedCount} approved / ${snapshot.deniedCount} denied / ${snapshot.removedCount} removed`,
      icon: ShieldCheck,
    },
    {
      label: 'Runtime',
      value: snapshot.meshEnabled ? 'enabled' : 'disabled',
      detail: `mesh ${snapshot.meshStarted ? 'started' : 'stopped'} · webrtc ${snapshot.webrtcStarted ? 'started' : 'stopped'}`,
      icon: Wifi,
    },
  ]
  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
      {items.map((item) => (
        <Card key={item.label} size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <item.icon /> {item.label}
            </CardTitle>
            <CardDescription>{item.detail}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold">{item.value}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function PendingRequestsTable({ peers, pendingPeerId, onReview }: { peers: MeshPeerRow[]; pendingPeerId: string | null; onReview: (peerId: string) => void }) {
  if (peers.length === 0) return null
  return (
    <div className="overflow-hidden rounded-xl border border-warning/35 bg-warning/5">
      <div className="flex items-center gap-1.5 border-b border-warning/25 px-4 py-3 text-sm font-semibold text-warning">
        <Network className="size-3.5" /> Pending pairing requests
      </div>
      <Table>
        <TableBody>
          {peers.map((peer) => {
            const pending = pendingPeerId === peer.peerId
            const pairing = peer.pendingPairing
            return (
              <TableRow key={`request-${peer.peerId}`} className="border-warning/20">
                <TableCell>
                  <div className="text-sm font-medium">{peer.nodeName}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {pairing?.remote_node_name ? 'mesh peer' : 'device'} · requested {formatRelative(pairing?.created_at ?? null)}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[15px] tracking-[0.08em]">{pairing?.code ?? '------'}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">expires {formatRelative(pairing?.expires_at ?? null)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button type="button" size="sm" onClick={() => onReview(peer.peerId)} disabled={pending}>
                    Review &amp; approve
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function PeerCardGrid({ peers, pendingPeerId, optimisticPeerId, onOpenScopes, onReview }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; onOpenScopes: (peerId: string) => void; onReview: (peerId: string) => void }) {
  if (peers.length === 0) return <EmptyPanel title="No mesh peers yet" description="Paired devices will appear here after they connect or request access." />
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
      {peers.map((peer) => {
        const pending = pendingPeerId === peer.peerId
        const optimistic = optimisticPeerId === peer.peerId
        const qualityPct = routeQualityPercent(peer)
        return (
          <Card key={peer.peerId} size="sm" data-state={optimistic ? 'optimistic' : undefined}>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{peer.nodeName}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{peer.fingerprint}</p>
                </div>
                <MeshStateBadge state={optimistic ? 'pending' : peer.trustState} />
              </div>
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Route quality</span>
                  <span>{qualityLabel(peer)}</span>
                </div>
                <Progress value={qualityPct} className="mt-1.5" aria-label={`Route quality for ${peer.nodeName}`} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{peer.latencyMs === null ? 'latency n/a' : `${peer.latencyMs}ms`}</span>
                <span>{peer.lastSeen ? formatRelative(peer.lastSeen) : 'last seen n/a'}</span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {peer.trustState === 'pending' || peer.pendingPairing ? (
                  <Button type="button" size="sm" disabled={pending} onClick={() => onReview(peer.peerId)}>
                    Review
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="outline" onClick={() => onOpenScopes(peer.peerId)}>
                  Scopes
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

/** Heuristic 0-100 route-quality percent derived from real latency/connection evidence (not a fabricated backend metric). */
function routeQualityPercent(peer: MeshPeerRow): number {
  if (peer.trustState === 'denied' || peer.outboundStatus === 'removed') return 0
  if (peer.latencyMs !== null) {
    const clamped = Math.max(0, Math.min(400, peer.latencyMs))
    return Math.round(100 - (clamped / 400) * 100)
  }
  if (peer.connectionStatus.includes('connected')) return 70
  if (peer.trustState === 'available-local' || peer.trustState === 'available-remote') return 60
  if (peer.trustState === 'pending') return 25
  return 10
}

function qualityLabel(peer: MeshPeerRow): string {
  const pct = routeQualityPercent(peer)
  if (peer.latencyMs !== null) return `${pct}%`
  if (pct >= 60) return 'good'
  if (pct >= 25) return 'fair'
  return 'poor'
}

function PeerTable({ peers, pendingPeerId, optimisticPeerId, mutationDisabled, onOpenScopes, onApprove, onDeny, onRemove }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; mutationDisabled: boolean; onOpenScopes: (peerId: string) => void; onApprove: ((peer: MeshPeerRow) => void) | undefined; onDeny: ((peer: MeshPeerRow) => void) | undefined; onRemove: ((peer: MeshPeerRow) => void) | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All peer records</CardTitle>
        <CardDescription>Peer permissions and actions.</CardDescription>
      </CardHeader>
      <CardContent>
        {peers.length === 0 ? (
          <EmptyPanel title="No rows" description="Peer permission rows will appear here after pairing." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Peer</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Trust</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {peers.map((peer) => {
                const optimistic = optimisticPeerId === peer.peerId
                return (
                  <TableRow key={`table-${peer.peerId}`} data-state={optimistic ? 'selected' : undefined}>
                    <TableCell>
                      <div className="flex min-w-48 flex-col">
                        <span className="text-sm font-medium">{peer.nodeName}</span>
                        <code className="truncate font-mono text-[11px] text-muted-foreground">{peer.fingerprint}</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      {peer.permissions.length > 0 ? (
                        <Badge variant="secondary">{peer.permissions.length === 1 ? peer.permissions[0] : `${peer.permissions[0]} +${peer.permissions.length - 1}`}</Badge>
                      ) : (
                        <span className="text-[11.5px] text-muted-foreground">no access</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{peer.latencyMs === null ? '-' : `${peer.latencyMs}ms`}</TableCell>
                    <TableCell>
                      <MeshStateBadge state={optimistic ? 'pending' : peer.trustState} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button type="button" size="sm" variant="outline" onClick={() => onOpenScopes(peer.peerId)}>
                        Scopes
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function RequestRow({ peer, pending, onReview }: { peer: MeshPeerRow; pending: boolean; onReview: () => void }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck /> {peer.nodeName}
        </CardTitle>
        <CardDescription>{peer.pendingPairing?.request_id ?? peer.peerId}</CardDescription>
        <CardAction>
          <MeshStateBadge state={pending ? 'pending' : peer.trustState} />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-3">
        <DetailItem label="Fingerprint" value={peer.fingerprint} />
        <DetailItem label="Requested" value={peer.permissions.join(', ') || 'no requested scopes'} />
        <DetailItem label="Status" value={peer.pendingPairing?.status ?? peer.outboundStatus} />
      </CardContent>
      <CardFooter className="justify-end">
        <Button type="button" size="sm" onClick={onReview} disabled={pending}>
          Review request
        </Button>
      </CardFooter>
    </Card>
  )
}

function PeerDetailSheet({ peer, open, onOpenChange }: { peer: MeshPeerRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{peer?.nodeName ?? 'Peer details'}</SheetTitle>
          <SheetDescription>Stable identity, trust grants, transport status, shared service summary, and route compatibility.</SheetDescription>
        </SheetHeader>
        {peer ? (
          <div className="flex flex-col gap-4 px-4 pb-4">
            <Card>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <DetailItem label="Stable peer id" value={peer.peerId} />
                <DetailItem label="Room" value={peer.roomName || 'not reported'} />
                <DetailItem label="Trust" value={peer.trustLabel} />
                <DetailItem label="Lifecycle" value={peer.lifecycleLabel} />
                <DetailItem label="Connection" value={peer.connectionStatus} />
                <DetailItem label="Latency" value={peer.latencyMs === null ? 'not reported' : `${peer.latencyMs} ms`} />
                <DetailItem label="Last seen" value={formatDate(peer.lastSeen)} />
                <DetailItem label="Details source" value={peer.lastEvidenceSource} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Permissions</CardTitle>
                <CardDescription>Outbound grants are what this node allows the peer to use; inbound grants are what the peer has granted to this node.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label>Outbound</Label>
                  <PermissionBadges permissions={peer.permissions} empty="No outbound permissions" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Inbound</Label>
                  <PermissionBadges permissions={peer.inboundPermissions} empty="No inbound permissions" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Shared services and route state</CardTitle>
                <CardDescription>Summaries only. Service-native management belongs on each service page.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <DetailItem label="Services" value={peer.services.join(', ') || 'none advertised'} />
                <DetailItem label="Compatibility" value={peer.compatibility} />
                <DetailItem label="Route quality" value={peer.routeQuality} />
              </CardContent>
            </Card>
          </div>
        ) : null}
        <SheetFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function toCatalogEntry(id: string): PermissionCatalogEntry {
  const [service, action] = id.includes('.') ? [id.slice(0, id.indexOf('.')), id.slice(id.indexOf('.') + 1)] : [null, null]
  return {
    id,
    label: id === '*' ? 'Full access' : id,
    description: '',
    service,
    action,
    kind: id === '*' ? 'all' : 'method',
    methodType: null,
    exposure: null,
    busTopic: null,
    routePath: null,
    availableOverHttp: false,
    requiredBy: [],
  }
}

function meshPermissionCatalog(...permissionSets: string[][]): PermissionCatalogEntry[] {
  const base = ['*', 'Gateway.use', 'Orchestrator.use', 'DB.use', 'Tooling.use', 'Scheduler.manage', 'TTS.use', 'STT.use']
  const roleDefaults = ROLE_TEMPLATES.flatMap((template) => template.permissions ?? [])
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const list of [...permissionSets, roleDefaults, base]) {
    for (const permission of list) {
      if (permission && !seen.has(permission)) {
        seen.add(permission)
        ordered.push(permission)
      }
    }
  }
  return ordered.map(toCatalogEntry)
}

function RequestReviewDialog({ peer, open, disabled, pending, permissions, onOpenChange, onPermissionsChange, onApprovePeer, onDenyPeer }: { peer: MeshPeerRow | null; open: boolean; disabled: boolean; pending: boolean; permissions: string; onOpenChange: (open: boolean) => void; onPermissionsChange: ((value: string) => void) | undefined; onApprovePeer: ((peer: MeshPeerRow) => void) | undefined; onDenyPeer: ((peer: MeshPeerRow) => void) | undefined }) {
  const selected = parseMeshPermissionList(permissions) ?? []
  const catalog = useMemo(() => meshPermissionCatalog(peer?.permissions ?? [], selected), [peer?.peerId, permissions])
  const checked: Record<string, boolean> = Object.fromEntries(selected.map((permission) => [permission, true]))
  const applyPermissions = (next: string[]) => onPermissionsChange?.(next.join(' '))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve {peer?.nodeName ?? 'device'}</DialogTitle>
          <DialogDescription>Verify the code out-of-band, start from a role, then fine-tune below.</DialogDescription>
        </DialogHeader>
        {peer ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-center font-mono text-xl tracking-[0.15em]">{peer.pendingPairing?.code ?? peer.fingerprint}</div>
            <PermissionEditorTable
              catalog={catalog}
              checked={checked}
              roleTemplate={matchRoleTemplate(selected)}
              onSelectRoleTemplate={(templateId) => {
                const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
                if (template?.permissions) applyPermissions(template.permissions)
              }}
              onToggle={(permissionId) => {
                const next = checked[permissionId] ? selected.filter((permission) => permission !== permissionId) : [...selected, permissionId]
                applyPermissions(next)
              }}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="destructive" disabled={disabled || pending || !peer?.denyAction} onClick={() => peer && onDenyPeer?.(peer)}>
            Refuse
          </Button>
          <Button type="button" disabled={disabled || pending || !peer?.approveAction} onClick={() => peer && onApprovePeer?.(peer)}>
            Approve &amp; pair
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EnumToggle({ value, options, disabled, onChange, ariaLabel }: { value: string; options: { value: string; label: string }[]; disabled?: boolean; onChange: (value: string) => void; ariaLabel?: string }) {
  return (
    <ToggleGroup variant="outline" value={[value]} disabled={disabled} aria-label={ariaLabel} onValueChange={(group: string[]) => {
      const next = group.find((entry) => entry !== value) ?? group[0]
      if (next) onChange(next)
    }}>
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="text-xs">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const SHARE_SCOPE_PRESETS: { value: string; label: string; permissions: string[] }[] = [
  { value: 'preview-only', label: 'Preview only', permissions: [] },
  { value: 'assistant-use', label: 'Assistant use', permissions: ['Orchestrator.use'] },
  { value: 'full-tools', label: 'Full tool access', permissions: ['*'] },
]

function currentShareScope(permissions: string[]): string {
  const match = SHARE_SCOPE_PRESETS.find((preset) => preset.permissions.length === permissions.length && preset.permissions.every((permission) => permissions.includes(permission)))
  return match?.value ?? 'preview-only'
}

function MeshSettingsCard({ snapshot, disabled, pendingKey, onConfigChange }: { snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined }) {
  const readOnly = disabled || Boolean(pendingKey) || !snapshot.config.editable || !onConfigChange
  const defaultPermissions = configArray(snapshot.config.fields, 'services.auth.default_pairing_permissions')
  const shareScope = currentShareScope(defaultPermissions)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 /> Mesh settings
        </CardTitle>
        <CardDescription>Config knobs that control how this node participates in the mesh.</CardDescription>
        <CardAction>
          <MeshStateBadge state={snapshot.config.state} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex max-w-[520px] flex-col gap-4">
        <div>
          <p className="mb-1.5 text-sm">Default share scope for new peers</p>
          <p className="mb-2 text-[11.5px] text-muted-foreground">
            Baseline permissions granted on approval (<code>auth.default_pairing_permissions</code>). Fine-tune per peer in Scopes.
          </p>
          <EnumToggle
            ariaLabel="Default share scope"
            value={shareScope}
            disabled={readOnly}
            options={SHARE_SCOPE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
            onChange={(value) => {
              const preset = SHARE_SCOPE_PRESETS.find((entry) => entry.value === value)
              if (!preset) return
              onConfigChange?.([{ keyPath: 'services.auth.default_pairing_permissions', value: preset.permissions }])
            }}
          />
        </div>
        {readOnly ? <p className="text-sm text-muted-foreground">Mesh settings are read-only right now.</p> : null}
      </CardContent>
    </Card>
  )
}

const PEER_SELECTION_OPTIONS = [
  { value: 'lowest_latency', label: 'Lowest latency' },
  { value: 'round_robin', label: 'Round robin' },
  { value: 'random', label: 'Random' },
]

const VERSION_POLICY_OPTIONS = [
  { value: 'exact', label: 'Exact' },
  { value: 'compatible', label: 'Compatible' },
  { value: 'any', label: 'Any' },
]

function MeshNetworkCard({ snapshot, route, disabled, pendingKey, onConfigChange }: { snapshot: MeshPeersSnapshot; route: RouteAvailability; disabled: boolean; pendingKey: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined }) {
  const fields = snapshot.config.fields
  const readOnly = disabled || Boolean(pendingKey) || !snapshot.config.editable || !onConfigChange
  const [nodeName, setNodeName] = useState('')
  const [room, setRoom] = useState('')
  const canonicalNodeName = configString(fields, 'services.gateway.mesh_network.node_name') || snapshot.localNodeName
  const canonicalRoom = configString(fields, 'services.gateway.webrtc.room')
  useEffect(() => setNodeName(canonicalNodeName), [canonicalNodeName])
  useEffect(() => setRoom(canonicalRoom), [canonicalRoom])
  const peerSelection = configString(fields, 'services.gateway.mesh_network.peer_selection') || 'lowest_latency'
  const versionPolicy = configString(fields, 'services.gateway.mesh_network.version_policy') || 'compatible'
  const encryptSignaling = configBoolean(fields, 'services.gateway.webrtc.encrypt_signaling', true)
  const e2ee = configBoolean(fields, 'services.gateway.webrtc.enable_app_layer_e2ee', true)
  const commit = (keyPath: string, value: JsonValue) => onConfigChange?.([{ keyPath, value }])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Router /> Network
        </CardTitle>
        <CardDescription>
          <code>gateway.mesh_network</code> / <code>gateway.webrtc</code> - identity, transport and signaling.
        </CardDescription>
        <CardAction>
          <MeshStateBadge state={snapshot.statusState} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex max-w-[560px] flex-col gap-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="mesh-node-name" className="text-[11.5px] normal-case tracking-normal text-muted-foreground">
              Node name
            </Label>
            <Input id="mesh-node-name" value={nodeName} disabled={readOnly} onChange={(event) => setNodeName(event.currentTarget.value)} onBlur={() => nodeName !== canonicalNodeName && commit('services.gateway.mesh_network.node_name', nodeName)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="mesh-room" className="text-[11.5px] normal-case tracking-normal text-muted-foreground">
              Signaling room
            </Label>
            <Input id="mesh-room" value={room} disabled={readOnly} onChange={(event) => setRoom(event.currentTarget.value)} onBlur={() => room !== canonicalRoom && commit('services.gateway.webrtc.room', room)} />
          </div>
        </div>
        <div>
          <p className="mb-1.5 text-[12.5px]">Peer selection strategy</p>
          <EnumToggle ariaLabel="Peer selection strategy" value={peerSelection} disabled={readOnly} options={PEER_SELECTION_OPTIONS} onChange={(value) => commit('services.gateway.mesh_network.peer_selection', value)} />
        </div>
        <div>
          <p className="mb-1.5 text-[12.5px]">Version policy</p>
          <EnumToggle ariaLabel="Version policy" value={versionPolicy} disabled={readOnly} options={VERSION_POLICY_OPTIONS} onChange={(value) => commit('services.gateway.mesh_network.version_policy', value)} />
        </div>
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px]">Encrypt signaling</p>
              <p className="text-[11.5px] text-muted-foreground">AEAD-seal presence/SDP/ICE messages with the room key.</p>
            </div>
            <Switch checked={encryptSignaling} disabled={readOnly} aria-label="Encrypt signaling" onCheckedChange={(checked) => commit('services.gateway.webrtc.encrypt_signaling', Boolean(checked))} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[13px]">App-layer end-to-end encryption</p>
              <p className="text-[11.5px] text-muted-foreground">Seals DataChannel messages; peers with mismatched settings won&apos;t fall back to plaintext.</p>
            </div>
            <Switch checked={e2ee} disabled={readOnly} aria-label="App-layer end-to-end encryption" onCheckedChange={(checked) => commit('services.gateway.webrtc.enable_app_layer_e2ee', Boolean(checked))} />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {snapshot.statusState}: {snapshot.statusReason}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {snapshot.listState}: {snapshot.listReason}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {snapshot.mutationState}: {snapshot.mutationReason}
        </p>
        <p className="text-[11px] text-muted-foreground">
          route {route.state}: {presentableSignal(route.explanation)}
        </p>
      </CardContent>
    </Card>
  )
}

function MeshConfigurationPanel({ snapshot, disabled, pendingKey, onConfigChange }: { snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => {
    setDrafts(Object.fromEntries(snapshot.config.fields.map((field) => [field.key_path, stringifyConfigValue(field.current_value ?? field.default ?? '')])))
  }, [snapshot.config.fields])
  const groups = groupConfigFields(snapshot.config.fields)
  const pending = Boolean(pendingKey)
  const changedFields = snapshot.config.fields.filter((field) => !field.secret && (drafts[field.key_path] ?? '') !== stringifyConfigValue(field.current_value ?? field.default ?? ''))
  const changedCount = changedFields.length
  const canApply = snapshot.config.editable && !disabled && !pending && changedCount > 0
  const applyChanges = () => {
    if (!canApply) return
    onConfigChange?.(
      changedFields.map((field) => ({
        keyPath: field.key_path,
        value: parseConfigValue(field, drafts[field.key_path] ?? ''),
      })),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <CardTitle className="flex items-center gap-2">
              <Settings2 /> Mesh configuration
            </CardTitle>
            <MeshStateBadge state={snapshot.config.state} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {changedCount > 0 ? <Badge variant="secondary">{changedCount} changed</Badge> : null}
            <Button type="button" onClick={applyChanges} disabled={!canApply}>
              {pending ? 'Applying' : 'Apply changes'}
            </Button>
          </div>
        </CardHeader>
      </Card>
      {snapshot.config.fields.length === 0 ? (
        <EmptyPanel title="Settings" description="Mesh and WebRTC settings appear here when reported by this node." />
      ) : (
        Object.entries(groups).map(([group, fields]) => (
          <Card key={group}>
            <CardHeader>
              <CardTitle>{group}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 lg:grid-cols-2">
              {fields.map((field) => {
                const fieldPending = pendingKey === field.key_path || pendingKey === '__batch__'
                const value = drafts[field.key_path] ?? ''
                const original = stringifyConfigValue(field.current_value ?? field.default ?? '')
                const changed = value !== original
                const readOnly = disabled || fieldPending || field.secret || !snapshot.config.editable
                return (
                  <div key={field.key_path} className="grid gap-3 rounded-xl border bg-background/60 p-3 transition-colors data-[changed=true]:border-primary/50 data-[changed=true]:bg-primary/5 sm:grid-cols-[minmax(0,1fr)_minmax(220px,300px)] sm:items-center" data-changed={changed || undefined}>
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={field.key_path} className="text-sm font-semibold normal-case tracking-normal">
                        {field.title || field.key_path.split('.').at(-1) || field.key_path}
                      </Label>
                      <p className="line-clamp-2 text-xs text-muted-foreground">{field.description || field.key_path}</p>
                      <div className="flex flex-wrap gap-1">
                        {changed ? <Badge>changed</Badge> : null}
                        {field.secret ? <Badge variant="secondary">secret</Badge> : null}
                        {field.reload_required ? <Badge variant="outline">reload</Badge> : null}
                        {field.restart_required ? <Badge variant="destructive">restart</Badge> : null}
                      </div>
                      <code className="block truncate text-xs text-muted-foreground" title={field.key_path}>
                        {field.key_path}
                      </code>
                    </div>
                    <ConfigFieldControl
                      field={field}
                      value={value}
                      disabled={readOnly}
                      onChange={(next) =>
                        setDrafts((current) => ({
                          ...current,
                          [field.key_path]: next,
                        }))
                      }
                    />
                  </div>
                )
              })}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}

function ConfigFieldControl({ field, value, disabled, onChange }: { field: ConfigFieldMetadata; value: string; disabled: boolean; onChange: (value: string) => void }) {
  if (isBooleanConfigField(field)) {
    return (
      <div className="flex items-center justify-between rounded-lg border bg-background/50 p-3">
        <span className="text-sm text-muted-foreground">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
        <Switch checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(String(Boolean(checked)))} />
      </div>
    )
  }
  if (field.choices && field.choices.length > 0) {
    return (
      <select id={field.key_path} className="h-10 rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50" value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)}>
        {field.choices.map((choice) => (
          <option key={String(choice)} value={String(choice)}>
            {String(choice)}
          </option>
        ))}
      </select>
    )
  }
  if (isArrayConfigField(field)) {
    return <Textarea id={field.key_path} value={value} disabled={disabled} rows={3} onChange={(event) => onChange(event.currentTarget.value)} />
  }
  return <Input id={field.key_path} type={isNumberConfigField(field) ? 'number' : 'text'} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
}

function ScopesDialog({ peer, open, disabled, pending, onOpenChange, onSave }: { peer: MeshPeerRow | null; open: boolean; disabled: boolean; pending: boolean; onOpenChange: (open: boolean) => void; onSave: ((peer: MeshPeerRow, permissions: string[]) => void) | undefined }) {
  const [selected, setSelected] = useState<string[]>([])
  useEffect(() => {
    if (peer) setSelected(peer.permissions)
  }, [peer?.peerId, open])
  const catalog = useMemo(() => meshPermissionCatalog(peer?.permissions ?? [], selected), [peer?.peerId, selected])
  const checked: Record<string, boolean> = Object.fromEntries(selected.map((permission) => [permission, true]))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scopes{peer ? ` - ${peer.nodeName}` : ''}</DialogTitle>
          <DialogDescription>What this peer can access on this node. Bilateral - the peer independently controls what it grants you.</DialogDescription>
        </DialogHeader>
        {peer ? (
          <PermissionEditorTable
            catalog={catalog}
            checked={checked}
            roleTemplate={matchRoleTemplate(selected)}
            onSelectRoleTemplate={(templateId) => {
              const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
              if (template?.permissions) setSelected(template.permissions)
            }}
            onToggle={(permissionId) => setSelected((current) => (current.includes(permissionId) ? current.filter((permission) => permission !== permissionId) : [...current, permissionId]))}
          />
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={disabled || pending || !peer || !onSave} onClick={() => peer && onSave?.(peer, selected)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PairNewDeviceDialog({ open, snapshot, includePassword, inviteText, operation, onIncludePasswordChange, onCreatePairingCode, onConnectPairingCode, onOpenChange }: { open: boolean; snapshot: MeshPeersSnapshot; includePassword: boolean; inviteText: string; operation: MeshPairingOperation; onIncludePasswordChange: (value: boolean) => void; onCreatePairingCode: ((input: MeshPairingStartInput) => void) | undefined; onConnectPairingCode: ((code: string) => void) | undefined; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'show-code' | 'connect'>('show-code')
  const [deviceName, setDeviceName] = useState('Aurora mesh peer')
  const [remotePeerId, setRemotePeerId] = useState('')
  const [remoteNodeName, setRemoteNodeName] = useState('')
  const [peerCode, setPeerCode] = useState('')
  const passwordField = configField(snapshot.config.fields, 'services.gateway.webrtc.password')
  const canIncludePassword = Boolean(passwordField?.current_value && passwordField.current_value !== '[REDACTED]')
  const copyInvite = async () => {
    await navigator.clipboard?.writeText(operation.created?.code ?? inviteText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Pair a new device</DialogTitle>
          <DialogDescription>Use Auth pairing calls when available, or copy the current mesh/WebRTC handoff without inventing backend state.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(value) => setMode(String(value) === 'connect' ? 'connect' : 'show-code')}>
          <TabsList>
            <TabsTrigger value="show-code">Show code on this node</TabsTrigger>
            <TabsTrigger value="connect">Connect to a peer</TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'show-code' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound /> Pairing code
                </CardTitle>
                <CardDescription>
                  Create a one-time code through <code>Auth.PairingStart</code>. If a code cannot be created yet, the config handoff remains visible below.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-2 sm:col-span-1">
                    <Label htmlFor="mesh-pair-device-name">Device name</Label>
                    <Input id="mesh-pair-device-name" value={deviceName} disabled={operation.pending} onChange={(event) => setDeviceName(event.currentTarget.value)} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mesh-pair-remote-peer">Remote peer id</Label>
                    <Input id="mesh-pair-remote-peer" value={remotePeerId} disabled={operation.pending} placeholder="optional" onChange={(event) => setRemotePeerId(event.currentTarget.value)} />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mesh-pair-remote-node">Remote node</Label>
                    <Input id="mesh-pair-remote-node" value={remoteNodeName} disabled={operation.pending} placeholder="optional" onChange={(event) => setRemoteNodeName(event.currentTarget.value)} />
                  </div>
                </div>
                <Button
                  type="button"
                  disabled={operation.pending || !onCreatePairingCode}
                  onClick={() =>
                    onCreatePairingCode?.({
                      deviceName,
                      remotePeerId,
                      remoteNodeName,
                    })
                  }
                >
                  {operation.pending ? 'Creating code…' : 'Create pairing code'}
                </Button>
                {operation.created ? (
                  <div className="rounded-lg bg-muted/40 p-4 text-center font-mono text-3xl tracking-[.2em]">{operation.created.code}</div>
                ) : (
                  <Alert>
                    <Signal />
                    <AlertTitle>Create a pairing code</AlertTitle>
                    <AlertDescription>No one-time code is shown until this node creates one. The mesh handoff below is generated from reported config only.</AlertDescription>
                  </Alert>
                )}
                <Textarea aria-label="Mesh invite payload" className="min-h-56 font-mono text-xs" value={inviteText} readOnly />
              </CardContent>
              <CardFooter className="justify-between">
                <Label>
                  <Checkbox checked={includePassword} disabled={!canIncludePassword} onCheckedChange={(checked) => onIncludePasswordChange(Boolean(checked))} />
                  <span>Include room password</span>
                </Label>
                <Button type="button" onClick={copyInvite}>
                  <Copy data-icon="inline-start" /> {copied ? 'Copied' : operation.created ? 'Copy code' : 'Copy handoff'}
                </Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <QrCode /> Handoff QR
                </CardTitle>
                <CardDescription>Scannable config payload for mobile setup; not a fake pairing code.</CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <InviteQr value={inviteText} />
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <RadioTower /> Connect to a peer
              </CardTitle>
              <CardDescription>
                Submit a code from another Aurora node through <code>Auth.PairingConnect</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Label htmlFor="mesh-peer-code">Peer pairing code</Label>
              <Input id="mesh-peer-code" value={peerCode} disabled={operation.pending} placeholder="Enter code from peer" onChange={(event) => setPeerCode(event.currentTarget.value)} />
              <Button type="button" disabled={operation.pending || !onConnectPairingCode} onClick={() => onConnectPairingCode?.(peerCode)}>
                {operation.pending ? 'Sending request…' : 'Send pairing request'}
              </Button>
              {operation.connected ? (
                <Alert>
                  <ShieldCheck />
                  <AlertTitle>Pairing request sent</AlertTitle>
                  <AlertDescription>
                    {operation.connected.request_id} is {operation.connected.status} for {operation.connected.device_name}.
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        )}
        <Alert>
          <LockKeyhole />
          <AlertTitle>Security default</AlertTitle>
          <AlertDescription>The room password is omitted unless explicitly included here. Prefer sharing secrets through a private channel.</AlertDescription>
        </Alert>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function InviteQr({ value }: { value: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void import('qrcode')
      .then((module) => module.toString(value, { type: 'svg', margin: 1, width: 220 }))
      .then((next) => {
        if (!cancelled) setSvg(next)
      })
      .catch(() => {
        if (!cancelled) setSvg(null)
      })
    return () => {
      cancelled = true
    }
  }, [value])
  if (!svg) return <Skeleton className="size-56" aria-label="Generating QR code" />
  return <div className="rounded-lg bg-background p-2 ring-1 ring-border" aria-label="Mesh invite QR code" dangerouslySetInnerHTML={{ __html: svg }} />
}

function MeshRuntimeOverview({ snapshot, route, expanded = false }: { snapshot: MeshPeersSnapshot; route: RouteAvailability; expanded?: boolean }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Router /> Runtime state
          </CardTitle>
          <CardDescription>Local mesh status and route availability.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <DetailItem label="Mesh" value={snapshot.meshEnabled ? 'enabled' : 'disabled'} />
          <DetailItem label="Started" value={snapshot.meshStarted ? 'yes' : 'no'} />
          <DetailItem label="WebRTC" value={snapshot.webrtcStarted ? 'started' : 'not started'} />
          <DetailItem label="Route" value={`${route.state}: ${presentableSignal(route.explanation)}`} />
          <DetailItem label="Peer list" value={`${snapshot.listState}: ${snapshot.listReason}`} />
          <DetailItem label="Mutations" value={`${snapshot.mutationState}: ${snapshot.mutationReason}`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch /> Shared module summary
          </CardTitle>
          <CardDescription>High-level service summary only; manage services on their dedicated pages.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {snapshot.peers.flatMap((peer) => peer.services).length === 0 ? <p className="text-sm text-muted-foreground">No shared modules reported by peer manifests.</p> : <PermissionBadges permissions={[...new Set(snapshot.peers.flatMap((peer) => peer.services))]} empty="No shared modules" />}
          {expanded ? <DetailItem label="Compatibility failures" value={snapshot.compatibilityFailures.join('; ') || 'none reported'} /> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function LiveSessionsPanel({ sessions, fixtureOnly }: { sessions: MeshLiveSessionRow[]; fixtureOnly: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active WebRTC sessions</CardTitle>
        <CardDescription>Transport session IDs stay separate from stable Auth peer identity.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sessions.length === 0 ? (
          <EmptyPanel title="No active WebRTC sessions" description="Gateway.GetWebRTCDiagnostics did not report open sessions." />
        ) : (
          sessions.map((session) => (
            <Card key={session.sessionId} size="sm">
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <DetailItem label="Session" value={session.sessionId} />
                <DetailItem label="Peer" value={`${session.nodeName} (${session.stablePeerId})`} />
                <DetailItem label="Transport" value={`${session.connectionState}; ICE ${session.iceState}; channel ${session.dataChannelState}`} />
                <DetailItem label="Auth" value={session.authState} />
                <DetailItem label="Latency" value={session.latencyMs === null ? 'not reported' : `${session.latencyMs} ms`} />
                <DetailItem label="Pairing" value={session.pairingState} />
                <DetailItem label="Linked peer" value={session.linkedPeerState} />
                <DetailItem label="Status" value={fixtureOnly ? fixtureEvidence(session.evidenceSource) : session.evidenceSource} />
              </CardContent>
            </Card>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function DevicesPanel({ devices, fixtureOnly }: { devices: MeshDeviceRow[]; fixtureOnly: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Auth device records</CardTitle>
        <CardDescription>Device trust is shown separately from mesh peer trust and live transport state.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {devices.length === 0 ? (
          <EmptyPanel title="No Auth device records" description="Auth.ListDevices did not report devices for this mesh view." />
        ) : (
          devices.map((device) => (
            <Card key={device.deviceId} size="sm">
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <DetailItem label="Device" value={device.name} />
                <DetailItem label="Device id" value={device.deviceId} />
                <DetailItem label="Trust" value={device.trustLabel} />
                <DetailItem label="Linked peer" value={device.linkedPeerLabel} />
                <DetailItem label="Stable peer" value={device.linkedPeerId ?? 'not linked'} />
                <DetailItem label="Last seen" value={formatDate(device.lastSeen)} />
                <DetailItem label="Status" value={fixtureOnly ? fixtureEvidence(device.evidenceSource) : device.evidenceSource} />
              </CardContent>
            </Card>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function WarningsPanel({ snapshot }: { snapshot: MeshPeersSnapshot }) {
  const warnings = [...snapshot.compatibilityFailures, ...snapshot.warnings]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Warnings and compatibility</CardTitle>
        <CardDescription>Useful runtime details for troubleshooting peer routing.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No compatibility failures or warning details reported.</p>
        ) : (
          warnings.map((warning) => (
            <Alert key={warning}>
              <AlertTriangle />
              <AlertTitle>Mesh detail</AlertTitle>
              <AlertDescription>{warning}</AlertDescription>
            </Alert>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function EmptyPanel({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
        <Signal />
        <p className="font-medium">{title}</p>
        <p className="max-w-lg text-sm text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

function PermissionBadges({ permissions, empty, compact = false }: { permissions: string[]; empty: string; compact?: boolean }) {
  if (permissions.length === 0) return <span className="text-sm text-muted-foreground">{empty}</span>
  const visible = compact ? permissions.slice(0, 3) : permissions
  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((permission) => (
        <Badge key={permission} variant="outline">
          {permission}
        </Badge>
      ))}
      {visible.length < permissions.length ? <Badge variant="secondary">+{permissions.length - visible.length}</Badge> : null}
    </div>
  )
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/40 p-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm" title={value}>
        {value}
      </dd>
    </div>
  )
}

function buildConfigValueFields(config: JsonObject | null): ConfigFieldMetadata[] {
  if (!config) return []
  return sortConfigFields(
    meshConfigKeyPaths
      .map((keyPath) => {
        const value = readConfigPath(config, keyPath.replace(/^services\./, '')) ?? readConfigPath(config, keyPath)
        if (value === undefined) return null
        return fallbackConfigField(keyPath, titleForConfigKey(keyPath), descriptionForConfigKey(keyPath), typeForConfigValue(value, keyPath), value, false)
      })
      .filter((field): field is ConfigFieldMetadata => Boolean(field)),
  )
}

function mergeConfigFields(primary: ConfigFieldMetadata[], fallback: ConfigFieldMetadata[]): ConfigFieldMetadata[] {
  const byKey = new Map<string, ConfigFieldMetadata>()
  for (const field of fallback) byKey.set(field.key_path, field)
  for (const field of primary) byKey.set(field.key_path, { ...byKey.get(field.key_path), ...field })
  return sortConfigFields([...byKey.values()])
}

function readConfigPath(config: JsonObject, path: string): JsonValue | undefined {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current as JsonValue
}

function titleForConfigKey(keyPath: string): string {
  const last = keyPath.split('.').at(-1) ?? keyPath
  return last.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function descriptionForConfigKey(keyPath: string): string {
  if (keyPath.includes('.mesh_network.')) return 'Mesh network setting.'
  if (keyPath.includes('.webrtc.')) return 'WebRTC signaling and transport setting.'
  if (keyPath.includes('.signaling_mqtt.')) return 'MQTT signaling setting.'
  return 'Pairing and authentication setting.'
}

function typeForConfigValue(value: JsonValue, keyPath: string): string {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float'
  if (Array.isArray(value)) return 'list'
  if (keyPath.endsWith('.version_policy') || keyPath.endsWith('.peer_selection')) return 'choice'
  return 'string'
}

function buildRuntimeConfigFields(status: MeshStatusResponse | null, diagnostics: WebRTCDiagnosticsResponse | null): ConfigFieldMetadata[] {
  return sortConfigFields([
    fallbackConfigField('services.gateway.mesh_network.enabled', 'Mesh enabled', 'Whether mesh routing is enabled.', 'boolean', status?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? false),
    fallbackConfigField('services.gateway.mesh_network.node_name', 'Node name', 'Local node name reported by Gateway.', 'string', status?.local.node_name ?? diagnostics?.local_node_name ?? 'Aurora node'),
    fallbackConfigField('services.gateway.mesh_network.version_policy', 'Version policy', 'Runtime version compatibility policy.', 'string', status?.local.version_policy ?? 'compatible'),
    fallbackConfigField('services.gateway.mesh_network.peer_selection', 'Peer selection', 'Runtime peer selection strategy.', 'string', status?.local.peer_selection ?? 'latency'),
    fallbackConfigField('services.gateway.webrtc.enabled', 'WebRTC enabled', 'Whether WebRTC transport is enabled.', 'boolean', diagnostics?.enabled ?? status?.local.webrtc_started ?? false),
    fallbackConfigField('services.gateway.webrtc.strategy', 'Signaling strategy', 'WebRTC signaling strategy.', 'string', diagnostics?.signaling.strategy ?? 'mqtt'),
    fallbackConfigField('services.gateway.webrtc.encrypt_signaling', 'Encrypt signaling', 'Whether signaling presence is encrypted.', 'boolean', diagnostics?.signaling.encrypted_presence ?? true),
    fallbackConfigField('services.gateway.webrtc.enable_app_layer_e2ee', 'Application E2EE', 'Whether app-layer peer encryption is enabled.', 'boolean', diagnostics?.app_layer_e2ee_enabled ?? true),
    fallbackConfigField('services.auth.webrtc_auth_timeout_seconds', 'Auth timeout', 'WebRTC auth timeout in seconds.', 'integer', diagnostics?.auth_timeout_seconds ?? 30),
    fallbackConfigField('services.auth.webrtc_pairing_timeout_seconds', 'Pairing timeout', 'Pairing approval timeout in seconds.', 'integer', diagnostics?.pairing_timeout_seconds ?? 300),
  ])
}

function isPendingPairing(entry: PendingPairingEntry): boolean {
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
    source_layer: editable ? 'config' : 'runtime',
    secret: false,
    reload_required: true,
    restart_required: false,
    affected_services: ['gateway'],
    constraints: {},
    choices: null,
  }
}

function sortConfigFields(fields: ConfigFieldMetadata[]): ConfigFieldMetadata[] {
  return [...fields].sort((a, b) => meshConfigKeyPaths.indexOf(a.key_path) - meshConfigKeyPaths.indexOf(b.key_path))
}

function groupConfigFields(fields: ConfigFieldMetadata[]): Record<string, ConfigFieldMetadata[]> {
  const groups: Record<string, ConfigFieldMetadata[]> = {}
  for (const field of fields) {
    const group = field.key_path.includes('.mesh_network.') ? 'Mesh network' : field.key_path.includes('.webrtc.') ? 'WebRTC signaling' : field.key_path.includes('.signaling_mqtt.') ? 'MQTT signaling' : 'Pairing and auth'
    groups[group] = [...(groups[group] ?? []), field]
  }
  return groups
}

function normalizedConfigType(field: ConfigFieldMetadata): string {
  return field.type.toLowerCase()
}

function isBooleanConfigField(field: ConfigFieldMetadata): boolean {
  return ['bool', 'boolean'].includes(normalizedConfigType(field))
}

function isArrayConfigField(field: ConfigFieldMetadata): boolean {
  return ['array', 'list'].includes(normalizedConfigType(field))
}

function isNumberConfigField(field: ConfigFieldMetadata): boolean {
  return ['integer', 'int', 'number', 'float'].includes(normalizedConfigType(field))
}

function stringifyConfigValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.join('\n')
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function parseConfigValue(field: ConfigFieldMetadata, value: string): JsonValue {
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

export function buildMeshInvitePayload(snapshot: MeshPeersSnapshot, includePassword: boolean): JsonObject {
  const fields = snapshot.config.fields
  const payload: JsonObject = {
    kind: 'aurora.mesh.invite',
    version: 1,
    generated_at: new Date().toISOString(),
    node: {
      peer_id: snapshot.localPeerId,
      node_name: configString(fields, 'services.gateway.mesh_network.node_name') || snapshot.localNodeName,
    },
    mesh: {
      enabled: configBoolean(fields, 'services.gateway.mesh_network.enabled', snapshot.meshEnabled),
      version_policy: configString(fields, 'services.gateway.mesh_network.version_policy'),
      peer_selection: configString(fields, 'services.gateway.mesh_network.peer_selection'),
    },
    signaling: {
      provider: configString(fields, 'services.gateway.webrtc.strategy'),
      app_id: configString(fields, 'services.gateway.webrtc.app_id'),
      room: configString(fields, 'services.gateway.webrtc.room'),
      encrypt_signaling: configBoolean(fields, 'services.gateway.webrtc.encrypt_signaling', true),
      mqtt_brokers: configArray(fields, 'services.gateway.signaling_mqtt.brokers'),
      mqtt_topic_root: configString(fields, 'services.gateway.signaling_mqtt.topic_root'),
    },
    webrtc: {
      enabled: configBoolean(fields, 'services.gateway.webrtc.enabled', snapshot.webrtcStarted),
      app_layer_e2ee: configBoolean(fields, 'services.gateway.webrtc.enable_app_layer_e2ee', true),
      stun_servers: configArray(fields, 'services.gateway.webrtc.stun_servers'),
      turn_servers: configArray(fields, 'services.gateway.webrtc.turn_servers'),
    },
    auth: {
      default_pairing_permissions: configArray(fields, 'services.auth.default_pairing_permissions'),
      auth_timeout_seconds: configNumber(fields, 'services.auth.webrtc_auth_timeout_seconds'),
      pairing_timeout_seconds: configNumber(fields, 'services.auth.webrtc_pairing_timeout_seconds'),
    },
    note: 'Paste/import support is not implemented yet; configure the receiving device manually from this payload.',
  }
  if (includePassword) {
    const password = configString(fields, 'services.gateway.webrtc.password')
    if (password && password !== '[REDACTED]') {
      payload.signaling = {
        ...(payload.signaling as JsonObject),
        room_password: password,
      }
    }
  }
  return payload
}

function configField(fields: ConfigFieldMetadata[], keyPath: string): ConfigFieldMetadata | null {
  return fields.find((field) => field.key_path === keyPath) ?? null
}

function configString(fields: ConfigFieldMetadata[], keyPath: string): string {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function configBoolean(fields: ConfigFieldMetadata[], keyPath: string, fallback: boolean): boolean {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'boolean' ? value : fallback
}

function configNumber(fields: ConfigFieldMetadata[], keyPath: string): number | null {
  const value = configField(fields, keyPath)?.current_value
  return typeof value === 'number' ? value : null
}

function configArray(fields: ConfigFieldMetadata[], keyPath: string): string[] {
  const value = configField(fields, keyPath)?.current_value
  return Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []
}

function peerInitials(value: string): string {
  const parts = value.split(/\s+/).filter(Boolean)
  return (parts[0]?.[0] ?? 'M').concat(parts[1]?.[0] ?? '').toUpperCase()
}

function buildMeshLiveSessionRows(diagnostics: WebRTCDiagnosticsResponse | null, status: MeshStatusResponse | null, persistedPeers: MeshPeerInfo[]): MeshLiveSessionRow[] {
  return (diagnostics?.peers ?? []).map((session) => {
    const runtime = status?.peers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    const persisted = persistedPeers.find((peer) => peer.peer_id === session.stable_peer_id) ?? null
    return {
      sessionId: session.signaling_peer_id,
      stablePeerId: session.stable_peer_id,
      nodeName: session.node_name || runtime?.node_name || persisted?.node_name || 'Unnamed WebRTC session',
      state: liveSessionState(session, runtime, persisted),
      connectionState: session.connection_state,
      iceState: session.ice_connection_state,
      dataChannelState: session.data_channel_state,
      authState: session.auth_state,
      latencyMs: session.rtt_ms ?? runtime?.latency_ms ?? null,
      identitySource: session.identity_source,
      permissions: `${session.effective_permission_count} effective permissions${session.is_admin ? '; admin principal' : ''}`,
      pairingState: [session.pairing_active ? 'pairing active' : null, session.auth_timeout_pending ? 'auth timeout pending' : null, session.pending_pairing_task ? 'pending pairing work' : null].filter(Boolean).join('; ') || 'no pairing work reported',
      linkedPeerState: persisted ? `Auth peer ${persisted.outbound_status}/${persisted.inbound_status}` : runtime ? `runtime peer ${runtime.status}` : 'no persisted peer record',
      evidenceSource: 'Gateway.GetWebRTCDiagnostics',
    }
  })
}

function buildMeshDeviceRows(devices: DeviceResponse[], peers: MeshPeerRow[], sessions: MeshLiveSessionRow[]): MeshDeviceRow[] {
  return devices.map((device) => {
    const linkedPeer = matchDevicePeer(device, peers, sessions)
    return {
      deviceId: device.id,
      name: device.name,
      principalId: device.user_id ?? null,
      state: device.is_trusted ? 'available-local' : 'denied',
      trustLabel: device.is_trusted ? 'trusted Auth device' : 'untrusted Auth device',
      linkedPeerId: linkedPeer?.peerId ?? null,
      linkedPeerLabel: linkedPeer ? `${linkedPeer.nodeName} (${linkedPeer.source})` : 'not linked to a mesh peer by service status',
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
        source: 'live WebRTC session',
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

function buildMeshPeerRows(input: { persistedPeers: MeshPeerInfo[]; pendingPairings: PendingPairingEntry[]; status: MeshStatusResponse | null; diagnostics: WebRTCDiagnosticsResponse | null; mutationCapability: CapabilitySummary | null }): MeshPeerRow[] {
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
    return 'Stale peer requires manifest/heartbeat review before cleanup'
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
    nodeName: persisted?.node_name || runtime?.node_name || pairing?.remote_node_name || 'Unnamed mesh peer',
    roomName: persisted?.room_name ?? 'not reported',
    lifecycleState,
    lifecycleLabel: runtime?.status ?? persisted?.connection_status ?? 'no runtime status',
    trustState,
    trustLabel: `outbound=${outboundStatus}; inbound=${inboundStatus}`,
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
            reason: 'Approve mesh peer',
            permissions: base.permissions.join(', '),
          })
        : null,
    denyAction: canMutate && outboundStatus !== 'denied' ? buildMeshPeerAdminAction(base, 'deny', { reason: 'Deny mesh peer' }) : null,
    removeAction:
      canMutate && outboundStatus !== 'removed'
        ? buildMeshPeerAdminAction(base, 'remove', {
            reason: 'Remove mesh peer',
            revokeToken: true,
          })
        : null,
  }
}

export function buildMeshPeerAdminAction(
  peer: Pick<MeshPeerRow, 'peerId' | 'nodeName'>,
  action: 'approve' | 'deny' | 'remove',
  input: {
    reason: string
    permissions?: string
    revokeToken?: boolean
    reauthConfirmed?: boolean
  },
): MeshPeerAdminAction | null {
  const reason = input.reason.trim() || `${action} mesh peer ${peer.peerId}`
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

export function parseMeshPermissionList(value: string): string[] | null {
  const permissions = value
    .split(/[\s,]+/)
    .map((permission) => permission.trim())
    .filter(Boolean)
  return permissions.length > 0 ? permissions : null
}

export function meshPeerErrorMessage(error: unknown): string {
  if (error instanceof AuroraError) {
    if (error.code === 'permission' || error.code === 'auth') return `Permission denied by Auth: ${error.message}`
    if (error.code === 'unavailable_service') return `Mesh peer service unavailable: ${error.message}`
    if (error.code === 'unsupported_feature') return `Mesh peer lifecycle unsupported by this backend: ${error.message}`
    if (error.code === 'timeout') return `Aurora request timed out: ${error.message}`
    return error.message
  }
  return error instanceof Error ? error.message : 'Unknown mesh peer lifecycle error'
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
  return `${value} (preview data)`
}

function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok ? (result.value.data ?? null) : null
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function withUiTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} did not respond within ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

function failureMessage(label: string, result: PromiseSettledResult<unknown>, optional = false): string | null {
  if (result.status === 'fulfilled') {
    const value = result.value as { ok?: boolean; error?: unknown } | undefined
    if (value?.ok === false) return `${label}: ${meshPeerErrorMessage(value.error)}`
    return null
  }
  return optional ? `${label} unavailable: ${meshPeerErrorMessage(result.reason)}` : `${label}: ${meshPeerErrorMessage(result.reason)}`
}

function isDeniedFailure(result: PromiseSettledResult<unknown>): boolean {
  const error = result.status === 'fulfilled' ? (result.value as { ok?: boolean; error?: unknown }).error : result.reason
  return error instanceof AuroraError && (error.code === 'permission' || error.code === 'auth')
}

function capabilityFor(methodId: string, capabilities: CapabilitySummary[]): CapabilitySummary | null {
  return capabilities.find((capability) => capability.busTopic === methodId || capability.id === methodId) ?? null
}

function firstCapability(methodIds: string[], capabilities: CapabilitySummary[]): CapabilitySummary | null {
  for (const methodId of methodIds) {
    const capability = capabilityFor(methodId, capabilities)
    if (capability) return capability
  }
  return null
}

function stateFromCapability(capability: CapabilitySummary | null, fallback: AvailabilityState): AvailabilityState {
  return capability?.availability ?? fallback
}

function capabilityReason(capability: CapabilitySummary | null, fallback: string): string {
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
  if (!peer) return 'no manifest compatibility status'
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

function evidenceFor(persisted: MeshPeerInfo | null, runtime: MeshPeerDiagnostic | null, pairing: PendingPairingEntry | null, diagnostics: WebRTCDiagnosticsResponse | null): string {
  const sources = [persisted ? 'Auth.MeshListPeers' : null, runtime ? 'Gateway.GetMeshStatus' : null, pairing ? 'Auth.ListPendingPairings' : null, diagnostics?.peers.some((peer) => peer.stable_peer_id === (persisted?.peer_id ?? runtime?.peer_id ?? pairing?.remote_peer_id)) ? 'Gateway.GetWebRTCDiagnostics' : null].filter(Boolean)
  return sources.join(', ') || 'no service status'
}

function formatRelative(value: string | null | undefined): string {
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

function formatDate(value: string | null | undefined): string {
  if (!value) return 'not reported'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

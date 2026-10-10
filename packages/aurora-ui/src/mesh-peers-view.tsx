'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Network, RadioTower, RefreshCw, Settings2 } from 'lucide-react'
import { AUTH_METHODS, type AuroraClient, type AvailabilityState, type ConfigFieldMetadata, type JsonObject, type JsonValue, type MeshInviteConfigResponse, type PendingPairingEntry } from '@aurora/client'
import type { PeerPairingApproval, SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card'
import { Switch } from '#components/ui/switch'
import {
  getAuroraSurfaceProfile,
  runtimeModeFromTransportKind,
  type AuroraSurfaceProfile,
} from './platform-surface'
import { PRODUCT_COPY } from './product-copy'
import { RouteStateNotice } from './state-surface'
import { encodeMeshInviteUrl } from './mesh-invite'
import {
  type LocalFeatureSharingPort,
  type LocalShareableServiceScope,
  localFeatureIdsForServicePermissions,
  localServicePermissionCatalog,
  localShareableServiceScopes,
} from './local-feature-sharing'
import type { RouteAvailability } from './shell-data'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot } from './web-thin-runtime'
import { AuroraQueryProvider, useAuroraQueryScope, useAuroraQueryScopeKey } from './query'
import { usePeerRoster } from './use-peer-roster'
import {
  commitMeshConfigChangeSet,
  meshInviteConfigChanges,
  prepareLocalFeatureSharingApproval,
} from './mesh-peers-data'
import {
  ConnectPeerDialog,
  DiscoveredDevicesCard,
  MeshSettingsDialog,
  MeshSummaryCards,
  MeshVerificationCode,
  PeerCardGrid,
  PeerDetailSheet,
  PeerTable,
  PendingRequestsTable,
  RequestReviewDialog,
  ScopesDialog,
  ThinPeerConnectionStatus,
  ThinPeerPairingDialog,
  buildMeshInvitePayload,
  buildMeshPeerAdminAction,
  buildMeshScopesAdminAction,
  configBoolean,
  configField,
  meshInviteReadiness,
  meshPeerActionIdentity,
  meshPeerErrorMessage,
  isPermissionAllowedOnSurface,
  meshPeerScopesEditable,
  meshSafeErrorTitle,
  parseMeshPermissionList,
} from './mesh-peers-sections'
export {
  buildLocalMeshNodeSnapshot,
  buildMeshPeersSnapshot,
  commitMeshConfigChangeSet,
  meshInviteConfigChanges,
  meshInviteQuiesceChanges,
  prepareLocalFeatureSharingApproval,
  reconcileMeshPeersWithThinPeer,
} from './mesh-peers-data'
export {
  buildMeshInvitePayload,
  buildMeshPeerAdminAction,
  buildMeshScopesAdminAction,
  meshInviteReadiness,
  meshPeerErrorMessage,
  meshPeerScopesEditable,
  parseMeshPermissionList,
} from './mesh-peers-sections'

export type MeshPeersLoadState = 'loading' | 'ready' | 'empty' | 'degraded' | 'denied' | 'service-unavailable' | 'error'

export interface MeshPeerAdminAction {
  methodId: typeof AUTH_METHODS.meshApprovePeer | typeof AUTH_METHODS.meshDenyPeer | typeof AUTH_METHODS.meshUpdatePeerPermissions | typeof AUTH_METHODS.meshRemovePeer | typeof AUTH_METHODS.pairingApprove | typeof AUTH_METHODS.pairingDeny
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

export type MeshPendingRequestRow = MeshPeerRow & { pendingPairing: PendingPairingEntry }

export interface MeshLiveSessionRow {
  sessionId: string
  stablePeerId: string
  nodeName: string
  pairingSessionId: string | null
  verificationCode: string | null
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
  /** Admin-gated signaling material used only to build the explicitly shared invite. */
  inviteConfig?: MeshInviteConfigResponse | null
  secretsRedacted: boolean
  peers: MeshPeerRow[]
  pendingRequests: MeshPendingRequestRow[]
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
  /** Centralized surface policy for local-vs-remote configuration ownership. */
  surfaceProfile?: AuroraSurfaceProfile
  /** Thin WebRTC peer state used by the normal Mesh pairing workflow. */
  thinPeer?: BrowserWebRtcPeerController
  /** Invite text handed off through a scrubbed fragment/deep-link handoff; never read from query params. */
  initialInviteText?: string | null
  /** Native QR scanner (mobile shells); resolves to the scanned text or null when cancelled. */
  onScanQr?: () => Promise<string | null>
  /** Local authority facade; omitted when this surface cannot safely offer local features. */
  localFeatureSharing?: LocalFeatureSharingPort | undefined
  /** Stable identity owned by a lightweight mesh node on this surface. */
  localNode?: LocalMeshNodeIdentity | undefined
  /** Session admin from WhoAmI / host shell. Home-server sharing stays visible but locked when false. */
  sessionIsAdmin?: boolean
}

export interface LocalMeshNodeIdentity {
  readonly peerId: string
  readonly nodeName: string
}

export interface MeshPeersSnapshotOptions {
  signal?: AbortSignal | undefined
  /** Local configuration and invite credentials are available only to the owning Aurora surface. */
  canManageLocalServiceConfiguration?: boolean
}

export interface MeshPeersViewProps {
  snapshot: MeshPeersSnapshot
  route: RouteAvailability
  surfaceProfile?: AuroraSurfaceProfile
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
  /** Drop this device's saved approval for a peer; remote removal is best effort. */
  onForgetPeer?: (peer: MeshPeerRow) => void
  forgetPendingPeerId?: string | null
  /** Product-safe notice when forgetting only removed this device's side. */
  forgetWarning?: string | null
  onConfigChange?: (changes: MeshConfigChange[]) => void
  onSaveScopes?: (peer: MeshPeerRow, permissions: string[]) => void
  onScanQr?: () => Promise<string | null>
  onApplyInvite?: (invite: JsonObject) => void
  inviteImport?: MeshInviteImportOperation
  canManageLocalServiceConfiguration?: boolean
  thinPeerSnapshot?: BrowserWebRtcSnapshot | null
  thinPeerEvidence?: SelectedCandidatePairEvidence | null
  thinPeerMutationError?: string | null
  /**
   * Set up one more device from the ones found in this Aurora. Several devices
   * can be connected at once here; Connect stays on one on purpose.
   */
  onConnectDiscoveredDevice?: (peerId: string) => void | Promise<void>
  onConfirmThinPairing?: (sessionId: string, approval: PeerPairingApproval) => void | Promise<void>
  onRejectThinPairing?: (sessionId: string) => void
  onReconnectThinPeer?: () => void
  /** Invite text handed off by a deep link (`aurora://mesh/invite`); opens the connect dialog pre-filled. */
  initialInviteText?: string | null
  /** Local authority facade; omitted when this surface cannot safely offer local features. */
  localFeatureSharing?: LocalFeatureSharingPort | undefined
  /** Services this local node can share. Tool-level choices remain on the Tools page. */
  localServiceScopes?: readonly LocalShareableServiceScope[] | undefined
  ownsLocalNodeState?: boolean
  /** Session admin from WhoAmI / host shell. Home-server peer scopes stay visible but locked when false. */
  sessionIsAdmin?: boolean
}

export interface MeshInviteImportOperation {
  pending: boolean
  error: string | null
  appliedChangeCount: number | null
}

const idleInviteImport: MeshInviteImportOperation = {
  pending: false,
  error: null,
  appliedChangeCount: null,
}

export function resolveSessionIsAdmin(
  sessionIsAdmin: boolean | undefined,
  client?: { auth?: { snapshot?: () => { isAdmin?: boolean } } } | null,
): boolean {
  if (typeof sessionIsAdmin === 'boolean') return sessionIsAdmin
  try {
    return client?.auth?.snapshot?.()?.isAdmin === true
  } catch {
    return false
  }
}

/** Home-server sharing and peer scopes are administrator-owned. Local this-device sharing is not. */
export function meshHomeServerConfigLocked(input: {
  sessionIsAdmin: boolean
  ownsLocalNodeState: boolean
}): boolean {
  return !input.ownsLocalNodeState && !input.sessionIsAdmin
}

export function MeshPeersResource(props: MeshPeersResourceProps) {
  const hasQueryScope = useAuroraQueryScope()
  if (hasQueryScope) return <MeshPeersResourceContent {...props} />
  return (
    <AuroraQueryProvider client={props.client} surfaceProfile={props.surfaceProfile ?? null}>
      <MeshPeersResourceContent {...props} />
    </AuroraQueryProvider>
  )
}

function MeshPeersResourceContent({
  client,
  route,
  surfaceProfile,
  thinPeer,
  initialInviteText: initialInviteTextProp = null,
  onScanQr,
  localFeatureSharing,
  localNode,
  sessionIsAdmin,
}: MeshPeersResourceProps) {
  const resolvedSurface = useMemo(
    () =>
      surfaceProfile
      ?? getAuroraSurfaceProfile({
        runtimeMode: runtimeModeFromTransportKind(client.transport.kind),
        transportKind: client.transport.kind,
        userAgent:
          typeof navigator === 'undefined' ? undefined : navigator.userAgent,
      }),
    [client.transport.kind, surfaceProfile],
  )
  const [permissions, setPermissions] = useState(() =>
    resolvedSurface.isMobile ? 'Orchestrator.use' : 'Gateway.use',
  )
  const [revokeToken, setRevokeToken] = useState(true)
  const [pendingPeerId, setPendingPeerId] = useState<string | null>(null)
  const [optimisticPeerId, setOptimisticPeerId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [configPendingKey, setConfigPendingKey] = useState<string | null>(null)
  const [configMutationError, setConfigMutationError] = useState<string | null>(null)
  const [inviteImport, setInviteImport] = useState<MeshInviteImportOperation>(idleInviteImport)
  const [initialInviteText] = useState<string | null>(() => initialInviteTextProp)
  const [thinPeerMutationError, setThinPeerMutationError] =
    useState<string | null>(null)
  const thinPairingApprovals = useRef<Set<string>>(new Set<string>())
  const thinPairingApprovalsInFlight = useRef<Set<string>>(new Set<string>())
  const runningActions = useRef<Set<string>>(new Set<string>())
  const canManageLocalServiceConfiguration =
    resolvedSurface.canManageLocalServiceConfiguration
  const ownsLocalNodeState = resolvedSurface.ownsLocalNodeState
  const [resolvedSessionIsAdmin, setResolvedSessionIsAdmin] = useState(
    () => resolveSessionIsAdmin(sessionIsAdmin, client),
  )
  useEffect(() => {
    if (typeof sessionIsAdmin === 'boolean') {
      setResolvedSessionIsAdmin(sessionIsAdmin)
      return
    }
    const auth = client.auth
    if (!auth?.subscribe) {
      setResolvedSessionIsAdmin(resolveSessionIsAdmin(undefined, client))
      return
    }
    return auth.subscribe((next) => {
      setResolvedSessionIsAdmin(next.isAdmin === true)
    })
  }, [client, sessionIsAdmin])
  const homeServerConfigLocked = meshHomeServerConfigLocked({
    sessionIsAdmin: resolvedSessionIsAdmin,
    ownsLocalNodeState,
  })

  const sanitizePermissions = useCallback(
    (value: string) =>
      parseMeshPermissionList(value)
        ?.filter((permission) => isPermissionAllowedOnSurface(permission, resolvedSurface))
        .join(' ') || '',
    [resolvedSurface],
  )

  const filterPermissions = useCallback(
    (nextPermissions: string[]) =>
      nextPermissions.filter((permission) => isPermissionAllowedOnSurface(permission, resolvedSurface)),
    [resolvedSurface],
  )

  useEffect(() => {
    setPermissions((next) => sanitizePermissions(next) || (resolvedSurface.isMobile ? 'Orchestrator.use' : 'Gateway.use'))
  }, [resolvedSurface.isMobile, sanitizePermissions])
  const {
    snapshot,
    loadPeers,
    thinPeerSnapshot,
    thinPeerEvidence,
    localSharingSnapshot,
  } = usePeerRoster({
    client,
    route,
    thinPeer,
    localFeatureSharing,
    localNode,
    ownsLocalNodeState,
    canManageLocalServiceConfiguration,
  })


  const runAction = useCallback(
    async (peer: MeshPeerRow, kind: 'approve' | 'deny' | 'remove') => {
      if (homeServerConfigLocked) return
      const action =
        kind === 'approve'
          ? buildMeshPeerAdminAction(peer, 'approve', {
              reason: `Approve ${peer.nodeName}`,
              permissions: sanitizePermissions(permissions),
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
      const actionKey = `${meshPeerActionIdentity(peer)}:${kind}`
      if (runningActions.current.has(actionKey)) return
      runningActions.current.add(actionKey)
      setPendingPeerId(meshPeerActionIdentity(peer))
      setOptimisticPeerId(peer.peerId)
      setMutationError(null)
      try {
        await client.admin.execute(action)
        await loadPeers()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        runningActions.current.delete(actionKey)
        setPendingPeerId(null)
        setOptimisticPeerId(null)
      }
    },
    [client.admin, homeServerConfigLocked, loadPeers, permissions, revokeToken],
  )

  const [forgetPendingPeerId, setForgetPendingPeerId] = useState<string | null>(null)
  const [forgetWarning, setForgetWarning] = useState<string | null>(null)

  const forgetPeer = useCallback(
    async (peer: MeshPeerRow) => {
      if (!thinPeer) return
      setForgetPendingPeerId(peer.peerId)
      setForgetWarning(null)
      // Ask the other device to drop its side first, while the connection can
      // still carry the request. This stays best effort on purpose: an offline
      // or refusing device must never stop this device from forgetting its own
      // saved approval, because a one-sided approval is what strands pairing.
      let remoteForgotten = false
      if (peer.connectionStatus === 'connected' && peer.removeAction) {
        try {
          await client.admin.execute(peer.removeAction)
          remoteForgotten = true
        } catch {
          remoteForgotten = false
        }
      }
      try {
        const result = await thinPeer.forgetSavedPeer(peer.peerId)
        if (!result.cleared) {
          setForgetWarning(
            result.failureReason ?? 'The saved approval for this device could not be removed.',
          )
        } else if (!remoteForgotten) {
          setForgetWarning(
            `${peer.nodeName} was removed from this device only. It may still list this device until you remove it there as well.`,
          )
        }
      } catch {
        setForgetWarning('The saved approval for this device could not be removed.')
      } finally {
        setForgetPendingPeerId(null)
        try {
          await loadPeers()
        } catch {
          // The local removal result is already shown; refresh failure is not a forget failure.
        }
      }
    },
    [client.admin, loadPeers, thinPeer],
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
        await commitMeshConfigChangeSet(
          client,
          configChanges,
          `Update mesh settings for ${snapshot.localNodeName}`,
          'Config change was not valid.',
        )
        await loadPeers()
      } catch (error) {
        setConfigMutationError(meshPeerErrorMessage(error))
      } finally {
        setConfigPendingKey(null)
      }
    },
    [client.config, loadPeers],
  )

  const applyInvite = useCallback(
    async (invite: JsonObject) => {
      setInviteImport({ pending: true, error: null, appliedChangeCount: null })
      try {
        const changes = meshInviteConfigChanges(invite)
        if (changes.length > 0) {
          await commitMeshConfigChangeSet(
            client,
            changes,
            `Join mesh from invite for ${snapshot.localNodeName}`,
            'Invite configuration was not valid for this device.',
          )
        }
        setInviteImport({ pending: false, error: null, appliedChangeCount: changes.length })
        await loadPeers()
      } catch (error) {
        setInviteImport({ pending: false, error: meshPeerErrorMessage(error), appliedChangeCount: null })
      }
    },
    [client.config, loadPeers],
  )

  const saveScopes = useCallback(
    async (peer: MeshPeerRow, nextPermissions: string[]) => {
      if (homeServerConfigLocked) return
      const action = buildMeshScopesAdminAction(peer, filterPermissions(nextPermissions))
      if (!action) {
        setMutationError('Pending pairing requests must be reviewed by comparing the verification code on both Auroras before shared features can be changed.')
        return
      }
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
    [client.admin, filterPermissions, homeServerConfigLocked, loadPeers],
  )

  const saveLocalScopes = useCallback(
    async (peer: MeshPeerRow, nextPermissions: string[]) => {
      if (!localFeatureSharing) return
      setPendingPeerId(peer.peerId)
      setOptimisticPeerId(peer.peerId)
      setMutationError(null)
      try {
        const current = await localFeatureSharing.load()
        const approvedDevice = current.approvedDevices.find((device) => device.peerId === peer.peerId)
        if (!approvedDevice) {
          throw new Error('This device is no longer available. Refresh connected devices and try again.')
        }
        const scopes = localShareableServiceScopes(current)
        const selectedFeatureIds = localFeatureIdsForServicePermissions(scopes, nextPermissions)
        const enabledFeatureIds = await prepareLocalFeatureSharingApproval(localFeatureSharing, selectedFeatureIds)
        await localFeatureSharing.replacePeerSharing(
          peer.peerId,
          enabledFeatureIds,
          approvedDevice.expiresAtMs,
        )
        await loadPeers()
      } catch (error) {
        setMutationError(meshPeerErrorMessage(error))
      } finally {
        setPendingPeerId(null)
        setOptimisticPeerId(null)
      }
    },
    [loadPeers, localFeatureSharing],
  )

  const confirmThinPairing = useCallback(
    async (sessionId: string, approval: PeerPairingApproval) => {
      if (thinPairingApprovals.current.has(sessionId)) return
      if (thinPairingApprovalsInFlight.current.has(sessionId)) return
      if (!thinPeer) return
      thinPairingApprovalsInFlight.current.add(sessionId)
      setThinPeerMutationError(null)
      try {
        const sharedFeatureIds = localFeatureSharing
          ? await prepareLocalFeatureSharingApproval(localFeatureSharing, approval.sharedFeatureIds ?? [])
          : []
        await thinPeer.confirmPairing(sessionId, { sharedFeatureIds })
        thinPairingApprovals.current.add(sessionId)
      } catch (error) {
        setThinPeerMutationError(meshPeerErrorMessage(error))
        throw error
      } finally {
        thinPairingApprovalsInFlight.current.delete(sessionId)
      }
    },
    [localFeatureSharing, thinPeer],
  )

  const rejectThinPairing = useCallback(
    async (sessionId: string) => {
      if (!thinPeer) return
      setThinPeerMutationError(null)
      try {
        await thinPeer.rejectPairing(sessionId)
      } catch (error) {
        setThinPeerMutationError(meshPeerErrorMessage(error))
      }
    },
    [thinPeer],
  )

  const reconnectThinPeer = useCallback(async () => {
    if (!thinPeer) return
    setThinPeerMutationError(null)
    try {
      await thinPeer.connect()
    } catch (error) {
      setThinPeerMutationError(meshPeerErrorMessage(error))
    }
  }, [thinPeer])

  const connectDiscoveredDevice = useCallback(async (peerId: string) => {
    if (!thinPeer || !ownsLocalNodeState) return
    setThinPeerMutationError(null)
    try {
      await thinPeer.connectDiscoveredDevice(peerId)
    } catch (error) {
      setThinPeerMutationError(meshPeerErrorMessage(error))
    }
  }, [ownsLocalNodeState, thinPeer])

  return (
    <MeshPeersView
      snapshot={snapshot}
      route={route}
      surfaceProfile={resolvedSurface}
      permissions={permissions}
      revokeToken={revokeToken}
      pendingPeerId={pendingPeerId}
      optimisticPeerId={optimisticPeerId}
      mutationError={mutationError}
      configPendingKey={configPendingKey}
      configMutationError={configMutationError}
      onPermissionsChange={setPermissions}
      onRevokeTokenChange={setRevokeToken}
      onRefresh={loadPeers}
      canManageLocalServiceConfiguration={canManageLocalServiceConfiguration}
      ownsLocalNodeState={ownsLocalNodeState}
      sessionIsAdmin={resolvedSessionIsAdmin}
      thinPeerSnapshot={thinPeerSnapshot}
      thinPeerEvidence={thinPeerEvidence}
      thinPeerMutationError={thinPeerMutationError}
      forgetPendingPeerId={forgetPendingPeerId}
      forgetWarning={forgetWarning}
      {...(thinPeer ? { onForgetPeer: (peer: MeshPeerRow) => void forgetPeer(peer) } : {})}
      onConfirmThinPairing={confirmThinPairing}
      onRejectThinPairing={(sessionId) => void rejectThinPairing(sessionId)}
      onReconnectThinPeer={() => void reconnectThinPeer()}
      {...(ownsLocalNodeState && thinPeer
        ? { onConnectDiscoveredDevice: connectDiscoveredDevice }
        : {})}
      {...(canManageLocalServiceConfiguration
        ? {
            onConfigChange: runConfigChange,
            onApplyInvite: applyInvite,
          }
        : {})}
      {...(!ownsLocalNodeState
        ? {
            onApprovePeer: (peer: MeshPeerRow) => runAction(peer, 'approve'),
            onDenyPeer: (peer: MeshPeerRow) => runAction(peer, 'deny'),
            onRemovePeer: (peer: MeshPeerRow) => runAction(peer, 'remove'),
            onSaveScopes: saveScopes,
          }
        : localFeatureSharing
          ? { onSaveScopes: saveLocalScopes }
          : {})}
      {...(onScanQr ? { onScanQr } : {})}
      inviteImport={inviteImport}
      initialInviteText={initialInviteText}
      {...(localFeatureSharing ? { localFeatureSharing } : {})}
      {...(ownsLocalNodeState && localSharingSnapshot
        ? { localServiceScopes: localShareableServiceScopes(localSharingSnapshot) }
        : {})}
    />
  )
}

export function MeshPeersView({
  snapshot,
  route,
  surfaceProfile,
  permissions = '',
  revokeToken = true,
  pendingPeerId = null,
  optimisticPeerId = null,
  mutationError = null,
  configPendingKey = null,
  configMutationError = null,
  inviteImport = idleInviteImport,
  canManageLocalServiceConfiguration = true,
  thinPeerSnapshot = null,
  thinPeerEvidence = null,
  thinPeerMutationError = null,
  onConnectDiscoveredDevice,
  initialInviteText = null,
  onPermissionsChange,
  onRevokeTokenChange,
  onRefresh,
  onApprovePeer,
  onDenyPeer,
  onRemovePeer,
  onForgetPeer,
  forgetPendingPeerId,
  forgetWarning,
  onConfigChange,
  onSaveScopes,
  onScanQr,
  onApplyInvite,
  onConfirmThinPairing,
  onRejectThinPairing,
  onReconnectThinPeer,
  localFeatureSharing,
  localServiceScopes = [],
  ownsLocalNodeState = false,
  sessionIsAdmin = false,
}: MeshPeersViewProps) {
  const [reviewRequestId, setReviewRequestId] = useState<string | null>(null)
  const [connectOpen, setConnectOpen] = useState<boolean>(() => Boolean(initialInviteText))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scopesPeerId, setScopesPeerId] = useState<string | null>(null)
  const [detailsPeerId, setDetailsPeerId] = useState<string | null>(null)
  const [thinPairingOpen, setThinPairingOpen] = useState(false)
  const [thinPairingSessionId, setThinPairingSessionId] = useState<string | null>(null)
  const [setupPeerId, setSetupPeerId] = useState<string | null>(null)
  const queryScopeKey = useAuroraQueryScopeKey()
  const scopesDialogScopeKey = useMemo(() => JSON.stringify(queryScopeKey), [queryScopeKey])
  const selectedScopesScopeKeyRef = useRef<string | null>(null)
  const lastScopesPeerRef = useRef<{ scopeKey: string; peer: MeshPeerRow } | null>(null)
  const openScopesDialog = useCallback((peerId: string) => {
    selectedScopesScopeKeyRef.current = scopesDialogScopeKey
    setScopesPeerId(peerId)
  }, [scopesDialogScopeKey])
  useEffect(() => {
    if (selectedScopesScopeKeyRef.current === null || selectedScopesScopeKeyRef.current === scopesDialogScopeKey) return
    selectedScopesScopeKeyRef.current = null
    setScopesPeerId(null)
  }, [scopesDialogScopeKey])
  useEffect(() => {
    if (!thinPairingOpen) return
    if (
      !thinPeerSnapshot?.pairingSessionId
      || !thinPairingSessionId
      || thinPeerSnapshot.pairingSessionId !== thinPairingSessionId
    ) {
      setThinPairingOpen(false)
      setThinPairingSessionId(null)
    }
  }, [thinPairingOpen, thinPairingSessionId, thinPeerSnapshot?.pairingSessionId])
  useEffect(() => {
    if (
      setupPeerId
      && thinPeerSnapshot?.pairingSessionId
      && thinPeerSnapshot.expectedStablePeerId === setupPeerId
    ) {
      setThinPairingSessionId(thinPeerSnapshot.pairingSessionId)
      setThinPairingOpen(true)
      setSetupPeerId(null)
    }
  }, [setupPeerId, thinPeerSnapshot?.expectedStablePeerId, thinPeerSnapshot?.pairingSessionId])
  const thinPairingSnapshot = thinPairingSessionId
    && thinPeerSnapshot?.pairingSessionId === thinPairingSessionId
    ? thinPeerSnapshot
    : null
  const pendingRequests = snapshot.pendingRequests
  const outgoingPairingSessions = pendingRequests.length === 0
    ? snapshot.liveSessions.filter((session) => {
        const pairingState = session.pairingState.toLowerCase()
        return session.connectionState.toLowerCase() === 'connected'
          && (pairingState.includes('pairing active') || pairingState.includes('pending pairing work'))
      })
    : []
  const outgoingPairingLabels = [...new Set(outgoingPairingSessions.map((session) => session.nodeName.trim() || session.stablePeerId || session.sessionId))]
  const reviewPeer = pendingRequests.find((peer) => peer.pendingPairing.request_id === reviewRequestId) ?? null
  const scopesDialogScopeMatches = selectedScopesScopeKeyRef.current === scopesDialogScopeKey
  const effectiveScopesPeerId = scopesDialogScopeMatches ? scopesPeerId : null
  const currentScopesPeer = snapshot.peers.find((peer) => peer.peerId === effectiveScopesPeerId && meshPeerScopesEditable(peer)) ?? null
  if (currentScopesPeer) {
    lastScopesPeerRef.current = { scopeKey: scopesDialogScopeKey, peer: currentScopesPeer }
  } else if (
    !effectiveScopesPeerId
    || snapshot.loadState !== 'loading'
    || lastScopesPeerRef.current?.scopeKey !== scopesDialogScopeKey
    || lastScopesPeerRef.current.peer.peerId !== effectiveScopesPeerId
  ) {
    lastScopesPeerRef.current = null
  }
  const scopesPeer = currentScopesPeer ?? (snapshot.loadState === 'loading' && lastScopesPeerRef.current?.scopeKey === scopesDialogScopeKey ? lastScopesPeerRef.current.peer : null)
  const detailsPeer = snapshot.peers.find((peer) => peer.peerId === detailsPeerId) ?? null
  const detailsSession = detailsPeer
    ? snapshot.liveSessions.find((session) => session.stablePeerId === detailsPeer.peerId) ?? null
    : null
  const controlsDisabled = route.disabled || snapshot.loadState === 'loading' || snapshot.loadState === 'denied'
  const mutationDisabled = controlsDisabled || Boolean(pendingPeerId) || !['available-local', 'available-remote', 'degraded'].includes(snapshot.mutationState)
  const homeServerConfigLocked = meshHomeServerConfigLocked({ sessionIsAdmin, ownsLocalNodeState })
  const homeServerMutationsDisabled = mutationDisabled || homeServerConfigLocked
  const inviteReadiness = useMemo(() => meshInviteReadiness(snapshot), [snapshot])
  const invitePayload = useMemo(() => (inviteReadiness.ready ? buildMeshInvitePayload(snapshot) : null), [inviteReadiness.ready, snapshot])
  const inviteUrl = useMemo(() => (invitePayload ? encodeMeshInviteUrl(invitePayload) : null), [invitePayload])
  const meshEnabledField = configField(snapshot.config.fields, 'services.gateway.mesh_network.enabled')
  const meshEnabledChecked = configBoolean(snapshot.config.fields, 'services.gateway.mesh_network.enabled', snapshot.meshEnabled)
  const masterSwitchUnavailable = !canManageLocalServiceConfiguration
    ? 'This device can view mesh state from its connected Aurora device, but only the home computer can change this switch.'
    : !meshEnabledField
      ? 'Aurora did not report the switch state.'
      : !snapshot.config.editable
        ? 'Changes are unavailable right now; showing the last reported mesh state.'
        : !onConfigChange
          ? 'Changes are unavailable on this screen.'
          : null
  const masterSwitchDisabled =
    !canManageLocalServiceConfiguration
    || controlsDisabled
    || Boolean(configPendingKey)
    || Boolean(masterSwitchUnavailable)

  const resolvedSurface =
    surfaceProfile
    ?? getAuroraSurfaceProfile({
      runtimeMode: runtimeModeFromTransportKind(snapshot.transportKind),
      transportKind: snapshot.transportKind,
      userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    })

  return (
    <div
      className="flex flex-col gap-5"
      aria-labelledby="mesh-peers-title"
      data-thin-peer-status={thinPeerSnapshot?.status}
      data-thin-peer-state={thinPeerSnapshot?.state}
      data-thin-peer-broker={thinPeerSnapshot?.selectedSignalingBrokerOrigin}
      data-thin-peer-error={thinPeerSnapshot?.lastRedactedError?.code}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 id="mesh-peers-title" className="text-xl font-semibold tracking-tight">
            Connected devices
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">Connect trusted devices and choose what each one can use.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onRefresh} disabled={controlsDisabled}>
            <RefreshCw data-icon="inline-start" /> Refresh
          </Button>
          {canManageLocalServiceConfiguration ? (
            <>
              <Button type="button" variant="outline" onClick={() => setSettingsOpen(true)} disabled={controlsDisabled && snapshot.config.fields.length === 0}>
                <Settings2 data-icon="inline-start" /> Device network settings
              </Button>
              <Button type="button" onClick={() => setConnectOpen(true)} disabled={controlsDisabled && snapshot.config.fields.length === 0}>
                <RadioTower data-icon="inline-start" /> Connect device
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 empty:hidden" aria-live="polite">
        {snapshot.loadState === 'loading' ? <RouteStateNotice state="loading" title="Loading connected devices" message="Loading trusted devices and pending requests." /> : null}
        {snapshot.loadState === 'error' ? <RouteStateNotice state="error" title="Connected devices unavailable" message={snapshot.error ?? 'Aurora could not load connected devices.'} /> : null}
        {snapshot.loadState === 'denied' ? <RouteStateNotice state="permission" title="Connected devices need approval" message="Review access before managing trusted devices." /> : null}
        {snapshot.loadState === 'service-unavailable' ? <RouteStateNotice state="offline" title="Connected devices unavailable" message="Aurora cannot reach device management right now." /> : null}
        {mutationError ? <RouteStateNotice state="error" title="Device change was not saved" message={meshSafeErrorTitle(mutationError)} /> : null}
        {configMutationError ? <RouteStateNotice state="error" title="Network setting was not saved" message={meshSafeErrorTitle(configMutationError)} /> : null}
        {inviteImport.error ? <RouteStateNotice state="error" title="Invite was not applied" message={meshSafeErrorTitle(inviteImport.error)} /> : null}
        {thinPeerMutationError ? <RouteStateNotice state="error" title="Connection request was not completed" message={meshSafeErrorTitle(thinPeerMutationError)} /> : null}
      </div>

      <ThinPeerConnectionStatus
        snapshot={thinPeerSnapshot}
        onReview={() => {
          const sessionId = thinPeerSnapshot?.pairingSessionId ?? null
          if (!sessionId) return
          setThinPairingSessionId(sessionId)
          setThinPairingOpen(true)
        }}
        onReconnect={onReconnectThinPeer}
      />

      <MeshSummaryCards snapshot={snapshot} pendingPeers={pendingRequests.length} />

      {!ownsLocalNodeState || canManageLocalServiceConfiguration ? <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network /> Device connections
          </CardTitle>
          <CardDescription>
            {canManageLocalServiceConfiguration
              ? <>Turning this off disconnects trusted devices.</>
              : <>Connection state is reported by the connected Aurora device. This device can view it, but cannot change it.</>}
          </CardDescription>
          <CardAction>
            <Switch
              aria-label="Device connections"
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
            {masterSwitchUnavailable ? <p className="text-sm text-muted-foreground">This switch is read-only right now.</p> : null}
            {configPendingKey ? <p className="text-sm text-muted-foreground">Applying changes…</p> : null}
          </CardContent>
        ) : null}
      </Card> : null}

      {outgoingPairingLabels.length > 0 ? (
        <Alert role="status">
          <RadioTower />
          <AlertTitle>Outgoing pairing is active</AlertTitle>
          <AlertDescription>
            Pairing request sent to <strong>{outgoingPairingLabels.join(', ')}</strong>. Compare the verification code shown on both devices, then approve on each Aurora.
            {outgoingPairingSessions.some((session) => session.verificationCode) ? (
              <span className="mt-2 flex flex-col gap-1">
                {outgoingPairingSessions.map((session) => (
                  <span key={session.pairingSessionId || session.sessionId}>
                    {session.nodeName}: <MeshVerificationCode value={session.verificationCode} />
                  </span>
                ))}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <PendingRequestsTable peers={pendingRequests} pendingPeerId={pendingPeerId} onReview={setReviewRequestId} />
      <DiscoveredDevicesCard
        devices={thinPeerSnapshot?.discoveredDevices ?? []}
        knownPeerIds={snapshot.peers.map((peer) => peer.peerId)}
        {...(onConnectDiscoveredDevice
          ? {
              onConnect: (peerId: string) => {
                setSetupPeerId(peerId)
                return onConnectDiscoveredDevice(peerId)
              },
            }
          : {})}
      />
      {homeServerConfigLocked ? (
        <p className="text-xs text-muted-foreground">{PRODUCT_COPY.mesh.adminSharingLocked}</p>
      ) : null}
      <PeerCardGrid peers={snapshot.peers} pendingPeerId={pendingPeerId} optimisticPeerId={optimisticPeerId} onOpenDetails={setDetailsPeerId} onOpenScopes={onSaveScopes ? openScopesDialog : undefined} onReview={(peerId) => {
        const request = pendingRequests.find((peer) => peer.peerId === peerId)
        if (request) setReviewRequestId(request.pendingPairing.request_id)
      }} />

      <div className="hidden md:block">
        <PeerTable
          peers={snapshot.peers}
          pendingPeerId={pendingPeerId}
          optimisticPeerId={optimisticPeerId}
          mutationDisabled={mutationDisabled}
          onOpenDetails={setDetailsPeerId}
          onOpenScopes={onSaveScopes ? openScopesDialog : undefined}
          onApprove={onApprovePeer}
          onDeny={onDenyPeer}
          onRemove={onRemovePeer}
        />
      </div>
      <PeerDetailSheet
        peer={detailsPeer}
        session={detailsSession}
        thinPeerSnapshot={thinPeerSnapshot}
        thinPeerEvidence={thinPeerEvidence}
        open={Boolean(detailsPeer)}
        onOpenChange={(open) => !open && setDetailsPeerId(null)}
        forgetPending={Boolean(detailsPeer && forgetPendingPeerId === detailsPeer.peerId)}
        forgetWarning={forgetWarning ?? null}
        {...(onForgetPeer ? { onForget: onForgetPeer } : {})}
      />
      <RequestReviewDialog
        peer={reviewPeer}
        open={Boolean(reviewPeer)}
        disabled={homeServerMutationsDisabled}
        pending={reviewPeer ? pendingPeerId === meshPeerActionIdentity(reviewPeer) : false}
        permissions={permissions}
        surfaceProfile={resolvedSurface}
        onOpenChange={(open) => !open && setReviewRequestId(null)}
        onPermissionsChange={onPermissionsChange}
        onApprovePeer={onApprovePeer}
        onDenyPeer={onDenyPeer}
      />
      {canManageLocalServiceConfiguration ? (
        <>
          <ConnectPeerDialog open={connectOpen} inviteUrl={inviteUrl} inviteReadiness={inviteReadiness} inviteImport={inviteImport} initialInviteText={initialInviteText} onScanQr={onScanQr} onApplyInvite={onApplyInvite} onOpenChange={setConnectOpen} />
          <MeshSettingsDialog open={settingsOpen} snapshot={snapshot} disabled={controlsDisabled} pendingKey={configPendingKey} mutationError={configMutationError} onConfigChange={onConfigChange} onOpenChange={setSettingsOpen} />
        </>
      ) : null}
      <ThinPeerPairingDialog
        snapshot={thinPairingSnapshot}
        open={thinPairingOpen}
        onOpenChange={(open) => {
          setThinPairingOpen(open)
          if (!open) setThinPairingSessionId(null)
        }}
        localFeatureSharing={localFeatureSharing}
        onConfirm={onConfirmThinPairing}
        onReject={onRejectThinPairing}
      />
      {onSaveScopes ? (
        <ScopesDialog
          peer={scopesPeer}
          open={Boolean(scopesPeer)}
          disabled={homeServerMutationsDisabled}
          lockMessage={homeServerConfigLocked ? PRODUCT_COPY.mesh.adminSharingLocked : null}
          pending={scopesPeer ? pendingPeerId === scopesPeer.peerId : false}
          surfaceProfile={resolvedSurface}
          {...(ownsLocalNodeState
            ? {
                permissionCatalog: localServicePermissionCatalog(localServiceScopes),
                showRoleTemplates: false,
                showPermissionIds: false,
              }
            : {})}
          onOpenChange={(open) => {
            if (!open) {
              selectedScopesScopeKeyRef.current = null
              setScopesPeerId(null)
            }
          }}
          onSave={onSaveScopes}
        />
      ) : null}
    </div>
  )
}

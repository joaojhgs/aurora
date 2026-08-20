'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, GitBranch, KeyRound, Link2, LockKeyhole, Network, QrCode, RadioTower, RefreshCw, Router, ScanLine, Settings2, ShieldCheck, Signal, UsersRound, Wifi } from 'lucide-react'
import { AUTH_METHODS, AuroraError, GATEWAY_METHODS, routePath, summarizeCapabilities, type AuroraClient, type AvailabilityState, type CapabilitySummary, type ConfigFieldMetadata, type ConfigSchemaMetadataResponse, type DeviceListResponse, type DeviceResponse, type JsonObject, type JsonValue, type ListPendingPairingsResponse, type MeshInviteConfigResponse, type MeshPeerListResponse, type MeshPeerDiagnostic, type MeshPeerInfo, type MeshRouteDiagnostic, type MeshStatusResponse, type PendingPairingEntry, type PermissionCatalogEntry, type WebRTCDiagnosticsResponse } from '@aurora/client'
import type { PeerPairingApproval, SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Checkbox } from '#components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '#components/ui/sheet'
import { Skeleton } from '#components/ui/skeleton'
import { Switch } from '#components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs'
import { Textarea } from '#components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '#components/ui/toggle-group'
import { PermissionEditorTable, ROLE_TEMPLATES, matchRoleTemplate } from './shared-components'
import { decodeMeshInvite, encodeMeshInviteUrl, meshInviteSummary, MESH_INVITE_VERSION_V2 } from './mesh-invite'
import {
  getAuroraSurfaceProfile,
  runtimeModeFromTransportKind,
  type AuroraSurfaceProfile,
} from './platform-surface'
import { presentableSignal } from './status-badges'
import { PRODUCT_COPY, safeErrorCopy } from './product-copy'
import {
  type LocalDeviceFeature,
  type LocalFeatureSharingPort,
  type LocalFeatureSharingSnapshot,
  type LocalShareableServiceScope,
  localFeatureIdsForServicePermissions,
  localShareableServiceScopes,
  localServicePermissionCatalog,
  selectedLocalServicePermissions,
} from './local-feature-sharing'
import type { RouteAvailability } from './shell-data'
import {
  isBrowserWebRtcConfigured,
  isBrowserWebRtcConnected,
  type BrowserDiscoveredDevice,
  type BrowserWebRtcPeerController,
  type BrowserWebRtcSnapshot,
} from './web-thin-runtime'
import { discoveredDeviceStateLabel } from './web-thin-connection-panel'

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

const meshConfigKeyPaths = ['services.gateway.mesh_network.enabled', 'services.gateway.mesh_network.node_name', 'services.gateway.mesh_network.version_policy', 'services.gateway.mesh_network.peer_selection', 'services.gateway.mesh_network.ping_interval_s', 'services.gateway.mesh_network.registry_announce_interval_s', 'services.gateway.mesh_network.stale_peer_timeout_s', 'services.gateway.mesh_network.remote_timeout_s', 'services.gateway.webrtc.enabled', 'services.gateway.webrtc.strategy', 'services.gateway.webrtc.app_id', 'services.gateway.webrtc.room', 'services.gateway.webrtc.password', 'services.gateway.webrtc.encrypt_signaling', 'services.gateway.webrtc.enable_app_layer_e2ee', 'services.gateway.webrtc.legacy_event_broadcast', 'services.gateway.webrtc.stun_servers', 'services.gateway.webrtc.turn_servers', 'services.gateway.signaling_mqtt.brokers', 'services.gateway.signaling_mqtt.topic_root', 'services.auth.enabled', 'services.auth.default_pairing_permissions', 'services.auth.webrtc_auth_timeout_seconds', 'services.auth.webrtc_pairing_timeout_seconds']

const MESH_PRIMARY_READ_TIMEOUT_MS = 8_000
const MESH_OPTIONAL_READ_TIMEOUT_MS = 5_000
const CONNECTION_STATS_POLL_MS = 3_000

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

export function MeshPeersResource({
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
  const [snapshot, setSnapshot] = useState<MeshPeersSnapshot>(loadingSnapshot)
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
  const [thinPeerSnapshot, setThinPeerSnapshot] =
    useState<BrowserWebRtcSnapshot | null>(() => thinPeer?.snapshot() ?? null)
  const [thinPeerEvidence, setThinPeerEvidence] =
    useState<SelectedCandidatePairEvidence | null>(null)
  const thinPeerEvidenceRef = useRef<SelectedCandidatePairEvidence | null>(null)
  const [thinPeerMutationError, setThinPeerMutationError] =
    useState<string | null>(null)
  const thinPairingApprovals = useRef<Set<string>>(new Set<string>())
  const localSharingSnapshot = useRef<LocalFeatureSharingSnapshot | null>(null)
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

  useEffect(() => {
    if (!thinPeer) {
      setThinPeerSnapshot(null)
      return
    }
    return thinPeer.subscribe((nextThinSnapshot) => {
      setThinPeerSnapshot(nextThinSnapshot)
      setSnapshot((current) => ownsLocalNodeState
        ? buildLocalMeshNodeSnapshot({
            localNode,
            thinPeer: nextThinSnapshot,
            connectionEvidence: thinPeerEvidenceRef.current,
            featureSharing: localSharingSnapshot.current,
            sharingAvailable: Boolean(localFeatureSharing),
          })
        : reconcileMeshPeersWithThinPeer(current, nextThinSnapshot, current, thinPeerEvidenceRef.current))
    })
  }, [localFeatureSharing, localNode, ownsLocalNodeState, thinPeer])

  useEffect(() => {
    if (!ownsLocalNodeState || !localFeatureSharing?.subscribe) return
    return localFeatureSharing.subscribe((nextSharing) => {
      localSharingSnapshot.current = nextSharing
      setSnapshot(buildLocalMeshNodeSnapshot({
        localNode,
        thinPeer: thinPeer?.snapshot() ?? null,
        connectionEvidence: thinPeerEvidenceRef.current,
        featureSharing: nextSharing,
        sharingAvailable: true,
      }))
    })
  }, [localFeatureSharing, localNode, ownsLocalNodeState, thinPeer])

  const loadPeers = useCallback(async () => {
    if (ownsLocalNodeState) {
      let featureSharing: LocalFeatureSharingSnapshot | null = null
      if (localFeatureSharing) {
        try {
          featureSharing = await localFeatureSharing.load()
        } catch {
          featureSharing = null
        }
      }
      localSharingSnapshot.current = featureSharing
      setSnapshot(buildLocalMeshNodeSnapshot({
        localNode,
        thinPeer: thinPeer?.snapshot() ?? null,
        connectionEvidence: thinPeerEvidenceRef.current,
        featureSharing,
        sharingAvailable: Boolean(localFeatureSharing),
      }))
      return
    }
    const next = await buildMeshPeersSnapshot(client, route, {
      canManageLocalServiceConfiguration,
    })
    setSnapshot((current) =>
      reconcileMeshPeersWithThinPeer(
        next,
        thinPeer?.snapshot() ?? thinPeerSnapshot,
        current,
        thinPeerEvidenceRef.current,
      ),
    )
  }, [canManageLocalServiceConfiguration, client, localFeatureSharing, localNode, ownsLocalNodeState, route, thinPeer])

  useEffect(() => {
    if (ownsLocalNodeState || !snapshot.meshEnabled) return
    let cancelled = false
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const next = await buildMeshPeersSnapshot(client, route, {
          canManageLocalServiceConfiguration,
        })
        if (!cancelled) {
          setSnapshot((current) =>
            reconcileMeshPeersWithThinPeer(
              next,
              thinPeer?.snapshot() ?? thinPeerSnapshot,
              current,
              thinPeerEvidenceRef.current,
            ),
          )
        }
      } finally {
        pending = false
      }
    }
    const interval = window.setInterval(() => void refresh(), 3_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [canManageLocalServiceConfiguration, client, ownsLocalNodeState, route, snapshot.meshEnabled, thinPeer, thinPeerSnapshot])

  useEffect(() => {
    if (!thinPeer || !isBrowserWebRtcConnected(thinPeerSnapshot)) {
      thinPeerEvidenceRef.current = null
      setThinPeerEvidence(null)
      return
    }
    let cancelled = false
    let pending = false
    const measure = async () => {
      if (pending) return
      pending = true
      try {
        const evidence = await thinPeer.getSelectedCandidatePairEvidence()
        if (cancelled) return
        thinPeerEvidenceRef.current = evidence
        setThinPeerEvidence(evidence)
        const currentThinSnapshot = thinPeer.snapshot()
        setSnapshot((current) => ownsLocalNodeState
          ? buildLocalMeshNodeSnapshot({
              localNode,
              thinPeer: currentThinSnapshot,
              connectionEvidence: evidence,
              featureSharing: localSharingSnapshot.current,
              sharingAvailable: Boolean(localFeatureSharing),
            })
          : reconcileMeshPeersWithThinPeer(current, currentThinSnapshot, current, evidence))
      } catch {
        if (!cancelled) {
          thinPeerEvidenceRef.current = null
          setThinPeerEvidence(null)
          const currentThinSnapshot = thinPeer.snapshot()
          setSnapshot((current) => ownsLocalNodeState
            ? buildLocalMeshNodeSnapshot({
                localNode,
                thinPeer: currentThinSnapshot,
                connectionEvidence: null,
                featureSharing: localSharingSnapshot.current,
                sharingAvailable: Boolean(localFeatureSharing),
              })
            : reconcileMeshPeersWithThinPeer(current, currentThinSnapshot, current, null))
        }
      } finally {
        pending = false
      }
    }
    void measure()
    const interval = window.setInterval(() => void measure(), CONNECTION_STATS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    localFeatureSharing,
    localNode,
    ownsLocalNodeState,
    thinPeer,
    thinPeerSnapshot?.expectedStablePeerId,
    thinPeerSnapshot?.state,
    thinPeerSnapshot?.status,
  ])

  useEffect(() => {
    let cancelled = false
    setSnapshot(loadingSnapshot)
    void loadPeers().catch(() => {
      if (!cancelled) setSnapshot((current) => ({ ...current, loadState: 'error', error: 'Aurora could not load connected devices.' }))
    })
    return () => {
      cancelled = true
    }
  }, [loadPeers])

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
      setPendingPeerId(meshPeerActionIdentity(peer))
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
      const result = await thinPeer.forgetSavedPeer()
      setForgetPendingPeerId(null)
      if (!result.cleared) {
        setForgetWarning(
          result.failureReason ?? 'The saved approval for this device could not be removed.',
        )
      } else if (!remoteForgotten) {
        setForgetWarning(
          `${peer.nodeName} was removed from this device only. It may still list this device until you remove it there as well.`,
        )
      }
      try {
        await loadPeers()
      } catch {
        // The saved approval is already gone; a refresh failure is not a forget failure.
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
            reason: `Update mesh settings for ${snapshot.localNodeName}`,
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

  const applyInvite = useCallback(
    async (invite: JsonObject) => {
      setInviteImport({ pending: true, error: null, appliedChangeCount: null })
      try {
        const changes = meshInviteConfigChanges(invite)
        if (changes.length > 0) {
          const diff = await client.config.previewDiff({ changes })
          if (!diff.ok || !diff.data?.valid) {
            throw new Error(diff.ok ? diff.data?.errors.join('; ') || 'Invite configuration was not valid for this node.' : meshPeerErrorMessage(diff.error))
          }
          await client.config.previewReloadImpact({ changes })
          const quiesceChanges = meshInviteQuiesceChanges()
          const quiesceDiff = await client.config.previewDiff({ changes: quiesceChanges })
          if (!quiesceDiff.ok || !quiesceDiff.data?.valid) {
                throw new Error(quiesceDiff.ok ? 'Aurora could not pause existing connections before applying the invite.' : meshPeerErrorMessage(quiesceDiff.error))
          }
          await client.config.previewReloadImpact({ changes: quiesceChanges })
          for (const change of quiesceChanges) {
            await client.config.applyChange({
              change,
              reason: `Pause mesh connections before invite for ${snapshot.localNodeName}`,
              reauthConfirmed: true,
            })
          }
          for (const change of changes) {
            await client.config.applyChange({
              change,
              reason: `Join mesh from invite for ${snapshot.localNodeName}`,
              reauthConfirmed: true,
            })
          }
        }
        setInviteImport({ pending: false, error: null, appliedChangeCount: changes.length + meshInviteQuiesceChanges().length })
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
      if (!thinPeer) return
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
      {...(ownsLocalNodeState && localSharingSnapshot.current
        ? { localServiceScopes: localShareableServiceScopes(localSharingSnapshot.current) }
        : {})}
    />
  )
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

function filterPairingFeatures(
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
  const [statusResult, diagnosticsResult, catalogResult, configResult, inviteConfigResult] = await Promise.allSettled([
    client.requestResult<MeshStatusResponse, JsonObject>(
      GATEWAY_METHODS.getMeshStatus,
      {},
      {
        path: routePath('Gateway', 'GetMeshStatus'),
        timeoutMs: MESH_PRIMARY_READ_TIMEOUT_MS,
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
    withUiTimeout(
      client.capabilities.listCatalog({
        include_unavailable: true,
        include_internal: true,
      }),
      MESH_PRIMARY_READ_TIMEOUT_MS,
      'capability catalog',
    ),
    canManageLocalServiceConfiguration
      ? client.config.getSchemaMetadata({ include_values: true })
      : skippedMeshAuthRead<ConfigSchemaMetadataResponse>(),
    canManageLocalServiceConfiguration
      ? client.requestResult<MeshInviteConfigResponse, JsonObject>(
          GATEWAY_METHODS.getMeshInviteConfig,
          {},
          {
            path: routePath('Gateway', 'GetMeshInviteConfig'),
            timeoutMs: MESH_OPTIONAL_READ_TIMEOUT_MS,
          },
        )
      : skippedMeshAuthRead<MeshInviteConfigResponse>(),
  ])

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
          },
        )
      : skippedMeshAuthRead<DeviceListResponse>(),
  ])

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
  connectionEvidence,
  featureSharing,
  sharingAvailable,
}: {
  localNode?: LocalMeshNodeIdentity | undefined
  thinPeer?: BrowserWebRtcSnapshot | null | undefined
  connectionEvidence?: SelectedCandidatePairEvidence | null | undefined
  featureSharing?: LocalFeatureSharingSnapshot | null | undefined
  sharingAvailable?: boolean
}): MeshPeersSnapshot {
  const configured = isBrowserWebRtcConfigured(thinPeer)
  const connected = isBrowserWebRtcConnected(thinPeer)
  const expectedPeerId = configured ? thinPeer.expectedStablePeerId ?? null : null
  const featureById = new Map((featureSharing?.features ?? []).map((feature) => [feature.id, feature]))
  const approvedDevices = featureSharing?.approvedDevices ?? []
  const serviceScopes = featureSharing ? localShareableServiceScopes(featureSharing) : []
  const latencyMs = connected ? connectionRoundTripTimeMs(connectionEvidence) : null
  const rows = new Map<string, MeshPeerRow>()

  for (const approved of approvedDevices) {
    const isCurrent = approved.peerId === expectedPeerId
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
      nodeName: isCurrent ? thinPeer?.nodeName?.trim() || approved.peerLabel : approved.peerLabel,
      connected: isCurrent && connected,
      updatedAt: isCurrent ? thinPeer?.updatedAt ?? null : null,
      latencyMs: isCurrent ? latencyMs : null,
      permissions,
      services: grantedServices.map((scope) => scope.label),
    }))
  }

  if (expectedPeerId && !rows.has(expectedPeerId)) {
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
    liveSessions: connected && expectedPeerId ? [localMeshSessionRow(expectedPeerId, thinPeer!, latencyMs)] : [],
    devices: [],
    pendingCount: thinPeer?.pairingSessionId ? 1 : 0,
    approvedCount: peers.filter((peer) => peer.trustState === 'available-local' || peer.trustState === 'available-remote').length,
    deniedCount: 0,
    removedCount: 0,
    runtimePeerCount: peers.length,
    liveSessionCount: connected ? 1 : 0,
    deviceCount: peers.length,
    routeCount: connected ? 1 : 0,
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

function localMeshSessionRow(
  peerId: string,
  thinPeer: BrowserWebRtcSnapshot,
  latencyMs: number | null,
): MeshLiveSessionRow {
  return {
    sessionId: `direct:${peerId}`,
    stablePeerId: peerId,
    nodeName: thinPeer.nodeName?.trim() || 'Connected Aurora device',
    pairingSessionId: thinPeer.pairingSessionId ?? null,
    verificationCode: thinPeer.pairingVerificationCode ?? null,
    state: 'available-remote',
    connectionState: 'connected',
    iceState: thinPeer.icePathCategory,
    dataChannelState: 'connected',
    authState: 'approved',
    latencyMs,
    identitySource: 'Saved device identity',
    permissions: 'Approved connection',
    pairingState: thinPeer.pairingSessionId ? 'Waiting for approval' : 'Complete',
    linkedPeerState: 'Linked',
    evidenceSource: 'Direct connection',
  }
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
  useEffect(() => {
    if (!thinPeerSnapshot?.pairingSessionId) setThinPairingOpen(false)
  }, [thinPeerSnapshot?.pairingSessionId])
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
  const scopesPeer = snapshot.peers.find((peer) => peer.peerId === scopesPeerId && meshPeerScopesEditable(peer)) ?? null
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
        {mutationError ? <p className="text-sm text-destructive">{meshSafeErrorTitle(mutationError)}</p> : null}
        {configMutationError ? <p className="text-sm text-destructive">{meshSafeErrorTitle(configMutationError)}</p> : null}
        {inviteImport.error ? <p className="text-sm text-destructive">{meshSafeErrorTitle(inviteImport.error)}</p> : null}
        {thinPeerMutationError ? <p className="text-sm text-destructive">{meshSafeErrorTitle(thinPeerMutationError)}</p> : null}
      </div>

      <ThinPeerConnectionStatus
        snapshot={thinPeerSnapshot}
        onReview={() => setThinPairingOpen(true)}
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
        {...(onConnectDiscoveredDevice ? { onConnect: onConnectDiscoveredDevice } : {})}
      />
      {homeServerConfigLocked ? (
        <p className="text-xs text-muted-foreground">{PRODUCT_COPY.mesh.adminSharingLocked}</p>
      ) : null}
      <PeerCardGrid peers={snapshot.peers} pendingPeerId={pendingPeerId} optimisticPeerId={optimisticPeerId} onOpenDetails={setDetailsPeerId} onOpenScopes={onSaveScopes ? setScopesPeerId : undefined} onReview={(peerId) => {
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
          onOpenScopes={onSaveScopes ? setScopesPeerId : undefined}
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
        snapshot={thinPeerSnapshot}
        open={thinPairingOpen}
        onOpenChange={setThinPairingOpen}
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
          onOpenChange={(open) => !open && setScopesPeerId(null)}
          onSave={onSaveScopes}
        />
      ) : null}
    </div>
  )
}

function ThinPeerConnectionStatus({
  snapshot,
  onReview,
  onReconnect,
}: {
  snapshot: BrowserWebRtcSnapshot | null
  onReview: () => void
  onReconnect: (() => void) | undefined
}) {
  if (!snapshot || snapshot.status === 'authorized' || snapshot.status === 'fallback-http') {
    return null
  }

  if (snapshot.pairingSessionId && snapshot.pairingVerificationCode) {
    return (
      <div className="overflow-hidden rounded-xl border border-warning/35 bg-warning/5">
        <div className="flex items-center gap-1.5 border-b border-warning/25 px-4 py-3 text-sm font-semibold text-warning">
          <Network className="size-3.5" /> Waiting for approval
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {snapshot.nodeName || 'Invited Aurora device'}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Compare this code on both Auroras
            </p>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Verification code
            </span>
            <MeshVerificationCode value={snapshot.pairingVerificationCode} />
          </div>
          <Button type="button" size="sm" onClick={onReview}>
            Review &amp; approve
          </Button>
        </div>
      </div>
    )
  }

  if (
    snapshot.status === 'connecting'
    || snapshot.status === 'pairing'
    || snapshot.status === 'idle'
  ) {
    return (
      <Alert role="status">
        <RadioTower />
        <AlertTitle>Connecting to the invited Aurora device</AlertTitle>
        <AlertDescription>
          Aurora is preparing a direct connection. The verification request
          will appear here when both devices are ready.
        </AlertDescription>
      </Alert>
    )
  }

  if (
    snapshot.status === 'closed'
    || snapshot.status === 'failed'
  ) {
    const peerName =
      snapshot.nodeName
      || 'Invited Aurora device'
    return (
      <Alert role="status">
        <Wifi />
        <AlertTitle>{peerName} is offline</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>
            Aurora can retry the connection. Saved devices and last-known
            services stay visible until a trusted connection returns.
          </span>
          {onReconnect ? (
            <Button type="button" size="sm" variant="outline" onClick={onReconnect}>
              Reconnect
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="destructive" role="alert">
      <AlertTriangle />
      <AlertTitle>Device connection needs attention</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span>
          {snapshot.diagnostic
            ?? (snapshot.status === 'needs-invite'
              ? 'The saved Aurora invite is unavailable.'
              : 'The device connection is not active.')}
        </span>
        {onReconnect && snapshot.status !== 'disabled' ? (
          <Button type="button" size="sm" variant="outline" onClick={onReconnect}>
            Reconnect
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

function ThinPeerPairingDialog({
  snapshot,
  open,
  onOpenChange,
  localFeatureSharing,
  onConfirm,
  onReject,
}: {
  snapshot: BrowserWebRtcSnapshot | null
  open: boolean
  onOpenChange: (open: boolean) => void
  localFeatureSharing: LocalFeatureSharingPort | undefined
  onConfirm: ((sessionId: string, approval: PeerPairingApproval) => void | Promise<void>) | undefined
  onReject: ((sessionId: string) => void) | undefined
}) {
  const sessionId = snapshot?.pairingSessionId ?? null
  const verificationCode = snapshot?.pairingVerificationCode ?? null
  const [serviceScopes, setServiceScopes] = useState<LocalShareableServiceScope[]>([])
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const [featuresLoading, setFeaturesLoading] = useState(false)
  const [featureLoadError, setFeatureLoadError] = useState<string | null>(null)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [confirmPending, setConfirmPending] = useState(false)
  const approvalAttempt = useRef(0)
  useEffect(() => {
    if (!open || !sessionId) return
    let active = true
    approvalAttempt.current += 1
    setFeatureLoadError(null)
    setConfirmError(null)
    setConfirmPending(false)
    if (!localFeatureSharing) {
      setServiceScopes([])
      setSelectedPermissions([])
      setFeaturesLoading(false)
      return
    }
    setFeaturesLoading(true)
    void localFeatureSharing.load().then((next) => {
      if (!active) return
      const filtered = {
        ...next,
        features: filterPairingFeatures(next.features),
      }
      const scopes = localShareableServiceScopes(filtered)
      setServiceScopes(scopes)
      setSelectedPermissions(selectedLocalServicePermissions(filtered, scopes))
      setFeaturesLoading(false)
    }, () => {
      if (!active) return
      setServiceScopes([])
      setSelectedPermissions([])
      setFeaturesLoading(false)
      setFeatureLoadError('This device’s sharing options are unavailable right now. Try again.')
    })
    return () => {
      active = false
    }
  }, [localFeatureSharing, open, sessionId])
  const togglePermission = (permissionId: string) => {
    setSelectedPermissions((current) => {
      if (!current.includes(permissionId)) return [...current, permissionId]
      return current.filter((currentId) => currentId !== permissionId)
    })
  }
  const approve = async () => {
    if (!sessionId || !verificationCode || !onConfirm || featuresLoading || featureLoadError) return
    const attempt = approvalAttempt.current + 1
    approvalAttempt.current = attempt
    setConfirmPending(true)
    setConfirmError(null)
    try {
      const selected = localFeatureIdsForServicePermissions(serviceScopes, selectedPermissions)
      await onConfirm(sessionId, { sharedFeatureIds: selected })
      if (approvalAttempt.current === attempt) onOpenChange(false)
    } catch {
      if (approvalAttempt.current === attempt) {
        setConfirmError('Could not approve this device. Check the connection and try again.')
      }
    } finally {
      if (approvalAttempt.current === attempt) setConfirmPending(false)
    }
  }
  return (
    <Dialog open={open && Boolean(sessionId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Approve {snapshot?.nodeName || 'Aurora device'}
          </DialogTitle>
          <DialogDescription>
            Confirm that the verification code matches on both Auroras. Each
            device must approve independently before sharing starts.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-center text-xl">
          <p className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Verification code
          </p>
          <MeshVerificationCode value={verificationCode} />
        </div>
        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">Choose what {snapshot?.nodeName || 'this Aurora'} can use from this device</h3>
            <p className="text-xs text-muted-foreground">Only services available on this device are shown. You can change this later.</p>
          </div>
          {featuresLoading ? <Skeleton className="h-16 w-full" /> : null}
          {!featuresLoading && serviceScopes.length === 0 && !featureLoadError ? (
            <p className="text-sm text-muted-foreground">No services are available to share. You can still pair the devices.</p>
          ) : null}
          {!featuresLoading && serviceScopes.length > 0 ? (
            <PermissionEditorTable
              catalog={localServicePermissionCatalog(serviceScopes)}
              checked={Object.fromEntries(selectedPermissions.map((permission) => [permission, true]))}
              roleTemplate="custom"
              showRoleTemplates={false}
              showPermissionIds={false}
              onSelectRoleTemplate={() => undefined}
              onToggle={togglePermission}
            />
          ) : null}
        </div>
        {featureLoadError || confirmError ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{featureLoadError ?? confirmError}</AlertDescription>
          </Alert>
        ) : null}
        {!verificationCode ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              This pairing session did not report a verification code. Do not
              approve it.
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            disabled={!sessionId || !onReject || confirmPending}
            onClick={() => {
              if (sessionId) onReject?.(sessionId)
              onOpenChange(false)
            }}
          >
            Refuse
          </Button>
          <Button
            type="button"
            disabled={!sessionId || !verificationCode || !onConfirm || featuresLoading || Boolean(featureLoadError) || confirmPending}
            onClick={() => void approve()}
          >
            {confirmPending ? 'Waiting for other device…' : 'Approve & pair'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MeshStateBadge({ state }: { state: AvailabilityState | MeshPeersLoadState }) {
  return <Badge variant="outline">{meshStateLabel(state)}</Badge>
}

function MeshPeerStateBadge({
  peer,
  optimistic,
}: {
  peer: MeshPeerRow
  optimistic: boolean
}) {
  if (!optimistic && peer.lifecycleState === 'stale' && !peer.pendingPairing) {
    return <Badge variant="outline">Offline</Badge>
  }
  return (
    <MeshStateBadge state={optimistic ? 'pending' : peerVisibleState(peer)} />
  )
}

function peerVisibleState(peer: MeshPeerRow): AvailabilityState {
  if (peer.pendingPairing || peer.trustState === 'pending') return 'pending'
  if (peer.trustState === 'denied' || peer.outboundStatus === 'removed') return peer.trustState
  if (peer.lifecycleState === 'available-local' || peer.lifecycleState === 'available-remote') {
    return peer.lifecycleState
  }
  if (peer.connectionStatus.includes('connected') && !peer.connectionStatus.includes('disconnected')) {
    return 'available-remote'
  }
  return peer.trustState
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

function MeshSummaryCards({ snapshot, pendingPeers }: { snapshot: MeshPeersSnapshot; pendingPeers: number }) {
  const items = [
    {
      label: 'This device',
      value: snapshot.localNodeName,
      detail: snapshot.meshStarted ? 'Ready for secure connections' : 'Connections are unavailable',
      icon: Network,
    },
    {
      label: 'Connected devices',
      value: String(snapshot.liveSessionCount),
      detail: `${snapshot.runtimePeerCount} saved · ${snapshot.liveSessionCount} online`,
      icon: UsersRound,
    },
    {
      label: 'Pending requests',
      value: String(pendingPeers),
      detail: pendingPeers > 0 ? 'Review requests before another device can connect' : 'No requests waiting',
      icon: ShieldCheck,
    },
    {
      label: 'Availability',
      value: snapshot.meshEnabled ? 'On' : 'Off',
      detail: snapshot.meshStarted && snapshot.webrtcStarted
        ? 'Ready for device connections'
        : 'Device connections are unavailable',
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

/**
 * Devices seen in this Aurora that this device has not set up yet.
 *
 * Being here means a device announced itself, nothing more: every one of them
 * still needs its code confirmed and its approval given before it can do
 * anything. Several can be set up from here; the single-device restriction
 * belongs to Connect, not to this screen.
 */
function DiscoveredDevicesCard({
  devices,
  knownPeerIds,
  onConnect,
}: {
  devices: readonly BrowserDiscoveredDevice[]
  knownPeerIds: readonly string[]
  onConnect?: (peerId: string) => void | Promise<void>
}) {
  const known = new Set(knownPeerIds)
  const available = devices.filter((device) => !known.has(device.peerId))
  if (available.length === 0) return null
  return (
    <Card aria-label="Devices in this Aurora">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Network className="size-4" aria-hidden /> Devices in this Aurora
        </CardTitle>
        <CardDescription>
          Found nearby and not set up here yet. Add as many as you need.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {available.map((device) => (
          <div
            key={device.peerId}
            className="flex items-center justify-between gap-3 rounded-lg border border-border/80 p-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{device.deviceName}</p>
              <p className="truncate text-xs text-muted-foreground">
                Code {device.shortCode} · {discoveredDeviceStateLabel(device.state)}
              </p>
            </div>
            {onConnect && device.state !== 'connected' ? (
              <Button type="button" size="sm" variant="outline" onClick={() => void onConnect(device.peerId)}>
                Set up
              </Button>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PendingRequestsTable({ peers, pendingPeerId, onReview }: { peers: MeshPendingRequestRow[]; pendingPeerId: string | null; onReview: (requestId: string) => void }) {
  if (peers.length === 0) return null
  return (
    <div className="overflow-hidden rounded-xl border border-warning/35 bg-warning/5">
      <div className="flex items-center gap-1.5 border-b border-warning/25 px-4 py-3 text-sm font-semibold text-warning">
        <Network className="size-3.5" /> Waiting for approval
      </div>
      <Table>
        <TableBody>
          {peers.map((peer) => {
            const pairing = peer.pendingPairing
            const pending = pendingPeerId === pairing.request_id
            return (
              <TableRow key={`request-${pairing.request_id}`} className="border-warning/20">
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar className="size-8 border border-warning/30 bg-warning/10">
                      <AvatarFallback className="bg-transparent text-[11px] font-semibold text-warning">{peerInitials(peer.nodeName)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <div className="text-sm font-medium">{peer.nodeName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        device · requested {formatRelative(pairing?.created_at ?? null)}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Verification code</span>
                    <MeshVerificationCode value={pairing.verification_code} />
                  </div>
                </TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">expires {formatRelative(pairing?.expires_at ?? null)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button type="button" size="sm" onClick={() => onReview(pairing.request_id)} disabled={pending}>
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

function PeerCardGrid({ peers, pendingPeerId, optimisticPeerId, onOpenDetails, onOpenScopes, onReview }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; onOpenDetails: (peerId: string) => void; onOpenScopes?: ((peerId: string) => void) | undefined; onReview: (peerId: string) => void }) {
  if (peers.length === 0) return <EmptyPanel title="No connected devices yet" description="Approved devices will appear here after they connect or request access." />
  return (
    <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
      {peers.map((peer) => {
        const pending = pendingPeerId === peer.peerId
        const optimistic = optimisticPeerId === peer.peerId
        return (
          <Card key={peer.peerId} size="sm" data-state={optimistic ? 'optimistic' : undefined} className="transition-all hover:border-primary/40">
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar className="size-9 border">
                    <AvatarFallback className="text-[11px] font-semibold">{peerInitials(peer.nodeName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${peerPresenceDotClass(peer)}`} />
                      <span className="truncate">{peer.nodeName}</span>
                    </p>
                  </div>
                </div>
                <MeshPeerStateBadge peer={peer} optimistic={optimistic} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{peer.latencyMs === null ? 'Response time unavailable' : formatLatencyMs(peer.latencyMs)}</span>
                <span>{peer.lastSeen ? formatRelative(peer.lastSeen) : 'last seen n/a'}</span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => onOpenDetails(peer.peerId)}>
                  Details
                </Button>
                {peer.trustState === 'pending' || peer.pendingPairing ? (
                  <Button type="button" size="sm" disabled={pending} onClick={() => onReview(peer.peerId)}>
                    Review
                  </Button>
                ) : null}
                {onOpenScopes && meshPeerScopesEditable(peer) ? (
                  <Button type="button" size="sm" variant="outline" onClick={() => onOpenScopes(peer.peerId)}>
                    Features
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function peerPresenceDotClass(peer: MeshPeerRow): string {
  if (peer.trustState === 'denied' || peer.outboundStatus === 'removed') return 'bg-destructive'
  if (peer.lifecycleState === 'available-local' || peer.lifecycleState === 'available-remote') return 'bg-emerald-500'
  if (peer.connectionStatus.includes('connected') && !peer.connectionStatus.includes('disconnected')) return 'bg-emerald-500'
  if (peer.trustState === 'pending' || peer.pendingPairing) return 'bg-amber-500'
  return 'bg-muted-foreground/40'
}

function formatLatencyMs(latencyMs: number): string {
  return `${latencyMs.toFixed(1)} ms`
}

function connectionRoundTripTimeMs(
  evidence: SelectedCandidatePairEvidence | null | undefined,
): number | null {
  const value = evidence?.roundTripTimeMs
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function connectionPathLabel(value: string | null | undefined): string {
  switch (value?.toLowerCase()) {
    case 'host':
      return 'Nearby direct'
    case 'srflx':
    case 'prflx':
      return 'Public-address direct'
    case 'relay':
      return 'Relayed'
    default:
      return 'Not available'
  }
}

function candidateEndpointLabel(
  kind: string | undefined,
  networkKind: string | undefined,
): string {
  const path = kind === 'host'
    ? 'Nearby'
    : kind === 'srflx' || kind === 'prflx'
      ? 'Public address'
      : kind === 'relay'
        ? 'Relay'
        : 'Not available'
  return networkKind && path !== 'Not available'
    ? `${path} · ${networkKind.toUpperCase()}`
    : path
}

function negotiationRoleLabel(role: BrowserWebRtcSnapshot['negotiationRole']): string {
  if (role === 'offerer') return 'This device'
  if (role === 'answerer') return 'Other device'
  return 'Not available'
}

function formatConnectionBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1_024) return `${Math.round(bytes)} B`
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function PeerTable({ peers, pendingPeerId, optimisticPeerId, mutationDisabled, onOpenDetails, onOpenScopes, onApprove, onDeny, onRemove }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; mutationDisabled: boolean; onOpenDetails: (peerId: string) => void; onOpenScopes?: ((peerId: string) => void) | undefined; onApprove: ((peer: MeshPeerRow) => void) | undefined; onDeny: ((peer: MeshPeerRow) => void) | undefined; onRemove: ((peer: MeshPeerRow) => void) | undefined }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>All devices</CardTitle>
        <CardDescription>Device permissions and actions.</CardDescription>
      </CardHeader>
      <CardContent>
        {peers.length === 0 ? (
          <EmptyPanel title="No devices" description="Device permission rows will appear here after pairing." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
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
                      </div>
                    </TableCell>
                    <TableCell>
                      {peer.permissions.length > 0 ? (
                        <Badge variant="secondary">{permissionSummary(peer.permissions)}</Badge>
                      ) : (
                        <span className="text-[11.5px] text-muted-foreground">no access</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {peer.lifecycleState === 'stale'
                        ? 'offline'
                        : peer.latencyMs === null
                          ? 'not available'
                          : formatLatencyMs(peer.latencyMs)}
                    </TableCell>
                    <TableCell>
                      <MeshPeerStateBadge peer={peer} optimistic={optimistic} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => onOpenDetails(peer.peerId)}>
                          Details
                        </Button>
                        {onOpenScopes && meshPeerScopesEditable(peer) ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => onOpenScopes(peer.peerId)}>
                            Features
                          </Button>
                        ) : (
                          <span className="self-center text-[11.5px] text-muted-foreground">Review required</span>
                        )}
                      </div>
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
        <DetailItem label="Device ID" value={peer.fingerprint} />
        <DetailItem label="Requested" value={permissionSummary(peer.permissions)} />
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

function PeerDetailSheet({
  peer,
  session,
  thinPeerSnapshot,
  thinPeerEvidence,
  open,
  onOpenChange,
  onForget,
  forgetPending,
  forgetWarning,
}: {
  peer: MeshPeerRow | null
  session: MeshLiveSessionRow | null
  thinPeerSnapshot: BrowserWebRtcSnapshot | null
  thinPeerEvidence: SelectedCandidatePairEvidence | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onForget?: (peer: MeshPeerRow) => void
  forgetPending?: boolean
  forgetWarning?: string | null
}) {
  const directSnapshot = peer && thinPeerSnapshot && (
    thinPeerSnapshot.expectedStablePeerId === peer.peerId
    || thinPeerSnapshot.connectedStablePeerId === peer.peerId
  ) ? thinPeerSnapshot : null
  const directEvidence = directSnapshot ? thinPeerEvidence : null
  const responseTimeMs = peer?.latencyMs
    ?? connectionRoundTripTimeMs(directEvidence)
    ?? session?.latencyMs
    ?? null
  const hasConnectionDetails = Boolean(directSnapshot || session)
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{peer?.nodeName ?? 'Device details'}</SheetTitle>
          <SheetDescription>Connection status and the features shared between these devices.</SheetDescription>
        </SheetHeader>
        {peer ? (
          <div className="flex flex-col gap-4 px-4 pb-4">
            <Card>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <DetailItem label="Device ID" value={peer.peerId} />
                <DetailItem label="Connection group" value={peer.roomName || 'Not available'} />
                <DetailItem label="Trust" value={peer.trustLabel} />
                <DetailItem label="Availability" value={peer.lifecycleLabel} />
                <DetailItem label="Connection" value={peer.connectionStatus} />
                <DetailItem label="Response time" value={responseTimeMs === null ? 'Not available' : formatLatencyMs(responseTimeMs)} />
                <DetailItem label="Last seen" value={formatDate(peer.lastSeen)} />
              </CardContent>
            </Card>
            {hasConnectionDetails ? (
              <Card>
                <CardHeader>
                  <CardTitle>More connection details</CardTitle>
                  <CardDescription>Privacy-safe connection state for troubleshooting.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  <DetailItem
                    label="Connection path"
                    value={connectionPathLabel(directEvidence?.category ?? directSnapshot?.icePathCategory ?? session?.iceState)}
                  />
                  <DetailItem label="Response time" value={responseTimeMs === null ? 'Not available' : formatLatencyMs(responseTimeMs)} />
                  <DetailItem label="Connection check" value={productConnectionState(directEvidence?.pairState ?? session?.connectionState ?? directSnapshot?.state ?? '')} />
                  <DetailItem label="This device path" value={candidateEndpointLabel(directEvidence?.localCandidateType, directEvidence?.localProtocol)} />
                  <DetailItem label="Other device path" value={candidateEndpointLabel(directEvidence?.remoteCandidateType, directEvidence?.remoteProtocol)} />
                  <DetailItem label="Public address discovery" value={directEvidence?.stunServerReflexiveCandidate?.gathered ? 'Available' : 'Not observed'} />
                  <DetailItem label="Started by" value={negotiationRoleLabel(directSnapshot?.negotiationRole)} />
                  <DetailItem label="Coordination address" value={directSnapshot?.selectedSignalingBrokerOrigin ?? 'Not available'} />
                  <DetailItem label="Reconnect attempts" value={String(directSnapshot?.reconnectCount ?? 0)} />
                  <DetailItem label="Requests in progress" value={String(directSnapshot?.pendingCallCount ?? 0)} />
                  <DetailItem label="Replies in progress" value={String(directSnapshot?.pendingStreamCount ?? 0)} />
                  <DetailItem label="Live updates" value={String(directSnapshot?.pendingSubscriptionCount ?? 0)} />
                  <DetailItem label="Message parts waiting" value={String(directSnapshot?.pendingFragmentCount ?? 0)} />
                  <DetailItem label="Message parts sent" value={String(directSnapshot?.sentFragmentCount ?? 0)} />
                  <DetailItem label="Message parts received" value={String(directSnapshot?.receivedFragmentCount ?? 0)} />
                  <DetailItem label="Highest queued amount" value={formatConnectionBytes(directSnapshot?.bufferPressureHighWaterBytes ?? 0)} />
                  <DetailItem label="Protected page" value={directSnapshot?.secureContext === false ? 'No' : 'Yes'} />
                  <DetailItem label="Connection saved" value={directSnapshot?.secretsPersisted ? 'Yes' : 'No'} />
                </CardContent>
                <CardFooter>
                  <p className="text-xs text-muted-foreground">Network addresses are hidden.</p>
                </CardFooter>
              </Card>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>Permissions</CardTitle>
                <CardDescription>Review what each device has chosen to share.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label>Shared with this device</Label>
                  <PermissionBadges permissions={peer.permissions} empty="Nothing shared" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label>Available from this device</Label>
                  <PermissionBadges permissions={peer.inboundPermissions} empty="Nothing available" />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Shared features and connection</CardTitle>
                <CardDescription>What this device offers and how well the connection is working.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <DetailItem label="Available features" value={peer.services.join(', ') || 'None reported'} />
                <DetailItem label="App compatibility" value={peer.compatibility} />
              </CardContent>
            </Card>
          </div>
        ) : null}
        {onForget && peer ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Forgetting removes this device's saved approval for {peer.nodeName}. The other device is
              asked to remove its own approval too, but only if it is reachable right now.
            </p>
            {forgetWarning ? (
              <p role="status" className="text-sm font-medium text-amber-600 dark:text-amber-500">
                {forgetWarning}
              </p>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              disabled={Boolean(forgetPending)}
              onClick={() => onForget(peer)}
            >
              {forgetPending ? 'Forgetting…' : 'Forget this device'}
            </Button>
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
    label: permissionLabel(id),
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

function isPermissionAllowedOnSurface(permission: string, surfaceProfile: AuroraSurfaceProfile): boolean {
  if (!permission) return false
  if (surfaceProfile.isMobile && permission === 'Gateway.use') return false
  return true
}

function meshPermissionCatalog(surfaceProfile: AuroraSurfaceProfile, ...permissionSets: string[][]): PermissionCatalogEntry[] {
  const base = ['*', 'Gateway.use', 'Orchestrator.use', 'Orchestrator.RemoteInference', 'DB.use', 'Tooling.use', 'Scheduler.manage', 'TTS.use', 'STT.use']
  const roleDefaults = ROLE_TEMPLATES.flatMap((template) => template.permissions ?? [])
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const list of [...permissionSets, roleDefaults, base]) {
    for (const permission of list) {
      if (!isPermissionAllowedOnSurface(permission, surfaceProfile)) continue
      if (!seen.has(permission)) {
        seen.add(permission)
        ordered.push(permission)
      }
    }
  }
  return ordered.map(toCatalogEntry)
}

function RequestReviewDialog({
  peer,
  open,
  disabled,
  pending,
  permissions,
  surfaceProfile,
  onOpenChange,
  onPermissionsChange,
  onApprovePeer,
  onDenyPeer,
}: {
  peer: MeshPeerRow | null
  open: boolean
  disabled: boolean
  pending: boolean
  permissions: string
  surfaceProfile: AuroraSurfaceProfile
  onOpenChange: (open: boolean) => void
  onPermissionsChange: ((value: string) => void) | undefined
  onApprovePeer: ((peer: MeshPeerRow) => void) | undefined
  onDenyPeer: ((peer: MeshPeerRow) => void) | undefined
}) {
  const selected = parseMeshPermissionList(permissions) ?? []
  const filteredSelected = useMemo(() => selected.filter((permission) => isPermissionAllowedOnSurface(permission, surfaceProfile)), [selected, surfaceProfile])
  const catalog = useMemo(() => meshPermissionCatalog(surfaceProfile, peer?.permissions ?? [], filteredSelected), [peer?.peerId, filteredSelected, surfaceProfile])
  const checked: Record<string, boolean> = Object.fromEntries(filteredSelected.map((permission) => [permission, true]))
  const verificationCode = peer?.pendingPairing?.verification_code?.trim() || null
  const applyPermissions = (next: string[]) => onPermissionsChange?.(next.filter((permission) => isPermissionAllowedOnSurface(permission, surfaceProfile)).join(' '))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve {peer?.nodeName ?? 'device'}</DialogTitle>
          <DialogDescription>Confirm that the verification code matches on both Auroras, then approve independently on this Aurora. Start from a role, then fine-tune below.</DialogDescription>
        </DialogHeader>
        {peer ? (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-center text-xl">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Verification code</p>
              <MeshVerificationCode value={verificationCode} />
            </div>
            {!verificationCode ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>This pairing request did not report a verification code. Do not approve it until both Auroras show the same code.</AlertDescription>
              </Alert>
            ) : null}
            <PermissionEditorTable
              catalog={catalog}
              checked={checked}
              roleTemplate={matchRoleTemplate(filteredSelected)}
              disabled={disabled}
              onSelectRoleTemplate={(templateId) => {
                const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
                if (template?.permissions) applyPermissions(template.permissions)
              }}
              onToggle={(permissionId) => {
                const next = checked[permissionId] ? filteredSelected.filter((permission) => permission !== permissionId) : [...filteredSelected, permissionId]
                applyPermissions(next)
              }}
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="destructive" disabled={disabled || pending || !peer?.denyAction} onClick={() => peer && onDenyPeer?.(peer)}>
            Refuse
          </Button>
          <Button type="button" disabled={disabled || pending || !peer?.approveAction || !verificationCode} onClick={() => peer && onApprovePeer?.(peer)}>
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
  { value: 'view-only', label: 'View only', permissions: [] },
  { value: 'assistant-use', label: 'Assistant use', permissions: ['Orchestrator.use'] },
  { value: 'full-tools', label: 'Full tool access', permissions: ['*'] },
]

function currentShareScope(permissions: string[]): string {
  const match = SHARE_SCOPE_PRESETS.find((preset) => preset.permissions.length === permissions.length && preset.permissions.every((permission) => permissions.includes(permission)))
  return match?.value ?? 'view-only'
}

function MeshSettingsDialog({ open, snapshot, disabled, pendingKey, mutationError, onConfigChange, onOpenChange }: { open: boolean; snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; mutationError: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined; onOpenChange: (open: boolean) => void }) {
  const readOnly = disabled || Boolean(pendingKey) || !snapshot.config.editable || !onConfigChange
  const defaultPermissions = configArray(snapshot.config.fields, 'services.auth.default_pairing_permissions')
  const shareScope = currentShareScope(defaultPermissions)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-full overflow-y-auto" style={{ maxWidth: 'min(68rem, calc(100vw - 2rem))' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings2 /> Device connection settings
          </DialogTitle>
          <DialogDescription>
            Choose this device&apos;s name, connection behavior,
            security, and pairing defaults. Changes are reviewed before they
            take effect.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div aria-live="polite" className="empty:hidden">
            {mutationError ? (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertTitle>{meshSafeErrorTitle(mutationError)}</AlertTitle>
                <AlertDescription>Try again after Aurora finishes the current change.</AlertDescription>
              </Alert>
            ) : null}
            {pendingKey ? <p className="text-sm text-muted-foreground">Applying changes…</p> : null}
            {readOnly ? <p className="text-sm text-muted-foreground">Connection settings are read-only right now.</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
            <div>
              <p className="text-[13px] font-medium">Default sharing for new devices</p>
              <p className="text-[11.5px] text-muted-foreground">
                Baseline permissions granted on approval. Fine-tune each device in Features.
              </p>
            </div>
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
          <MeshConfigurationPanel snapshot={snapshot} disabled={disabled} pendingKey={pendingKey} onConfigChange={onConfigChange} />
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  )
}

function MeshConfigurationPanel({ snapshot, disabled, pendingKey, onConfigChange }: { snapshot: MeshPeersSnapshot; disabled: boolean; pendingKey: string | null; onConfigChange: ((changes: MeshConfigChange[]) => void) | undefined }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => {
    setDrafts(Object.fromEntries(snapshot.config.fields.map((field) => [field.key_path, stringifyConfigValue(field.current_value ?? field.default ?? '')])))
  }, [snapshot.config.fields])
  const groups = groupConfigFields(snapshot.config.fields)
  const groupNames = Object.keys(groups)
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const currentGroup = activeGroup && groupNames.includes(activeGroup) ? activeGroup : (groupNames[0] ?? null)
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

  if (snapshot.config.fields.length === 0) {
    return <EmptyPanel title="Settings" description="Connection settings appear here when Aurora reports them." />
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={currentGroup ?? ''} onValueChange={(value) => setActiveGroup(String(value))}>
          <TabsList>
            {groupNames.map((group) => (
              <TabsTrigger key={group} value={group}>
                {group}
                {groups[group]?.some((field) => (drafts[field.key_path] ?? '') !== stringifyConfigValue(field.current_value ?? field.default ?? '') && !field.secret) ? <span aria-hidden className="ml-1 size-1.5 rounded-full bg-primary" /> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <MeshStateBadge state={snapshot.config.state} />
          {changedCount > 0 ? <Badge variant="secondary">{changedCount} changed</Badge> : null}
          <Button type="button" onClick={applyChanges} disabled={!canApply}>
            {pending ? 'Applying' : 'Apply changes'}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {(currentGroup ? (groups[currentGroup] ?? []) : []).map((field) => {
          const fieldPending = pendingKey === field.key_path || pendingKey === '__batch__'
          const value = drafts[field.key_path] ?? ''
          const original = stringifyConfigValue(field.current_value ?? field.default ?? '')
          const changed = value !== original
          const readOnly = disabled || fieldPending || field.secret || !snapshot.config.editable
          return (
            <div key={field.key_path} className="grid gap-3 rounded-xl border border-border bg-background/60 p-3 transition-colors data-[changed=true]:border-primary/50 data-[changed=true]:bg-primary/5 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)] sm:items-center" data-changed={changed || undefined}>
              <div className="min-w-0 space-y-1">
                <Label htmlFor={field.key_path} className="text-sm font-semibold normal-case tracking-normal">
                  {field.title || configFieldFallbackTitle(field.key_path)}
                </Label>
                <p className="line-clamp-2 text-xs text-muted-foreground">{productConfigDescription(field)}</p>
                <div className="flex flex-wrap gap-1">
                  {changed ? <Badge>changed</Badge> : null}
                  {field.secret ? <Badge variant="secondary">secret</Badge> : null}
                  {field.reload_required ? <Badge variant="outline">needs refresh</Badge> : null}
                  {field.restart_required ? <Badge variant="outline">needs attention</Badge> : null}
                </div>
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
      </div>
    </div>
  )
}

function configFieldFallbackTitle(keyPath: string): string {
  const last = keyPath.split('.').at(-1) ?? keyPath
  return last.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function ConfigFieldControl({ field, value, disabled, onChange }: { field: ConfigFieldMetadata; value: string; disabled: boolean; onChange: (value: string) => void }) {
  if (disabled && value === '' && field.current_value == null && field.default == null) {
    return <div className="rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">Not reported</div>
  }
  if (isBooleanConfigField(field)) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-border bg-background/50 p-3">
        <span className="text-sm text-muted-foreground">{value === 'true' ? 'Enabled' : 'Disabled'}</span>
        <Switch checked={value === 'true'} disabled={disabled} onCheckedChange={(checked) => onChange(String(Boolean(checked)))} />
      </div>
    )
  }
  if (field.choices && field.choices.length > 0) {
    return (
      <Select value={value} disabled={disabled} onValueChange={(next) => next && typeof next === 'string' && onChange(next)}>
        <SelectTrigger id={field.key_path} className="w-full" disabled={disabled}>
          <SelectValue placeholder="Select…" />
        </SelectTrigger>
        <SelectContent>
          {field.choices.map((choice) => (
            <SelectItem key={String(choice)} value={String(choice)}>
              {String(choice).replace(/_/g, ' ')}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  if (isArrayConfigField(field)) {
    return <Textarea id={field.key_path} value={value} disabled={disabled} rows={3} onChange={(event) => onChange(event.currentTarget.value)} />
  }
  return <Input id={field.key_path} type={isNumberConfigField(field) ? 'number' : 'text'} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} />
}

function ScopesDialog({
  peer,
  open,
  disabled,
  lockMessage = null,
  pending,
  surfaceProfile,
  permissionCatalog,
  showRoleTemplates = true,
  showPermissionIds = true,
  onOpenChange,
  onSave,
}: {
  peer: MeshPeerRow | null
  open: boolean
  disabled: boolean
  lockMessage?: string | null
  pending: boolean
  surfaceProfile: AuroraSurfaceProfile
  permissionCatalog?: readonly PermissionCatalogEntry[] | undefined
  showRoleTemplates?: boolean | undefined
  showPermissionIds?: boolean | undefined
  onOpenChange: (open: boolean) => void
  onSave: ((peer: MeshPeerRow, permissions: string[]) => void) | undefined
}) {
  const [selected, setSelected] = useState<string[]>([])
  const allowedPermissionIds = useMemo(
    () => permissionCatalog ? new Set(permissionCatalog.map((permission) => permission.id)) : null,
    [permissionCatalog],
  )
  const permissionAllowed = useCallback(
    (permission: string) =>
      isPermissionAllowedOnSurface(permission, surfaceProfile)
      && (!allowedPermissionIds || allowedPermissionIds.has(permission)),
    [allowedPermissionIds, surfaceProfile],
  )
  useEffect(() => {
    if (peer) setSelected(peer.permissions.filter(permissionAllowed))
  }, [open, peer?.peerId, permissionAllowed])
  const sanitizedSelected = useMemo(() => selected.filter(permissionAllowed), [permissionAllowed, selected])
  const catalog = useMemo(
    () => permissionCatalog
      ? [...permissionCatalog]
      : meshPermissionCatalog(surfaceProfile, peer?.permissions ?? [], sanitizedSelected),
    [peer?.peerId, permissionCatalog, sanitizedSelected, surfaceProfile],
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Features{peer ? ` - ${peer.nodeName}` : ''}</DialogTitle>
          <DialogDescription>Choose what this device can use. The other device separately controls what it shares back.</DialogDescription>
        </DialogHeader>
        {lockMessage ? <p className="text-xs text-muted-foreground">{lockMessage}</p> : null}
    {peer && meshPeerScopesEditable(peer) ? (
          <PermissionEditorTable
            catalog={catalog}
            checked={Object.fromEntries(sanitizedSelected.map((permission) => [permission, true]))}
            roleTemplate={matchRoleTemplate(sanitizedSelected)}
            disabled={disabled}
            onSelectRoleTemplate={(templateId) => {
              const template = ROLE_TEMPLATES.find((entry) => entry.id === templateId)
              if (template?.permissions) setSelected(template.permissions.filter(permissionAllowed))
            }}
            onToggle={(permissionId) => setSelected((current) => (current.includes(permissionId) ? current.filter((permission) => permission !== permissionId) : [...current, permissionId]))}
            showRoleTemplates={showRoleTemplates}
            showPermissionIds={showPermissionIds}
          />
        ) : peer ? (
          <p className="text-sm text-muted-foreground">Review this pending pairing request and verify its exact code before sharing features.</p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={disabled || pending || !peer || !meshPeerScopesEditable(peer) || !onSave} onClick={() => peer && meshPeerScopesEditable(peer) && onSave?.(peer, sanitizedSelected)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectPeerDialog({ open, inviteUrl, inviteReadiness, inviteImport, initialInviteText, onScanQr, onApplyInvite, onOpenChange }: { open: boolean; inviteUrl: string | null; inviteReadiness: MeshInviteReadiness; inviteImport: MeshInviteImportOperation; initialInviteText: string | null; onScanQr: (() => Promise<string | null>) | undefined; onApplyInvite: ((invite: JsonObject) => void) | undefined; onOpenChange: (open: boolean) => void }) {
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<'invite' | 'join'>(initialInviteText ? 'join' : 'invite')
  const [joinText, setJoinText] = useState((initialInviteText ?? '').trim())
  const [scanError, setScanError] = useState<string | null>(null)
  const joinInvite = useMemo(() => decodeMeshInvite(joinText.trim()), [joinText])
  const joinSummary = useMemo(() => (joinInvite ? meshInviteSummary(joinInvite) : null), [joinInvite])
  const copyInvite = async () => {
    if (!inviteUrl) return
    await navigator.clipboard?.writeText(inviteUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  const scanQr = async () => {
    if (!onScanQr) return
    setScanError(null)
    try {
      const scanned = await onScanQr()
      if (scanned) setJoinText(scanned.trim())
    } catch (error) {
      setScanError(meshPeerErrorMessage(error))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect device</DialogTitle>
          <DialogDescription>Invite another device, or configure this device from an invite created elsewhere.</DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(value) => setMode(String(value) === 'join' ? 'join' : 'invite')}>
          <TabsList>
            <TabsTrigger value="invite">Invite a device</TabsTrigger>
            <TabsTrigger value="join">Join from an invite</TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'invite' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound /> Invite
                </CardTitle>
                <CardDescription>
                  Share this private invite with the other device. Pairing starts after both devices are ready.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {!inviteReadiness.ready ? (
                  <Alert>
                    <Signal />
                    <AlertTitle>Secure mesh invite is not ready</AlertTitle>
                    <AlertDescription>{inviteReadiness.reason}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mesh-invite-link" className="flex items-center gap-1.5">
                    <Link2 className="size-3.5" /> Invite link
                  </Label>
                  <Textarea id="mesh-invite-link" aria-label="Mesh invite link" className="min-h-16 break-all font-mono text-[11px]" value={inviteUrl ?? ''} placeholder="Enable mesh and wait for secure services to start." readOnly />
                  <p className="text-[11px] text-muted-foreground">The link includes sensitive connection details. Share it only through a private channel.</p>
                </div>
              </CardContent>
              <CardFooter className="justify-end">
                <Button type="button" onClick={copyInvite} disabled={!inviteUrl}>
                  <Copy data-icon="inline-start" /> {copied ? 'Copied' : 'Copy invite link'}
                </Button>
              </CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <QrCode /> Invite QR
                </CardTitle>
                <CardDescription>Scan with the Aurora mobile app or any camera app.</CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                {inviteUrl ? <InviteQr value={inviteUrl} /> : <p className="text-sm text-muted-foreground">QR becomes available after secure mesh startup completes.</p>}
              </CardContent>
            </Card>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RadioTower /> Join from an invite
                </CardTitle>
                <CardDescription>Paste or scan an invite to connect both devices. Pairing starts only after both devices are ready.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="mesh-join-invite">Invite link or code</Label>
                    {onScanQr ? (
                      <Button type="button" size="sm" variant="outline" disabled={inviteImport.pending} onClick={scanQr}>
                        <ScanLine data-icon="inline-start" /> Scan QR
                      </Button>
                    ) : null}
                  </div>
                  <Textarea id="mesh-join-invite" className="min-h-16 break-all font-mono text-[11px]" placeholder="aurora://mesh/invite?i=amv2.…" value={joinText} disabled={inviteImport.pending} onChange={(event) => setJoinText(event.currentTarget.value.trim())} />
                  {scanError ? <p className="text-sm text-destructive">{meshSafeErrorTitle(scanError)}</p> : null}
                  {joinText && !joinInvite ? <p className="text-sm text-muted-foreground">Not a recognizable Aurora mesh invite yet. Paste the full invite link or the invite code.</p> : null}
                </div>
                {joinSummary ? (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <DetailItem label="Device" value={joinSummary.nodeName} />
                    <DetailItem label="Invite" value="Ready" />
                    <DetailItem label="Connection" value={joinSummary.brokerCount > 0 ? 'Available' : 'Needs attention'} />
                    <DetailItem label="Sensitive details" value={joinSummary.includesPassword ? 'Included' : 'Missing'} />
                    <DetailItem label="Created" value={joinSummary.generatedAt ? formatRelative(joinSummary.generatedAt) : 'unknown'} />
                  </div>
                ) : null}
                {joinSummary && !joinSummary.includesPassword ? (
                  <Alert variant="destructive">
                    <AlertTriangle />
                    <AlertTitle>Incomplete invite</AlertTitle>
                    <AlertDescription>This invite is incomplete. Ask the sender for a new invite.</AlertDescription>
                  </Alert>
                ) : null}
                <Button type="button" disabled={!joinInvite || inviteImport.pending || !onApplyInvite} onClick={() => joinInvite && onApplyInvite?.(joinInvite)}>
                  {inviteImport.pending ? 'Applying invite…' : 'Apply invite'}
                </Button>
                {inviteImport.appliedChangeCount !== null ? (
                  <Alert>
                    <ShieldCheck />
                    <AlertTitle>Invite applied</AlertTitle>
                    <AlertDescription>
                      Invite details were saved. Aurora will connect and show approval requests on both devices.
                    </AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </div>
        )}
        <Alert>
          <LockKeyhole />
          <AlertTitle>Private invitation</AlertTitle>
          <AlertDescription>The invite includes sensitive connection details. Share it only through a private channel.</AlertDescription>
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
            <Router /> Local mesh state
          </CardTitle>
          <CardDescription>Local mesh status and page availability.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <DetailItem label="Mesh" value={snapshot.meshEnabled ? 'enabled' : 'disabled'} />
          <DetailItem label="Started" value={snapshot.meshStarted ? 'yes' : 'no'} />
          <DetailItem label="Direct connections" value={snapshot.webrtcStarted ? 'ready' : 'off'} />
          <DetailItem label="Page" value={route.disabled ? 'needs attention' : 'ready'} />
          <DetailItem label="Peer list" value={meshStateLabel(snapshot.listState)} />
          <DetailItem label="Changes" value={meshStateLabel(snapshot.mutationState)} />
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
          {snapshot.peers.flatMap((peer) => peer.services).length === 0 ? <p className="text-sm text-muted-foreground">No shared services reported by peers.</p> : <PermissionBadges permissions={[...new Set(snapshot.peers.flatMap((peer) => peer.services))]} empty="No shared services" />}
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
        <CardTitle>Active connections</CardTitle>
        <CardDescription>Active connection details are shown separately from saved device trust.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {sessions.length === 0 ? (
          <EmptyPanel title="No active connections" description="No active device connections were reported." />
        ) : (
          sessions.map((session) => (
            <Card key={session.sessionId} size="sm">
              <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <DetailItem label="Connection" value={session.nodeName} />
                <DetailItem label="Device" value={session.nodeName} />
                <DetailItem label="Status" value={meshStateLabel(session.state)} />
                <DetailItem label="Access" value={productConnectionState(session.authState)} />
                <DetailItem label="Response time" value={session.latencyMs === null ? 'Response time unavailable' : formatLatencyMs(session.latencyMs)} />
                <DetailItem label="Pairing" value={session.pairingState} />
                <DetailItem label="Linked peer" value={session.linkedPeerState} />
                <DetailItem label="Details" value={fixtureOnly ? 'Sample data' : 'Available'} />
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
        <CardDescription>Device trust is shown separately from live connection state.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {devices.length === 0 ? (
          <EmptyPanel title="No saved devices" description="No saved devices were reported for this mesh view." />
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
                <DetailItem label="Status" value={fixtureOnly ? 'Sample data' : 'Available'} />
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
        <CardDescription>Useful details for troubleshooting peer connections.</CardDescription>
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
          {permissionLabel(permission)}
        </Badge>
      ))}
      {visible.length < permissions.length ? <Badge variant="secondary">+{permissions.length - visible.length}</Badge> : null}
    </div>
  )
}

function permissionSummary(permissions: string[]): string {
  if (permissions.length === 0) return 'No access'
  if (permissions.length === 1) return permissionLabel(permissions[0] ?? '')
  return `${permissionLabel(permissions[0] ?? '')} +${permissions.length - 1}`
}

function permissionLabel(permission: string): string {
  const labels: Record<string, string> = {
    '*': 'Full access',
    'Gateway.use': 'Device connection',
    'Orchestrator.use': 'Assistant use',
    'Orchestrator.RemoteInference': 'Model selection',
    'DB.use': 'Memory use',
    'Tooling.use': 'Tool use',
    'Scheduler.manage': 'Automation management',
    'TTS.use': 'Speech output',
    'STT.use': 'Speech input',
  }
  return labels[permission] ?? permission.replace(/^[A-Z]+\./, '').replace(/_/g, ' ')
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

function titleForConfigKey(keyPath: string): string {
  const last = keyPath.split('.').at(-1) ?? keyPath
  return last.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function descriptionForConfigKey(keyPath: string): string {
  if (keyPath.includes('.mesh_network.')) return 'Mesh network setting.'
  if (keyPath.includes('.webrtc.')) return 'Direct connection setting.'
  if (keyPath.includes('.signaling_mqtt.')) return 'Invite service setting.'
  return 'Pairing and authentication setting.'
}

function productConfigDescription(field: ConfigFieldMetadata): string {
  return field.description && !hasInternalCopy(field.description)
    ? field.description
    : descriptionForConfigKey(field.key_path)
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
    fallbackConfigField('services.gateway.mesh_network.enabled', 'Mesh enabled', 'Whether mesh routing is enabled.', 'boolean', status?.local.mesh_enabled ?? diagnostics?.mesh_enabled ?? null),
    fallbackConfigField('services.gateway.mesh_network.node_name', 'Node name', 'Local node name reported by Gateway.', 'string', status?.local.node_name ?? diagnostics?.local_node_name ?? null),
    fallbackConfigField('services.gateway.mesh_network.version_policy', 'Version policy', 'Device compatibility policy.', 'string', status?.local.version_policy ?? null),
    fallbackConfigField('services.gateway.mesh_network.peer_selection', 'Peer selection', 'Device selection strategy.', 'string', status?.local.peer_selection ?? null),
    fallbackConfigField('services.gateway.webrtc.enabled', 'Direct connections enabled', 'Whether direct connections are enabled.', 'boolean', diagnostics?.enabled ?? status?.local.webrtc_started ?? null),
    fallbackConfigField('services.gateway.webrtc.strategy', 'Invite service strategy', 'Invite service strategy.', 'string', diagnostics?.signaling.strategy ?? null),
    fallbackConfigField('services.gateway.webrtc.encrypt_signaling', 'Encrypt signaling', 'Whether signaling presence is encrypted.', 'boolean', diagnostics?.signaling.encrypted_presence ?? null),
    fallbackConfigField('services.gateway.webrtc.enable_app_layer_e2ee', 'Application E2EE', 'Whether app-layer peer encryption is enabled.', 'boolean', diagnostics?.app_layer_e2ee_enabled ?? null),
    fallbackConfigField('services.gateway.webrtc.legacy_event_broadcast', 'Event compatibility', 'Temporary compatibility for older approved devices.', 'boolean', null),
    fallbackConfigField('services.auth.webrtc_auth_timeout_seconds', 'Access timeout', 'Access timeout in seconds.', 'integer', diagnostics?.auth_timeout_seconds ?? null),
    fallbackConfigField('services.auth.webrtc_pairing_timeout_seconds', 'Pairing timeout', 'Pairing approval timeout in seconds.', 'integer', diagnostics?.pairing_timeout_seconds ?? null),
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
    source_layer: editable ? 'user' : 'service',
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
    const group = field.key_path.includes('.mesh_network.') ? 'Mesh network' : field.key_path.includes('.webrtc.') ? 'Direct connections' : field.key_path.includes('.signaling_mqtt.') ? 'Invite service' : 'Pairing and access'
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

function buildMeshPendingRequestRows(input: { persistedPeers: MeshPeerInfo[]; pendingPairings: PendingPairingEntry[]; status: MeshStatusResponse | null; diagnostics: WebRTCDiagnosticsResponse | null; mutationCapability: CapabilitySummary | null }): MeshPendingRequestRow[] {
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
    lifecycleLabel: runtime?.status ?? persisted?.connection_status ?? 'No recent status',
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
      return {
        methodId: AUTH_METHODS.pairingApprove,
        payload: {
          code: peer.pendingPairing.code,
          permissions: parseMeshPermissionList(input.permissions ?? ''),
          is_admin: false,
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

function meshPeerActionIdentity(peer: Pick<MeshPeerRow, 'peerId' | 'pendingPairing'>): string {
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

function meshSafeErrorTitle(error: unknown): string {
  return safeErrorCopy(error).title
}

function hasInternalCopy(value: string): boolean {
  return /\b(?:webrtc|gateway|transport|runtime|manifest|config|preview|schema|contract|fallback|provider|consumer|hybrid|sqlite|indexeddb|opfs|sidecar|thin|datachannel|signaling|room password)\b|(?:services|auth|gateway|config)\.[a-z0-9_.]+/iu.test(value)
}

function productConnectionState(value: string): string {
  if (/authorized|authenticated|approved|connected|ready/iu.test(value)) return 'Ready'
  if (/pending|pairing|connecting/iu.test(value)) return 'Waiting'
  if (/denied|failed|error|closed|stale|timeout/iu.test(value)) return 'Needs attention'
  return 'Checking'
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function isExpectedOfflineTransportMessage(value: string): boolean {
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

function responseDataOrNull<T>(result: PromiseSettledResult<{ ok: boolean; data?: T }>): T | null {
  return result.status === 'fulfilled' && result.value.ok ? (result.value.data ?? null) : null
}

function valueOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function skippedMeshAuthRead<T>(): Promise<{ ok: true; data?: T }> {
  return Promise.resolve({ ok: true })
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

function MeshVerificationCode({ value }: { value: string | null | undefined }) {
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

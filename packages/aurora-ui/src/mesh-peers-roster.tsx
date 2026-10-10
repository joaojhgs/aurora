import { Avatar, AvatarFallback } from '#components/ui/avatar'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Label } from '#components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '#components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '#components/ui/table'
import { Network, ShieldCheck, UsersRound, Wifi } from 'lucide-react'
import { useRef, useState } from 'react'
import type { AvailabilityState } from '@aurora/client'
import type { SelectedCandidatePairEvidence } from '@aurora/client/webrtc'
import type { BrowserDiscoveredDevice, BrowserWebRtcSnapshot } from './web-thin-runtime'
import { discoveredDeviceStateLabel } from './web-thin-connection-panel'
import { DetailItem, EmptyPanel, PermissionBadges, permissionSummary } from './mesh-peers-shared'
import { MeshVerificationCode, formatDate, formatRelative, meshPeerScopesEditable, peerInitials, productConnectionState } from './mesh-peers-model'
import type { MeshDeviceRow, MeshLiveSessionRow, MeshPeerRow, MeshPeersLoadState, MeshPeersSnapshot, MeshPendingRequestRow } from './mesh-peers-view'

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

export function MeshSummaryCards({ snapshot, pendingPeers }: { snapshot: MeshPeersSnapshot; pendingPeers: number }) {
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
    <div className="@container/mesh-summary">
      <div className="grid grid-cols-2 gap-3 @min-[42rem]/mesh-summary:grid-cols-4">
        {items.map((item) => (
          <Card key={item.label} size="sm" className="min-w-0">
            <CardHeader>
              <CardTitle className="flex items-start gap-2 text-xs leading-snug sm:text-sm">
                <item.icon className="size-4 shrink-0" /> {item.label}
              </CardTitle>
              <CardDescription className="text-[11px] leading-relaxed sm:text-xs">{item.detail}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="break-words text-lg leading-snug font-semibold sm:text-xl">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
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
export function DiscoveredDevicesCard({
  devices,
  knownPeerIds,
  onConnect,
}: {
  devices: readonly BrowserDiscoveredDevice[]
  knownPeerIds: readonly string[]
  onConnect?: (peerId: string) => void | Promise<void>
}) {
  const [pendingPeerIds, setPendingPeerIds] = useState<ReadonlySet<string>>(() => new Set())
  const pendingPeerIdsRef = useRef<Set<string>>(new Set())
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
            {onConnect && (device.state === 'new' || device.state === 'known') ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pendingPeerIds.has(device.peerId)}
                onClick={() => {
                  if (pendingPeerIdsRef.current.has(device.peerId)) return
                  pendingPeerIdsRef.current.add(device.peerId)
                  setPendingPeerIds(new Set(pendingPeerIdsRef.current))
                  void Promise.resolve()
                    .then(() => onConnect(device.peerId))
                    .catch(() => undefined)
                    .finally(() => {
                      pendingPeerIdsRef.current.delete(device.peerId)
                      setPendingPeerIds(new Set(pendingPeerIdsRef.current))
                  })
                }}
              >
                Set up
              </Button>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function PendingRequestsTable({ peers, pendingPeerId, onReview }: { peers: MeshPendingRequestRow[]; pendingPeerId: string | null; onReview: (requestId: string) => void }) {
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

export function PeerCardGrid({ peers, pendingPeerId, optimisticPeerId, onOpenDetails, onOpenScopes, onReview }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; onOpenDetails: (peerId: string) => void; onOpenScopes?: ((peerId: string) => void) | undefined; onReview: (peerId: string) => void }) {
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
  return typeof value === 'number' && Number.isFinite(value) && value > 0
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

export function PeerTable({ peers, pendingPeerId, optimisticPeerId, mutationDisabled, onOpenDetails, onOpenScopes, onApprove, onDeny, onRemove }: { peers: MeshPeerRow[]; pendingPeerId: string | null; optimisticPeerId: string | null; mutationDisabled: boolean; onOpenDetails: (peerId: string) => void; onOpenScopes?: ((peerId: string) => void) | undefined; onApprove: ((peer: MeshPeerRow) => void) | undefined; onDeny: ((peer: MeshPeerRow) => void) | undefined; onRemove: ((peer: MeshPeerRow) => void) | undefined }) {
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

export function PeerDetailSheet({
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

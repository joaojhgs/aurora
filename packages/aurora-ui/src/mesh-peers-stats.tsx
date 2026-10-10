import { AlertTriangle, GitBranch, Router } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card'
import type { AvailabilityState } from '@aurora/client'
import type { RouteAvailability } from './shell-data'
import { DetailItem, EmptyPanel, PermissionBadges } from './mesh-peers-shared'
import { formatDate, productConnectionState, sanitizeMeshDetail } from './mesh-peers-model'
import type { MeshDeviceRow, MeshLiveSessionRow, MeshPeersLoadState, MeshPeersSnapshot } from './mesh-peers-view'

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

function formatLatencyMs(latencyMs: number): string {
  return `${latencyMs.toFixed(1)} ms`
}

export function MeshRuntimeOverview({ snapshot, route, expanded = false }: { snapshot: MeshPeersSnapshot; route: RouteAvailability; expanded?: boolean }) {
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

export function LiveSessionsPanel({ sessions, fixtureOnly }: { sessions: MeshLiveSessionRow[]; fixtureOnly: boolean }) {
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
                <DetailItem label="Pairing" value={productConnectionState(session.pairingState)} />
                <DetailItem label="Linked device" value={session.linkedPeerState} />
                <DetailItem label="Details" value={fixtureOnly ? 'Sample data' : 'Available'} />
              </CardContent>
            </Card>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export function DevicesPanel({ devices, fixtureOnly }: { devices: MeshDeviceRow[]; fixtureOnly: boolean }) {
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

export function WarningsPanel({ snapshot }: { snapshot: MeshPeersSnapshot }) {
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
              <AlertTitle>Device detail</AlertTitle>
              <AlertDescription>{sanitizeMeshDetail(warning)}</AlertDescription>
            </Alert>
          ))
        )}
      </CardContent>
    </Card>
  )
}


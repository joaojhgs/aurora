import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Network, RadioTower, Wifi } from 'lucide-react'
import type { PeerPairingApproval } from '@aurora/client/webrtc'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Button } from '#components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Skeleton } from '#components/ui/skeleton'
import { PermissionEditorTable } from './shared-components'
import { type LocalFeatureSharingPort, type LocalShareableServiceScope, localFeatureIdsForServicePermissions, localShareableServiceScopes, localServicePermissionCatalog, selectedLocalServicePermissions } from './local-feature-sharing'
import { filterPairingFeatures } from './mesh-peers-data'
import { MeshVerificationCode } from './mesh-peers-model'
import type { BrowserWebRtcSnapshot } from './web-thin-runtime'

export function ThinPeerConnectionStatus({
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

export function ThinPeerPairingDialog({
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
  const approvalInFlight = useRef(new Set<string>())
  const activeApprovalSession = useRef<string | null>(null)
  const mounted = useRef(false)
  activeApprovalSession.current = open ? sessionId : null
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!open || !sessionId) return
    let active = true
    setFeatureLoadError(null)
    setConfirmError(null)
    setConfirmPending(approvalInFlight.current.has(sessionId))
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
    if (approvalInFlight.current.has(sessionId)) return
    approvalInFlight.current.add(sessionId)
    setConfirmPending(true)
    setConfirmError(null)
    try {
      const selected = localFeatureIdsForServicePermissions(serviceScopes, selectedPermissions)
      await onConfirm(sessionId, { sharedFeatureIds: selected })
      if (mounted.current && activeApprovalSession.current === sessionId) onOpenChange(false)
    } catch {
      if (mounted.current && activeApprovalSession.current === sessionId) {
        setConfirmError('Could not approve this device. Check the connection and try again.')
      }
    } finally {
      approvalInFlight.current.delete(sessionId)
      if (mounted.current && activeApprovalSession.current === sessionId) setConfirmPending(false)
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

export {
  DiscoveredDevicesCard,
  MeshSummaryCards,
  PeerCardGrid,
  PeerDetailSheet,
  PeerTable,
  PendingRequestsTable,
} from './mesh-peers-roster'

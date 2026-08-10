'use client'

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, FileUp, Link2, LockKeyhole, Network, QrCode, ShieldCheck, WifiOff } from 'lucide-react'
import {
  isBrowserWebRtcConfigured,
  parseWebRtcInvite,
  type BrowserWebRtcPeerController,
  type BrowserWebRtcSnapshot,
  type AuroraThinConnectionMode,
} from './web-thin-runtime'
import { type PeerPairingApproval, type WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import { getAuroraSurfaceProfile } from './platform-surface'
import type { ThinConnectionProfile } from './thin-connection-profile'
import { scanQrInviteWithBrowserCamera } from './browser-qr-scanner'
import { PRODUCT_COPY, productStatusCopy, safeErrorCopy } from './product-copy'
import {
  type LocalFeatureSharingPort,
  type LocalShareableServiceScope,
  localFeatureIdsForServicePermissions,
  localShareableServiceScopes,
  localServicePermissionCatalog,
  selectedLocalServicePermissions,
} from './local-feature-sharing'
import { PermissionEditorTable } from './shared-components'
import type { OnboardingProductModeId } from './onboarding-view'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field'
import { Input } from '#components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Textarea } from '#components/ui/textarea'

export type WebThinConnectionProfile = ThinConnectionProfile
export interface WebThinRoomSecret {
  roomSecretRef: string
  roomSecret: string
}

export interface WebThinConnectionPanelProps {
  peer: BrowserWebRtcPeerController
  mode: AuroraThinConnectionMode
  transportKind: string
  nativePlatform?: string | undefined
  initialInviteText?: string | null | undefined
  onInviteAccepted?: (profile: WebRtcPeerConnectionProfile, inviteText: string) => void | Promise<void>
  onScanQr?: () => Promise<string | null>
  configureOnly?: boolean | undefined
  profile?: WebThinConnectionProfile | undefined
  profiles?: WebThinConnectionProfile[] | undefined
  profileStoreEvidence?: string | undefined
  localFeatureSharing?: LocalFeatureSharingPort | undefined
  setupIntent?: OnboardingProductModeId | undefined
  onSaveProfile?: (
    profile: WebThinConnectionProfile,
    roomSecret?: WebThinRoomSecret,
  ) => Promise<void>
  onSelectProfile?: (profileId: string) => Promise<void>
}

export type HomeNodeConnectionPanelProps = WebThinConnectionPanelProps

export function HomeNodeConnectionPanel({
  peer,
  mode,
  transportKind,
  nativePlatform,
  initialInviteText = null,
  onInviteAccepted,
  onScanQr,
  configureOnly = false,
  profile,
  profiles = [],
  profileStoreEvidence,
  localFeatureSharing,
  setupIntent = 'connect-to-aurora',
  onSaveProfile,
  onSelectProfile,
}: WebThinConnectionPanelProps) {
  const [snapshot, setSnapshot] = useState<BrowserWebRtcSnapshot>(() => peer.snapshot())
  const [inviteText, setInviteText] = useState(initialInviteText ?? '')
  const [productError, setProductError] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const [invitePending, setInvitePending] = useState(false)
  const [availableServiceScopes, setAvailableServiceScopes] = useState<readonly LocalShareableServiceScope[]>([])
  const [selectedServicePermissions, setSelectedServicePermissions] = useState<string[]>([])
  const [sharedFeatureLoadError, setSharedFeatureLoadError] = useState<string | null>(null)
  const [pairingApprovalPending, setPairingApprovalPending] = useState(false)
  const approvedPairingSessionsRef = useMemo(() => new Map<string, number>(), [])
  const pairingApprovalInFlightRef = useMemo(() => new Set<string>(), [])
  const inviteFileRef = useRef<HTMLInputElement>(null)
  const normalizedInviteText = useMemo(() => inviteText.trim(), [inviteText])
  const surface = useMemo(() => getAuroraSurfaceProfile({
    runtimeMode: mode === 'http-only' ? 'web' : 'web-thin',
    transportKind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }), [mode, transportKind, nativePlatform])
  const makingThisDeviceAvailable = setupIntent === 'make-this-device-available'
  const [draftProfile, setDraftProfile] = useState<WebThinConnectionProfile | null>(
    () => profile ?? defaultProfileForSurface(surface),
  )
  const invite = useMemo(() => decodeMeshInvite(normalizedInviteText), [normalizedInviteText])
  const parsedInvite = useMemo(() => parseWebRtcInvite(normalizedInviteText), [normalizedInviteText])
  const summary = invite ? meshInviteSummary(invite) : null
  const mixedContentWarning = hostedMixedContentWarning(
    surface.kind,
    draftProfile,
    typeof window === 'undefined' ? null : window.location.protocol,
  )
  const configuredWebRtc = isBrowserWebRtcConfigured(snapshot)
  const configuredPeerOffline =
    configuredWebRtc
    && (snapshot.status === 'closed' || snapshot.status === 'failed')
  const peerLabel =
    snapshot.nodeName?.trim()
    || snapshot.expectedStablePeerId
    || 'Invited Aurora peer'
  const visibleDiagnostic =
    snapshot.diagnostic
    && (!configuredPeerOffline || !isExpectedOfflineDiagnostic(snapshot.diagnostic))
      ? productDiagnosticMessage(snapshot.diagnostic)
      : null
  const requiresSecureContext = !snapshot.secureContext
  const hasConnectableInvite = Boolean(parsedInvite)
  const connectDisabled = snapshot.status === 'disabled'
    || !hasConnectableInvite
    || requiresSecureContext
    || (configureOnly && !draftProfile?.nodeName.trim())
  useEffect(() => peer.subscribe(setSnapshot), [peer])
  useEffect(() => {
    if (initialInviteText) setInviteText(initialInviteText)
  }, [initialInviteText])
  useEffect(() => {
    let active = true
    const loadFeatures = async () => {
      if (!snapshot.pairingSessionId || !localFeatureSharing) {
        setAvailableServiceScopes([])
        setSelectedServicePermissions([])
        setSharedFeatureLoadError(null)
        return
      }
      try {
        const next = await localFeatureSharing.load()
        if (!active) return
        const scopes = localShareableServiceScopes(next)
        setAvailableServiceScopes(scopes)
        setSelectedServicePermissions(selectedLocalServicePermissions(next, scopes))
        setSharedFeatureLoadError(null)
      } catch {
        if (!active) return
        setAvailableServiceScopes([])
        setSelectedServicePermissions([])
        setSharedFeatureLoadError('This device’s sharing options are unavailable right now. Try again.')
      }
    }
    void loadFeatures()
    return () => {
      active = false
    }
  }, [localFeatureSharing, snapshot.pairingSessionId])
  useEffect(() => {
    setDraftProfile(profile ?? defaultProfileForSurface(surface))
  }, [profile, surface])

  const connectInvite = async () => {
    if (!invite) {
      setProductError('Paste a valid Aurora invite before continuing.')
      return
    }
    const nextParsedInvite = parsedInvite ?? parseWebRtcInvite(normalizedInviteText)
    if (!nextParsedInvite) {
      setProductError('This invite can’t be used to connect right now. Generate a fresh invite and try again.')
      return
    }
    setProductError(null)
    setInvitePending(true)
    try {
      const webRtcProfile = peer.importInvite(normalizedInviteText)
      if (
        nextParsedInvite.profile.roomSecretRef !== webRtcProfile.roomSecretRef
      ) {
        throw new Error('invalid_invite')
      }
      const currentProfile = draftProfile ?? defaultProfileForSurface(surface)
      const nextMode = currentProfile.mode === 'http-only'
        ? (currentProfile.gatewayUrl.trim() ? 'webrtc-preferred' : 'webrtc-only')
        : currentProfile.mode
      const nextProfile: WebThinConnectionProfile = {
        ...currentProfile,
        mode: nextMode,
        signalingUrl: currentProfile.signalingUrl.trim() || webRtcProfile.signalingBrokers[0] || '',
        webrtcProfile: {
          ...webRtcProfile,
          mode: nextMode,
          signalingBrokers: currentProfile.signalingUrl.trim()
            ? [currentProfile.signalingUrl.trim()]
            : webRtcProfile.signalingBrokers,
        },
      }
      await onSaveProfile?.(nextProfile, {
        roomSecretRef: webRtcProfile.roomSecretRef,
        roomSecret: nextParsedInvite.roomSecret,
      })
      await onInviteAccepted?.(webRtcProfile, normalizedInviteText)
      if (!configureOnly) await peer.connect(nextProfile.webrtcProfile)
    } catch (nextError) {
      setProductError(uiErrorMessage(nextError))
    } finally {
      setInvitePending(false)
    }
  }

  const openInviteFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setProductError(null)
    try {
      const text = await file.text()
      const trimmed = text.trim()
      if (!decodeMeshInvite(trimmed)) {
        throw new Error('invalid_invite')
      }
      setInviteText(trimmed)
    } catch (nextError) {
      setProductError(uiErrorMessage(nextError))
    }
  }

  const scanQr = async () => {
    if (invitePending) return
    setProductError(null)
    setInvitePending(true)
    try {
      const scanned = await (onScanQr ?? scanQrInviteWithBrowserCamera)()
      if (scanned) setInviteText(scanned.trim())
    } catch (nextError) {
      setProductError(uiErrorMessage(nextError))
    } finally {
      setInvitePending(false)
    }
  }

  const reconnect = async () => {
    setProductError(null)
    try {
      if (invite) {
        const profile = peer.importInvite(normalizedInviteText)
        await peer.connect(profile)
      } else {
        await peer.connect()
      }
    } catch (nextError) {
      setProductError(uiErrorMessage(nextError))
    }
  }

  const confirmPairing = async () => {
    if (!snapshot.pairingSessionId || !snapshot.pairingVerificationCode) return
    if (!snapshot.pairingSessionId) return
    const sessionId = snapshot.pairingSessionId
    if (pairingApprovalInFlightRef.has(sessionId) || approvedPairingSessionsRef.has(sessionId)) return
    setProductError(null)
    setPairingApprovalPending(true)
    pairingApprovalInFlightRef.add(sessionId)
    try {
      let sharedFeatureIdsToShare: string[] = []
      if (localFeatureSharing) {
        const requested = new Set(
          localFeatureIdsForServicePermissions(availableServiceScopes, selectedServicePermissions),
        )
        const featureSnapshot = await localFeatureSharing.load()
        const availableFeatures = featureSnapshot.features.filter((feature) => feature.available)
        const available = new Map(availableFeatures.map((feature) => [feature.id, feature]))
        for (const featureId of requested) {
          const feature = available.get(featureId)
          if (!feature?.available) {
            throw new Error('The selected services are no longer available. Review the selection and try again.')
          }
        }
        for (const featureId of requested) {
          const feature = available.get(featureId)
          if (feature && !feature.enabled) {
            await localFeatureSharing.setFeatureEnabled(featureId, true)
          }
        }
        sharedFeatureIdsToShare = availableFeatures
          .filter((feature) => requested.has(feature.id))
          .map((feature) => feature.id)
      }
      const approval: PeerPairingApproval = {
        sharedFeatureIds: sharedFeatureIdsToShare,
      }
      await peer.confirmPairing(sessionId, approval)
      approvedPairingSessionsRef.set(sessionId, Date.now())
    } catch (nextError) {
      setProductError(uiErrorMessage(nextError))
      if (localFeatureSharing) {
        try {
          const next = await localFeatureSharing.load()
          const scopes = localShareableServiceScopes(next)
          setAvailableServiceScopes(scopes)
          setSelectedServicePermissions(selectedLocalServicePermissions(next, scopes))
          setSharedFeatureLoadError(null)
        } catch {
          setAvailableServiceScopes([])
          setSelectedServicePermissions([])
          setSharedFeatureLoadError('This device’s sharing options are unavailable right now. Try again.')
        }
      }
    } finally {
      pairingApprovalInFlightRef.delete(sessionId)
      setPairingApprovalPending(false)
    }
  }

  useEffect(() => {
    const sessionId = snapshot.pairingSessionId
    if (!sessionId) {
      const now = Date.now()
      for (const [knownSessionId, approvedAt] of approvedPairingSessionsRef) {
        if (now - approvedAt > 65_000) approvedPairingSessionsRef.delete(knownSessionId)
      }
    } else if (!snapshot.pairingVerificationCode) {
      approvedPairingSessionsRef.delete(sessionId)
    }
  }, [snapshot.pairingSessionId, snapshot.pairingVerificationCode])

  const saveProfile = async () => {
    if (!draftProfile || !onSaveProfile) return
    setProfilePending(true)
    setProfileError(null)
    try {
      await onSaveProfile(draftProfile)
    } catch (nextError) {
      setProfileError(uiErrorMessage(nextError))
    } finally {
      setProfilePending(false)
    }
  }

  const selectProfile = async (profileId: string) => {
    if (!onSelectProfile || profileId === profile?.id) return
    setProfilePending(true)
    setProfileError(null)
    try {
      await onSelectProfile(profileId)
    } catch (nextError) {
      setProfileError(uiErrorMessage(nextError))
    } finally {
      setProfilePending(false)
    }
  }

  const newProfile = () => {
    const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}`
    setDraftProfile(defaultProfileForSurface(surface, suffix))
  }

  const toggleServicePermission = (permissionId: string) => {
    setSelectedServicePermissions((current) => {
      if (!current.includes(permissionId)) return [...current, permissionId]
      return current.filter((currentId) => currentId !== permissionId)
    })
  }

  if (configureOnly) {
    return (
      <Card
        aria-label={makingThisDeviceAvailable ? "Aurora device sharing setup" : "Aurora invite onboarding"}
        className="overflow-hidden border-border/80 bg-card/95 shadow-xl shadow-black/10"
        data-thin-invite-onboarding="true"
      >
        <CardContent className="aui-webthin-invite-card-content flex flex-col gap-5 p-5 sm:p-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="webthin-profile-node-name">
                {PRODUCT_COPY.onboarding.invite.deviceName}
              </FieldLabel>
              <Input
                id="webthin-profile-node-name"
                value={draftProfile?.nodeName ?? ''}
                onChange={(event) => setDraftProfile({
                  ...(draftProfile ?? defaultProfileForSurface(surface)),
                  nodeName: event.currentTarget.value,
                })}
                disabled={profilePending || invitePending}
                autoComplete="off"
                placeholder="Kitchen tablet"
              />
              <FieldDescription>
                The name other Aurora devices will see.
              </FieldDescription>
            </Field>

            <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5">
              <p className="text-sm font-medium">
                {makingThisDeviceAvailable ? 'Add setup invite' : PRODUCT_COPY.onboarding.invite.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {makingThisDeviceAvailable
                  ? 'Use an invite from the Aurora device that will approve what this device shares.'
                  : 'Use the invite created by the Aurora device you want to use.'}
              </p>
              <input
                ref={inviteFileRef}
                type="file"
                accept=".aurora,.txt,.json,text/plain,application/json,application/vnd.aurora.context+json"
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => void openInviteFile(event)}
              />
              <div
                className={`mt-3 grid gap-2 ${surface.isMobile ? 'grid-cols-2' : 'grid-cols-1'}`}
              >
                {surface.isMobile ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-10"
                    onClick={() => void scanQr()}
                    disabled={invitePending}
                  >
                    <QrCode size={16} aria-hidden /> {PRODUCT_COPY.onboarding.invite.scan}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-10"
                  onClick={() => inviteFileRef.current?.click()}
                  disabled={invitePending}
                >
                  <FileUp size={16} aria-hidden /> {PRODUCT_COPY.onboarding.invite.openFile}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-border" />
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                or
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <Field>
              <FieldLabel htmlFor="webthin-invite">
                {PRODUCT_COPY.onboarding.invite.paste}
              </FieldLabel>
              <Textarea
                id="webthin-invite"
                value={inviteText}
                onChange={(event) => setInviteText(event.currentTarget.value)}
                placeholder="aurora://mesh/invite?…"
                rows={3}
                spellCheck={false}
                className="aui-webthin-invite-textarea min-h-24 resize-y font-mono text-xs"
              />
            </Field>
          </FieldGroup>

          {summary ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3"
              aria-label="Invite details"
            >
              <CheckCircle2
                className="shrink-0 text-primary"
                size={18}
                aria-hidden
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  Invite from {summary.nodeName}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {summary.room} · {summary.brokerCount} connection option
                  {summary.brokerCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          ) : null}

          {requiresSecureContext ? (
            <Alert variant="destructive">
              <AlertTriangle size={16} aria-hidden />
              <AlertTitle>Secure connection needed</AlertTitle>
              <AlertDescription>
                Open Aurora from HTTPS, localhost, or the desktop app before joining.
              </AlertDescription>
            </Alert>
          ) : null}
          {snapshot.status === 'disabled' ? (
            <Alert>
              <WifiOff size={16} aria-hidden />
              <AlertTitle>Connection unavailable</AlertTitle>
              <AlertDescription>
                This device cannot use an invite right now.
              </AlertDescription>
            </Alert>
          ) : null}
          {snapshot.persistenceFallbackReason ? (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              {PRODUCT_COPY.localData.temporary}
            </p>
          ) : null}
          {productError ? (
            <p role="alert" className="text-sm text-destructive">
              {productError}
            </p>
          ) : null}

          <Button
            type="button"
            className="aui-webthin-invite-action h-auto min-h-11 w-full"
            disabled={connectDisabled || invitePending}
            onClick={() => void connectInvite()}
          >
            {invitePending
              ? PRODUCT_COPY.onboarding.invite.saving
              : makingThisDeviceAvailable
                ? 'Save device setup'
                : PRODUCT_COPY.onboarding.invite.continue}
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
            {makingThisDeviceAvailable
              ? 'Sharing details come from the invite. You can edit device settings later.'
              : 'Connection details come from the invite. You can edit address settings later.'}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card aria-label={PRODUCT_COPY.connection.panelTitle} className="border-dashed">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Network size={18} aria-hidden /> {PRODUCT_COPY.connection.panelTitle}</CardTitle>
            <CardDescription>
              Connection details come from the saved Aurora invite and can be changed later.
            </CardDescription>
          </div>
          <Badge variant={snapshot.status === 'authorized' ? 'default' : 'outline'}>
            {configuredPeerOffline ? 'Offline' : connectionStatusLabel(snapshot.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {draftProfile && onSaveProfile ? (
          <FieldGroup aria-label="Saved connection profile">
            {onSelectProfile && profiles.length > 0 ? <Field orientation="horizontal">
              <FieldLabel htmlFor="webthin-profile-select">Saved profile</FieldLabel>
              <Select
                value={profile?.id ?? draftProfile.id}
                onValueChange={(value) => typeof value === 'string' && void selectProfile(value)}
                disabled={profilePending}
              >
                <SelectTrigger id="webthin-profile-select" className="w-full">
                  <SelectValue placeholder="Select profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {profiles.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>{candidate.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field> : null}
            <Field>
              <FieldLabel htmlFor="webthin-profile-label">Profile name</FieldLabel>
              <Input id="webthin-profile-label" value={draftProfile.label} onChange={(event) => setDraftProfile({ ...draftProfile, label: event.currentTarget.value })} disabled={profilePending} />
            </Field>
            <Field>
              <FieldLabel htmlFor="webthin-profile-mode">{PRODUCT_COPY.connection.methodLabel}</FieldLabel>
              <Select
                value={draftProfile.mode}
                onValueChange={(value) => typeof value === 'string' && setDraftProfile({ ...draftProfile, mode: value as AuroraThinConnectionMode })}
                disabled={profilePending}
              >
                <SelectTrigger id="webthin-profile-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="http-only">HTTP only</SelectItem>
                    <SelectItem value="webrtc-only">WebRTC only</SelectItem>
                    <SelectItem value="webrtc-preferred">WebRTC preferred</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field data-disabled={draftProfile.mode === 'webrtc-only' || undefined}>
              <FieldLabel htmlFor="webthin-profile-gateway">{PRODUCT_COPY.connection.addressLabel}</FieldLabel>
              <Input id="webthin-profile-gateway" type="url" value={draftProfile.gatewayUrl} onChange={(event) => setDraftProfile({ ...draftProfile, gatewayUrl: event.currentTarget.value })} disabled={profilePending || draftProfile.mode === 'webrtc-only'} autoComplete="off" />
            </Field>
            <Field data-disabled={draftProfile.mode === 'http-only' || undefined}>
              <FieldLabel htmlFor="webthin-profile-signaling">Invite service address</FieldLabel>
              <Input id="webthin-profile-signaling" type="url" value={draftProfile.signalingUrl} onChange={(event) => setDraftProfile({ ...draftProfile, signalingUrl: event.currentTarget.value })} disabled={profilePending || draftProfile.mode === 'http-only'} autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="webthin-profile-node-name">{PRODUCT_COPY.onboarding.invite.deviceName}</FieldLabel>
              <Input id="webthin-profile-node-name" value={draftProfile.nodeName} onChange={(event) => setDraftProfile({ ...draftProfile, nodeName: event.currentTarget.value })} disabled={profilePending} autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="webthin-profile-stable-peer">Device ID</FieldLabel>
              <Input id="webthin-profile-stable-peer" value={draftProfile.localStablePeerId} onChange={(event) => setDraftProfile({ ...draftProfile, localStablePeerId: event.currentTarget.value })} disabled={profilePending} autoComplete="off" />
              <FieldDescription>Only address and device details are saved here.</FieldDescription>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void saveProfile()} disabled={profilePending}>{profilePending ? 'Saving…' : 'Save and use profile'}</Button>
              <Button type="button" variant="outline" onClick={newProfile} disabled={profilePending}>New profile</Button>
            </div>
            {profileError ? <p role="alert" className="text-sm text-destructive">{profileError}</p> : null}
          </FieldGroup>
        ) : null}
        {mixedContentWarning ? (
          <Alert>
            <AlertTriangle size={16} aria-hidden />
            <AlertTitle>Address blocked</AlertTitle>
            <AlertDescription>{mixedContentWarning}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-2 text-sm md:grid-cols-3" aria-label="Connection status">
          <Diagnostic icon={<ShieldCheck size={15} aria-hidden />} label="Secure connection" value={snapshot.secureContext ? 'Ready' : 'Needed'} />
          <Diagnostic icon={<Link2 size={15} aria-hidden />} label="Address backup" value={mode === 'webrtc-only' ? 'Not set' : snapshot.hasHttpFallback ? 'Available' : 'Not set'} />
          <Diagnostic
            icon={<LockKeyhole size={15} aria-hidden />}
            label="Saved info"
            value={snapshot.secretsPersisted ? PRODUCT_COPY.localData.saved : PRODUCT_COPY.localData.temporary}
          />
        </div>
        {!snapshot.secureContext ? (
          <Alert variant="destructive">
            <AlertTriangle size={16} aria-hidden />
            <AlertTitle>Secure connection needed</AlertTitle>
            <AlertDescription>Open Aurora from a secure page, localhost, or the desktop app before joining.</AlertDescription>
          </Alert>
        ) : null}
        {snapshot.status === 'disabled' ? (
          <Alert>
            <WifiOff size={16} aria-hidden />
            <AlertTitle>Connection unavailable</AlertTitle>
            <AlertDescription>This device cannot use an invite right now.</AlertDescription>
          </Alert>
        ) : null}
        {configuredPeerOffline ? (
          <Alert role="status">
            <WifiOff size={16} aria-hidden />
            <AlertTitle>{peerLabel} is offline</AlertTitle>
            <AlertDescription>
              Aurora will retry the saved device. Trusted devices stay visible while they reconnect.
            </AlertDescription>
          </Alert>
        ) : null}
        {snapshot.fallbackReason && snapshot.status === 'fallback-http' ? (
          <Alert>
            <WifiOff size={16} aria-hidden />
            <AlertTitle>{PRODUCT_COPY.connection.connected}</AlertTitle>
            <AlertDescription>Aurora is connected with the saved address.</AlertDescription>
          </Alert>
        ) : null}
        {snapshot.pairingVerificationCode ? (
          <Alert>
            <CheckCircle2 size={16} aria-hidden />
            <AlertTitle>Compare this code on both devices</AlertTitle>
            <AlertDescription>
              Verification code <strong className="font-mono">{snapshot.pairingVerificationCode}</strong>. Confirm only if the same code appears on the other device.
            </AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor="webthin-invite">{PRODUCT_COPY.onboarding.invite.paste}</FieldLabel>
          <Textarea
            id="webthin-invite"
            value={inviteText}
            onChange={(event) => setInviteText(event.currentTarget.value)}
            placeholder="Paste aurora://mesh/invite?... or amv1.…"
            rows={4}
            spellCheck={false}
            className="aui-webthin-invite-textarea font-mono text-xs"
          />
            <FieldDescription>
            Sensitive invite details are saved privately when this device supports it.
          </FieldDescription>
        </Field>
        <input
          ref={inviteFileRef}
          type="file"
          accept=".aurora,.txt,.json,text/plain,application/json,application/vnd.aurora.context+json"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => void openInviteFile(event)}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => void scanQr()} disabled={invitePending}>
            <QrCode size={15} aria-hidden /> {PRODUCT_COPY.onboarding.invite.scan}
          </Button>
          <Button type="button" variant="outline" onClick={() => inviteFileRef.current?.click()} disabled={invitePending}>
            <FileUp size={15} aria-hidden /> {PRODUCT_COPY.onboarding.invite.openFile}
          </Button>
        </div>
        {summary ? (
          <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-2" aria-label="Invite details">
            <div><dt className="text-muted-foreground">Device</dt><dd>{summary.nodeName}</dd></div>
            <div><dt className="text-muted-foreground">Room</dt><dd>{summary.room}</dd></div>
            <div><dt className="text-muted-foreground">Invite service</dt><dd>{summary.signalingProvider} · {summary.brokerCount} address{summary.brokerCount === 1 ? '' : 'es'}</dd></div>
            <div><dt className="text-muted-foreground">Sensitive details</dt><dd>{summary.includesPassword ? (snapshot.secretsPersisted ? PRODUCT_COPY.localData.saved : PRODUCT_COPY.localData.temporary) : 'Invite is incomplete'}</dd></div>
          </dl>
        ) : null}
        {snapshot.persistenceFallbackReason ? (
          <p role="status" className="text-xs text-muted-foreground">
            {PRODUCT_COPY.localData.temporary}
          </p>
        ) : null}
        {productError ?? visibleDiagnostic ? <p role="alert" className="text-sm text-destructive">{productError ?? visibleDiagnostic}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {snapshot.pairingSessionId && surface.isMobile ? (
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
            <p className="text-sm font-medium">
              Confirm this connection to pair this Aurora with the invited device.
            </p>
            <p className="text-xs text-muted-foreground">
              Scopes are based on what this device can safely share.
            </p>
          </div>
        ) : null}
        {snapshot.pairingSessionId && !localFeatureSharing && !surface.isMobile ? (
          <Button
            type="button"
            variant="outline"
            disabled={!snapshot.pairingVerificationCode || pairingApprovalPending}
            onClick={() => void confirmPairing()}
          >
            Approve connection
          </Button>
        ) : null}
        {snapshot.pairingSessionId && localFeatureSharing ? (
          <div className="flex w-full flex-col gap-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium">Choose what {snapshot.nodeName || 'the connected Aurora'} can use from this device</p>
              <p className="text-xs text-muted-foreground">Only services available on this device are shown. You can change this later.</p>
            </div>
            {sharedFeatureLoadError ? <p role="alert" className="text-xs text-destructive">{sharedFeatureLoadError}</p> : null}
            {!sharedFeatureLoadError && availableServiceScopes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No services are available to share. You can still pair the devices.</p>
            ) : null}
            {availableServiceScopes.length > 0 ? (
              <PermissionEditorTable
                catalog={localServicePermissionCatalog(availableServiceScopes)}
                checked={Object.fromEntries(selectedServicePermissions.map((permission) => [permission, true]))}
                roleTemplate="custom"
                showRoleTemplates={false}
                showPermissionIds={false}
                onSelectRoleTemplate={() => undefined}
                onToggle={toggleServicePermission}
              />
            ) : null}
          </div>
        ) : null}
        {snapshot.pairingSessionId && !snapshot.pairingVerificationCode ? (
          <p role="alert" className="w-full text-sm text-destructive">This connection cannot be approved safely. Try again.</p>
        ) : null}
        {snapshot.pairingSessionId && (localFeatureSharing || surface.isMobile) ? (
          <Button
            type="button"
            variant="outline"
            disabled={!snapshot.pairingVerificationCode || pairingApprovalPending || invitePending || Boolean(sharedFeatureLoadError)}
            onClick={() => void confirmPairing()}
          >
            {pairingApprovalPending ? 'Approving…' : 'Approve connection'}
          </Button>
        ) : null}
        <Button type="button" disabled={connectDisabled || invitePending || pairingApprovalPending} onClick={() => void connectInvite()}>
          {invitePending ? PRODUCT_COPY.onboarding.invite.saving : configureOnly ? PRODUCT_COPY.onboarding.invite.continue : PRODUCT_COPY.connection.useInvite}
        </Button>
        {!configureOnly ? <Button type="button" variant="outline" disabled={mode === 'http-only' || requiresSecureContext} onClick={() => void reconnect()}>{PRODUCT_COPY.connection.reconnect}</Button> : null}
        {!configureOnly ? <Button type="button" variant="ghost" onClick={() => void peer.disconnect('disconnect')}>{PRODUCT_COPY.connection.disconnect}</Button> : null}
      </CardFooter>
    </Card>
  )
}

export const WebThinConnectionPanel = HomeNodeConnectionPanel

function defaultProfileForSurface(
  surface: ReturnType<typeof getAuroraSurfaceProfile>,
  suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}`,
): WebThinConnectionProfile {
  const surfaceLabel = surface.isAndroid
    ? 'Android device'
    : surface.isIos
      ? 'iOS device'
      : surface.isMobile
        ? 'Mobile device'
        : surface.kind === 'web'
          ? 'Hosted web'
          : 'Desktop device'
  const nodeName = `Aurora ${surfaceLabel.toLowerCase()}`
  return {
    id: `profile-${suffix}`,
    label: surfaceLabel,
    mode: 'http-only',
    gatewayUrl: '',
    signalingUrl: '',
    nodeName,
    localStablePeerId: `aurora-thin-${suffix}`,
  }
}

function Diagnostic({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background/60 px-2.5 py-2">
      {icon}
      <span className="min-w-0"><strong className="block text-xs">{label}</strong><small className="text-muted-foreground">{value}</small></span>
    </div>
  )
}

export function hostedMixedContentWarning(
  surfaceKind: ReturnType<typeof getAuroraSurfaceProfile>['kind'],
  profile: WebThinConnectionProfile | null,
  pageProtocol: string | null,
): string | null {
  if (
    surfaceKind !== 'web'
    || pageProtocol !== 'https:'
    || !profile
  ) {
    return null
  }
  const insecureGateway =
    profile.mode !== 'webrtc-only' && /^http:\/\//iu.test(profile.gatewayUrl.trim())
  const insecureSignaling =
    profile.mode !== 'http-only' && /^ws:\/\//iu.test(profile.signalingUrl.trim())
  if (!insecureGateway && !insecureSignaling) return null
  return 'This page cannot use that address. Use a secure address, localhost, or the desktop app.'
}

function uiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === 'invalid_invite') {
    return productStatusCopy('item-read-failed').title
  }
  return safeErrorCopy(error).title
}

function productDiagnosticMessage(value: string): string {
  const diagnostic = redactUiDiagnostic(value)
  if (/secure|https|localhost/iu.test(diagnostic)) {
    return 'Open Aurora from a secure page, localhost, or the desktop app before joining.'
  }
  if (/invite|profile|room|pair/iu.test(diagnostic)) {
    return 'Add a valid Aurora invite before connecting.'
  }
  if (/offline|closed|failed|not connected|unavailable|transport|runtime|thin|webrtc|datachannel|signaling|fallback/iu.test(diagnostic)) {
    return productStatusCopy('connection-failed').title
  }
  return productStatusCopy('connection-failed').title
}

function connectionStatusLabel(status: BrowserWebRtcSnapshot['status']): string {
  switch (status) {
    case 'authorized':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'pairing':
      return 'Waiting for approval'
    case 'idle':
      return 'Ready'
    case 'closed':
    case 'failed':
      return 'Offline'
    case 'disabled':
      return 'Unavailable'
    case 'needs-invite':
      return 'Needs invite'
    case 'fallback-http':
      return 'Connected'
    default:
      return 'Checking'
  }
}

function redactUiDiagnostic(value: string): string {
  return value
    .replace(/"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;<>"']+/gi, '$1$2[redacted]')
    .replace(/\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)\b(\s*[:=]\s*)(["']?)[^\s,;<>"']+/gi, '$1$2$3[redacted]')
    .replace(/([?&](?:(?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
}

function isExpectedOfflineDiagnostic(value: string): boolean {
  return /webrtc mesh transport is not connected|transport datachannel not connected|preferred-mode fallback is unavailable/i.test(value)
}

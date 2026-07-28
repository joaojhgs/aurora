'use client'

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, FileUp, Link2, LockKeyhole, Network, QrCode, ShieldCheck, WifiOff } from 'lucide-react'
import {
  parseWebRtcInvite,
  type BrowserWebRtcPeerController,
  type BrowserWebRtcSnapshot,
  type AuroraThinConnectionMode,
} from './web-thin-runtime'
import type { WebRtcPeerConnectionProfile } from '@aurora/client/webrtc'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import { getAuroraSurfaceProfile } from './platform-surface'
import type { ThinConnectionProfile } from './thin-connection-profile'
import { scanQrInviteWithBrowserCamera } from './browser-qr-scanner'
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
  onSaveProfile?: (
    profile: WebThinConnectionProfile,
    roomSecret?: WebThinRoomSecret,
  ) => Promise<void>
  onSelectProfile?: (profileId: string) => Promise<void>
}

export function WebThinConnectionPanel({
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
  onSaveProfile,
  onSelectProfile,
}: WebThinConnectionPanelProps) {
  const [snapshot, setSnapshot] = useState<BrowserWebRtcSnapshot>(() => peer.snapshot())
  const [inviteText, setInviteText] = useState(initialInviteText ?? '')
  const [error, setError] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profilePending, setProfilePending] = useState(false)
  const [invitePending, setInvitePending] = useState(false)
  const inviteFileRef = useRef<HTMLInputElement>(null)
  const surface = useMemo(() => getAuroraSurfaceProfile({
    runtimeMode: mode === 'http-only' ? 'web' : 'web-thin',
    transportKind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }), [mode, transportKind, nativePlatform])
  const [draftProfile, setDraftProfile] = useState<WebThinConnectionProfile | null>(
    () => profile ?? defaultProfileForSurface(surface),
  )
  const invite = useMemo(() => decodeMeshInvite(inviteText), [inviteText])
  const summary = invite ? meshInviteSummary(invite) : null
  const mixedContentWarning = hostedMixedContentWarning(
    surface.kind,
    draftProfile,
    typeof window === 'undefined' ? null : window.location.protocol,
  )
  const connectDisabled = (!configureOnly && mode === 'http-only')
    || snapshot.status === 'disabled'
    || !invite
    || !snapshot.secureContext
    || (configureOnly && !draftProfile?.nodeName.trim())
  useEffect(() => peer.subscribe(setSnapshot), [peer])
  useEffect(() => {
    if (initialInviteText) setInviteText(initialInviteText)
  }, [initialInviteText])
  useEffect(() => {
    setDraftProfile(profile ?? defaultProfileForSurface(surface))
  }, [profile, surface])

  const connectInvite = async () => {
    if (!invite) {
      setError('Paste a valid Aurora mesh invite before connecting WebRTC thin mode.')
      return
    }
    setError(null)
    setInvitePending(true)
    try {
      const webRtcProfile = peer.importInvite(inviteText)
      const parsedInvite = parseWebRtcInvite(inviteText)
      if (
        !parsedInvite
        || parsedInvite.profile.roomSecretRef !== webRtcProfile.roomSecretRef
      ) {
        throw new Error('Aurora invite room-secret metadata is invalid.')
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
          nodeName: currentProfile.nodeName,
          signalingBrokers: currentProfile.signalingUrl.trim()
            ? [currentProfile.signalingUrl.trim()]
            : webRtcProfile.signalingBrokers,
        },
      }
      await onSaveProfile?.(nextProfile, {
        roomSecretRef: webRtcProfile.roomSecretRef,
        roomSecret: parsedInvite.roomSecret,
      })
      await onInviteAccepted?.(webRtcProfile, inviteText)
      if (!configureOnly) await peer.connect(nextProfile.webrtcProfile)
    } catch (nextError) {
      setError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setInvitePending(false)
    }
  }

  const openInviteFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setError(null)
    try {
      const text = await file.text()
      if (!decodeMeshInvite(text)) {
        throw new Error('The selected file does not contain a valid Aurora invite.')
      }
      setInviteText(text)
    } catch (nextError) {
      setError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
    }
  }

  const scanQr = async () => {
    if (invitePending) return
    setError(null)
    setInvitePending(true)
    try {
      const scanned = await (onScanQr ?? scanQrInviteWithBrowserCamera)()
      if (scanned) setInviteText(scanned)
    } catch (nextError) {
      setError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
    } finally {
      setInvitePending(false)
    }
  }

  const reconnect = async () => {
    setError(null)
    try {
      if (invite) {
        const profile = peer.importInvite(inviteText)
        await peer.connect(profile)
      } else {
        await peer.connect()
      }
    } catch (nextError) {
      setError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
    }
  }

  const saveProfile = async () => {
    if (!draftProfile || !onSaveProfile) return
    setProfilePending(true)
    setProfileError(null)
    try {
      await onSaveProfile(draftProfile)
    } catch (nextError) {
      setProfileError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
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
      setProfileError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
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

  if (configureOnly) {
    return (
      <Card
        aria-label="Aurora invite onboarding"
        className="overflow-hidden border-border/80 bg-card/95 shadow-xl shadow-black/10"
        data-thin-invite-onboarding="true"
      >
        <CardContent className="flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex items-start gap-3.5">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-primary">
              <Network size={19} aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">
                Join an Aurora node
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Your invite supplies signaling and connection details
                automatically.
              </p>
            </div>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="webthin-profile-node-name">
                Node name
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
                The name other Aurora devices will see for this client.
              </FieldDescription>
            </Field>

            <div className="rounded-xl border border-border/80 bg-muted/20 p-3.5">
              <p className="text-sm font-medium">Add your invite</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Use the invite created by the Aurora node you want to connect
                to.
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
                    <QrCode size={16} aria-hidden /> Scan QR invite
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-10"
                  onClick={() => inviteFileRef.current?.click()}
                  disabled={invitePending}
                >
                  <FileUp size={16} aria-hidden /> Open invite file
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
                Paste mesh invite
              </FieldLabel>
              <Textarea
                id="webthin-invite"
                value={inviteText}
                onChange={(event) => setInviteText(event.currentTarget.value)}
                placeholder="aurora://mesh/invite?…"
                rows={3}
                spellCheck={false}
                className="min-h-24 resize-y font-mono text-xs"
              />
            </Field>
          </FieldGroup>

          {summary ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3"
              aria-label="Invite preview"
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
                  {summary.room} · {summary.brokerCount} signaling broker
                  {summary.brokerCount === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          ) : null}

          {!snapshot.secureContext ? (
            <Alert variant="destructive">
              <AlertTriangle size={16} aria-hidden />
              <AlertTitle>Secure context required</AlertTitle>
              <AlertDescription>
                Use HTTPS, localhost, or a trusted native WebView to join with
                WebRTC.
              </AlertDescription>
            </Alert>
          ) : null}
          {snapshot.status === 'disabled' ? (
            <Alert>
              <WifiOff size={16} aria-hidden />
              <AlertTitle>WebRTC is unavailable</AlertTitle>
              <AlertDescription>
                {snapshot.diagnostic ?? 'This client cannot import a mesh invite right now.'}
              </AlertDescription>
            </Alert>
          ) : null}
          {snapshot.persistenceFallbackReason ? (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              Secure persistent storage is unavailable; this connection will
              remain in memory only. {snapshot.persistenceFallbackReason}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button
            type="button"
            className="h-auto min-h-11 w-full"
            disabled={connectDisabled || invitePending}
            onClick={() => void connectInvite()}
          >
            {invitePending ? 'Saving…' : 'Save invite and continue'}
          </Button>
          <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
            Connection details come from the invite. You can edit advanced
            transport settings later.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card aria-label="WebRTC thin-shell connection" className="border-dashed">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Network size={18} aria-hidden /> Thin-shell transport</CardTitle>
            <CardDescription>
              {surface.label} · {mode}. Configure HTTP Gateway and WebRTC signaling at runtime; no build-time endpoint or Python sidecar is required for thin mode.
              {' '}WebRTC uses the browser/WebView RTCPeerConnection path; no Rust transport or Python sidecar is claimed here.
            </CardDescription>
          </div>
          <Badge variant={snapshot.status === 'authorized' ? 'default' : 'outline'}>{snapshot.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {draftProfile && onSaveProfile ? (
          <FieldGroup aria-label="Thin connection profile">
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
              <FieldLabel htmlFor="webthin-profile-mode">Connection mode</FieldLabel>
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
              <FieldLabel htmlFor="webthin-profile-gateway">HTTP Gateway endpoint</FieldLabel>
              <Input id="webthin-profile-gateway" type="url" value={draftProfile.gatewayUrl} onChange={(event) => setDraftProfile({ ...draftProfile, gatewayUrl: event.currentTarget.value })} disabled={profilePending || draftProfile.mode === 'webrtc-only'} autoComplete="off" />
            </Field>
            <Field data-disabled={draftProfile.mode === 'http-only' || undefined}>
              <FieldLabel htmlFor="webthin-profile-signaling">WebSocket signaling endpoint</FieldLabel>
              <Input id="webthin-profile-signaling" type="url" value={draftProfile.signalingUrl} onChange={(event) => setDraftProfile({ ...draftProfile, signalingUrl: event.currentTarget.value })} disabled={profilePending || draftProfile.mode === 'http-only'} autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="webthin-profile-node-name">Node name</FieldLabel>
              <Input id="webthin-profile-node-name" value={draftProfile.nodeName} onChange={(event) => setDraftProfile({ ...draftProfile, nodeName: event.currentTarget.value })} disabled={profilePending} autoComplete="off" />
            </Field>
            <Field>
              <FieldLabel htmlFor="webthin-profile-stable-peer">Stable peer ID</FieldLabel>
              <Input id="webthin-profile-stable-peer" value={draftProfile.localStablePeerId} onChange={(event) => setDraftProfile({ ...draftProfile, localStablePeerId: event.currentTarget.value })} disabled={profilePending} autoComplete="off" />
              <FieldDescription>{profileStoreEvidence ?? 'Only nonsecret endpoint and stable peer metadata are persisted.'}</FieldDescription>
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
            <AlertTitle>Hosted HTTPS transport restriction</AlertTitle>
            <AlertDescription>{mixedContentWarning}</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-2 text-sm md:grid-cols-3" aria-label="Thin transport diagnostics">
          <Diagnostic icon={<ShieldCheck size={15} aria-hidden />} label="Secure context" value={snapshot.secureContext ? 'ready' : 'required'} />
          <Diagnostic icon={<Link2 size={15} aria-hidden />} label="Fallback" value={mode === 'webrtc-only' ? 'disabled' : snapshot.hasHttpFallback ? 'HTTP available' : 'none'} />
          <Diagnostic
            icon={<LockKeyhole size={15} aria-hidden />}
            label="Secrets"
            value={snapshot.secretsPersisted ? `${snapshot.persistenceBackend ?? 'persistent vault'} (encrypted)` : 'memory-only fallback'}
          />
        </div>
        {!snapshot.secureContext ? (
          <Alert variant="destructive">
            <AlertTriangle size={16} aria-hidden />
            <AlertTitle>Secure context required</AlertTitle>
            <AlertDescription>Use HTTPS, localhost, or a trusted native WebView before enabling browser WebRTC and microphone capture.</AlertDescription>
          </Alert>
        ) : null}
        {snapshot.status === 'disabled' ? (
          <Alert>
            <WifiOff size={16} aria-hidden />
            <AlertTitle>WebRTC rollout disabled</AlertTitle>
            <AlertDescription>{snapshot.diagnostic ?? 'HTTP and desktop-local modes remain available.'}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot.fallbackReason ? (
          <Alert>
            <WifiOff size={16} aria-hidden />
            <AlertTitle>HTTP fallback active</AlertTitle>
            <AlertDescription>{snapshot.fallbackReason}</AlertDescription>
          </Alert>
        ) : null}
        {snapshot.pairingVerificationCode ? (
          <Alert>
            <CheckCircle2 size={16} aria-hidden />
            <AlertTitle>Compare SAS on both devices</AlertTitle>
            <AlertDescription>
              Verification code <strong className="font-mono">{snapshot.pairingVerificationCode}</strong>. Confirm only if the same code is shown on the Aurora host.
            </AlertDescription>
          </Alert>
        ) : null}
        <Field>
          <FieldLabel htmlFor="webthin-invite">Mesh invite / deep link</FieldLabel>
          <Textarea
            id="webthin-invite"
            value={inviteText}
            onChange={(event) => setInviteText(event.currentTarget.value)}
            placeholder="Paste aurora://mesh/invite?... or amv1.…"
            rows={4}
            spellCheck={false}
          />
            <FieldDescription>
            Invite secrets are removed from the URL. Native shells persist them in the platform credential store; hosted web encrypts them in IndexedDB when WebCrypto is available and otherwise reports a memory-only fallback.
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
            <QrCode size={15} aria-hidden /> Scan QR invite
          </Button>
          <Button type="button" variant="outline" onClick={() => inviteFileRef.current?.click()} disabled={invitePending}>
            <FileUp size={15} aria-hidden /> Open invite file
          </Button>
        </div>
        {summary ? (
          <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-2" aria-label="Invite preview">
            <div><dt className="text-muted-foreground">Node</dt><dd>{summary.nodeName}</dd></div>
            <div><dt className="text-muted-foreground">Room</dt><dd>{summary.room}</dd></div>
            <div><dt className="text-muted-foreground">Signaling</dt><dd>{summary.signalingProvider} · {summary.brokerCount} broker(s)</dd></div>
            <div><dt className="text-muted-foreground">Secret handling</dt><dd>{summary.includesPassword ? (snapshot.secretsPersisted ? 'encrypted browser vault' : 'memory-only fallback') : 'missing secret'}</dd></div>
          </dl>
        ) : null}
        {snapshot.persistenceFallbackReason ? (
          <p role="status" className="text-xs text-muted-foreground">
            Persistent browser vault unavailable; continuing memory-only. {snapshot.persistenceFallbackReason}
          </p>
        ) : null}
        {error ?? snapshot.diagnostic ? <p role="alert" className="text-sm text-destructive">{error ?? snapshot.diagnostic}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" disabled={connectDisabled || invitePending} onClick={() => void connectInvite()}>
          {invitePending ? 'Saving…' : configureOnly ? 'Save invite and continue' : 'Use invite for WebRTC'}
        </Button>
        {!configureOnly ? <Button type="button" variant="outline" disabled={mode === 'http-only' || !snapshot.secureContext} onClick={() => void reconnect()}>Reconnect WebRTC</Button> : null}
        {snapshot.pairingSessionId ? (
          <Button type="button" variant="outline" onClick={() => void peer.confirmPairing(snapshot.pairingSessionId!)}>Confirm SAS</Button>
        ) : null}
        {!configureOnly ? <Button type="button" variant="ghost" onClick={() => void peer.disconnect('disconnect')}>Disconnect</Button> : null}
      </CardFooter>
    </Card>
  )
}

function defaultProfileForSurface(
  surface: ReturnType<typeof getAuroraSurfaceProfile>,
  suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}`,
): WebThinConnectionProfile {
  const surfaceLabel = surface.isAndroid
    ? 'Android thin'
    : surface.isIos
      ? 'iOS thin'
      : surface.isMobile
        ? 'Mobile thin'
        : surface.kind === 'web'
          ? 'Hosted web thin'
          : 'Desktop thin'
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
  return 'Browsers block HTTP or unencrypted WebSocket endpoints from an HTTPS-hosted page even when CSP permits them. Use HTTPS/WSS for hosted web, or use a native thin shell when the Aurora service is intentionally cleartext.'
}


function redactUiDiagnostic(value: string): string {
  return value
    .replace(/"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;<>"']+/gi, '$1$2[redacted]')
    .replace(/\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)\b(\s*[:=]\s*)(["']?)[^\s,;<>"']+/gi, '$1$2$3[redacted]')
    .replace(/([?&](?:(?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
}

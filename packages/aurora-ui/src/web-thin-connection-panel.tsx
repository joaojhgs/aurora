'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Link2, LockKeyhole, Network, ShieldCheck, WifiOff } from 'lucide-react'
import type { BrowserWebRtcPeerController, BrowserWebRtcSnapshot, AuroraThinConnectionMode } from './web-thin-runtime'
import { decodeMeshInvite, meshInviteSummary } from './mesh-invite'
import { getAuroraSurfaceProfile } from './platform-surface'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field'
import { Input } from '#components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Textarea } from '#components/ui/textarea'

export interface WebThinConnectionProfile {
  id: string
  label: string
  mode: AuroraThinConnectionMode
  gatewayUrl: string
  signalingUrl: string
  nodeName: string
  localStablePeerId: string
}

export interface WebThinConnectionPanelProps {
  peer: BrowserWebRtcPeerController
  mode: AuroraThinConnectionMode
  transportKind: string
  nativePlatform?: string | undefined
  initialInviteText?: string | null | undefined
  onInviteAccepted?: () => void
  profile?: WebThinConnectionProfile | undefined
  profiles?: WebThinConnectionProfile[] | undefined
  profileStoreEvidence?: string | undefined
  onSaveProfile?: (profile: WebThinConnectionProfile) => Promise<void>
  onSelectProfile?: (profileId: string) => Promise<void>
}

export function WebThinConnectionPanel({
  peer,
  mode,
  transportKind,
  nativePlatform,
  initialInviteText = null,
  onInviteAccepted,
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
  const [draftProfile, setDraftProfile] = useState<WebThinConnectionProfile | null>(profile ?? null)
  const surface = useMemo(() => getAuroraSurfaceProfile({
    runtimeMode: mode === 'http-only' ? 'web' : 'web-thin',
    transportKind,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }), [mode, transportKind, nativePlatform])
  const invite = useMemo(() => decodeMeshInvite(inviteText), [inviteText])
  const summary = invite ? meshInviteSummary(invite) : null
  const connectDisabled = mode === 'http-only' || !invite || !snapshot.secureContext
  useEffect(() => peer.subscribe(setSnapshot), [peer])
  useEffect(() => {
    if (initialInviteText) setInviteText(initialInviteText)
  }, [initialInviteText])
  useEffect(() => setDraftProfile(profile ?? null), [profile])

  const connectInvite = async () => {
    if (!invite) {
      setError('Paste a valid Aurora mesh invite before connecting WebRTC thin mode.')
      return
    }
    setError(null)
    try {
      const profile = peer.importInvite(inviteText)
      await peer.connect(profile)
      onInviteAccepted?.()
    } catch (nextError) {
      setError(redactUiDiagnostic(nextError instanceof Error ? nextError.message : String(nextError)))
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
    setDraftProfile({
      id: `profile-${suffix}`,
      label: 'New desktop thin profile',
      mode: 'http-only',
      gatewayUrl: '',
      signalingUrl: '',
      nodeName: 'Aurora desktop thin',
      localStablePeerId: `aurora-desktop-${suffix}`,
    })
  }

  return (
    <Card aria-label="WebRTC thin-shell connection" className="border-dashed">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><Network size={18} aria-hidden /> Thin-shell transport</CardTitle>
            <CardDescription>
              {surface.label} · {mode}. WebRTC uses the browser/WebView RTCPeerConnection path; no Rust transport or Python sidecar is claimed here.
            </CardDescription>
          </div>
          <Badge variant={snapshot.status === 'authorized' ? 'default' : 'outline'}>{snapshot.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {draftProfile && onSaveProfile && onSelectProfile ? (
          <FieldGroup aria-label="Desktop thin connection profile">
            <Field orientation="horizontal">
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
            </Field>
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
              <FieldLabel htmlFor="webthin-profile-gateway">HTTPS Gateway endpoint</FieldLabel>
              <Input id="webthin-profile-gateway" type="url" value={draftProfile.gatewayUrl} onChange={(event) => setDraftProfile({ ...draftProfile, gatewayUrl: event.currentTarget.value })} disabled={profilePending || draftProfile.mode === 'webrtc-only'} autoComplete="off" />
            </Field>
            <Field data-disabled={draftProfile.mode === 'http-only' || undefined}>
              <FieldLabel htmlFor="webthin-profile-signaling">WSS signaling endpoint</FieldLabel>
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
        <div className="grid gap-2 text-sm md:grid-cols-3" aria-label="Thin transport diagnostics">
          <Diagnostic icon={<ShieldCheck size={15} aria-hidden />} label="Secure context" value={snapshot.secureContext ? 'ready' : 'required'} />
          <Diagnostic icon={<Link2 size={15} aria-hidden />} label="Fallback" value={mode === 'webrtc-only' ? 'disabled' : snapshot.hasHttpFallback ? 'HTTP available' : 'none'} />
          <Diagnostic icon={<LockKeyhole size={15} aria-hidden />} label="Secrets" value="memory-only" />
        </div>
        {!snapshot.secureContext ? (
          <Alert variant="destructive">
            <AlertTriangle size={16} aria-hidden />
            <AlertTitle>Secure context required</AlertTitle>
            <AlertDescription>Use HTTPS, localhost, or a trusted native WebView before enabling browser WebRTC and microphone capture.</AlertDescription>
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
          <FieldDescription>Invite secrets stay in the URL fragment and this runtime's memory only.</FieldDescription>
        </Field>
        {summary ? (
          <dl className="grid gap-1 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-2" aria-label="Invite preview">
            <div><dt className="text-muted-foreground">Node</dt><dd>{summary.nodeName}</dd></div>
            <div><dt className="text-muted-foreground">Room</dt><dd>{summary.room}</dd></div>
            <div><dt className="text-muted-foreground">Signaling</dt><dd>{summary.signalingProvider} · {summary.brokerCount} broker(s)</dd></div>
            <div><dt className="text-muted-foreground">Secret handling</dt><dd>{summary.includesPassword ? 'memory-only until refresh' : 'missing secret'}</dd></div>
          </dl>
        ) : null}
        {error ?? snapshot.diagnostic ? <p role="alert" className="text-sm text-destructive">{error ?? snapshot.diagnostic}</p> : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" disabled={connectDisabled} onClick={() => void connectInvite()}>Use invite for WebRTC</Button>
        <Button type="button" variant="outline" disabled={mode === 'http-only' || !snapshot.secureContext} onClick={() => void reconnect()}>Reconnect WebRTC</Button>
        {snapshot.pairingSessionId ? (
          <Button type="button" variant="outline" onClick={() => void peer.confirmPairing(snapshot.pairingSessionId!)}>Confirm SAS</Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={() => void peer.disconnect('disconnect')}>Disconnect</Button>
      </CardFooter>
    </Card>
  )
}

function Diagnostic({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-background/60 px-2.5 py-2">
      {icon}
      <span className="min-w-0"><strong className="block text-xs">{label}</strong><small className="text-muted-foreground">{value}</small></span>
    </div>
  )
}


function redactUiDiagnostic(value: string): string {
  return value
    .replace(/"((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(authorization)\b(\s*[:=]\s*)(?:bearer\s+)?[^\s,;<>"']+/gi, '$1$2[redacted]')
    .replace(/\b((?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)\b(\s*[:=]\s*)(["']?)[^\s,;<>"']+/gi, '$1$2$3[redacted]')
    .replace(/([?&](?:(?:access_?|refresh_?|api_?)?token|secret|password|credential|api[_-]?key|authorization|room_password)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
}

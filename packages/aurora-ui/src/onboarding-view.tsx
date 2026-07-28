'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Compass, KeyRound, Monitor, Server, ShieldCheck, Smartphone } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthSessionSnapshot, AvailabilityState } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { presentableSignal } from './status-badges'
import { getAuroraSurfaceProfile } from './platform-surface'
import { Button, FormField } from './primitives'
import { buttonVariants } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { cn } from '#lib/utils'

export interface OnboardingViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  modePreferenceStore?: OnboardingModePreferenceStore | undefined
  thinConnectionPanel?: ReactNode
  setupRequired?: boolean | undefined
}

export interface OnboardingModePreferenceStore {
  evidence: string
  readSelectedMode: () => Promise<string | null>
  writeSelectedMode: (modeId: string) => Promise<boolean>
}

export interface DeploymentModeCard {
  id: string
  label: string
  description: string
  routeLabel: string
  state: AvailabilityState
  disabled: boolean
  evidence: string
  repair: string
}

export interface OnboardingSetupStep {
  title: string
  detail: string
  state: AvailabilityState
  progress: number | null
  repair: string
}

export interface MobileFirstLaunchNote {
  platform: 'Android' | 'iOS'
  state: AvailabilityState
  detail: string
  evidence: string
}

export interface PlatformBehaviorNote {
  label: string
  state: AvailabilityState
  behavior: string
  evidence: string
}

export interface OnboardingViewModel {
  session: AuthSessionSnapshot
  modes: DeploymentModeCard[]
  selectedModeId: string
  endpointState: AvailabilityState
  endpointEvidence: string
  authState: AvailabilityState
  authExplanation: string
  pairingState: AvailabilityState
  pairingExplanation: string
  setupSteps: OnboardingSetupStep[]
  resumeTitle: string
  resumeDetail: string
  selectedMode: DeploymentModeCard
  mobileNotes: MobileFirstLaunchNote[]
  platformBehavior: PlatformBehaviorNote[]
  cockpitHref: string
}

export function OnboardingView({ client, snapshot, modePreferenceStore, thinConnectionPanel, setupRequired = false }: OnboardingViewProps) {
  const [session, setSession] = useState(() => client.auth.refreshClock())
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const [selectedModeId, setSelectedModeId] = useState(() => defaultModeId(client.transport.kind, snapshot, userAgent))
  const [modePreferenceReady, setModePreferenceReady] = useState(() => !modePreferenceStore)
  const [modePreferenceEvidence, setModePreferenceEvidence] = useState(() => modePreferenceStore?.evidence ?? 'mode preference memory only')
  const modeSelectionTouchedRef = useRef(false)
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [pairingDevice, setPairingDevice] = useState('Aurora device')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [wizardStep, setWizardStep] = useState<'detect' | 'setup' | 'done'>('detect')

  const model = useMemo(
    () =>
      buildOnboardingViewModel({
        client,
        snapshot,
        selectedModeId,
        endpoint,
        userAgent,
      }),
    [client, snapshot, selectedModeId, endpoint, session, userAgent],
  )

  useEffect(() => {
    return client.auth.subscribe(setSession)
  }, [client])

  useEffect(() => {
    let cancelled = false
    if (!modePreferenceStore) {
      setModePreferenceReady(true)
      setModePreferenceEvidence('mode preference memory only')
      return () => {
        cancelled = true
      }
    }
    modeSelectionTouchedRef.current = false
    setModePreferenceReady(false)
    setModePreferenceEvidence(`${modePreferenceStore.evidence} · checking saved mode`)
    void modePreferenceStore.readSelectedMode().then(
      (modeId) => {
        if (cancelled) return
        if (modeId && isSupportedModeId(modeId) && !modeSelectionTouchedRef.current) {
          setSelectedModeId(modeId)
          setModePreferenceEvidence(`${modePreferenceStore.evidence} · restored ${modeLabel(modeId)}`)
        } else if (modeId && !isSupportedModeId(modeId)) {
          setModePreferenceEvidence(`${modePreferenceStore.evidence} · ignored unsupported saved mode`)
        } else {
          setModePreferenceEvidence(`${modePreferenceStore.evidence} · no saved mode`)
        }
        setModePreferenceReady(true)
      },
      () => {
        if (!cancelled) {
          setModePreferenceEvidence(`${modePreferenceStore.evidence} · restore unavailable; select a mode to retry save`)
          setModePreferenceReady(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [client.transport.kind, modePreferenceStore, snapshot.nativePlatform])

  function onSelectMode(modeId: string) {
    if (!modePreferenceReady || !isSupportedModeId(modeId)) return
    modeSelectionTouchedRef.current = true
    setSelectedModeId(modeId)
    if (!modePreferenceStore) return
    setModePreferenceEvidence(`${modePreferenceStore.evidence} · saving ${modeLabel(modeId)}`)
    void modePreferenceStore.writeSelectedMode(modeId).then(
      (ok) => {
        setModePreferenceEvidence(ok ? `${modePreferenceStore.evidence} · saved ${modeLabel(modeId)}` : `${modePreferenceStore.evidence} · save unavailable`)
      },
      () => setModePreferenceEvidence(`${modePreferenceStore.evidence} · save unavailable`),
    )
  }

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy('login')
    setMessage(null)
    const result = await client.authApi.login({
      username: username.trim(),
      password,
    })
    setBusy(null)
    if (result.ok) {
      setToken(result.data.token)
      setPassword('')
      setMessage('Signed in. Your token remains in memory for this session and is not persisted in browser storage.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onValidateToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token.trim() || busy) return
    setBusy('token')
    setMessage(null)
    const result = await client.authApi.validateToken({ token: token.trim() })
    setBusy(null)
    if (result.ok) {
      setMessage(result.data.valid ? 'Access restored for this session only.' : 'That access key was rejected.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onStartPairing() {
    if (busy) return
    setBusy('pairing-start')
    setMessage(null)
    const result = await client.authApi.pairingStart({
      device_name: pairingDevice.trim() || 'Aurora device',
    })
    setBusy(null)
    if (result.ok) {
      client.auth.setPairing({
        reason: 'Pairing code issued by Auth.PairingStart',
      })
      setPairingCode(result.data.code)
      setMessage(`Pairing code created; expires in ${result.data.expires_in_seconds} seconds.`)
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onExchangePairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pairingCode.trim() || busy) return
    setBusy('pairing-exchange')
    setMessage(null)
    const result = await client.authApi.pairingExchange({
      code: pairingCode.trim(),
    })
    setBusy(null)
    if (result.ok) {
      setToken(result.data.token)
      setMessage('Pairing complete. Your token remains in memory for this session and is not persisted in browser storage.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  const completedStepCount = model.setupSteps.filter(isStepComplete).length
  const allStepsComplete = model.setupSteps.length > 0 && completedStepCount === model.setupSteps.length

  if (setupRequired && thinConnectionPanel) {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-6 pb-10 sm:px-6" aria-labelledby="onboarding-title">
        <div className="text-center">
          <h1 id="onboarding-title" className="text-xl font-semibold tracking-tight">
            Connect this Aurora client
          </h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Choose HTTP, WebRTC, or WebRTC with HTTP fallback. This client stores the selected runtime profile on this device; endpoints are not compiled into the app.
          </p>
        </div>
        <div data-step="thin-connection">{thinConnectionPanel}</div>
      </section>
    )
  }

  return (
    <section className="mx-auto flex max-w-xl flex-col gap-6 px-6 pt-8 pb-10" aria-labelledby="onboarding-title">
      <div className="text-center">
        <h1 id="onboarding-title" className="text-xl font-semibold tracking-tight">
          Welcome to Aurora
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {setupRequired ? 'Configure this thin client before entering Aurora.' : 'We auto-detect how this client is running, then walk through the setup that matches it.'}
        </p>
      </div>

      {thinConnectionPanel ? (
        <div className="flex flex-col gap-3" data-step="thin-connection">
          {thinConnectionPanel}
        </div>
      ) : null}

      {wizardStep === 'detect' ? (
        <div className="flex flex-col gap-4" data-step="detect">
          <div>
            <p className="mb-2.5 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">Detected installation</p>
            <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Installation type">
              {model.modes.map((mode) => {
                const active = mode.id === model.selectedModeId
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={mode.disabled || !modePreferenceReady}
                    title={mode.label}
                    onClick={() => onSelectMode(mode.id)}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border p-3.5 text-left ring-1 ring-foreground/10 transition-colors',
                      active ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-foreground/30',
                      (mode.disabled || !modePreferenceReady) && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    <span className="mt-0.5 shrink-0 text-foreground">
                      <ModeIcon id={mode.id} />
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <strong className="text-[13.5px] font-semibold">{mode.label}</strong>
                      <small className="text-xs text-muted-foreground">{mode.description}</small>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <p className="text-[11.5px] text-muted-foreground">Not right? Pick the correct installation above, then continue.</p>
          <Button variant="primary" onClick={() => setWizardStep('setup')} disabled={!modePreferenceReady}>
            Start guided setup
          </Button>
        </div>
      ) : null}

      {wizardStep === 'setup' ? (
        <div className="flex flex-col gap-6" data-step="setup">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ModeIcon id={model.selectedMode.id} />
              <strong className="text-sm font-semibold">{model.selectedMode.label}</strong>
            </div>
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setWizardStep('detect')}>
              Change
            </button>
          </div>

          <section aria-labelledby="guided-setup-title" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="guided-setup-title" className="flex items-center gap-2 text-sm font-semibold">
                <Compass size={16} aria-hidden />
                Guided setup
              </h2>
              <span className="text-[11.5px] text-muted-foreground">
                {completedStepCount} of {model.setupSteps.length} steps complete
              </span>
            </div>
            <ol className="flex flex-col gap-2.5">
              {model.setupSteps.map((step) => {
                const complete = isStepComplete(step)
                return (
                  <li key={step.title} className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-3">
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border',
                        complete ? 'border-success bg-success/15 text-success' : 'border-border text-transparent'
                      )}
                    >
                      <Check size={12} />
                    </span>
                    <div className="flex flex-1 flex-col gap-1">
                      <strong className="text-[13px] font-medium">{step.title}</strong>
                      <p className="text-[11.5px] text-muted-foreground">{step.detail.length > 120 ? `${step.detail.slice(0, 117)}…` : step.detail}</p>
                      {step.progress !== null ? (
                        <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-label={`${step.title} ${step.progress}% complete`}>
                          <div className="h-full rounded-full bg-primary" style={{ width: `${step.progress}%` }} />
                        </div>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>

          <section aria-labelledby="gateway-title" className="flex flex-col gap-2.5">
            <h2 id="gateway-title" className="text-sm font-semibold">
              Gateway address
            </h2>
            <FormField label="Gateway or local node URL" htmlFor="aurora-endpoint">
              <Input
                id="aurora-endpoint"
                value={endpoint}
                onChange={(event) => setEndpoint(event.currentTarget.value)}
                placeholder="https://aurora.example.test or http://127.0.0.1:8000"
                inputMode="url"
              />
            </FormField>
            <Button variant="outline" disabled={!endpoint.trim()} onClick={() => setMessage('Gateway address saved for this setup session.')}>
              Use this address
            </Button>
          </section>

          <section aria-labelledby="account-title" aria-live="polite" className="flex flex-col gap-2.5">
            <h2 id="account-title" className="text-sm font-semibold">
              Sign in
            </h2>
            {session.isAuthenticated ? (
              <p className="text-[13px] text-muted-foreground">Signed in as {session.principalName ?? session.principalId ?? 'Aurora user'}.</p>
            ) : (
              <p className="text-[13px] text-muted-foreground">Sign in, restore an access key, or pair this device.</p>
            )}
            <form className="flex flex-col gap-2.5" onSubmit={onLogin}>
              <FormField label="Username" htmlFor="aurora-username">
                <Input id="aurora-username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="username" />
              </FormField>
              <FormField label="Password" htmlFor="aurora-password">
                <Input id="aurora-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} type="password" autoComplete="current-password" />
              </FormField>
              <Button type="submit" variant="outline" disabled={busy !== null || !username.trim() || !password}>
                Login
              </Button>
            </form>
            <form className="flex flex-col gap-2.5" onSubmit={onValidateToken}>
              <FormField label="Access key" htmlFor="aurora-token">
                <Input id="aurora-token" value={token} onChange={(event) => setToken(event.currentTarget.value)} type="password" autoComplete="off" />
              </FormField>
              <Button type="submit" variant="outline" disabled={busy !== null || !token.trim()}>
                Restore access
              </Button>
            </form>
            {session.isTerminal ? (
              <Button variant="ghost" onClick={() => client.auth.clear()}>
                Clear session
              </Button>
            ) : null}
          </section>

          <section aria-labelledby="pairing-title" className="flex flex-col gap-2.5">
            <h2 id="pairing-title" className="text-sm font-semibold">
              Pair this device
            </h2>
            <FormField label="Device name" htmlFor="aurora-device-name">
              <Input id="aurora-device-name" value={pairingDevice} onChange={(event) => setPairingDevice(event.currentTarget.value)} />
            </FormField>
            <Button variant="outline" disabled={busy !== null} onClick={onStartPairing}>
              Request pairing code
            </Button>
            <form className="flex flex-col gap-2.5" onSubmit={onExchangePairing}>
              <FormField label="Approved code" htmlFor="aurora-pairing-code">
                <Input id="aurora-pairing-code" value={pairingCode} onChange={(event) => setPairingCode(event.currentTarget.value)} autoComplete="one-time-code" />
              </FormField>
              <Button type="submit" variant="outline" disabled={busy !== null || !pairingCode.trim()}>
                Exchange code
              </Button>
            </form>
          </section>

          <Button
            variant="primary"
            onClick={() => setWizardStep('done')}
            disabled={!allStepsComplete}
            disabledReason="Complete every guided-setup step above before finishing."
          >
            Finish setup
          </Button>
        </div>
      ) : null}

      {wizardStep === 'done' ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center" data-step="done">
          <Check size={40} aria-hidden className="text-success" />
          <h2 className="text-base font-semibold">You're all set</h2>
          <p className="text-[12.5px] text-muted-foreground">{model.selectedMode.label} is configured. You can revisit any of this from Settings later.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setWizardStep('detect')}>
              Run setup again
            </Button>
            <a className={cn(buttonVariants({ variant: 'default' }))} href={model.cockpitHref}>
              Go to Assistant
            </a>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="text-center text-[13px] text-muted-foreground" role="alert">
          {message}
        </p>
      ) : null}
    </section>
  )
}

export function buildOnboardingViewModel({ client, snapshot, selectedModeId, endpoint, userAgent }: { client: AuroraClient; snapshot: AuroraShellSnapshot; selectedModeId?: string; endpoint?: string; userAgent?: string }): OnboardingViewModel {
  const session = client.auth.refreshClock()
  const modes = deploymentModes(client.transport.kind, snapshot, userAgent)
  const selected = selectedModeId && modes.some((mode) => mode.id === selectedModeId && !mode.disabled) ? selectedModeId : (modes.find((mode) => !mode.disabled)?.id ?? modes[0]?.id ?? 'desktop-web-thin')
  const authState = authAvailability(session)
  const pairingState = pairingAvailability(session, routeById(snapshot, 'mesh'))
  const selectedMode = modes.find((mode) => mode.id === selected) ?? modes[0] ?? mode('desktop-web-thin', 'Desktop Web thin', 'Remote desktop', 'No setup modes are available.', 'unsupported', 'No SDK transport status.', 'Reload the Aurora shell after the SDK initializes.')
  const steps = setupSteps({
    session,
    snapshot,
    selectedMode,
    authState,
    pairingState,
  })
  return {
    session,
    modes,
    selectedModeId: selected,
    endpointState: endpointState(endpoint, client.transport.kind, snapshot.loadState),
    endpointEvidence: endpointEvidence(endpoint, client.transport.kind, snapshot.loadState),
    authState,
    authExplanation: authExplanation(session),
    pairingState,
    pairingExplanation: pairingExplanation(session, routeById(snapshot, 'mesh')),
    setupSteps: steps,
    resumeTitle: resumeSetupTitle(steps),
    resumeDetail: resumeSetupDetail(steps),
    selectedMode,
    mobileNotes: mobileFirstLaunchNotes(snapshot),
    platformBehavior: platformBehaviorNotes(snapshot, client.transport.kind),
    cockpitHref: '/',
  }
}

function deploymentModes(transportKind: string, snapshot: AuroraShellSnapshot, userAgent?: string): DeploymentModeCard[] {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent,
  })
  const desktopNative = desktopLocalState(snapshot, transportKind)
  const desktopWeb = desktopThinState(snapshot, transportKind)
  const mobileNative = mobileNativeState(snapshot, transportKind, userAgent)
  const mobileWeb = mobileWebThinState(snapshot, transportKind, userAgent)
  return [
    mode('desktop-native', 'Desktop Native', 'Desktop local', 'Tauri desktop local mode with the supervised Python sidecar and loopback Gateway when available.', desktopNative.state, `${profile.label}; ${desktopNative.evidence}`, desktopNative.repair),
    mode('desktop-web-thin', 'Desktop Web thin', 'Remote desktop/web', 'Browser or Tauri thin shell connected to an operator-managed Aurora Gateway; no local Python sidecar is claimed.', desktopWeb.state, `${profile.label}; ${desktopWeb.evidence}`, desktopWeb.repair),
    mode('mobile-native', 'Mobile Native', 'Native mobile shell', 'Android or iOS native shell using platform manifest evidence for storage, permissions, and app-owned invocation surfaces.', mobileNative.state, `${profile.label}; ${mobileNative.evidence}`, mobileNative.repair),
    mode('mobile-web-thin', 'Mobile Web thin', 'Mobile browser', 'Mobile browser connected to a remote Gateway with focused WebView/browser capture only; durable background wake requires native adapters.', mobileWeb.state, `${profile.label}; ${mobileWeb.evidence}`, mobileWeb.repair),
  ]
}

function desktopLocalState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'tauri-local') {
    const nativeEvidence = snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native manifest pending'
    return {
      state: snapshot.loadState === 'ready' ? 'available-local' : 'pending',
      evidence: `${nativeEvidence}; local Gateway readiness is shown by the Tauri runtime panel`,
      repair: 'Run `pnpm --filter @aurora/tauri-ui tauri dev`; the Rust sidecar starts Python services in threads mode and reports Gateway health.',
    }
  }
  return {
    state: 'unsupported',
    evidence: `Current transport is ${transportKind}; no local sidecar status is available.`,
    repair: 'Switch to Desktop Native from Tauri or use Desktop Web thin for remote Gateway operation.',
  }
}

function desktopThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'http') {
    return {
      state: 'available-remote',
      evidence: 'HTTP Gateway transport; sidecar intentionally not used',
      repair: 'Validate the remote endpoint and authenticate with Auth.Login, token restore, or pairing before entering the cockpit.',
    }
  }
  if (transportKind === 'tauri-local') {
    return {
      state: 'pending',
      evidence: 'Tauri desktop can run thin mode when configured with a remote Gateway URL.',
      repair: 'Set the desktop-thin Gateway URL and restart without local sidecar startup.',
    }
  }
  return {
    state: transportKind === 'mock' ? 'degraded' : 'unsupported',
    evidence: transportKind === 'mock' ? 'demo only; no remote Gateway proof' : `Current transport is ${transportKind}.`,
    repair: 'Open setup and configure or import a runtime HTTP/WebRTC connection profile.',
  }
}

function androidMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('android')) {
    return {
      state: 'available-remote',
      evidence: 'native-mobile Android transport with SDK native manifest status',
      repair: 'Continue with endpoint/pairing and store credentials only through Android keystore-backed native storage when advertised.',
    }
  }
  if (platform.includes('android')) {
    return {
      state: snapshot.nativeAvailable ? 'degraded' : 'unsupported',
      evidence: `Android manifest ${snapshot.nativeAvailable ? 'available' : 'missing'}; transport=${transportKind}`,
      repair: 'Use remote Gateway or mesh pairing; assistant role depends on package qualification, OS support, and user/OEM grant.',
    }
  }
  if (transportKind === 'http') {
    return {
      state: 'pending',
      evidence: 'HTTP transport can support Android thin after native shell packaging status.',
      repair: 'Pair or authenticate against the remote Gateway, then verify Android permissions and keystore capability in /settings/native.',
    }
  }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'Android native manifest missing',
    repair: 'Android thin mode requires Android native manifest status or a remote Gateway URL.',
  }
}

function iosMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('ios')) {
    return {
      state: iosLocalLightState(snapshot) === 'unsupported' ? 'degraded' : iosLocalLightState(snapshot),
      evidence: iosLocalLightEvidence(snapshot),
      repair: 'Use Keychain for credentials when advertised; invoke through App Intents, Shortcuts, widgets, share sheet, file associations, or deep links only.',
    }
  }
  if (platform.includes('ios')) {
    return {
      state: snapshot.nativeAvailable ? iosLocalLightState(snapshot) : 'unsupported',
      evidence: iosLocalLightEvidence(snapshot),
      repair: 'iOS uses Siri/Shortcuts/App Intents, widgets, share sheet, and deep links in app-owned surfaces; system assistant ownership is unavailable.',
    }
  }
  if (transportKind === 'http') {
    return {
      state: 'pending',
      evidence: 'HTTP transport can support iOS thin after native shell packaging status.',
      repair: 'Pair or authenticate against the remote Gateway, then verify Keychain/App Intents/Shortcuts support in /settings/native.',
    }
  }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'iOS native manifest missing',
    repair: 'iOS thin mode requires iOS native manifest status or a remote Gateway URL.',
  }
}

function mobileNativeState(snapshot: AuroraShellSnapshot, transportKind: string, userAgent?: string): { state: AvailabilityState; evidence: string; repair: string } {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent,
  })
  if (profile.isAndroid) return androidMobileThinState(snapshot, transportKind)
  if (profile.isIos) return iosMobileThinState(snapshot, transportKind)
  if (transportKind === 'native-mobile')
    return {
      state: 'degraded',
      evidence: 'native-mobile transport without Android/iOS manifest detail',
      repair: 'Verify platform manifest status before claiming native credential storage or background capabilities.',
    }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'mobile native manifest missing',
    repair: 'Open Aurora from Android or iOS native shell to use native storage, permission, and invocation surfaces.',
  }
}

function mobileWebThinState(snapshot: AuroraShellSnapshot, transportKind: string, userAgent?: string): { state: AvailabilityState; evidence: string; repair: string } {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent,
  })
  if (profile.isMobile && transportKind === 'http')
    return {
      state: 'available-remote',
      evidence: 'HTTP Gateway transport on a mobile user agent/native platform',
      repair: 'Authenticate or pair; background wake and durable credential storage require Mobile Native.',
    }
  if (transportKind === 'http')
    return {
      state: 'pending',
      evidence: 'HTTP Gateway transport can be used from mobile web after mobile browser detection.',
      repair: 'Open the Gateway URL from a mobile browser and authenticate or pair.',
    }
  if (transportKind === 'mock')
    return {
      state: 'degraded',
      evidence: 'Mobile web setup waits for a live Gateway connection',
      repair: 'Connect a remote Gateway from mobile browser for production truth.',
    }
  return {
    state: 'unsupported',
    evidence: `Current transport is ${transportKind}; mobile web thin needs HTTP Gateway transport.`,
    repair: 'Use a mobile browser with an http:// or https:// Aurora Gateway endpoint.',
  }
}

function iosLocalLightState(snapshot: AuroraShellSnapshot): AvailabilityState {
  if (!snapshot.nativePlatform.toLowerCase().includes('ios')) return 'unsupported'
  const integrations = snapshot.nativeMobileIntegrations ?? []
  if (integrations.some((integration) => integration.platform === 'ios' && integration.support === 'supported')) {
    return 'available-local'
  }
  if (integrations.some((integration) => integration.platform === 'ios' && integration.support === 'supported-path')) {
    return 'degraded'
  }
  if (integrations.some((integration) => integration.platform === 'ios' && integration.support === 'planned')) {
    return 'pending'
  }
  return 'unsupported'
}

function iosLocalLightEvidence(snapshot: AuroraShellSnapshot): string {
  if (!snapshot.nativePlatform.toLowerCase().includes('ios')) return snapshot.nativePlatform
  const ids = (snapshot.nativeMobileIntegrations ?? []).filter((integration) => integration.platform === 'ios' && integration.id !== 'siriReplacement').map((integration) => integration.id)
  return ids.length > 0 ? `iOS native manifest: ${ids.join(', ')}` : 'iOS native manifest missing'
}

function mode(id: string, label: string, routeLabel: string, description: string, state: AvailabilityState, evidence: string, repair: string): DeploymentModeCard {
  return {
    id,
    label,
    routeLabel,
    description,
    state,
    evidence,
    repair,
    disabled: !['available-local', 'available-remote', 'degraded', 'pending'].includes(state),
  }
}

function setupSteps(input: { session: AuthSessionSnapshot; snapshot: AuroraShellSnapshot; selectedMode: DeploymentModeCard; authState: AvailabilityState; pairingState: AvailabilityState }): OnboardingSetupStep[] {
  const selectedMode = input.selectedMode.id.includes('web-thin') ? 'available-remote' : 'available-local'
  return [
    {
      title: 'Select mode',
      detail: 'Choose exactly one mode: Desktop Native, Desktop Web thin, Mobile Native, or Mobile Web thin.',
      state: selectedMode,
      progress: null,
      repair: input.selectedMode.repair,
    },
    {
      title: 'Authenticate / pair',
      detail: 'Sign in, restore an in-memory token, enter pairing code, or load local owner identity through Auth SDK calls.',
      state: input.authState === 'pending' ? input.pairingState : input.authState,
      progress: input.session.isAuthenticated ? 100 : input.session.state === 'pairing' ? 45 : null,
      repair: input.session.isAuthenticated ? 'Session ready.' : 'If login fails, check endpoint reachability and retry Auth.Login, token restore, or Auth.PairingExchange.',
    },
    {
      title: 'Load capability graph',
      detail: `${input.snapshot.routeCount} routes, ${input.snapshot.availableCount} selectable routes, and native/peer manifests drive every screen.`,
      state: input.snapshot.loadState === 'ready' ? 'available-local' : input.snapshot.loadState === 'loading' ? 'pending' : 'denied',
      progress: input.snapshot.routeCount ? Math.min(100, Math.round((input.snapshot.availableCount / Math.max(1, input.snapshot.routeCount)) * 100)) : null,
      repair: input.snapshot.loadState === 'error' ? 'Retry the Gateway request after endpoint/auth recovery.' : 'Continue once Aurora returns capability status.',
    },
    {
      title: 'Review privacy defaults',
      detail: 'Confirm local-first routing, remote fallback, mesh selector policy, and native permission states before enabling sensitive actions.',
      state: input.snapshot.secretsRedacted ? 'available-local' : 'degraded',
      progress: input.snapshot.secretsRedacted ? 100 : 50,
      repair: input.snapshot.secretsRedacted ? 'Secrets are redacted in snapshot status.' : 'Repair backend redaction before exporting support bundles or logs.',
    },
    {
      title: 'Land in cockpit',
      detail: 'Assistant and Admin share the same production shell once route, auth, privacy, and platform status are loaded.',
      state: input.session.isAuthenticated || input.snapshot.loadState === 'ready' ? 'available-local' : 'pending',
      progress: input.session.isAuthenticated ? 100 : null,
      repair: 'Enter the cockpit only after route, auth, privacy, and platform status are visible.',
    },
  ]
}

function resumeSetupTitle(steps: OnboardingSetupStep[]): string {
  const next = steps.find((step) => step.state === 'pending' || step.state === 'denied' || step.state === 'unsupported' || step.state === 'privacy-blocked')
  return next ? `Resume: ${next.title}` : 'Resume: Land in cockpit'
}

function resumeSetupDetail(steps: OnboardingSetupStep[]): string {
  const next = steps.find((step) => step.state === 'pending' || step.state === 'denied' || step.state === 'unsupported' || step.state === 'privacy-blocked')
  return next?.repair ?? 'Setup prerequisites are complete from the current SDK session snapshot.'
}

function isStepComplete(step: OnboardingSetupStep): boolean {
  return step.state === 'available-local' || step.state === 'available-remote' || step.progress === 100
}

function androidAssistantRoleEvidence(assistant: NonNullable<AuroraShellSnapshot['nativeAssistantRole']>, fallbackCount: number): string {
  return `${assistant.evidenceSource}; roleAvailable=${String(assistant.roleAvailable)}; roleHeld=${String(assistant.roleHeld)}; requestable=${String(assistant.requestable)}; fallback entrypoints=${fallbackCount}`
}

function mobileFirstLaunchNotes(snapshot: AuroraShellSnapshot): MobileFirstLaunchNote[] {
  const androidState: AvailabilityState = snapshot.nativePlatform === 'android' && snapshot.nativeAvailable ? 'degraded' : 'unsupported'
  const iosState: AvailabilityState = snapshot.nativePlatform === 'ios' && snapshot.nativeAvailable ? iosLocalLightState(snapshot) : 'unsupported'
  return [
    {
      platform: 'Android',
      state: androidState,
      detail: 'Aurora can request Android assistant role only when package qualification, OS availability, and user/OEM grant allow it; fallback entrypoints remain visible.',
      evidence: snapshot.nativeAssistantRole ? androidAssistantRoleEvidence(snapshot.nativeAssistantRole, snapshot.nativeFallbackEntrypoints.length) : 'Android assistant-role manifest status not present in this runtime.',
    },
    {
      platform: 'iOS',
      state: iosState,
      detail: 'Aurora integrates through Siri/Shortcuts/App Intents, widgets, share sheet, file associations, and deep links in app-owned surfaces only.',
      evidence: iosLocalLightEvidence(snapshot),
    },
  ]
}

function platformBehaviorNotes(snapshot: AuroraShellSnapshot, transportKind: string): PlatformBehaviorNote[] {
  const meshRoute = routeById(snapshot, 'mesh')
  const meshState = meshRoute?.state ?? 'unsupported'
  const meshEvidence = meshRoute ? `${meshRoute.providerLabel}; routeable=${String(meshRoute.routeable)}; blockers=${presentableSignal(meshRoute.blockers.join(',') || 'none')}` : 'Mesh route is not present in the capability graph.'
  const desktopState: AvailabilityState = transportKind === 'tauri-local' && !meshRoute?.disabled ? 'available-local' : transportKind === 'tauri-local' ? 'degraded' : 'unsupported'
  const webState: AvailabilityState = transportKind === 'http' ? meshState : transportKind === 'mock' ? 'degraded' : 'unsupported'
  const androidState = androidMobileThinState(snapshot, transportKind).state
  const iosState = iosMobileThinState(snapshot, transportKind).state
  return [
    {
      label: 'Desktop Tauri local',
      state: desktopState,
      behavior: 'Desktop local can be a full node only when the local Gateway reports mesh enabled and routeable; otherwise it stays a supervised local shell with explicit repair status.',
      evidence: transportKind === 'tauri-local' ? meshEvidence : `Current transport is ${transportKind}; desktop-local full-node behavior requires Tauri local Gateway status.`,
    },
    {
      label: 'Web thin',
      state: webState,
      behavior: 'Web thin can view and manage remote mesh only through Gateway APIs and AdminAction receipts; it never starts a sidecar or claims local node hosting.',
      evidence: transportKind === 'http' ? meshEvidence : `Current transport is ${transportKind}; use HTTP Gateway transport for web-thin mesh management.`,
    },
    {
      label: 'Android mobile thin',
      state: androidState,
      behavior: 'Android mobile thin can pair and invoke remote or mesh capabilities through Gateway/native manifest status, while assistant-role ownership remains conditional on OS/OEM/user grants.',
      evidence: androidMobileThinState(snapshot, transportKind).evidence,
    },
    {
      label: 'iOS mobile thin',
      state: iosState,
      behavior: 'iOS mobile thin can pair and invoke remote or mesh capabilities from app-owned surfaces only; it must not claim system assistant replacement.',
      evidence: iosMobileThinState(snapshot, transportKind).evidence,
    },
  ]
}

function endpointState(endpoint: string | undefined, transportKind: string, loadState: string): AvailabilityState {
  if (loadState === 'error') return 'denied'
  if (transportKind === 'mock') return 'degraded'
  if (!endpoint?.trim()) return transportKind === 'http' ? 'available-remote' : 'pending'
  try {
    const parsed = new URL(endpoint)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'available-remote' : 'denied'
  } catch {
    return 'denied'
  }
}

function endpointEvidence(endpoint: string | undefined, transportKind: string, loadState: string): string {
  if (loadState === 'error') return 'Aurora could not load the capability snapshot.'
  if (transportKind === 'mock') return 'No Gateway URL is configured; the UI is using SDK demo modes as a degraded development fallback.'
  if (!endpoint?.trim()) return `Current SDK transport is ${transportKind}; enter a URL only when changing Gateway targets.`
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return `Valid ${parsed.protocol} endpoint syntax; backend proof still requires Auth/Gateway response.`
    return 'Endpoint must use http or https.'
  } catch {
    return 'Endpoint is not a valid URL.'
  }
}

function authAvailability(session: AuthSessionSnapshot): AvailabilityState {
  if (session.isAuthenticated) return session.isSystem ? 'degraded' : 'available-local'
  if (session.state === 'pairing') return 'pending'
  if (session.state === 'expired' || session.state === 'revoked') return 'denied'
  if (session.isDenied) return 'denied'
  return 'pending'
}

function authExplanation(session: AuthSessionSnapshot): string {
  if (session.isSystem) return 'AuthSession reports SYSTEM/API-key mode; expose this only for local development or auth-disabled backends.'
  if (session.isAuthenticated) return 'AuthSession is authenticated from SDK/service status.'
  if (session.state === 'pairing') return 'Pairing has started and remains pending until Auth reports exchange success or denial.'
  if (session.state === 'expired') return session.reason ?? 'Session expired; restore or log in again.'
  if (session.state === 'revoked') return session.reason ?? 'Session revoked; restore or log in again.'
  if (session.isDenied) return session.reason ?? 'Authentication or permission denied by backend.'
  return 'No authenticated session is present. Login, restore a token, or exchange an approved pairing code.'
}

function pairingAvailability(session: AuthSessionSnapshot, meshRoute: RouteAvailability | undefined): AvailabilityState {
  if (session.isMeshPeer) return 'available-remote'
  if (session.state === 'pairing') return 'pending'
  if (meshRoute) return meshRoute.state
  return 'unsupported'
}

function pairingExplanation(session: AuthSessionSnapshot, meshRoute: RouteAvailability | undefined): string {
  if (session.isMeshPeer) return 'Pairing exchange returned mesh peer identity through AuthSession.'
  if (session.state === 'pairing') return 'Pairing request is pending backend approval and exchange.'
  return meshRoute?.explanation ?? 'Pairing is unavailable until Auth pairing methods and mesh capability status are exposed.'
}

function routeById(snapshot: AuroraShellSnapshot, id: string): RouteAvailability | undefined {
  return snapshot.routes.find((route) => route.item.id === id)
}

function defaultModeId(transportKind: string, snapshot?: AuroraShellSnapshot, userAgent?: string): string {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot?.nativePlatform,
    userAgent,
  })
  if (transportKind === 'tauri-local') return 'desktop-native'
  if (transportKind === 'native-mobile' || profile.isMobile) return transportKind === 'http' ? 'mobile-web-thin' : 'mobile-native'
  return 'desktop-web-thin'
}

function isSupportedModeId(modeId: string): boolean {
  return supportedModeIds.has(modeId)
}

const supportedModeIds = new Set(['desktop-native', 'desktop-web-thin', 'mobile-native', 'mobile-web-thin'])

function modeLabel(modeId: string): string {
  return modeId.replace(/-/g, ' ')
}

function clientTransportEvidence(transportKind: string): string {
  return transportKind || 'transport not reported'
}

function onboardingErrorMessage(error: AuroraError): string {
  if (error.code === 'auth') return 'Auth request was denied or expired. Verify the Gateway endpoint, then retry login, token restore, or pairing exchange.'
  if (error.code === 'permission') return 'Current principal lacks permission for this Auth action. Pair an owner/admin device or use an account with onboarding access.'
  if (error.code === 'unsupported_feature') return 'This backend or mock transport does not expose the required Auth method yet.'
  if (error.code === 'timeout') return 'Auth request timed out before backend confirmation. Check endpoint reachability and retry without changing stored credentials.'
  return error.message || 'Onboarding request failed.'
}

function ModeIcon({ id }: { id: string }) {
  const props = { size: 18, 'aria-hidden': true as const }
  if (id === 'desktop-native') return <Monitor {...props} />
  if (id === 'desktop-web-thin') return <Server {...props} />
  if (id === 'mobile-native' || id === 'mobile-web-thin') return <Smartphone {...props} />
  if (id === 'auth') return <KeyRound {...props} />
  return <ShieldCheck {...props} />
}

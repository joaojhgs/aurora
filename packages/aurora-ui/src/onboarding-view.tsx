'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Compass, KeyRound, Monitor, PlugZap, RadioTower, Rocket, Server, ShieldCheck, Smartphone } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthSessionSnapshot, AvailabilityState } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { EvidenceBadge, StatusBadge, presentableSignal } from './status-badges'
import { PageHeader } from './state-surface'

export interface OnboardingViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  modePreferenceStore?: OnboardingModePreferenceStore | undefined
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

const credentialStorageEvidence = 'browser token persistence disabled'

export function OnboardingView({ client, snapshot, modePreferenceStore }: OnboardingViewProps) {
  const [session, setSession] = useState(() => client.auth.refreshClock())
  const [selectedModeId, setSelectedModeId] = useState(() => defaultModeId(client.transport.kind, snapshot))
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

  const model = useMemo(
    () => buildOnboardingViewModel({ client, snapshot, selectedModeId, endpoint }),
    [client, snapshot, selectedModeId, endpoint, session]
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
      }
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
      () => setModePreferenceEvidence(`${modePreferenceStore.evidence} · save unavailable`)
    )
  }

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy('login')
    setMessage(null)
    const result = await client.authApi.login({ username: username.trim(), password })
    setBusy(null)
    if (result.ok) {
      setToken(result.data.token)
      setPassword('')
      setMessage('Login accepted by Auth.Login; token remains in memory for this session and is not persisted in browser storage.')
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
      setMessage(result.data.valid ? 'Token restored through Auth.ValidateToken for this session only.' : 'Token was rejected by Auth.ValidateToken.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onStartPairing() {
    if (busy) return
    setBusy('pairing-start')
    setMessage(null)
    const result = await client.authApi.pairingStart({ device_name: pairingDevice.trim() || 'Aurora device' })
    setBusy(null)
    if (result.ok) {
      client.auth.setPairing({ reason: 'Pairing code issued by Auth.PairingStart' })
      setPairingCode(result.data.code)
      setMessage(`Pairing code issued; expires in ${result.data.expires_in_seconds} seconds.`)
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onExchangePairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!pairingCode.trim() || busy) return
    setBusy('pairing-exchange')
    setMessage(null)
    const result = await client.authApi.pairingExchange({ code: pairingCode.trim() })
    setBusy(null)
    if (result.ok) {
      setToken(result.data.token)
      setMessage('Pairing exchange completed by Auth.PairingExchange; token remains in memory for this session and is not persisted in browser storage.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  return (
    <section className="aui-onboarding" aria-labelledby="onboarding-title">
      <PageHeader
        id="onboarding-title"
        eyebrow="First run"
        title="Connect Aurora"
        description="Choose a deployment mode, then authenticate or pair through SDK-backed Auth methods."
        badges={
          <>
            <StatusBadge state={model.authState} />
            <EvidenceBadge label={client.transport.kind} />
            <EvidenceBadge label={snapshot.evidenceSource} />
            <EvidenceBadge label={credentialStorageEvidence} />
          </>
        }
        badgesLabel="Onboarding status"
        actions={
          <button className="aui-primary-action" type="button" onClick={() => setMessage('Guided setup resumes from the first incomplete step: mode selection, Auth.Login/Auth.PairingStart, capability readiness, privacy review, then cockpit entry.') }>
            <Rocket size={15} aria-hidden />Start guided setup
          </button>
        }
      />
      <p className="aui-onboarding-mode-evidence" title={modePreferenceEvidence}>{presentableSignal(modePreferenceEvidence)}</p>

      <div className="aui-onboarding-grid">
        <section className="aui-onboarding-panel aui-mode-panel" aria-labelledby="mode-title">
          <h2 id="mode-title">Setup modes</h2>
          <div className="aui-mode-list" role="radiogroup" aria-label="Deployment mode">
            {model.modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={mode.id === model.selectedModeId ? 'aui-mode-card active' : 'aui-mode-card'}
                role="radio"
                aria-checked={mode.id === model.selectedModeId}
                disabled={mode.disabled || !modePreferenceReady}
                title={`${mode.routeLabel} · ${presentableSignal(mode.evidence)} · ${mode.repair}`}
                onClick={() => onSelectMode(mode.id)}
              >
                <ModeIcon id={mode.id} />
                <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
                <StatusBadge state={mode.state} />
                <em>{mode.routeLabel}</em>
              </button>
            ))}
          </div>
          <StateLine state={model.selectedMode.state} text={model.selectedMode.repair} />
        </section>

        <section className="aui-onboarding-panel aui-guided-setup" aria-labelledby="guided-setup-title">
          <h2 id="guided-setup-title"><Compass size={18} aria-hidden />Guided setup path</h2>
          <StateLine state="pending" text={`${model.resumeTitle}: ${model.resumeDetail}`} />
          <ol className="aui-setup-steps">
            {model.setupSteps.map((step, index) => (
              <li key={step.title}>
                <span className="aui-step-number">{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.detail.length > 120 ? `${step.detail.slice(0, 117)}…` : step.detail}</p>
                  <small title={step.repair}>{step.repair.length > 96 ? `${step.repair.slice(0, 93)}…` : step.repair}</small>
                  {step.progress !== null ? <div className="aui-setup-progress" aria-label={`${step.title} ${step.progress}% complete`}><span style={{ width: `${step.progress}%` }} /></div> : null}
                </div>
                <StatusBadge state={step.state} />
              </li>
            ))}
          </ol>
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="endpoint-title">
          <h2 id="endpoint-title">Endpoint</h2>
          <label htmlFor="aurora-endpoint">Gateway or local node URL</label>
          <input
            id="aurora-endpoint"
            value={endpoint}
            onChange={(event) => setEndpoint(event.currentTarget.value)}
            placeholder="https://aurora.example.test or http://127.0.0.1:8000"
            inputMode="url"
          />
          <button
            className="aui-action-chip"
            type="button"
            disabled={!endpoint.trim()}
            onClick={() => setMessage(`Endpoint validation: ${model.endpointEvidence}`)}
          >
            Validate endpoint
          </button>
          <StateLine state={model.endpointState} text={model.endpointEvidence} />
          {model.endpointState === 'denied' ? <p role="alert">Recovery: use an http:// or https:// Gateway URL, then retry authentication after the capability snapshot loads.</p> : null}
          <p>Endpoint checks are local syntax and SDK transport checks only; connection success is shown after Gateway/Auth responses arrive.</p>
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="auth-title" aria-live="polite">
          <h2 id="auth-title">Session</h2>
          <dl className="aui-onboarding-facts">
            <div><dt>State</dt><dd>{session.state}</dd></div>
            <div><dt>Principal</dt><dd>{session.principalName ?? session.principalId ?? 'not authenticated'}</dd></div>
            <div><dt>Credential</dt><dd>{session.credentialKind}</dd></div>
            <div><dt>Permissions</dt><dd>{session.effectivePermissions.join(', ') || 'none reported'}</dd></div>
          </dl>
          <StateLine state={model.authState} text={model.authExplanation} />
          {model.authState === 'denied' ? <p role="alert">Recovery: clear the session, then log in again, restore a freshly validated token, or exchange a newly approved pairing code.</p> : null}
          {session.isAuthenticated ? <a className="aui-primary-action" href={model.cockpitHref}>Enter cockpit</a> : null}
          {session.state === 'api_key_system' ? <p role="status">SYSTEM/API-key mode is visible because AuthSession reports an API-key or auth-disabled source.</p> : null}
          {session.isTerminal ? <button className="aui-action-chip" type="button" onClick={() => client.auth.clear()}>Clear session</button> : null}
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="login-title">
          <h2 id="login-title">Login or restore</h2>
          <form className="aui-onboarding-form" onSubmit={onLogin}>
            <label htmlFor="aurora-username">Username</label>
            <input id="aurora-username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} autoComplete="username" />
            <label htmlFor="aurora-password">Password</label>
            <input id="aurora-password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} type="password" autoComplete="current-password" />
            <button type="submit" disabled={busy !== null || !username.trim() || !password}>Login</button>
          </form>
          <form className="aui-onboarding-form" onSubmit={onValidateToken}>
            <label htmlFor="aurora-token">Existing token</label>
            <input id="aurora-token" value={token} onChange={(event) => setToken(event.currentTarget.value)} type="password" autoComplete="off" />
            <button type="submit" disabled={busy !== null || !token.trim()}>Restore token</button>
          </form>
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="pairing-title">
          <h2 id="pairing-title">Pairing code</h2>
          <label htmlFor="aurora-device-name">Device name</label>
          <input id="aurora-device-name" value={pairingDevice} onChange={(event) => setPairingDevice(event.currentTarget.value)} />
          <button className="aui-action-chip" type="button" disabled={busy !== null} onClick={onStartPairing}>Request pairing code</button>
          <form className="aui-onboarding-form" onSubmit={onExchangePairing}>
            <label htmlFor="aurora-pairing-code">Approved code</label>
            <input id="aurora-pairing-code" value={pairingCode} onChange={(event) => setPairingCode(event.currentTarget.value)} autoComplete="one-time-code" />
            <button type="submit" disabled={busy !== null || !pairingCode.trim()}>Exchange code</button>
          </form>
          <StateLine state={model.pairingState} text={model.pairingExplanation} />
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="mobile-first-launch-title">
          <h2 id="mobile-first-launch-title">Mobile first-launch copy</h2>
          <div className="aui-mobile-launch-list">
            {model.mobileNotes.map((note) => (
              <article key={note.platform}>
                <header><strong>{note.platform}</strong><StatusBadge state={note.state} /></header>
                <p>{note.detail}</p>
                <small>{presentableSignal(note.evidence)}</small>
              </article>
            ))}
          </div>
          <div className="aui-assistant-badges" aria-label="Mobile privacy classes">
            <EvidenceBadge label="audio capture permission" />
            <EvidenceBadge label="credential storage disabled" />
          </div>
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="platform-behavior-title">
          <h2 id="platform-behavior-title">Platform behavior</h2>
          <div className="aui-mobile-launch-list">
            {model.platformBehavior.map((note) => (
              <article key={note.label}>
                <header><strong>{note.label}</strong><StatusBadge state={note.state} /></header>
                <p>{note.behavior}</p>
                <small>{presentableSignal(note.evidence)}</small>
              </article>
            ))}
          </div>
        </section>

        <section className="aui-onboarding-panel" aria-labelledby="fallback-title">
          <h2 id="fallback-title">Fallbacks</h2>
          <ul className="aui-onboarding-list">
            {model.modes.filter((mode) => mode.disabled || mode.state === 'degraded').map((mode) => (
              <li key={mode.id}><StatusBadge state={mode.state} /> <span>{mode.label}: {mode.repair}</span></li>
            ))}
          </ul>
        </section>
      </div>
      {message ? <p className="aui-onboarding-message" role="alert">{message}</p> : null}
    </section>
  )
}

export function buildOnboardingViewModel({
  client,
  snapshot,
  selectedModeId,
  endpoint
}: {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  selectedModeId?: string
  endpoint?: string
}): OnboardingViewModel {
  const session = client.auth.refreshClock()
  const modes = deploymentModes(client.transport.kind, snapshot)
  const selected = selectedModeId && modes.some((mode) => mode.id === selectedModeId && !mode.disabled)
    ? selectedModeId
    : modes.find((mode) => !mode.disabled)?.id ?? modes[0]?.id ?? 'server-web'
  const authState = authAvailability(session)
  const pairingState = pairingAvailability(session, routeById(snapshot, 'mesh'))
  const selectedMode = modes.find((mode) => mode.id === selected) ?? modes[0] ?? mode('server-web', 'Server Web', 'Remote', 'No setup modes are available.', 'unsupported', 'No SDK transport status.', 'Reload the Aurora shell after the SDK initializes.')
  const steps = setupSteps({ session, snapshot, selectedMode, authState, pairingState })
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
    cockpitHref: '/'
  }
}

function deploymentModes(transportKind: string, snapshot: AuroraShellSnapshot): DeploymentModeCard[] {
  const meshRoute = routeById(snapshot, 'mesh')
  const desktopLocal = desktopLocalState(snapshot, transportKind)
  const desktopThin = desktopThinState(snapshot, transportKind)
  const android = androidMobileThinState(snapshot, transportKind)
  const ios = iosMobileThinState(snapshot, transportKind)
  return [
    mode('server-web', 'Server Web', 'Remote', 'Browser connected to an Aurora Gateway deployment for assistant and admin operation.', transportKind === 'http' ? 'available-remote' : transportKind === 'mock' ? 'degraded' : 'unsupported', transportKind === 'http' ? 'HTTP Gateway transport' : transportKind === 'mock' ? 'Demo transport, not a live server' : 'HTTP transport not active', 'Set AURORA_GATEWAY_URL or NEXT_PUBLIC_AURORA_GATEWAY_URL and validate Auth/Gateway responses.'),
    mode('desktop-local', 'Desktop Local', 'Local', 'Tauri desktop starts or attaches to the local Aurora Python node through sidecar/loopback/IPC status.', desktopLocal.state, desktopLocal.evidence, desktopLocal.repair),
    mode('desktop-thin', 'Desktop Thin', 'Remote desktop', 'Tauri desktop connects to a remote Gateway without starting a local Python sidecar.', desktopThin.state, desktopThin.evidence, desktopThin.repair),
    mode('mesh-shell', 'Mesh Shell', 'Mesh Peer', 'Pair with trusted peers and route only through peer capabilities and selector policy.', meshRoute?.state ?? 'unsupported', meshRoute?.providerLabel ?? 'mesh route not advertised', meshRoute?.explanation ?? 'Mesh pairing waits for Auth/Gateway capability status.'),
    mode('android-mobile-thin', 'Android Mobile Thin', 'Android thin', 'Android shell uses endpoint or pairing plus Android permission/keystore status; it does not run a local Python sidecar or guarantee assistant-role ownership.', android.state, android.evidence, android.repair),
    mode('ios-mobile-thin', 'iOS Mobile Thin', 'iOS thin', 'iOS shell uses endpoint or pairing plus Keychain/App Intents/Shortcuts/share/deep-link status; it does not claim system assistant replacement.', ios.state, ios.evidence, ios.repair),
    mode('offline-demo', 'Offline Demo', 'Fallback', 'Demo/demo-only exploration when no real Gateway is reachable; product data is explicitly labeled as mock status.', transportKind === 'mock' ? 'degraded' : 'unsupported', transportKind === 'mock' ? 'demo only via Demo transport' : clientTransportEvidence(transportKind), 'Use only for demos and visual review; connect a Gateway for production truth.')
  ]
}

function desktopLocalState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'tauri-local') {
    const nativeEvidence = snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native manifest pending'
    return {
      state: snapshot.loadState === 'ready' ? 'available-local' : 'pending',
      evidence: `${nativeEvidence}; local Gateway readiness is shown by the Tauri runtime panel`,
      repair: 'Run `pnpm --filter @aurora/tauri-ui tauri dev`; the Rust sidecar starts Python services in threads mode and reports Gateway health.'
    }
  }
  return {
    state: 'unsupported',
    evidence: `Current transport is ${transportKind}; no local sidecar status is available.`,
    repair: 'Switch to Desktop Local from Tauri or use Desktop Thin/Server Web for remote Gateway operation.'
  }
}

function desktopThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'http') {
    return {
      state: 'available-remote',
      evidence: 'HTTP Gateway transport; sidecar intentionally not used',
      repair: 'Validate the remote endpoint and authenticate with Auth.Login, token restore, or pairing before entering the cockpit.'
    }
  }
  if (transportKind === 'tauri-local') {
    return {
      state: 'pending',
      evidence: 'Tauri desktop can run thin mode when configured with a remote Gateway URL.',
      repair: 'Set the desktop-thin Gateway URL and restart without local sidecar startup.'
    }
  }
  return {
    state: transportKind === 'mock' ? 'degraded' : 'unsupported',
    evidence: transportKind === 'mock' ? 'demo only; no remote Gateway proof' : `Current transport is ${transportKind}.`,
    repair: 'Configure AURORA_GATEWAY_URL or NEXT_PUBLIC_AURORA_GATEWAY_URL for a remote Gateway.'
  }
}

function androidMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('android')) {
    return { state: 'available-remote', evidence: 'native-mobile Android transport with SDK native manifest status', repair: 'Continue with endpoint/pairing and store credentials only through Android keystore-backed native storage when advertised.' }
  }
  if (platform.includes('android')) {
    return { state: snapshot.nativeAvailable ? 'degraded' : 'unsupported', evidence: `Android manifest ${snapshot.nativeAvailable ? 'available' : 'missing'}; transport=${transportKind}`, repair: 'Use remote Gateway or mesh pairing; assistant role depends on package qualification, OS support, and user/OEM grant.' }
  }
  if (transportKind === 'http') {
    return { state: 'pending', evidence: 'HTTP transport can support Android thin after native shell packaging status.', repair: 'Pair or authenticate against the remote Gateway, then verify Android permissions and keystore capability in /settings/native.' }
  }
  return { state: 'unsupported', evidence: snapshot.nativePlatform || 'Android native manifest missing', repair: 'Android thin mode requires Android native manifest status or a remote Gateway URL.' }
}

function iosMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('ios')) {
    return { state: iosLocalLightState(snapshot) === 'unsupported' ? 'degraded' : iosLocalLightState(snapshot), evidence: iosLocalLightEvidence(snapshot), repair: 'Use Keychain for credentials when advertised; invoke through App Intents, Shortcuts, widgets, share sheet, file associations, or deep links only.' }
  }
  if (platform.includes('ios')) {
    return { state: snapshot.nativeAvailable ? iosLocalLightState(snapshot) : 'unsupported', evidence: iosLocalLightEvidence(snapshot), repair: 'iOS uses Siri/Shortcuts/App Intents, widgets, share sheet, and deep links in app-owned surfaces; system assistant ownership is unavailable.' }
  }
  if (transportKind === 'http') {
    return { state: 'pending', evidence: 'HTTP transport can support iOS thin after native shell packaging status.', repair: 'Pair or authenticate against the remote Gateway, then verify Keychain/App Intents/Shortcuts support in /settings/native.' }
  }
  return { state: 'unsupported', evidence: snapshot.nativePlatform || 'iOS native manifest missing', repair: 'iOS thin mode requires iOS native manifest status or a remote Gateway URL.' }
}

function mobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const android = androidMobileThinState(snapshot, transportKind)
  const ios = iosMobileThinState(snapshot, transportKind)
  if (android.state !== 'unsupported') return android
  return ios
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
  const ids = (snapshot.nativeMobileIntegrations ?? [])
    .filter((integration) => integration.platform === 'ios' && integration.id !== 'siriReplacement')
    .map((integration) => integration.id)
  return ids.length > 0 ? `iOS native manifest: ${ids.join(', ')}` : 'iOS native manifest missing'
}

function mode(id: string, label: string, routeLabel: string, description: string, state: AvailabilityState, evidence: string, repair: string): DeploymentModeCard {
  return { id, label, routeLabel, description, state, evidence, repair, disabled: !['available-local', 'available-remote', 'degraded', 'pending'].includes(state) }
}


function setupSteps(input: {
  session: AuthSessionSnapshot
  snapshot: AuroraShellSnapshot
  selectedMode: DeploymentModeCard
  authState: AvailabilityState
  pairingState: AvailabilityState
}): OnboardingSetupStep[] {
  const selectedMode = input.selectedMode.id === 'offline-demo'
    ? 'degraded'
    : input.selectedMode.id.includes('thin') || input.selectedMode.id === 'server-web'
      ? 'available-remote'
      : 'available-local'
  return [
    { title: 'Select mode', detail: 'Choose server web, desktop local, desktop thin, mesh shell, Android thin, iOS thin, or explicitly labeled offline demo.', state: selectedMode, progress: null, repair: input.selectedMode.repair },
    { title: 'Authenticate / pair', detail: 'Sign in, restore an in-memory token, enter pairing code, or load local owner identity through Auth SDK calls.', state: input.authState === 'pending' ? input.pairingState : input.authState, progress: input.session.isAuthenticated ? 100 : input.session.state === 'pairing' ? 45 : null, repair: input.session.isAuthenticated ? 'Session ready.' : 'If login fails, check endpoint reachability and retry Auth.Login, token restore, or Auth.PairingExchange.' },
    { title: 'Load capability graph', detail: `${input.snapshot.routeCount} routes, ${input.snapshot.availableCount} selectable routes, and native/peer manifests drive every screen.`, state: input.snapshot.loadState === 'ready' ? 'available-local' : input.snapshot.loadState === 'loading' ? 'pending' : 'denied', progress: input.snapshot.routeCount ? Math.min(100, Math.round((input.snapshot.availableCount / Math.max(1, input.snapshot.routeCount)) * 100)) : null, repair: input.snapshot.loadState === 'error' ? 'Retry the Gateway request after endpoint/auth recovery.' : 'Continue once Aurora returns capability status.' },
    { title: 'Review privacy defaults', detail: 'Confirm local-first routing, remote fallback, mesh selector policy, and native permission states before enabling sensitive actions.', state: input.snapshot.secretsRedacted ? 'available-local' : 'degraded', progress: input.snapshot.secretsRedacted ? 100 : 50, repair: input.snapshot.secretsRedacted ? 'Secrets are redacted in snapshot status.' : 'Repair backend redaction before exporting support bundles or logs.' },
    { title: 'Land in cockpit', detail: 'Assistant and Admin share the same production shell once route, auth, privacy, and platform status are loaded.', state: input.session.isAuthenticated || input.snapshot.loadState === 'ready' ? 'available-local' : 'pending', progress: input.session.isAuthenticated ? 100 : null, repair: 'Enter the cockpit only after route, auth, privacy, and platform status are visible.' }
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
      evidence: snapshot.nativeAssistantRole ? androidAssistantRoleEvidence(snapshot.nativeAssistantRole, snapshot.nativeFallbackEntrypoints.length) : 'Android assistant-role manifest status not present in this runtime.'
    },
    {
      platform: 'iOS',
      state: iosState,
      detail: 'Aurora integrates through Siri/Shortcuts/App Intents, widgets, share sheet, file associations, and deep links in app-owned surfaces only.',
      evidence: iosLocalLightEvidence(snapshot)
    }
  ]
}

function platformBehaviorNotes(snapshot: AuroraShellSnapshot, transportKind: string): PlatformBehaviorNote[] {
  const meshRoute = routeById(snapshot, 'mesh')
  const meshState = meshRoute?.state ?? 'unsupported'
  const meshEvidence = meshRoute
    ? `${meshRoute.providerLabel}; routeable=${String(meshRoute.routeable)}; blockers=${presentableSignal(meshRoute.blockers.join(',') || 'none')}`
    : 'Mesh route is not present in the capability graph.'
  const desktopState: AvailabilityState = transportKind === 'tauri-local' && !meshRoute?.disabled ? 'available-local' : transportKind === 'tauri-local' ? 'degraded' : 'unsupported'
  const webState: AvailabilityState = transportKind === 'http' ? meshState : transportKind === 'mock' ? 'degraded' : 'unsupported'
  const androidState = androidMobileThinState(snapshot, transportKind).state
  const iosState = iosMobileThinState(snapshot, transportKind).state
  return [
    {
      label: 'Desktop Tauri local',
      state: desktopState,
      behavior: 'Desktop local can be a full node only when the local Gateway reports mesh enabled and routeable; otherwise it stays a supervised local shell with explicit repair status.',
      evidence: transportKind === 'tauri-local' ? meshEvidence : `Current transport is ${transportKind}; desktop-local full-node behavior requires Tauri local Gateway status.`
    },
    {
      label: 'Web thin',
      state: webState,
      behavior: 'Web thin can view and manage remote mesh only through Gateway APIs and AdminAction receipts; it never starts a sidecar or claims local node hosting.',
      evidence: transportKind === 'http' ? meshEvidence : `Current transport is ${transportKind}; use HTTP Gateway transport for web-thin mesh management.`
    },
    {
      label: 'Android mobile thin',
      state: androidState,
      behavior: 'Android mobile thin can pair and invoke remote or mesh capabilities through Gateway/native manifest status, while assistant-role ownership remains conditional on OS/OEM/user grants.',
      evidence: androidMobileThinState(snapshot, transportKind).evidence
    },
    {
      label: 'iOS mobile thin',
      state: iosState,
      behavior: 'iOS mobile thin can pair and invoke remote or mesh capabilities from app-owned surfaces only; it must not claim system assistant replacement.',
      evidence: iosMobileThinState(snapshot, transportKind).evidence
    }
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

function defaultModeId(transportKind: string, snapshot?: AuroraShellSnapshot): string {
  if (transportKind === 'tauri-local') return 'desktop-local'
  if (transportKind === 'native-mobile' && snapshot?.nativePlatform.toLowerCase().includes('ios')) return 'ios-mobile-thin'
  if (transportKind === 'native-mobile') return 'android-mobile-thin'
  if (transportKind === 'mock') return 'offline-demo'
  return 'server-web'
}

function isSupportedModeId(modeId: string): boolean {
  return supportedModeIds.has(modeId)
}

const supportedModeIds = new Set([
  'server-web',
  'desktop-local',
  'desktop-thin',
  'mesh-shell',
  'android-mobile-thin',
  'ios-mobile-thin',
  'offline-demo'
])

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

function StateLine({ state, text }: { state: AvailabilityState; text: string }) {
  return <p className="aui-state-line"><StatusBadge state={state} /> <span>{text}</span></p>
}

function ModeIcon({ id }: { id: string }) {
  const props = { size: 18, 'aria-hidden': true as const }
  if (id === 'server-web') return <Server {...props} />
  if (id === 'desktop-local') return <Monitor {...props} />
  if (id === 'desktop-thin') return <Monitor {...props} />
  if (id === 'mesh-shell') return <RadioTower {...props} />
  if (id === 'android-mobile-thin' || id === 'ios-mobile-thin' || id === 'mobile-thin') return <Smartphone {...props} />
  if (id === 'offline-demo') return <PlugZap {...props} />
  if (id === 'auth') return <KeyRound {...props} />
  return <ShieldCheck {...props} />
}

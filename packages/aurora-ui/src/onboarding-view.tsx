'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Compass, KeyRound, Monitor, PlugZap, RadioTower, Rocket, Server, ShieldCheck, Smartphone } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthSessionSnapshot, AvailabilityState } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { EvidenceBadge, StatusBadge } from './status-badges'

export interface OnboardingViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
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
}

export interface MobileFirstLaunchNote {
  platform: 'Android' | 'iOS'
  state: AvailabilityState
  detail: string
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
  mobileNotes: MobileFirstLaunchNote[]
  cockpitHref: string
}

const credentialStorageEvidence = 'browser token persistence disabled'

export function OnboardingView({ client, snapshot }: OnboardingViewProps) {
  const [session, setSession] = useState(() => client.auth.refreshClock())
  const [selectedModeId, setSelectedModeId] = useState(() => defaultModeId(client.transport.kind))
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
      <header className="aui-onboarding-header">
        <div>
          <p className="aui-kicker">First run</p>
          <h1 id="onboarding-title">Connect Aurora</h1>
          <p>Choose server web, desktop local, mesh shell, mobile thin, or explicitly labeled offline demo mode, then authenticate or pair through SDK-backed Auth methods.</p>
        </div>
        <button className="aui-primary-action" type="button" onClick={() => setMessage('Guided setup starts with mode selection, Auth.Login/Auth.PairingStart, capability graph load, privacy review, and cockpit entry.') }>
          <Rocket size={15} aria-hidden />Start guided setup
        </button>
        <div className="aui-assistant-badges" aria-label="Onboarding evidence">
          <StatusBadge state={model.authState} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={credentialStorageEvidence} />
        </div>
      </header>

      <div className="aui-onboarding-grid">
        <section className="aui-onboarding-panel aui-mode-panel" aria-labelledby="mode-title">
          <h2 id="mode-title">Setup modes</h2>
          <div className="aui-mode-list" role="radiogroup" aria-label="Deployment mode">
            {model.modes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={mode.id === selectedModeId ? 'aui-mode-card active' : 'aui-mode-card'}
                role="radio"
                aria-checked={mode.id === selectedModeId}
                disabled={mode.disabled}
                onClick={() => setSelectedModeId(mode.id)}
              >
                <ModeIcon id={mode.id} />
                <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
                <StatusBadge state={mode.state} />
                <em><b>{mode.routeLabel}</b> · {mode.evidence}</em>
              </button>
            ))}
          </div>
        </section>

        <section className="aui-onboarding-panel aui-guided-setup" aria-labelledby="guided-setup-title">
          <h2 id="guided-setup-title"><Compass size={18} aria-hidden />Guided setup path</h2>
          <ol className="aui-setup-steps">
            {model.setupSteps.map((step, index) => (
              <li key={step.title}>
                <span className="aui-step-number">{index + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.detail}</p>
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
          <StateLine state={model.endpointState} text={model.endpointEvidence} />
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
                <small>{note.evidence}</small>
              </article>
            ))}
          </div>
          <div className="aui-assistant-badges" aria-label="Mobile privacy classes">
            <EvidenceBadge label="audio capture permission" />
            <EvidenceBadge label="credential storage disabled" />
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
  return {
    session,
    modes,
    selectedModeId: selected,
    endpointState: endpointState(endpoint, client.transport.kind, snapshot.loadState),
    endpointEvidence: endpointEvidence(endpoint, client.transport.kind, snapshot.loadState),
    authState: authAvailability(session),
    authExplanation: authExplanation(session),
    pairingState: pairingAvailability(session, routeById(snapshot, 'mesh')), 
    pairingExplanation: pairingExplanation(session, routeById(snapshot, 'mesh')),
    setupSteps: setupSteps({ session, snapshot, selectedModeId: selected, authState: authAvailability(session), pairingState: pairingAvailability(session, routeById(snapshot, 'mesh')) }),
    mobileNotes: mobileFirstLaunchNotes(snapshot),
    cockpitHref: '/'
  }
}

function deploymentModes(transportKind: string, snapshot: AuroraShellSnapshot): DeploymentModeCard[] {
  const meshRoute = routeById(snapshot, 'mesh')
  const mobile = mobileThinState(snapshot, transportKind)
  return [
    mode('server-web', 'Server Web', 'Remote', 'Browser connected to an Aurora Gateway deployment for assistant and admin operation.', transportKind === 'http' ? 'available-remote' : transportKind === 'mock' ? 'degraded' : 'unsupported', transportKind === 'http' ? 'HTTP Gateway transport' : transportKind === 'mock' ? 'SDK mock transport fixture, not a live server' : 'HTTP transport not active', 'Set AURORA_GATEWAY_URL or NEXT_PUBLIC_AURORA_GATEWAY_URL and validate Auth/Gateway responses.'),
    mode('desktop-local', 'Desktop Local', 'Local', 'Tauri desktop starts or attaches to the local Aurora Python node through sidecar/loopback/IPC evidence.', transportKind === 'tauri-local' || snapshot.nativeAvailable ? 'available-local' : 'unsupported', snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native manifest missing', 'Requires Tauri desktop local runtime evidence and Gateway readiness before claiming local node control.'),
    mode('mesh-shell', 'Mesh Shell', 'Mesh Peer', 'Pair with trusted peers and route only through peer capabilities and selector policy.', meshRoute?.state ?? 'unsupported', meshRoute?.providerLabel ?? 'mesh route not advertised', meshRoute?.explanation ?? 'Mesh pairing waits for Auth/Gateway capability evidence.'),
    mode('mobile-thin', 'Mobile Thin', 'Native Mobile', 'Android/iOS shell that uses native permissions with server or mesh transport first; it does not claim unsupported local daemon or system assistant replacement behavior.', mobile.state, mobile.evidence, mobile.repair),
    mode('offline-demo', 'Offline Demo', 'Fallback', 'Fixture/demo-only exploration when no real Gateway is reachable; product data is explicitly labeled as mock evidence.', transportKind === 'mock' ? 'degraded' : 'unsupported', transportKind === 'mock' ? 'fixture/demo only via SDK mock transport' : clientTransportEvidence(transportKind), 'Use only for demos and visual review; connect a Gateway for production truth.')
  ]
}

function mobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'native-mobile') {
    return { state: 'available-remote', evidence: `native-mobile transport on ${snapshot.nativePlatform}`, repair: 'Continue with server or mesh transport; local Python sidecar is not claimed on mobile.' }
  }
  if (snapshot.nativePlatform.toLowerCase().includes('android')) {
    return { state: snapshot.nativeAvailable ? 'degraded' : 'unsupported', evidence: `Android manifest ${snapshot.nativeAvailable ? 'available' : 'missing'}`, repair: 'Assistant role depends on package qualification, OS support, and user/OEM grant; fallbacks stay visible.' }
  }
  if (snapshot.nativePlatform.toLowerCase().includes('ios')) {
    return { state: snapshot.nativeAvailable ? 'degraded' : 'unsupported', evidence: iosLocalLightEvidence(snapshot), repair: 'iOS uses Siri/Shortcuts/App Intents, widgets, share sheet, and deep links in app-owned surfaces; system assistant ownership is unavailable.' }
  }
  if (transportKind === 'http') {
    return { state: 'available-remote', evidence: 'web/thin HTTP transport', repair: 'Use browser permissions for mic/camera and pair/authenticate against the remote Gateway.' }
  }
  return { state: 'unsupported', evidence: snapshot.nativePlatform || 'native mobile manifest missing', repair: 'Android/iOS thin mode requires a mobile native manifest or a remote Gateway URL.' }
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
  selectedModeId: string
  authState: AvailabilityState
  pairingState: AvailabilityState
}): OnboardingSetupStep[] {
  const selectedMode = input.selectedModeId === 'offline-demo' ? 'degraded' : 'available-local'
  return [
    { title: 'Select mode', detail: 'Choose server web, desktop local, mesh shell, mobile thin, or explicitly labeled offline demo.', state: selectedMode, progress: null },
    { title: 'Authenticate / pair', detail: 'Sign in, restore an in-memory token, enter pairing code, or load local owner identity through Auth SDK calls.', state: input.authState === 'pending' ? input.pairingState : input.authState, progress: input.session.isAuthenticated ? 100 : input.session.state === 'pairing' ? 45 : null },
    { title: 'Load capability graph', detail: `${input.snapshot.routeCount} routes, ${input.snapshot.availableCount} selectable routes, and native/peer manifests drive every screen.`, state: input.snapshot.loadState === 'ready' ? 'available-local' : input.snapshot.loadState === 'loading' ? 'pending' : 'denied', progress: input.snapshot.routeCount ? Math.min(100, Math.round((input.snapshot.availableCount / Math.max(1, input.snapshot.routeCount)) * 100)) : null },
    { title: 'Review privacy defaults', detail: 'Confirm local-first routing, remote fallback, mesh selector policy, and native permission states before enabling sensitive actions.', state: input.snapshot.secretsRedacted ? 'available-local' : 'degraded', progress: input.snapshot.secretsRedacted ? 100 : 50 },
    { title: 'Land in cockpit', detail: 'Assistant and Admin share the same production shell once route, auth, privacy, and platform evidence are loaded.', state: input.session.isAuthenticated || input.snapshot.loadState === 'ready' ? 'available-local' : 'pending', progress: input.session.isAuthenticated ? 100 : null }
  ]
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
      evidence: snapshot.nativeAssistantRole ? androidAssistantRoleEvidence(snapshot.nativeAssistantRole, snapshot.nativeFallbackEntrypoints.length) : 'Android assistant-role manifest evidence not present in this runtime.'
    },
    {
      platform: 'iOS',
      state: iosState,
      detail: 'Aurora integrates through Siri/Shortcuts/App Intents, widgets, share sheet, file associations, and deep links in app-owned surfaces only.',
      evidence: iosLocalLightEvidence(snapshot)
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
  if (loadState === 'error') return 'AuroraClient could not load the capability snapshot.'
  if (transportKind === 'mock') return 'No Gateway URL is configured; the UI is using SDK mock fixtures as a degraded development fallback.'
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
  if (session.isAuthenticated) return 'AuthSession is authenticated from SDK/backend evidence.'
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
  return meshRoute?.explanation ?? 'Pairing is unavailable until Auth pairing methods and mesh capability evidence are exposed.'
}

function routeById(snapshot: AuroraShellSnapshot, id: string): RouteAvailability | undefined {
  return snapshot.routes.find((route) => route.item.id === id)
}

function defaultModeId(transportKind: string): string {
  if (transportKind === 'tauri-local') return 'desktop-local'
  if (transportKind === 'native-mobile') return 'mobile-thin'
  if (transportKind === 'mock') return 'offline-demo'
  return 'server-web'
}

function clientTransportEvidence(transportKind: string): string {
  return transportKind || 'transport not reported'
}

function onboardingErrorMessage(error: AuroraError): string {
  if (error.code === 'auth') return 'Auth request was denied or expired.'
  if (error.code === 'permission') return 'Current principal lacks permission for this Auth action.'
  if (error.code === 'unsupported_feature') return 'This backend or mock transport does not expose the required Auth method yet.'
  if (error.code === 'timeout') return 'Auth request timed out before backend confirmation.'
  return error.message || 'Onboarding request failed.'
}

function StateLine({ state, text }: { state: AvailabilityState; text: string }) {
  return <p className="aui-state-line"><StatusBadge state={state} /> <span>{text}</span></p>
}

function ModeIcon({ id }: { id: string }) {
  const props = { size: 18, 'aria-hidden': true as const }
  if (id === 'server-web') return <Server {...props} />
  if (id === 'desktop-local') return <Monitor {...props} />
  if (id === 'mesh-shell') return <RadioTower {...props} />
  if (id === 'mobile-thin') return <Smartphone {...props} />
  if (id === 'offline-demo') return <PlugZap {...props} />
  if (id === 'auth') return <KeyRound {...props} />
  return <ShieldCheck {...props} />
}

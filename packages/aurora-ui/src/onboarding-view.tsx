'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { KeyRound, Monitor, PlugZap, RadioTower, Server, ShieldCheck, Smartphone } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthSessionSnapshot, AvailabilityState } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { EvidenceBadge, StatusBadge } from './status-badges'

export interface OnboardingViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  storageKey?: string
}

export interface DeploymentModeCard {
  id: string
  label: string
  description: string
  state: AvailabilityState
  disabled: boolean
  evidence: string
  repair: string
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
  cockpitHref: string
}

const defaultStorageKey = 'aurora.auth.token.v1'

export function OnboardingView({ client, snapshot, storageKey = defaultStorageKey }: OnboardingViewProps) {
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
  const [tokenRestoreStatus, setTokenRestoreStatus] = useState('not checked')

  const model = useMemo(
    () => buildOnboardingViewModel({ client, snapshot, selectedModeId, endpoint }),
    [client, snapshot, selectedModeId, endpoint, session]
  )

  useEffect(() => {
    return client.auth.subscribe(setSession)
  }, [client])

  useEffect(() => {
    const restored = readStoredToken(storageKey)
    if (!restored) {
      setTokenRestoreStatus('no stored token')
      return
    }
    setTokenRestoreStatus('validating stored token')
    setToken(restored)
    client.authApi.validateToken({ token: restored }).then((result) => {
      if (result.ok) {
        setTokenRestoreStatus(result.data.valid ? 'stored token accepted by Auth.ValidateToken' : 'stored token rejected')
        return
      }
      setTokenRestoreStatus(`stored token validation failed: ${onboardingErrorMessage(result.error)}`)
    })
  }, [client, storageKey])

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!username.trim() || !password || busy) return
    setBusy('login')
    setMessage(null)
    const result = await client.authApi.login({ username: username.trim(), password })
    setBusy(null)
    if (result.ok) {
      storeToken(storageKey, result.data.token)
      setToken(result.data.token)
      setPassword('')
      setMessage('Login accepted by Auth.Login; capability manifest can now refresh before entering cockpit.')
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
      if (result.data.valid) storeToken(storageKey, token.trim())
      setMessage(result.data.valid ? 'Token restored through Auth.ValidateToken.' : 'Token was rejected by Auth.ValidateToken.')
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
      storeToken(storageKey, result.data.token)
      setToken(result.data.token)
      setMessage('Pairing exchange completed by Auth.PairingExchange; peer/session identity is backend-proven.')
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
          <p>Choose a deployment mode, validate the endpoint boundary, then authenticate or pair through SDK-backed Auth methods.</p>
        </div>
        <div className="aui-assistant-badges" aria-label="Onboarding evidence">
          <StatusBadge state={model.authState} />
          <EvidenceBadge label={client.transport.kind} />
          <EvidenceBadge label={snapshot.evidenceSource} />
          <EvidenceBadge label={tokenRestoreStatus} />
        </div>
      </header>

      <div className="aui-onboarding-grid">
        <section className="aui-onboarding-panel aui-mode-panel" aria-labelledby="mode-title">
          <h2 id="mode-title">Deployment mode</h2>
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
                <em>{mode.evidence}</em>
              </button>
            ))}
          </div>
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
    cockpitHref: '/'
  }
}

function deploymentModes(transportKind: string, snapshot: AuroraShellSnapshot): DeploymentModeCard[] {
  const meshRoute = routeById(snapshot, 'mesh')
  return [
    mode('server-web', 'Server Web', 'Browser connected to an Aurora Gateway.', transportKind === 'http' ? 'available-remote' : transportKind === 'mock' ? 'degraded' : 'unsupported', transportKind === 'http' ? 'HTTP Gateway transport' : transportKind === 'mock' ? 'SDK mock transport fixture' : 'HTTP transport not active', 'Set AURORA_GATEWAY_URL or NEXT_PUBLIC_AURORA_GATEWAY_URL.'),
    mode('desktop-local', 'Desktop Local', 'Local desktop shell or sidecar node.', transportKind === 'tauri-local' || snapshot.nativeAvailable ? 'available-local' : 'unsupported', snapshot.nativeAvailable ? `native ${snapshot.nativePlatform}` : 'native manifest missing', 'Requires the future Tauri/native capability manifest.'),
    mode('mesh-peer', 'Mesh Peer', 'Pair with or reconnect to a mesh node.', meshRoute?.state ?? 'unsupported', meshRoute?.providerLabel ?? 'mesh route not advertised', meshRoute?.explanation ?? 'Mesh pairing waits for Auth/Gateway capability evidence.'),
    mode('android-thin', 'Android Thin', 'Android client against a remote Gateway.', transportKind === 'native-mobile' && snapshot.nativePlatform.toLowerCase().includes('android') ? 'available-remote' : 'unsupported', snapshot.nativePlatform, 'Android native/local features require native manifest support.'),
    mode('ios-thin', 'iOS Thin', 'iOS client against a remote Gateway.', transportKind === 'native-mobile' && snapshot.nativePlatform.toLowerCase().includes('ios') ? 'available-remote' : 'unsupported', snapshot.nativePlatform, 'iOS remains app-owned surfaces only with Siri/Shortcuts/App Intents integration; Siri replacement is unsupported.'),
    mode('offline-local', 'Offline Local', 'Local degraded mode without Gateway reachability.', transportKind === 'mock' ? 'degraded' : transportKind === 'tauri-local' ? 'available-local' : 'unsupported', transportKind === 'mock' ? 'development fixture only' : clientTransportEvidence(transportKind), 'Offline/local mode must be proven by SDK/native service evidence.')
  ]
}

function mode(id: string, label: string, description: string, state: AvailabilityState, evidence: string, repair: string): DeploymentModeCard {
  return { id, label, description, state, evidence, repair, disabled: !['available-local', 'available-remote', 'degraded', 'pending'].includes(state) }
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
  if (transportKind === 'native-mobile') return 'android-thin'
  if (transportKind === 'mock') return 'offline-local'
  return 'server-web'
}

function clientTransportEvidence(transportKind: string): string {
  return transportKind || 'transport not reported'
}

function readStoredToken(storageKey: string): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(storageKey)
}

function storeToken(storageKey: string, value: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storageKey, value)
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
  if (id === 'mesh-peer') return <RadioTower {...props} />
  if (id === 'android-thin' || id === 'ios-thin') return <Smartphone {...props} />
  if (id === 'offline-local') return <PlugZap {...props} />
  if (id === 'auth') return <KeyRound {...props} />
  return <ShieldCheck {...props} />
}

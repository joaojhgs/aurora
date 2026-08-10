'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, KeyRound, Monitor, Server, ShieldCheck, Smartphone } from 'lucide-react'
import type { AuroraClient, AuroraError, AuthSessionSnapshot, AvailabilityState } from '@aurora/client'
import type { AuroraShellSnapshot, RouteAvailability } from './shell-data'
import { presentableSignal } from './status-badges'
import { getAuroraSurfaceProfile } from './platform-surface'
import { PRODUCT_COPY, productStatusCopy, safeErrorCopy } from './product-copy'
import type { AuroraNodeMode, AuroraRuntimeTier } from './runtime-profile'
import { Button, FormField } from './primitives'
import { buttonVariants } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { cn } from '#lib/utils'

export interface OnboardingViewProps {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  modePreferenceStore?: OnboardingModePreferenceStore | undefined
  onApplyModePreference?: (() => Promise<void>) | undefined
  onUseManualAddress?: ((address: string) => Promise<void>) | undefined
  thinConnectionPanel?: ReactNode
  renderThinConnectionPanel?: ((modeId: OnboardingProductModeId) => ReactNode)
  setupRequired?: boolean | undefined
}

export interface OnboardingModePreferenceStore {
  evidence: string
  readSelectedMode: () => Promise<string | null>
  writeSelectedMode: (modeId: string) => Promise<boolean>
  readSelectedRuntimeTier?: (() => Promise<string | null>) | undefined
  writeSelectedRuntimeTier?: ((runtimeTier: string) => Promise<boolean>) | undefined
}

export type OnboardingProductModeId = 'connect-to-aurora' | 'make-this-device-available' | 'run-aurora-on-this-computer'

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

export function OnboardingView({
  client,
  snapshot,
  modePreferenceStore,
  onApplyModePreference,
  onUseManualAddress,
  thinConnectionPanel,
  renderThinConnectionPanel,
  setupRequired = false,
}: OnboardingViewProps) {
  const [session, setSession] = useState(() => client.auth.refreshClock())
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const [selectedModeId, setSelectedModeId] = useState(() => defaultModeId(client.transport.kind, snapshot, userAgent))
  const [modePreferenceReady, setModePreferenceReady] = useState(() => !modePreferenceStore)
  const [modePreferenceStatus, setModePreferenceStatus] = useState('Saved for this session')
  const modeSelectionTouchedRef = useRef(false)
  const modeSelectionRevisionRef = useRef(0)
  const [endpoint, setEndpoint] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [token, setToken] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [pairingDevice, setPairingDevice] = useState('Aurora device')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [wizardStep, setWizardStep] = useState<'detect' | 'setup' | 'done'>('detect')
  const [manualAddressVisible, setManualAddressVisible] = useState(false)
  const hasThinConnectionPanel = Boolean(thinConnectionPanel || renderThinConnectionPanel)
  const allowBrowserDeviceSetup = setupRequired && Boolean(modePreferenceStore && hasThinConnectionPanel)

  const model = useMemo(
    () =>
      buildOnboardingViewModel({
        client,
        snapshot,
        selectedModeId,
        endpoint,
        userAgent,
        allowBrowserDeviceSetup,
        setupRequired,
      }),
    [allowBrowserDeviceSetup, client, snapshot, selectedModeId, endpoint, session, setupRequired, userAgent],
  )

  useEffect(() => {
    return client.auth.subscribe(setSession)
  }, [client])

  function persistModePreference(modeId: OnboardingProductModeId, shouldApply: () => boolean = () => true) {
    if (!modePreferenceStore) {
      setModePreferenceReady(true)
      return
    }
    const revision = ++modeSelectionRevisionRef.current
    const preference = productModePreference(modeId)
    setModePreferenceReady(false)
    setModePreferenceStatus(`Saving ${modeLabel(modeId)}`)
    void Promise.all([
      modePreferenceStore.writeSelectedMode(preference.nodeMode),
      modePreferenceStore.writeSelectedRuntimeTier?.(preference.runtimeTier) ?? Promise.resolve(true),
    ]).then(
      ([modeOk, tierOk]) => {
        if (!shouldApply() || revision !== modeSelectionRevisionRef.current) return
        setModePreferenceStatus(modeOk && tierOk ? `Saved ${modeLabel(modeId)}` : 'Choice not saved')
        setModePreferenceReady(modeOk && tierOk)
      },
      () => {
        if (!shouldApply() || revision !== modeSelectionRevisionRef.current) return
        setModePreferenceStatus('Choice not saved')
        setModePreferenceReady(false)
      },
    )
  }

  useEffect(() => {
    let cancelled = false
    if (!modePreferenceStore) {
      setModePreferenceReady(true)
      setModePreferenceStatus('Saved for this session')
      return () => {
        cancelled = true
      }
    }
    if (modeSelectionTouchedRef.current) {
      return () => {
        cancelled = true
      }
    }
    setModePreferenceReady(false)
    setModePreferenceStatus('Checking saved choice')
    void Promise.all([
      modePreferenceStore.readSelectedMode(),
      modePreferenceStore.readSelectedRuntimeTier?.() ?? Promise.resolve(null),
    ]).then(
      ([modeId, runtimeTier]) => {
        if (cancelled) return
        const productModeId = modeId ? storedModeToProductModeId(modeId, runtimeTier) : null
        const availableModeId = productModeId
          ? availableProductModeId(productModeId, client.transport.kind, snapshot, userAgent, { allowBrowserDeviceSetup })
          : null
        const savedLocalModeIsStillStarting = productModeId === 'run-aurora-on-this-computer'
          && client.transport.kind === 'tauri-local'
          && !snapshot.nativeAvailable
        if (availableModeId && !modeSelectionTouchedRef.current) {
          setSelectedModeId(availableModeId)
          setModePreferenceStatus(`Restored ${modeLabel(availableModeId)}`)
          setModePreferenceReady(true)
        } else if (modeId && !modeSelectionTouchedRef.current) {
          const fallbackModeId = availableProductModeId(
            selectedModeId,
            client.transport.kind,
            snapshot,
            userAgent,
            { allowBrowserDeviceSetup },
          ) ?? deploymentModes(client.transport.kind, snapshot, userAgent, { allowBrowserDeviceSetup })
            .find((mode) => !mode.disabled)?.id as OnboardingProductModeId | undefined
          if (fallbackModeId) {
            setSelectedModeId(fallbackModeId)
            if (savedLocalModeIsStillStarting) {
              setModePreferenceStatus('Saved choice is not available yet')
              setModePreferenceReady(false)
            } else {
              modeSelectionTouchedRef.current = true
              persistModePreference(fallbackModeId, () => !cancelled)
            }
          } else {
            setModePreferenceStatus('Choose how to use this device')
            setModePreferenceReady(false)
          }
        } else if (!modeSelectionTouchedRef.current) {
          const fallbackModeId = availableProductModeId(
            selectedModeId,
            client.transport.kind,
            snapshot,
            userAgent,
            { allowBrowserDeviceSetup },
          ) ?? defaultModeId(client.transport.kind, snapshot, userAgent)
          modeSelectionTouchedRef.current = true
          setSelectedModeId(fallbackModeId)
          persistModePreference(fallbackModeId, () => !cancelled)
        }
      },
      () => {
        if (!cancelled && !modeSelectionTouchedRef.current) {
          const fallbackModeId = defaultModeId(client.transport.kind, snapshot, userAgent)
          modeSelectionTouchedRef.current = true
          setSelectedModeId(fallbackModeId)
          persistModePreference(fallbackModeId, () => !cancelled)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [allowBrowserDeviceSetup, client.transport.kind, modePreferenceStore, snapshot, userAgent])

  function onSelectMode(modeId: string) {
    if (!isSupportedModeId(modeId)) return
    modeSelectionTouchedRef.current = true
    setSelectedModeId(modeId)
    if (!modePreferenceStore) {
      setModePreferenceReady(true)
      return
    }
    persistModePreference(modeId)
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
      setMessage('Signed in for this session.')
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
        reason: 'Pairing code created',
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
      setMessage('Pairing complete.')
      return
    }
    setMessage(onboardingErrorMessage(result.error))
  }

  async function onFinishSetup() {
    if (busy) return
    if (!onApplyModePreference) {
      setWizardStep('done')
      return
    }
    setBusy('mode-apply')
    setMessage(null)
    try {
      await onApplyModePreference()
      setWizardStep('done')
    } catch {
      setMessage('Aurora could not apply this choice. Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function onManualAddress() {
    const address = endpoint.trim()
    if (!address || busy) return
    if (!onUseManualAddress) {
      setMessage('Aurora could not use this address. Check it and try again.')
      return
    }
    setBusy('manual-address')
    setMessage(null)
    try {
      await onUseManualAddress(address)
      setMessage('Address saved for this setup session.')
    } catch {
      setMessage('Aurora could not use this address. Check it and try again.')
    } finally {
      setBusy(null)
    }
  }

  const selectedProductModeId = model.selectedMode.id as OnboardingProductModeId
  const activeThinConnectionPanel = renderThinConnectionPanel?.(selectedProductModeId) ?? thinConnectionPanel
  const selectedConnectMode = selectedProductModeId === 'connect-to-aurora'
  const manualAddressAvailable = Boolean(onUseManualAddress)
  const manualAddressGated = manualAddressAvailable && setupRequired && Boolean(activeThinConnectionPanel) && selectedConnectMode
  const showManualAddress = manualAddressAvailable && selectedConnectMode && (!manualAddressGated || manualAddressVisible)
  const showFirstRunInviteFlow = setupRequired && !activeThinConnectionPanel
  const showAccountAuthFlow = !setupRequired

  return (
    <section className="aui-onboarding-scroll-viewport min-h-0 w-full overflow-y-auto px-0" aria-labelledby="onboarding-title">
      <div className="aui-onboarding-content mx-auto flex max-w-xl flex-col gap-6 px-6 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="text-center">
        <h1 id="onboarding-title" className="text-xl font-semibold tracking-tight">
          {PRODUCT_COPY.onboarding.title}
        </h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">
          {setupRequired ? setupSubtitle(selectedProductModeId) : 'Choose how you want to use Aurora on this device.'}
        </p>
      </div>

      {wizardStep === 'detect' ? (
        <div className="flex flex-col gap-4" data-step="detect">
          <div>
            <p className="mb-2.5 text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">First step</p>
            <div className="flex flex-col gap-2.5" role="radiogroup" aria-label="Aurora setup choice">
              {model.modes.map((mode) => {
                const active = mode.id === model.selectedModeId
                return (
                  <button
                    key={mode.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={mode.disabled}
                    title={mode.label}
                    onClick={() => onSelectMode(mode.id)}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border p-3.5 text-left ring-1 ring-foreground/10 transition-colors',
                      active ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-foreground/30',
                      mode.disabled && 'cursor-not-allowed opacity-60'
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
          <p className="text-[11.5px] text-muted-foreground">{modePreferenceStatus}</p>
          <Button variant="primary" onClick={() => setWizardStep('setup')} disabled={!modePreferenceReady}>
            Continue
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
              Change choice
            </button>
          </div>

          {activeThinConnectionPanel ? (
            <div className="flex flex-col gap-3" data-step="home-node-connection">
              {activeThinConnectionPanel}
            </div>
          ) : null}

          {showFirstRunInviteFlow ? (
            <section aria-labelledby="first-run-device-title" className="flex flex-col gap-2.5">
              <h2 id="first-run-device-title" className="text-sm font-semibold">
                This device
              </h2>
              <FormField label="Device name" htmlFor="aurora-device-name">
                <Input id="aurora-device-name" value={pairingDevice} onChange={(event) => setPairingDevice(event.currentTarget.value)} />
              </FormField>
            </section>
          ) : null}

          {manualAddressGated && !manualAddressVisible ? (
            <Button variant="ghost" onClick={() => setManualAddressVisible(true)}>
              {PRODUCT_COPY.onboarding.invite.advanced}
            </Button>
          ) : null}

          {showManualAddress ? (
            <section aria-labelledby="gateway-title" className="flex flex-col gap-2.5">
              <h2 id="gateway-title" className="text-sm font-semibold">
                {PRODUCT_COPY.connection.addressLabel}
              </h2>
              <FormField label={PRODUCT_COPY.connection.addressLabel} htmlFor="aurora-endpoint">
                <Input
                  id="aurora-endpoint"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.currentTarget.value)}
                  placeholder="Aurora address"
                  inputMode="url"
                />
              </FormField>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy !== null || !endpoint.trim()} onClick={() => void onManualAddress()}>
                  {busy === 'manual-address' ? 'Saving address…' : 'Use this address'}
                </Button>
                {manualAddressGated ? (
                  <Button variant="ghost" onClick={() => setManualAddressVisible(false)}>
                    Use invite instead
                  </Button>
                ) : null}
              </div>
            </section>
          ) : null}

          {showAccountAuthFlow ? (
            <>
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
                  Approve this device
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
            </>
          ) : null}

          {!activeThinConnectionPanel ? (
            <Button variant="primary" onClick={onFinishSetup} disabled={busy !== null}>
              {busy === 'mode-apply' ? 'Applying choice…' : 'Finish setup'}
            </Button>
          ) : null}
        </div>
      ) : null}

      {wizardStep === 'done' ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center" data-step="done">
          <Check size={40} aria-hidden className="text-success" />
          <h2 className="text-base font-semibold">{PRODUCT_COPY.onboarding.done.title}</h2>
          <p className="text-[12.5px] text-muted-foreground">{model.selectedMode.label} is ready. You can change this choice from Settings.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setWizardStep('detect')}>
              Run setup again
            </Button>
            <a className={cn(buttonVariants({ variant: 'default' }))} href={model.cockpitHref}>
              {PRODUCT_COPY.onboarding.done.action}
            </a>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className="text-center text-[13px] text-muted-foreground" role="alert">
          {message}
        </p>
      ) : null}
      </div>
    </section>
  )
}

export function buildOnboardingViewModel({
  client,
  snapshot,
  selectedModeId,
  endpoint,
  userAgent,
  allowBrowserDeviceSetup = false,
  setupRequired = false,
}: {
  client: AuroraClient
  snapshot: AuroraShellSnapshot
  selectedModeId?: string
  endpoint?: string
  userAgent?: string
  allowBrowserDeviceSetup?: boolean
  setupRequired?: boolean
}): OnboardingViewModel {
  const session = client.auth.refreshClock()
  const modes = deploymentModes(client.transport.kind, snapshot, userAgent, { allowBrowserDeviceSetup })
  const selected = selectedModeId && modes.some((mode) => mode.id === selectedModeId && !mode.disabled) ? selectedModeId : (modes.find((mode) => !mode.disabled)?.id ?? modes[0]?.id ?? 'connect-to-aurora')
  const authState = authAvailability(session)
  const pairingState = pairingAvailability(session, routeById(snapshot, 'mesh'))
  const selectedMode = modes.find((mode) => mode.id === selected) ?? modes[0] ?? mode('connect-to-aurora', PRODUCT_COPY.onboarding.choices.connect.label, PRODUCT_COPY.mesh.connectedDevice, 'No setup choices are available.', 'unsupported', 'Aurora is not ready.', 'Reload Aurora after it starts.')
  const steps = setupSteps({
    session,
    snapshot,
    selectedMode,
    authState,
    pairingState,
    setupRequired,
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

function deploymentModes(
  transportKind: string,
  snapshot: AuroraShellSnapshot,
  userAgent?: string,
  options: { allowBrowserDeviceSetup?: boolean } = {},
): DeploymentModeCard[] {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent,
  })
  const connectState = profile.isMobile
    ? mobileRemoteConnectionState(snapshot, transportKind, userAgent)
    : desktopThinState(snapshot, transportKind)
  const baseMakeAvailableState = profile.isMobile
    ? mobileNativeState(snapshot, transportKind, userAgent)
    : desktopThinState(snapshot, transportKind)
  const makeAvailableState = options.allowBrowserDeviceSetup && baseMakeAvailableState.state === 'unsupported'
    ? browserDeviceSetupState()
    : baseMakeAvailableState
  const desktopNative = desktopLocalState(snapshot, transportKind)
  const modes = [
    mode('connect-to-aurora', PRODUCT_COPY.onboarding.choices.connect.label, PRODUCT_COPY.mesh.connectedDevice, PRODUCT_COPY.onboarding.choices.connect.description, connectState.state, connectState.evidence, connectState.repair),
    mode('make-this-device-available', PRODUCT_COPY.onboarding.choices.makeAvailable.label, PRODUCT_COPY.mesh.localFeatures, PRODUCT_COPY.onboarding.choices.makeAvailable.description, makeAvailableState.state, makeAvailableState.evidence, makeAvailableState.repair),
  ]
  if (canOfferFullLocalMode(transportKind, snapshot)) {
    modes.push(mode('run-aurora-on-this-computer', PRODUCT_COPY.onboarding.choices.runHere.label, PRODUCT_COPY.mesh.localDevice, PRODUCT_COPY.onboarding.choices.runHere.description, desktopNative.state, desktopNative.evidence, desktopNative.repair))
  }
  return modes
}

function mobileRemoteConnectionState(snapshot: AuroraShellSnapshot, transportKind: string, userAgent?: string): { state: AvailabilityState; evidence: string; repair: string } {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot.nativePlatform,
    userAgent,
  })
  if (profile.isMobile) {
    return {
      state: 'available-remote',
      evidence: 'This device can connect to an Aurora server.',
      repair: 'Use an invite or server address to begin pairing.',
    }
  }
  return mobileWebThinState(snapshot, transportKind, userAgent)
}

function browserDeviceSetupState(): { state: AvailabilityState; evidence: string; repair: string } {
  return {
    state: 'pending',
    evidence: 'Add an invite to make this device available.',
    repair: 'Use an invite from the Aurora device you want to use.',
  }
}

function desktopLocalState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (canOfferFullLocalMode(transportKind, snapshot)) {
    const nativeEvidence = snapshot.nativeAvailable ? `${surfaceDeviceLabel(snapshot.nativePlatform)} features available` : 'Device features are still loading'
    return {
      state: snapshot.loadState === 'ready' ? 'available-local' : 'pending',
      evidence: `${nativeEvidence}; Aurora is running on this computer`,
      repair: 'Start Aurora on this computer, then try again.',
    }
  }
  return {
    state: 'unsupported',
    evidence: 'Aurora is not running on this computer.',
    repair: 'Connect to Aurora on another device, or open the desktop app that includes Aurora.',
  }
}

function desktopThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  if (transportKind === 'http') {
    return {
      state: 'available-remote',
      evidence: PRODUCT_COPY.connection.connected,
      repair: 'Check the Aurora address, then sign in or approve this device.',
    }
  }
  if (transportKind === 'tauri-local' || isThinSetupTransport(transportKind)) {
    return {
      state: 'pending',
      evidence: 'Desktop app can connect to another Aurora device.',
      repair: 'Use an invite or address for the Aurora device you want to use.',
    }
  }
  return {
    state: transportKind === 'mock' ? 'degraded' : 'unsupported',
    evidence: transportKind === 'mock' ? 'Local preview' : 'Connection is not ready.',
    repair: 'Open setup and use an invite or address.',
  }
}

function isThinSetupTransport(transportKind: string): boolean {
  return [
    'mesh',
    'tauri-thin',
    'webrtc',
    'webrtc-preferred',
    'webrtc-only',
  ].includes(transportKind)
}

function androidMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('android')) {
    return {
      state: 'available-remote',
      evidence: 'Android app connection is available.',
      repair: 'Continue with an invite or sign-in, then keep credentials in Android secure storage when available.',
    }
  }
  if (platform.includes('android')) {
    return {
      state: snapshot.nativeAvailable ? 'available-local' : 'pending',
      evidence: snapshot.nativeAvailable ? 'Android device features are available.' : 'Android device features are still starting.',
      repair: 'Use an invite or sign in, then review Android permissions.',
    }
  }
  if (transportKind === 'http') {
    return {
      state: 'pending',
      evidence: 'Android can connect through the saved Aurora address.',
      repair: 'Use an invite or sign in, then review Android permissions.',
    }
  }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'Android device features are not available yet.',
    repair: 'Open Aurora on Android or connect to another Aurora device.',
  }
}

function iosMobileThinState(snapshot: AuroraShellSnapshot, transportKind: string): { state: AvailabilityState; evidence: string; repair: string } {
  const platform = snapshot.nativePlatform.toLowerCase()
  if (transportKind === 'native-mobile' && platform.includes('ios')) {
    return {
      state: iosLocalLightState(snapshot) === 'unsupported' ? 'degraded' : iosLocalLightState(snapshot),
      evidence: iosLocalLightEvidence(snapshot),
      repair: 'Use secure storage when available; launch Aurora from iOS shortcuts, widgets, sharing, or links.',
    }
  }
  if (platform.includes('ios')) {
    return {
      state: snapshot.nativeAvailable ? iosLocalLightState(snapshot) : 'pending',
      evidence: iosLocalLightEvidence(snapshot),
      repair: 'Use iOS shortcuts, widgets, sharing, and links from Aurora-owned surfaces.',
    }
  }
  if (transportKind === 'http') {
    return {
      state: 'pending',
      evidence: 'iOS can connect through the saved Aurora address.',
      repair: 'Use an invite or sign in, then review iOS device features.',
    }
  }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'iOS device features are not available yet.',
    repair: 'Open Aurora on iOS or connect to another Aurora device.',
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
      evidence: 'Mobile device features need attention.',
      repair: 'Review device features before turning on background access.',
    }
  return {
    state: 'unsupported',
    evidence: snapshot.nativePlatform || 'Mobile device features are not available yet.',
    repair: 'Open Aurora from the Android or iOS app to use device features.',
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
      evidence: 'Mobile browser connection is available.',
      repair: 'Sign in or approve this device. Background features require the mobile app.',
    }
  if (transportKind === 'http')
    return {
      state: 'pending',
      evidence: 'Mobile browser connection can be used after this page opens on mobile.',
      repair: 'Open Aurora in a mobile browser, then sign in or approve this device.',
    }
  if (transportKind === 'mock')
    return {
      state: 'degraded',
      evidence: 'Mobile browser setup is waiting for a live Aurora address.',
      repair: 'Connect to Aurora from a mobile browser.',
    }
  return {
    state: 'unsupported',
    evidence: 'Mobile browser setup is not connected yet.',
    repair: 'Use a mobile browser with an Aurora address.',
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
  return ids.length > 0 ? `iOS device features: ${ids.join(', ')}` : 'iOS device features are not available yet.'
}

function mode(id: OnboardingProductModeId, label: string, routeLabel: string, description: string, state: AvailabilityState, evidence: string, repair: string): DeploymentModeCard {
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

function setupSubtitle(modeId: OnboardingProductModeId): string {
  if (modeId === 'make-this-device-available') {
    return 'Choose what this device can share with approved Aurora devices.'
  }
  if (modeId === 'run-aurora-on-this-computer') {
    return 'Start Aurora here and connect this computer to your devices.'
  }
  return 'Use an invite or address to connect this device.'
}

function setupSteps(input: { session: AuthSessionSnapshot; snapshot: AuroraShellSnapshot; selectedMode: DeploymentModeCard; authState: AvailabilityState; pairingState: AvailabilityState; setupRequired?: boolean }): OnboardingSetupStep[] {
  const selectedMode = input.selectedMode.id === 'connect-to-aurora' ? 'available-remote' : 'available-local'
  const accessStep = input.setupRequired
    ? {
      title: 'Connect this device',
      detail: 'Use an invite, scan, file, paste, link, or address to connect this device.',
      repair: input.session.isAuthenticated ? 'Access ready.' : 'Use an invite or address from the Aurora device you want to use.',
    }
    : {
      title: 'Authenticate / pair',
      detail: 'Sign in, restore an access key, or approve this device.',
      repair: input.session.isAuthenticated ? 'Access ready.' : 'If sign-in fails, check the address and try again.',
    }
  return [
    {
      title: 'Select mode',
      detail: 'Choose whether to connect to Aurora, make this device available, or run Aurora here when supported.',
      state: selectedMode,
      progress: null,
      repair: input.selectedMode.repair,
    },
    {
      title: accessStep.title,
      detail: accessStep.detail,
      state: input.authState === 'pending' ? input.pairingState : input.authState,
      progress: input.session.isAuthenticated ? 100 : input.session.state === 'pairing' ? 45 : null,
      repair: accessStep.repair,
    },
    {
      title: 'Load capability graph',
      detail: 'Aurora checks which pages and actions are available for this device.',
      state: input.snapshot.loadState === 'ready' ? 'available-local' : input.snapshot.loadState === 'loading' ? 'pending' : 'denied',
      progress: input.snapshot.routeCount ? Math.min(100, Math.round((input.snapshot.availableCount / Math.max(1, input.snapshot.routeCount)) * 100)) : null,
      repair: input.snapshot.loadState === 'error' ? 'Check the address and try again.' : 'Continue once Aurora is ready.',
    },
    {
      title: 'Review privacy defaults',
      detail: 'Review which device can use sensitive actions before turning them on.',
      state: input.snapshot.secretsRedacted ? 'available-local' : 'degraded',
      progress: input.snapshot.secretsRedacted ? 100 : 50,
      repair: input.snapshot.secretsRedacted ? 'Sensitive details stay hidden.' : 'Sensitive details need attention before sharing support information.',
    },
    {
      title: 'Open Aurora',
      detail: 'Assistant and settings open after access and device status are ready.',
      state: input.session.isAuthenticated || input.snapshot.loadState === 'ready' ? 'available-local' : 'pending',
      progress: input.session.isAuthenticated ? 100 : null,
      repair: 'Open Aurora after access and device status are ready.',
    },
  ]
}

function resumeSetupTitle(steps: OnboardingSetupStep[]): string {
  const next = steps.find((step) => step.state === 'pending' || step.state === 'denied' || step.state === 'unsupported' || step.state === 'privacy-blocked')
  return next ? `Resume: ${next.title}` : 'Resume: Land in cockpit'
}

function resumeSetupDetail(steps: OnboardingSetupStep[]): string {
  const next = steps.find((step) => step.state === 'pending' || step.state === 'denied' || step.state === 'unsupported' || step.state === 'privacy-blocked')
  return next?.repair ?? 'Setup is complete for this device.'
}

function androidAssistantRoleEvidence(assistant: NonNullable<AuroraShellSnapshot['nativeAssistantRole']>, fallbackCount: number): string {
  return assistant.roleHeld
    ? 'Android assistant access is already enabled.'
    : assistant.requestable
      ? 'Android assistant access can be requested.'
      : fallbackCount > 0
        ? 'Android shortcut entry points are available.'
        : 'Android assistant access is not available yet.'
}

function mobileFirstLaunchNotes(snapshot: AuroraShellSnapshot): MobileFirstLaunchNote[] {
  const androidState: AvailabilityState = snapshot.nativePlatform === 'android' && snapshot.nativeAvailable ? 'degraded' : 'unsupported'
  const iosState: AvailabilityState = snapshot.nativePlatform === 'ios' && snapshot.nativeAvailable ? iosLocalLightState(snapshot) : 'unsupported'
  return [
    {
      platform: 'Android',
      state: androidState,
      detail: 'Aurora can ask to become the Android assistant only when this device allows it.',
      evidence: snapshot.nativeAssistantRole ? androidAssistantRoleEvidence(snapshot.nativeAssistantRole, snapshot.nativeFallbackEntrypoints.length) : 'Android assistant access is not available yet.',
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
  const meshEvidence = meshRoute
    ? (meshRoute.routeable ? 'Mesh is available for this device.' : 'Mesh needs attention before use.')
    : 'Mesh is not available yet.'
  const desktopState: AvailabilityState = transportKind === 'tauri-local' && !meshRoute?.disabled ? 'available-local' : transportKind === 'tauri-local' ? 'degraded' : 'unsupported'
  const webState: AvailabilityState = transportKind === 'http' ? meshState : transportKind === 'mock' ? 'degraded' : 'unsupported'
  const androidState = androidMobileThinState(snapshot, transportKind).state
  const iosState = iosMobileThinState(snapshot, transportKind).state
  return [
    {
      label: 'Desktop Tauri local',
      state: desktopState,
      behavior: 'Desktop can run Aurora here when local services are available.',
      evidence: transportKind === 'tauri-local' ? meshEvidence : 'Open the desktop app on the computer that should run Aurora.',
    },
    {
      label: 'Connected Aurora device',
      state: webState,
      behavior: 'This device can view and manage Aurora through the device it connects to.',
      evidence: transportKind === 'http' ? meshEvidence : 'Connect this device to Aurora before managing mesh.',
    },
    {
      label: 'Android app',
      state: androidState,
      behavior: 'Android can connect, pair, and use approved features. System assistant access depends on the device and user approval.',
      evidence: androidMobileThinState(snapshot, transportKind).evidence,
    },
    {
      label: 'iOS app',
      state: iosState,
      behavior: 'iOS can connect, pair, and use approved features from Aurora surfaces.',
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
  if (transportKind === 'mock') return 'Aurora is running with sample data.'
  if (!endpoint?.trim()) return 'Enter an Aurora address only when changing devices.'
  try {
    const parsed = new URL(endpoint)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'Address format looks valid; Aurora still needs to respond.'
    return 'Use an Aurora web address.'
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
  if (session.isSystem) return 'Local development access is active.'
  if (session.isAuthenticated) return 'Signed in.'
  if (session.state === 'pairing') return 'Pairing is waiting for approval.'
  if (session.state === 'expired') return session.reason ?? 'Session expired; restore or log in again.'
  if (session.state === 'revoked') return session.reason ?? 'Session revoked; restore or log in again.'
  if (session.isDenied) return session.reason ?? 'Authentication or permission denied by backend.'
  return 'Sign in, restore an access key, or enter an approved pairing code.'
}

function pairingAvailability(session: AuthSessionSnapshot, meshRoute: RouteAvailability | undefined): AvailabilityState {
  if (session.isMeshPeer) return 'available-remote'
  if (session.state === 'pairing') return 'pending'
  if (meshRoute) return meshRoute.state
  return 'unsupported'
}

function pairingExplanation(session: AuthSessionSnapshot, meshRoute: RouteAvailability | undefined): string {
  if (session.isMeshPeer) return 'This device is approved.'
  if (session.state === 'pairing') return 'Pairing is waiting for approval.'
  return meshRoute?.explanation ?? 'Pairing is unavailable right now.'
}

function surfaceDeviceLabel(platform: string): string {
  if (/android/iu.test(platform)) return 'Android'
  if (/ios|iphone|ipad/iu.test(platform)) return 'iOS'
  if (/mac|win|linux/iu.test(platform)) return 'Desktop'
  return 'Device'
}

function routeById(snapshot: AuroraShellSnapshot, id: string): RouteAvailability | undefined {
  return snapshot.routes.find((route) => route.item.id === id)
}

function defaultModeId(
  transportKind: string,
  snapshot?: AuroraShellSnapshot,
  userAgent?: string,
): OnboardingProductModeId {
  const profile = getAuroraSurfaceProfile({
    transportKind,
    nativePlatform: snapshot?.nativePlatform,
    userAgent,
  })
  if (snapshot && canOfferFullLocalMode(transportKind, snapshot)) return 'run-aurora-on-this-computer'
  if (transportKind === 'native-mobile' || profile.isMobile) return 'make-this-device-available'
  return 'connect-to-aurora'
}

function isSupportedModeId(modeId: string): modeId is OnboardingProductModeId {
  return supportedModeIds.has(modeId)
}

const supportedModeIds: ReadonlySet<string> = new Set(['connect-to-aurora', 'make-this-device-available', 'run-aurora-on-this-computer'])

function storedModeToProductModeId(modeId: string, runtimeTier: string | null | undefined): OnboardingProductModeId | null {
  switch (modeId) {
    case 'remote-console':
    case 'desktop-thin':
    case 'desktop-web-thin':
    case 'mobile-web-thin':
    case 'server-web':
    case 'web-thin':
      return 'connect-to-aurora'
    case 'mesh-node':
      return runtimeTier === 'python-full' ? 'run-aurora-on-this-computer' : 'make-this-device-available'
    case 'local-provider':
    case 'mobile-native':
    case 'mobile-thin':
    case 'android-thin':
    case 'ios-thin':
      return 'make-this-device-available'
    case 'full-local':
    case 'desktop-local':
    case 'desktop-native':
      return 'run-aurora-on-this-computer'
    default:
      return isSupportedModeId(modeId) ? modeId : null
  }
}

function productModePreference(modeId: OnboardingProductModeId): { nodeMode: AuroraNodeMode; runtimeTier: AuroraRuntimeTier } {
  if (modeId === 'run-aurora-on-this-computer') return { nodeMode: 'mesh-node', runtimeTier: 'python-full' }
  if (modeId === 'make-this-device-available') return { nodeMode: 'mesh-node', runtimeTier: 'lightweight-ts' }
  return { nodeMode: 'remote-console', runtimeTier: 'none' }
}

function availableProductModeId(
  modeId: OnboardingProductModeId,
  transportKind: string,
  snapshot: AuroraShellSnapshot,
  userAgent?: string,
  options: { allowBrowserDeviceSetup?: boolean } = {},
): OnboardingProductModeId | null {
  return deploymentModes(transportKind, snapshot, userAgent, options).some((mode) => mode.id === modeId && !mode.disabled) ? modeId : null
}

function canOfferFullLocalMode(transportKind: string, snapshot: AuroraShellSnapshot): boolean {
  return transportKind === 'tauri-local' && snapshot.nativeAvailable
}

function modeLabel(modeId: string): string {
  return ({
    'connect-to-aurora': PRODUCT_COPY.onboarding.choices.connect.label,
    'make-this-device-available': PRODUCT_COPY.onboarding.choices.makeAvailable.label,
    'run-aurora-on-this-computer': PRODUCT_COPY.onboarding.choices.runHere.label,
  } as Record<string, string>)[modeId] ?? modeId
}

function clientTransportEvidence(transportKind: string): string {
  return transportKind || 'transport not reported'
}

function onboardingErrorMessage(error: AuroraError): string {
  if (error.code === 'auth') return 'Access was denied or expired. Check the address, then try again.'
  if (error.code === 'permission') return productStatusCopy('local-permission-missing').title
  if (error.code === 'unsupported_feature') return productStatusCopy('unsupported-feature').title
  if (error.code === 'timeout') return 'Aurora did not respond in time. Check the address and try again.'
  return safeErrorCopy(error).title
}

function ModeIcon({ id }: { id: string }) {
  const props = { size: 18, 'aria-hidden': true as const }
  if (id === 'run-aurora-on-this-computer') return <Monitor {...props} />
  if (id === 'connect-to-aurora') return <Server {...props} />
  if (id === 'make-this-device-available') return <Smartphone {...props} />
  if (id === 'auth') return <KeyRound {...props} />
  return <ShieldCheck {...props} />
}

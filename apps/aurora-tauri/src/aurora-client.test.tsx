import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraTauriRuntime } from './aurora-client'
import { AuroraTauriApp } from './tauri-app'

describe('Aurora Tauri runtime wrapper', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    window.history.replaceState({}, '', '/')
  })

  it('uses the SDK mock transport when no Tauri shell or Gateway URL is present', async () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')
    vi.stubEnv('VITE_AURORA_GATEWAY_TOKEN', '')

    const runtime = createAuroraTauriRuntime()

    expect(runtime.mode).toBe('mock')
    expect(runtime.client.transport.kind).toBe('mock')
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.nativePermissionStatus()).resolves.toBeNull()
    await expect(runtime.iosSecureStorageStatus()).resolves.toBeNull()
    await expect(runtime.iosBiometricStatus()).resolves.toBeNull()
    await expect(runtime.iosLocalLightInferenceStatus()).resolves.toBeNull()
    await expect(runtime.androidBaselineStatus()).resolves.toBeNull()
    await expect(runtime.shutdown()).resolves.toBeUndefined()
  })

  it('uses thin HTTP mode for browser previews with an explicit Gateway URL', async () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', 'http://127.0.0.1:8000')
    vi.stubEnv('VITE_AURORA_GATEWAY_TOKEN', 'test-token')

    const runtime = createAuroraTauriRuntime()

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.client.transport.kind).toBe('http')
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.iosSecureStorageStatus()).resolves.toBeNull()
    await expect(runtime.iosLocalLightInferenceStatus()).resolves.toBeNull()
    await expect(runtime.androidBaselineStatus()).resolves.toBeNull()
  })

  it('renders the assistant page at the root instead of the diagnostics dashboard', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')

    const markup = renderToStaticMarkup(<AuroraTauriApp />)

    expect(markup).toContain('Assistant')
    expect(markup).toContain('Prompt')
    expect(markup).toContain('Assistant capability is unavailable')
    expect(markup).not.toContain('Native boundary')
    expect(markup).not.toContain('Denied native defaults')
  })

  it('routes the diagnostics dashboard away from the assistant landing page', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')
    window.history.replaceState({}, '', '/diagnostics')

    const markup = renderToStaticMarkup(<AuroraTauriApp />)

    expect(markup).toContain('Native boundary')
    expect(markup).toContain('Runtime mode')
    expect(markup).toContain('Audio bridge')
    expect(markup).toContain('iOS microphone capture')
    expect(markup).toContain('iOS background voice')
    expect(markup).toContain('iOS Keychain')
    expect(markup).toContain('Face ID / Touch ID')
    expect(markup).toContain('Siri/Shortcuts/App Intents integration')
    expect(markup).toContain('local-light inference')
    expect(markup).toContain('no system assistant role claim')
    expect(markup).toContain('Android baseline')
    expect(markup).toContain('Assistant role probe')
    expect(markup).toContain('Denied native defaults')
    expect(markup).toContain('mock (degraded development fixture only)')
    expect(markup).toContain('mock (SDK fixture transport; development fallback only)')
    expect(markup).toContain('not used in thin mode')
  })

  it('renders the models page for the models route', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')
    window.history.replaceState({}, '', '/models')

    const markup = renderToStaticMarkup(<AuroraTauriApp />)

    expect(markup).toContain('Models and runtime')
    expect(markup).toContain('Loading model runtime catalog from AuroraClient')
    expect(markup).not.toContain('Native boundary')
  })
})

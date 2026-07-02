import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auroraNavSections } from '@aurora/ui'
import { createAuroraTauriRuntime } from './aurora-client'
import { redactSmokeError, serializeEventForSmokeReport } from './eventstream-smoke'
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

  it('redacts EventStream smoke report payloads and secret-like errors', () => {
    const report = serializeEventForSmokeReport({
      id: 'evt-1',
      kind: 'health.updated',
      topic: 'health.updated',
      payload: {
        token: 'secret-token',
        rawAudio: 'pcm-secret',
        status: 'ok'
      },
      audit: {
        transport: 'tauri-local',
        correlationId: 'corr-1'
      }
    } as never)

    expect(JSON.stringify(report)).not.toContain('secret-token')
    expect(JSON.stringify(report)).not.toContain('pcm-secret')
    expect(report.payloadSummary).toEqual({
      present: true,
      keys: ['rawAudio', 'status', 'token'],
      redacted: true
    })

    const error = redactSmokeError(
      new Error('failed Authorization: Bearer gateway-token token=sidecar-token raw_audio=pcm-secret')
    )
    expect(error).not.toContain('gateway-token')
    expect(error).not.toContain('sidecar-token')
    expect(error).not.toContain('pcm-secret')
    expect(error).toContain('[redacted]')
  })
})

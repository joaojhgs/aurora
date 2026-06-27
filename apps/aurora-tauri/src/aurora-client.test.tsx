import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraTauriRuntime } from './aurora-client'
import { AuroraTauriApp } from './tauri-app'

describe('Aurora Tauri runtime wrapper', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
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
  })

  it('renders the shell without inventing sidecar state in non-Tauri test hosts', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')

    const markup = renderToStaticMarkup(<AuroraTauriApp />)

    expect(markup).toContain('Native boundary')
    expect(markup).toContain('Runtime mode')
    expect(markup).toContain('Audio bridge')
    expect(markup).toContain('iOS Keychain')
    expect(markup).toContain('Face ID / Touch ID')
    expect(markup).toContain('Denied native defaults')
    expect(markup).toContain('mock')
    expect(markup).toContain('not used in thin mode')
  })
})

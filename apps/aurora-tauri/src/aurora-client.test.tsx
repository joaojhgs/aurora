import { renderToStaticMarkup } from 'react-dom/server'
import { auroraNavSections } from '@aurora/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraTauriRuntime } from './aurora-client'
import { AuroraTauriApp, tauriRouteRegistryRouteIds } from './tauri-app'

const primaryNavItems = auroraNavSections.flatMap((section) => section.items)

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

  it('registers a production Tauri component for every primary nav route', () => {
    const routeIds = new Set(tauriRouteRegistryRouteIds)
    const missing = primaryNavItems.filter((item) => !routeIds.has(item.id)).map((item) => `${item.id}:${item.href}`)

    expect(missing).toEqual([])
    expect(routeIds.size).toBe(primaryNavItems.length)
  })

  it('renders every primary route without the legacy route placeholder copy', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')

    const routeMarkers: Record<string, string> = {
      assistant: 'Prompt',
      memory: 'History and RAG provenance',
      tools: 'Approval cards',
      mesh: 'Mesh peers',
      admin: 'Admin overview',
      services: 'Services',
      access: 'RBAC',
      tokens: 'RBAC',
      devices: 'Devices',
      config: 'Configuration',
      contracts: 'Services',
      plugins: 'Plugins, MCP, and tools',
      pairing: 'Pairing queue',
      backups: 'Backups &amp; Restore',
      scheduler: 'Scheduler',
      audit: 'Audit log',
      models: 'Models and runtime',
      diagnostics: 'Native boundary',
      onboarding: 'Connect Aurora',
      settings: 'Settings and permissions',
      data: 'History and RAG provenance',
      native: 'Settings and permissions'
    }

    for (const item of primaryNavItems) {
      window.history.replaceState({}, '', item.href)
      const markup = renderToStaticMarkup(<AuroraTauriApp />)

      expect(markup, item.href).toContain(routeMarkers[item.id])
      expect(markup, item.href).not.toContain('A full product page still needs to be mounted')
      expect(markup, item.href).not.toContain('This Tauri route is now navigable')
      expect(markup, item.href).not.toContain('route is unregistered')
    }
  })

  it('keeps credentials and raw-audio payloads out of rendered diagnostics and route output', () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', 'http://127.0.0.1:8000')
    vi.stubEnv('VITE_AURORA_GATEWAY_TOKEN', 'test-token')

    for (const href of ['/', '/diagnostics', '/admin/tokens', '/settings/native']) {
      window.history.replaceState({}, '', href)
      const markup = renderToStaticMarkup(<AuroraTauriApp />)

      expect(markup, href).not.toContain('test-token')
      expect(markup, href).not.toMatch(/authorization/i)
      expect(markup, href).not.toMatch(/api[_-]?key/i)
      expect(markup, href).not.toMatch(/raw[-_ ]audio payload/i)
      expect(markup, href).not.toMatch(/audio_buffer/i)
    }
  })
})

function resetTauriRouteGateState() {
  vi.unstubAllEnvs()
  window.history.replaceState({}, '', '/')
}

describe('Tauri CI/E2E route gates', () => {
  afterEach(resetTauriRouteGateState)

  it('e2e:routes renders every registered route without placeholder or debug dashboard UI', () => {
    const routes = auroraNavSections.flatMap((section) => section.items)
    expect(routes).toHaveLength(22)
    expect(new Set(tauriRouteRegistryRouteIds)).toEqual(
      new Set(routes.map((route) => route.id)),
    )

    for (const route of routes) {
      const markup = renderTauriRoute(route.href)

      expectNoPlaceholderOrDebugUi(markup, route.id)
      expect(markup, route.id).toContain(route.label)
      expect(markup, route.id).not.toContain(`${route.label} route registry error`)
    }
  })

  it('e2e:assistant keeps the assistant landing page separate from diagnostics', () => {
    const markup = renderTauriRoute('/')

    expectNoPlaceholderOrDebugUi(markup, 'assistant')
    expect(markup).toContain('Assistant')
    expect(markup).toContain('Prompt')
    expect(markup).toContain('Assistant capability is unavailable')
    expect(markup).not.toContain('Native boundary')
    expect(markup).not.toContain('Denied native defaults')
    expect(markup).not.toContain('route registry error')
  })

  it('e2e:admin renders admin routes with admin-specific components instead of placeholders', () => {
    const routes = routesByGroup(adminRouteIds)
    expect(routes.map((route) => route.id)).toEqual([
      'admin',
      'services',
      'access',
      'tokens',
      'devices',
      'config',
      'contracts',
      'plugins',
      'pairing',
      'backups',
      'scheduler',
      'audit',
    ])

    for (const route of routes) {
      const markup = renderTauriRoute(route.href)

      expectNoPlaceholderOrDebugUi(markup, route.id)
      expect(markup, route.id).toContain(route.label)
      expect(markup, route.id).not.toContain('route registry error')
      expect(markup, route.id).not.toContain('aui-badge-privacy-blocked')
    }
  })

  it('e2e:runtime renders runtime routes without false global privacy blocking', () => {
    const routes = routesByGroup(runtimeRouteIds)
    expect(routes.map((route) => route.id)).toEqual([
      'models',
      'diagnostics',
      'onboarding',
      'settings',
      'data',
      'native',
    ])

    for (const route of routes) {
      const markup = renderTauriRoute(route.href)

      expectNoPlaceholderOrDebugUi(markup, route.id)
      expect(markup, route.id).toContain(route.label)
      expect(markup, route.id).not.toContain('route registry error')
      if (route.id !== 'diagnostics') {
        expect(markup, route.id).not.toContain('Native boundary')
        expect(markup, route.id).not.toContain('Denied native defaults')
      }
      if (route.id !== 'data') {
        expect(markup, route.id).not.toContain('aui-badge-privacy-blocked')
      }
    }
  })
})

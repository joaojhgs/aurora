import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuroraClient, AuroraError, GATEWAY_METHODS, MockAuroraTransport, type AuroraTransportRequest } from '@aurora/client'
import { auroraNavSections, getProductionRouteOracle } from '@aurora/ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraTauriRuntime } from './aurora-client'
import { AuroraTauriApp, tauriRouteRegistryRouteIds, type AuroraTauriRuntime } from './tauri-app'

const primaryNavItems = auroraNavSections.flatMap((section) => section.items)

const PLACEHOLDER_MARKERS = [
  'A full product page still needs to be mounted',
  'rendering the assistant diagnostics on the wrong page',
  'TauriRoutePlaceholder',
  'ata-placeholder-panel',
  'debug-dashboard',
] as const

const adminRouteIds = new Set([
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

const runtimeRouteIds = new Set([
  'models',
  'diagnostics',
  'onboarding',
  'settings',
  'data',
  'native',
])

class RecordingMockAuroraTransport extends MockAuroraTransport {
  readonly requests: AuroraTransportRequest[] = []

  override async request<TData = unknown, TPayload = unknown>(
    request: AuroraTransportRequest<TPayload>,
  ) {
    this.requests.push(request)
    return super.request<TData, TPayload>(request)
  }
}

function testRuntime(client: AuroraClient): AuroraTauriRuntime {
  return {
    client,
    mode: 'mock',
    sidecarStatus: async () => null,
    startSidecar: async () => null,
    stopSidecar: async () => null,
    nativePermissionStatus: async () => null,
    trayStatus: async () => null,
    notificationStatus: async () => null,
    iosVoiceStatus: async () => null,
    iosInvocationStatus: async () => null,
    iosLocalLightInferenceStatus: async () => null,
    iosBackgroundStatus: async () => null,
    dialogStatus: async () => null,
    audioBridgeStatus: async () => null,
    iosSecureStorageStatus: async () => null,
    iosBiometricStatus: async () => null,
    androidBaselineStatus: async () => null,
    shutdown: async () => undefined,
  }
}

async function mountOutcomeApp(runtime: AuroraTauriRuntime) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(<AuroraTauriApp runtimeOverride={runtime} />)
    await flushReactWork()
  })
  return { container, root }
}

async function flushReactWork() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function waitUntil(assertion: () => void) {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await act(async () => {
        await flushReactWork()
      })
    }
  }
  throw lastError
}

async function navigateByHref(container: HTMLElement, href: string) {
  const link = Array.from(container.querySelectorAll<HTMLAnchorElement>(`a[href="${href}"]`))[0]
  expect(link, `navigation link for ${href}`).toBeDefined()
  await act(async () => {
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await flushReactWork()
  })
}

function requestMethods(transport: RecordingMockAuroraTransport): string[] {
  return transport.requests.map((request) => request.method)
}

function writeOutcomeArtifact(name: string, html: string) {
  const reportDir = join(process.cwd(), 'reports', 'e2e-outcomes')
  mkdirSync(reportDir, { recursive: true })
  writeFileSync(join(reportDir, `${name}.html`), html)
}

function renderTauriRoute(href: string) {
  vi.stubEnv('VITE_AURORA_GATEWAY_URL', '')
  window.history.replaceState({}, '', href)
  return renderToStaticMarkup(<AuroraTauriApp />)
}

function expectNoPlaceholderOrDebugUi(markup: string, routeId: string) {
  for (const marker of PLACEHOLDER_MARKERS) {
    expect(markup, `${routeId} should not render ${marker}`).not.toContain(marker)
  }
}

function routesByGroup(routeIds: Set<string>) {
  return auroraNavSections
    .flatMap((section) => section.items)
    .filter((route) => routeIds.has(route.id))
}

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

  it('uses HTTP Gateway transport without a sidecar when Tauri runs in desktop-thin mode', async () => {
    vi.stubEnv('VITE_AURORA_GATEWAY_URL', 'http://gateway.example.test:8000')
    vi.stubEnv('VITE_AURORA_GATEWAY_TOKEN', 'thin-token')
    Object.defineProperty(window, '__TAURI__', { value: {}, configurable: true })

    const runtime = createAuroraTauriRuntime()

    expect(runtime.mode).toBe('desktop-thin')
    expect(runtime.client.transport.kind).toBe('http')
    await expect(runtime.sidecarStatus()).resolves.toBeNull()
    await expect(runtime.startSidecar()).resolves.toBeNull()
    await expect(runtime.stopSidecar()).resolves.toBeNull()

    delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__
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

    for (const item of primaryNavItems) {
      window.history.replaceState({}, '', item.href)
      const markup = renderToStaticMarkup(<AuroraTauriApp />)
      const oracle = getProductionRouteOracle(item.id)

      expect(oracle, `${item.href} must have a production surface oracle`).toBeDefined()
      for (const landmark of oracle?.renderedLandmarks ?? []) {
        expectMarkupToContainText(markup, landmark, item.href)
      }
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


function expectMarkupToContainText(markup: string, text: string, context: string) {
  const htmlEscaped = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

  expect(
    markup.includes(text) || markup.includes(htmlEscaped),
    `${context} should render production landmark ${text}`,
  ).toBe(true)
}

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

  it('e2e:outcomes drives real navigation, SDK calls, visible errors, and render artifacts', async () => {
    const transport = new RecordingMockAuroraTransport()
    const runtime = testRuntime(new AuroraClient({ transport }))
    window.history.replaceState({}, '', '/')

    const { container, root } = await mountOutcomeApp(runtime)
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain('Prompt')
        expect(requestMethods(transport)).toContain('Gateway.GetCapabilityCatalog')
        expect(requestMethods(transport)).toContain('Gateway.GetRegistry')
      })
      expect(container.querySelector('[aria-label="Primary navigation"]')).not.toBeNull()
      expect(container.querySelector('[aria-label="Aurora shell status"]')?.textContent).toContain('Health')
      writeOutcomeArtifact('assistant-loaded', container.innerHTML)

      await navigateByHref(container, '/mesh')
      await waitUntil(() => {
        expect(window.location.pathname).toBe('/mesh')
        expect(container.textContent).toContain('Mesh')
        expect(requestMethods(transport)).toContain('Auth.MeshListPeers')
      })
      expect(container.textContent).toContain('trust')
      writeOutcomeArtifact('mesh-after-navigation', container.innerHTML)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }

    const failingTransport = new RecordingMockAuroraTransport()
    failingTransport.register('Gateway.GetCapabilityCatalog', () => {
      throw new AuroraError({
        code: 'transport_loss',
        message: 'Gateway unavailable for outcome test',
        method: 'Gateway.GetCapabilityCatalog',
      })
    })
    const failingRuntime = testRuntime(new AuroraClient({ transport: failingTransport }))
    window.history.replaceState({}, '', '/')

    const failure = await mountOutcomeApp(failingRuntime)
    try {
      await waitUntil(() => {
        expect(failure.container.textContent).toContain('Aurora unavailable')
        expect(failure.container.textContent).toContain('Capability state could not be loaded from AuroraClient.')
      })
      expect(requestMethods(failingTransport)).toContain('Gateway.GetCapabilityCatalog')
      writeOutcomeArtifact('gateway-error-visible', failure.container.innerHTML)
    } finally {
      await act(async () => failure.root.unmount())
      failure.container.remove()
    }
  })

  it('e2e:runtime probes local Gateway readiness before rendering desktop-local as ready', async () => {
    const transport = new RecordingMockAuroraTransport()
    transport.register(GATEWAY_METHODS.health, () => ({ status: 'healthy' }))
    const sidecarCalls: string[] = []
    const readySidecar = {
      running: true,
      mode: 'threads',
      pid: 4242,
      gatewayUrl: 'http://127.0.0.1:8000',
      lastError: null,
      details: { healthPath: '/api/health' },
    }
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(new AuroraClient({ transport })),
      mode: 'desktop-local',
      startSidecar: async () => {
        sidecarCalls.push('start')
        return readySidecar
      },
      sidecarStatus: async () => {
        sidecarCalls.push('status')
        return readySidecar
      },
    }
    window.history.replaceState({}, '', '/')

    const { container, root } = await mountOutcomeApp(runtime)
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain('Prompt')
      })
      expect(sidecarCalls).toEqual(['start', 'status'])
      const methods = requestMethods(transport)
      const firstCapabilityCatalog = methods.indexOf(GATEWAY_METHODS.getCapabilityCatalog)
      expect(methods.indexOf(GATEWAY_METHODS.health)).toBeGreaterThanOrEqual(0)
      expect(methods.indexOf(GATEWAY_METHODS.getRegistry)).toBeGreaterThanOrEqual(0)
      expect(methods.indexOf(GATEWAY_METHODS.getServices)).toBeGreaterThanOrEqual(0)
      expect(firstCapabilityCatalog).toBeGreaterThanOrEqual(0)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('e2e:runtime renders desktop-local sidecar status from Tauri command evidence', async () => {
    const transport = new RecordingMockAuroraTransport()
    transport.register(GATEWAY_METHODS.health, () => ({ status: 'healthy' }))
    const readySidecar = {
      running: true,
      mode: 'threads',
      pid: 5150,
      gatewayUrl: 'http://127.0.0.1:8000',
      lastError: null,
      details: { healthPath: '/api/health', command: 'aurora_sidecar_status' },
    }
    const runtime: AuroraTauriRuntime = {
      ...testRuntime(new AuroraClient({ transport })),
      mode: 'desktop-local',
      startSidecar: async () => readySidecar,
      sidecarStatus: async () => readySidecar,
    }
    window.history.replaceState({}, '', '/diagnostics')

    const { container, root } = await mountOutcomeApp(runtime)
    try {
      await waitUntil(() => {
        expect(container.textContent).toContain('Native boundary')
        expect(container.textContent).toContain('Desktop local shell')
      })
      expect(container.textContent).toContain('threads; gateway=http://127.0.0.1:8000; running=true')
      expect(container.textContent).toContain('Sidecar supervisorrunning')
      expect(container.textContent).not.toContain('native sidecar status unavailable in this runtime')
      expect(container.textContent).not.toContain('not used in thin mode')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

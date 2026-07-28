import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auroraBrowserRequiresOnboarding,
  createAuroraBrowserClient,
  createAuroraBrowserRuntime,
  createAuroraWebClient,
  resetAuroraBrowserClientForTests,
  saveAuroraBrowserThinProfile,
} from './aurora-client'
import { consumeFragmentInviteFromUrl } from './mesh/mesh-client'

describe('createAuroraWebClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetAuroraBrowserClientForTests()
  })

  it('uses the SDK mock transport only in explicit test or demo mode', () => {
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })

  it('fails closed instead of using fixture data as production truth when Gateway URL is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('http')
    await expect(client.capabilities.getGraph()).rejects.toThrow(/not been configured/)
  })

  it('requires explicit demo opt-in for fixture-backed web mode outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', '')
    vi.stubEnv('AURORA_WEB_DEMO_MODE', '1')

    const client = createAuroraWebClient()

    expect(client.transport.kind).toBe('mock')
  })
})

describe('createAuroraBrowserClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    resetAuroraBrowserClientForTests()
  })

  it('keeps one browser client identity and authorizes Gateway calls with an in-memory login token only', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/Login')) {
        return jsonResponse({
          token: 'login-token',
          user_id: 'user-1',
          username: 'Ada',
          permissions: ['Gateway.use']
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const login = await client.authApi.login({ username: 'ada', password: 'secret' })
    const sameClient = createAuroraBrowserClient()
    await sameClient.registry.getRegistry()

    expect(login.ok).toBe(true)
    expect(sameClient).toBe(client)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'user', isAuthenticated: true }))
    client.auth.clear()
    await sameClient.registry.getRegistry()
    expect(calls).toHaveLength(3)
    expect(calls[0]?.headers.Authorization).toBeUndefined()
    expect(calls[1]?.headers.Authorization).toBe('Bearer login-token')
    expect(calls[2]?.headers.Authorization).toBeUndefined()
    expectStorageHasNoSecrets(storage, ['login-token', 'secret'])
  })

  it('uses a validated manual token for later Gateway calls without browser storage', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/ValidateToken')) {
        return jsonResponse({
          valid: true,
          principal_id: 'user-2',
          principal_name: 'Grace',
          permissions: ['Gateway.use'],
          source: 'http_bearer'
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const validation = await client.authApi.validateToken({ token: 'manual-token' })
    await client.registry.getRegistry()

    expect(validation.ok).toBe(true)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'user', principalId: 'user-2' }))
    expect(calls[1]?.headers.Authorization).toBe('Bearer manual-token')
    expectStorageHasNoSecrets(storage, ['manual-token'])
  })

  it('does not bootstrap WebRTC invites from public env or persistent URL state', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_CONNECTION_MODE', 'webrtc-only')
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'https://aurora.example')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_INVITE', 'room_password=do-not-read')
    installBrowserStorage()
    const runtime = createAuroraBrowserRuntime()

    expect(auroraBrowserRequiresOnboarding()).toBe(true)
    expect(runtime.peer.snapshot().diagnostic ?? '').not.toContain('do-not-read')
  })

  it('uses the WebRTC rollout kill switch to keep hosted preferred mode on HTTP', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_THIN_CLIENT', '0')
    installBrowserStorage()
    await saveAuroraBrowserThinProfile({
      id: 'preferred',
      label: 'Preferred',
      mode: 'webrtc-preferred',
      gatewayUrl: 'https://aurora.example',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora Web',
      localStablePeerId: 'aurora-web-test-peer',
      webrtcProfile: {
        mode: 'webrtc-preferred',
        appId: 'aurora',
        room: 'office',
        roomSecretRef: 'ref:browser:office',
        signalingBrokers: ['wss://signaling.example.invalid'],
        nodeName: 'Aurora Web',
      },
    })

    const runtime = createAuroraBrowserRuntime()

    expect(runtime.mode).toBe('webrtc-preferred')
    expect(runtime.client.transport.kind).toBe('http')
    expect(runtime.peer.snapshot()).toMatchObject({
      status: 'disabled',
      hasHttpFallback: true,
    })
  })

  it('rejects a room secret that does not belong to the saved WebRTC profile', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    installBrowserStorage()
    const profile = {
      id: 'webrtc',
      label: 'WebRTC',
      mode: 'webrtc-only' as const,
      gatewayUrl: '',
      signalingUrl: 'wss://signaling.example.invalid',
      nodeName: 'Aurora Web',
      localStablePeerId: 'aurora-web-test-peer',
      webrtcProfile: {
        mode: 'webrtc-only' as const,
        appId: 'aurora',
        room: 'office',
        roomSecretRef: 'ref:browser:office',
        signalingBrokers: ['wss://signaling.example.invalid'],
        nodeName: 'Aurora Web',
      },
    }

    await expect(saveAuroraBrowserThinProfile(profile, {
      roomSecretRef: 'ref:browser:other-room',
      roomSecret: 'must-not-be-stored',
    })).rejects.toThrow(/does not match/)

    expect(auroraBrowserRequiresOnboarding()).toBe(true)
  })

  it('ignores query invites and only consumes scrubbed fragment invites without reload', () => {
    const testDir = dirname(fileURLToPath(import.meta.url))
    const clientSource = readFileSync(join(testDir, 'aurora-client.ts'), 'utf8')
    const meshSource = readFileSync(join(testDir, 'mesh/mesh-client.tsx'), 'utf8')
    const replacements: string[] = []

    expect(consumeFragmentInviteFromUrl('https://app.example/mesh?invite=query-secret', (url) => replacements.push(url))).toBeNull()
    expect(replacements).toEqual([])
    expect(consumeFragmentInviteFromUrl('https://app.example/mesh?view=peers#invite=fragment-secret&tab=rtc', (url) => replacements.push(url))).toBe('fragment-secret')
    expect(replacements).toEqual(['/mesh?view=peers#tab=rtc'])

    expect(clientSource).not.toContain('NEXT_PUBLIC_AURORA_WEBRTC_INVITE')
    expect(meshSource).not.toContain("searchParams.get('invite')")
    expect(meshSource).toContain('window.history.replaceState')
    expect(meshSource).not.toContain("url.searchParams.set('invite'")
    const inviteConsumerSource = meshSource.slice(meshSource.indexOf('export function consumeFragmentInviteFromUrl'))
    expect(inviteConsumerSource).not.toContain('window.location.reload')
  })

  it('uses a pairing exchange token for later Gateway calls without persisting the secret', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const storage = installBrowserStorage()
    await saveHttpThinProfile('http://aurora.local')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      const url = String(input)
      if (url.endsWith('/api/Auth/PairingExchange')) {
        return jsonResponse({
          token: 'pairing-token',
          user_id: 'peer-principal-1',
          device_id: 'device-1',
          peer_id: 'peer-1',
          node_name: 'Phone',
          permissions: ['Gateway.use']
        })
      }
      if (url.endsWith('/api/registry')) {
        return jsonResponse({ digest: 'fixture', modules: [], service_count: 0, method_count: 0 })
      }
      return jsonResponse({ detail: { message: `unexpected ${url}` } }, 404)
    })

    const client = createAuroraBrowserClient()
    const exchange = await client.authApi.pairingExchange({ code: 'PAIR-1234' })
    await client.registry.getRegistry()

    expect(exchange.ok).toBe(true)
    expect(client.auth.snapshot()).toEqual(expect.objectContaining({ state: 'mesh_peer', peerId: 'peer-1' }))
    expect(calls[1]?.headers.Authorization).toBe('Bearer pairing-token')
    expectStorageHasNoSecrets(storage, ['pairing-token', 'PAIR-1234'])
  })
})

async function saveHttpThinProfile(gatewayUrl: string): Promise<void> {
  await saveAuroraBrowserThinProfile({
    id: 'http',
    label: 'HTTP',
    mode: 'http-only',
    gatewayUrl,
    signalingUrl: '',
    nodeName: 'Aurora Web',
    localStablePeerId: 'aurora-web-test-peer',
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

function installBrowserStorage(): Storage & { dump(): Record<string, string> } {
  const values = new Map<string, string>()
  const storage: Storage & { dump(): Record<string, string> } = {
    length: 0,
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    setItem: vi.fn((key: string, value: string) => { values.set(key, String(value)) }),
    dump: () => Object.fromEntries(values),
  }
  Object.defineProperty(storage, 'length', {
    get: () => values.size,
  })
  vi.stubGlobal('window', {
    localStorage: storage,
    location: new URL('https://app.example/'),
  })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('sessionStorage', storage)
  return storage
}

function expectStorageHasNoSecrets(
  storage: Storage & { dump(): Record<string, string> },
  forbidden: string[],
): void {
  const encoded = JSON.stringify(storage.dump())
  for (const value of forbidden) {
    expect(encoded).not.toContain(value)
  }
}

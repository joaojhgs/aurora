import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuroraBrowserClient, createAuroraBrowserRuntime, createAuroraWebClient, resetAuroraBrowserClientForTests } from './aurora-client'
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
    await expect(client.capabilities.getGraph()).rejects.toThrow(/Gateway URL is not configured/)
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
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'http://aurora.local')
    const storage = throwingStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
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
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('uses a validated manual token for later Gateway calls without browser storage', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'http://aurora.local')
    const storage = throwingStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
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
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('does not bootstrap WebRTC invites from public env or persistent URL state', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_CONNECTION_MODE', 'webrtc-only')
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'https://aurora.example')
    vi.stubEnv('NEXT_PUBLIC_AURORA_WEBRTC_INVITE', 'room_password=do-not-read')
    const runtime = createAuroraBrowserRuntime()

    expect(runtime.peer.snapshot().status).toBe('needs-invite')
    expect(runtime.peer.snapshot().diagnostic ?? '').not.toContain('do-not-read')
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
    expect(meshSource).not.toContain('window.location.reload')
  })

  it('uses a pairing exchange token for later Gateway calls without persisting the secret', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_AURORA_GATEWAY_URL', 'http://aurora.local')
    const storage = throwingStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('sessionStorage', storage)
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
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

function throwingStorage(): Storage {
  return {
    length: 0,
    clear: vi.fn(() => { throw new Error('storage must not be used') }),
    getItem: vi.fn(() => { throw new Error('storage must not be used') }),
    key: vi.fn(() => { throw new Error('storage must not be used') }),
    removeItem: vi.fn(() => { throw new Error('storage must not be used') }),
    setItem: vi.fn(() => { throw new Error('storage must not be used') })
  }
}

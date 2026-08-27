import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

describe('/api/assistant/completion', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('reports disabled without exposing server-only provider config', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', '')

    const getResponse = await GET(configRequest())
    const postResponse = await POST(providerRequest({ messages: [], tools: [] }))

    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get('cache-control')).toBe('no-store, max-age=0')
    await expect(getResponse.json()).resolves.toEqual({ enabled: false })
    expect(postResponse.status).toBe(404)
    await expect(postResponse.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
  })

  it('uses the public request host when Next normalizes its internal URL', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', '')

    const response = await GET(new NextRequest('http://localhost:3000/api/assistant/completion', {
      method: 'GET',
      headers: {
        host: '127.0.0.1:54775',
        referer: 'http://127.0.0.1:54775/mesh',
        'sec-fetch-site': 'same-origin',
      },
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ enabled: false })
  })

  it('keeps the provider secret on the server-side request only', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(_input)
      if (url === 'https://gateway.example/api/Auth/WhoAmI') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer browser-session-token')
        return new Response(JSON.stringify({
          principal_id: 'user-1',
          principal_name: 'Ada',
          is_admin: false,
          permissions: ['Orchestrator.use'],
          effective_perms: ['Orchestrator.use'],
          source: 'http_bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      expect(url).toBe('https://provider.example/v1/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret')
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Ready.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const getResponse = await GET(configRequest({
      authorization: 'Bearer browser-session-token',
    }))
    const postResponse = await POST(providerRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 1,
    }, {
      authorization: 'Bearer browser-session-token',
    }))

    expect(getResponse.status).toBe(200)
    const publicConfig = await getResponse.json()
    expect(publicConfig).toEqual({ enabled: true })
    expect(postResponse.status).toBe(200)
    await expect(postResponse.json()).resolves.toEqual({ type: 'message', content: 'Ready.' })
    expect(JSON.stringify(upstreamFetch.mock.calls)).toContain('provider-secret')
    expect(JSON.stringify(publicConfig)).not.toContain('provider-secret')
  })

  it('denies headerless provider requests before touching Gateway or provider credentials', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL) => {
      if (String(_input) === 'https://gateway.example/api/Auth/WhoAmI') {
        return new Response(JSON.stringify({
          principal_id: 'user-1',
          principal_name: 'Ada',
          is_admin: false,
          permissions: ['Orchestrator.use'],
          effective_perms: ['Orchestrator.use'],
          source: 'http_bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'should not call provider' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await POST(new NextRequest('https://app.example/api/assistant/completion', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [],
        maxToolCalls: 0,
      }),
      headers: { 'content-type': 'application/json' },
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('denies same-origin provider requests without a browser session bearer', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL) => {
      if (String(_input) === 'https://gateway.example/api/Auth/WhoAmI') {
        return new Response(JSON.stringify({
          principal_id: 'user-1',
          principal_name: 'Ada',
          is_admin: false,
          permissions: ['Orchestrator.use'],
          effective_perms: ['Orchestrator.use'],
          source: 'http_bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'should not call provider' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await POST(providerRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 0,
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('denies browser session bearers that are not allowed to use the assistant', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('https://gateway.example/api/Auth/WhoAmI')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer limited-token')
      return new Response(JSON.stringify({
        principal_id: 'user-1',
        principal_name: 'Ada',
        is_admin: false,
        permissions: ['Gateway.use'],
        effective_perms: ['Gateway.use'],
        source: 'http_bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await POST(providerRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 0,
    }, {
      authorization: 'Bearer limited-token',
    }))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(upstreamFetch.mock.calls)).not.toContain('provider-secret')
  })

  it('rejects cross-origin and oversized requests without provider details', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL) => {
      if (String(_input) === 'https://gateway.example/api/Auth/WhoAmI') {
        return new Response(JSON.stringify({
          principal_id: 'user-1',
          principal_name: 'Ada',
          is_admin: false,
          permissions: ['Orchestrator.use'],
          effective_perms: ['Orchestrator.use'],
          source: 'http_bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'should not call provider' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const crossOrigin = await POST(providerRequest({ messages: [], tools: [] }, {
      origin: 'https://evil.example',
    }))
    const oversized = await POST(providerRequest({
      messages: [{ role: 'user', content: 'x'.repeat(140 * 1024) }],
      tools: [],
      maxToolCalls: 0,
    }, {
      authorization: 'Bearer browser-session-token',
    }))

    expect(crossOrigin.status).toBe(404)
    expect(oversized.status).toBe(400)
    await expect(crossOrigin.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
    await expect(oversized.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
    expect(upstreamFetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(upstreamFetch.mock.calls)).not.toContain('provider-secret')
    expect(JSON.stringify(upstreamFetch.mock.calls)).not.toContain('provider.example')
  })

  it('bounds upstream failures to a generic unavailable response', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://gateway.example/api/Auth/WhoAmI') {
        return new Response(JSON.stringify({
          principal_id: 'user-1',
          principal_name: 'Ada',
          is_admin: false,
          permissions: ['Orchestrator.use'],
          effective_perms: ['Orchestrator.use'],
          source: 'http_bearer',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        error: {
          message: 'provider internal token detail',
        },
      }), { status: 500, headers: { 'content-type': 'application/json' } })
    }))

    const response = await POST(providerRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 1,
    }, {
      authorization: 'Bearer browser-session-token',
    }))

    expect(response.status).toBe(502)
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
    const body = await response.json()
    expect(body).toEqual({ ok: false, error: 'assistant_unavailable' })
    expect(JSON.stringify(body)).not.toMatch(/provider internal|provider-secret/i)
  })
})

function configRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example/api/assistant/completion', {
    method: 'GET',
    headers: {
      origin: 'https://app.example',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  })
}

function providerRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example/api/assistant/completion', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example',
      'sec-fetch-site': 'same-origin',
      ...headers,
    },
  })
}

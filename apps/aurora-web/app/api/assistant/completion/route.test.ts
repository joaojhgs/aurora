import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET, POST } from './route'

describe('/api/assistant/completion', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('fails closed when the server-only provider config is absent', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', '')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', '')

    const getResponse = GET()
    const postResponse = await POST(providerRequest({ messages: [], tools: [] }))

    expect(getResponse.status).toBe(404)
    await expect(getResponse.json()).resolves.toEqual({ enabled: false })
    expect(postResponse.status).toBe(404)
    await expect(postResponse.json()).resolves.toEqual({ ok: false, error: 'assistant_unavailable' })
  })

  it('keeps the provider secret on the server-side request only', async () => {
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_ENDPOINT', 'https://provider.example/v1/chat/completions')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_MODEL', 'small-model')
    vi.stubEnv('AURORA_LIGHTWEIGHT_ASSISTANT_API_KEY', 'provider-secret')
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe('https://provider.example/v1/chat/completions')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer provider-secret')
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Ready.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const getResponse = GET()
    const postResponse = await POST(providerRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
      maxToolCalls: 1,
    }))

    expect(getResponse.status).toBe(200)
    const publicConfig = await getResponse.json()
    expect(publicConfig).toEqual({ enabled: true })
    expect(postResponse.status).toBe(200)
    await expect(postResponse.json()).resolves.toEqual({ type: 'message', content: 'Ready.' })
    expect(JSON.stringify(upstreamFetch.mock.calls)).toContain('provider-secret')
    expect(JSON.stringify(publicConfig)).not.toContain('provider-secret')
  })
})

function providerRequest(body: unknown): NextRequest {
  return new NextRequest('https://app.example/api/assistant/completion', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Page from './page'

describe('Diagnostics page', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('renders product-safe diagnostics, redaction, and support export states', async () => {
    const markup = renderToStaticMarkup(await Page())

    expect(markup).toContain('Health Checks')
    expect(markup).toContain('Available Features')
    expect(markup).toContain('Device Connection')
    expect(markup).toContain('Trusted device connection health')
    expect(markup).toContain('Redaction Preview')
    expect(markup).toContain('Tokens and credentials')
    expect(markup).toContain('Support Bundle Export')
    expect(markup).toContain('Confirmation controls are loading')

    const appOwnedMarkup = markup.slice(0, markup.indexOf('<div class="flex flex-col gap-6">'))
    expect(appOwnedMarkup).not.toMatch(/Gateway\.|WebRTC|DataChannel|sidecar|evidence|SDK|fallback|provider|contract|raw|room-password|\/home\//i)
  })

  it('does not perform privileged server diagnostics reads with the shared environment token', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    vi.stubEnv('AURORA_GATEWAY_TOKEN', 'server-shared-token')
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: plainHeaders(init?.headers) })
      return new Response(JSON.stringify({ detail: { message: 'authentication_required' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    })

    renderToStaticMarkup(await Page())

    expect(calls.every((call) => call.headers.Authorization === undefined && call.headers.authorization === undefined)).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('server-shared-token')
    expect(calls.map((call) => call.url)).not.toContain('https://gateway.example/api/services')
    expect(calls.map((call) => call.url)).not.toContain('https://gateway.example/api/Gateway/GetDeploymentTopology')
    expect(calls.map((call) => call.url)).not.toContain('https://gateway.example/api/Gateway/GetWebRTCDiagnostics')
    expect(calls.map((call) => call.url)).not.toContain('https://gateway.example/api/Gateway/GetMeshStatus')
    expect(calls.map((call) => call.url)).not.toContain('https://gateway.example/api/Gateway/ExplainRoute')
  })
})

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers)
  return Object.fromEntries(normalized.entries())
}

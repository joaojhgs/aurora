import { afterEach, describe, expect, it, vi } from 'vitest'
import { getShellSnapshot } from './shell-state'

describe('getShellSnapshot', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('does not attach the shared environment Gateway token during server shell reads', async () => {
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

    const snapshot = await getShellSnapshot()

    expect(snapshot.loadState).toBe('error')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.headers.Authorization === undefined && call.headers.authorization === undefined)).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('server-shared-token')
  })
})

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers)
  return Object.fromEntries(normalized.entries())
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from './route'

describe('/aurora-voice-assets', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('proxies allowlisted GitHub speech archives same-origin', async () => {
    const body = new Uint8Array([1, 2, 3, 4])
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2',
      )
      const response = new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(body.byteLength),
        },
      })
      Object.defineProperty(response, 'url', {
        value: 'https://objects.githubusercontent.com/github-production-release-asset-2e65be/kws.tar.bz2',
      })
      return response
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await GET(assetRequest(
      '/aurora-voice-assets/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2',
    ), {
      params: Promise.resolve({
        path: ['k2-fsa', 'sherpa-onnx', 'releases', 'download', 'kws-models', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2'],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('cache-control')).toBe('private, max-age=0')
    await expect(response.arrayBuffer()).resolves.toEqual(body.buffer)
  })

  it('rejects paths outside the Sherpa release tree', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await GET(assetRequest('/aurora-voice-assets/evil/payload.bin'), {
      params: Promise.resolve({ path: ['evil', 'payload.bin'] }),
    })

    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects path traversal segments', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await GET(assetRequest('/aurora-voice-assets/k2-fsa/sherpa-onnx/releases/download/../secrets.bin'), {
      params: Promise.resolve({
        path: ['k2-fsa', 'sherpa-onnx', 'releases', 'download', '..', 'secrets.bin'],
      }),
    })

    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects malformed path encoding before contacting the upstream host', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await GET(assetRequest('/aurora-voice-assets/k2-fsa/sherpa-onnx/releases/download/%25/payload.bin'), {
      params: Promise.resolve({
        path: ['k2-fsa', 'sherpa-onnx', 'releases', 'download', '%', 'payload.bin'],
      }),
    })

    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('fails closed when the upstream response has no verifiable final URL', async () => {
    const upstreamFetch = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await GET(assetRequest(
      '/aurora-voice-assets/k2-fsa/sherpa-onnx/releases/download/kws-models/pack.tar.bz2',
    ), {
      params: Promise.resolve({
        path: ['k2-fsa', 'sherpa-onnx', 'releases', 'download', 'kws-models', 'pack.tar.bz2'],
      }),
    })

    expect(response.status).toBe(502)
  })
})

function assetRequest(path: string): NextRequest {
  return new NextRequest(`https://100.64.0.3:3410${path}`, { method: 'GET' })
}

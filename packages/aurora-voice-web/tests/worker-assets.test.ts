import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAuroraVoiceWorkerUrl, resolveSameOriginWasmUrl } from '../src/worker-assets.js'

const packageDir = new URL('..', import.meta.url).pathname
const distDir = join(packageDir, 'dist')

describe('voice worker production assets', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds the default module Worker URL with an explicit generated WASM URL', () => {
    const url = buildAuroraVoiceWorkerUrl(
      new URL('https://voice.example/dist/voice-worker.js'),
      new URL('https://voice.example/dist/wasm/aurora_voice_wasm_bg.wasm')
    )

    expect(url.href).toBe('https://voice.example/dist/voice-worker.js?wasm=https%3A%2F%2Fvoice.example%2Fdist%2Fwasm%2Faurora_voice_wasm_bg.wasm')
  })

  it('resolves bundler-generated relative asset URLs against the browser page', () => {
    const workerUrl = { href: '/_next/static/media/voice-worker.1234.js' } as URL
    const wasmUrl = { href: '/_next/static/media/aurora_voice_wasm_bg.5678.wasm' } as URL

    const url = buildAuroraVoiceWorkerUrl(
      workerUrl,
      wasmUrl,
      'http://127.0.0.1:3427/assistant'
    )

    expect(url.href).toBe(
      'http://127.0.0.1:3427/_next/static/media/voice-worker.1234.js?wasm=http%3A%2F%2F127.0.0.1%3A3427%2F_next%2Fstatic%2Fmedia%2Faurora_voice_wasm_bg.5678.wasm'
    )
  })

  it('uses the current browser page for relative assets when no base is supplied', () => {
    vi.stubGlobal('location', { href: 'https://voice.example/assistant' })

    const url = buildAuroraVoiceWorkerUrl(
      { href: '/assets/voice-worker.js' },
      { href: '/assets/aurora_voice_wasm_bg.wasm' }
    )

    expect(url.href).toBe(
      'https://voice.example/assets/voice-worker.js?wasm=https%3A%2F%2Fvoice.example%2Fassets%2Faurora_voice_wasm_bg.wasm'
    )
  })

  it('accepts only same-origin generated WASM URLs in the worker', () => {
    expect(resolveSameOriginWasmUrl({ href: 'https://voice.example/dist/voice-worker.js?wasm=https%3A%2F%2Fvoice.example%2Fdist%2Fwasm%2Faurora_voice_wasm_bg.wasm' }).href)
      .toBe('https://voice.example/dist/wasm/aurora_voice_wasm_bg.wasm')
    expect(resolveSameOriginWasmUrl({ href: 'https://voice.example/dist/voice-worker.js' }).href)
      .toBe('https://voice.example/dist/wasm/aurora_voice_wasm_bg.wasm')
    expect(() => resolveSameOriginWasmUrl({ href: 'https://voice.example/dist/voice-worker.js?wasm=https%3A%2F%2Fother.example%2Faurora_voice_wasm_bg.wasm' }))
      .toThrow('Voice worker is not available')
  })

  it('emits a bundled module Worker and separate generated WASM core after build', () => {
    const workerPath = join(distDir, 'voice-worker.js')
    const wasmPath = join(distDir, 'wasm', 'aurora_voice_wasm_bg.wasm')
    expect(existsSync(workerPath)).toBe(true)
    expect(existsSync(wasmPath)).toBe(true)

    const workerSource = readFileSync(workerPath, 'utf8')
    expect(workerSource).not.toMatch(/\b(?:import|export)\s+(?:[^'"]+\s+from\s+)?['"]\.\//)
    expect(workerSource).not.toMatch(/\bimport\(\s*['"]\.\//)
    expect(workerSource).toContain('aurora_voice_wasm_bg.wasm')
    expect(workerSource).toContain('resolveSameOriginWasmUrl')
  })
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buildAuroraVoiceWorkerUrl, resolveSameOriginWasmUrl } from '../src/worker-assets.js'

const packageDir = new URL('..', import.meta.url).pathname
const distDir = join(packageDir, 'dist')

describe('voice worker production assets', () => {
  it('builds the default module Worker URL with an explicit generated WASM URL', () => {
    const url = buildAuroraVoiceWorkerUrl(
      new URL('https://voice.example/dist/voice-worker.js'),
      new URL('https://voice.example/dist/wasm/aurora_voice_wasm_bg.wasm')
    )

    expect(url.href).toBe('https://voice.example/dist/voice-worker.js?wasm=https%3A%2F%2Fvoice.example%2Fdist%2Fwasm%2Faurora_voice_wasm_bg.wasm')
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

import { describe, expect, it } from 'vitest'

import { AuroraSherpaWasmVoiceEngine, assertNoBundledDataPreload, fetchNeutralEngineSource } from '../src/sherpa-engine.js'
import type { AuroraPcmFrameEnvelope, AuroraVoiceWebModelBindings, AuroraVoiceWebModelFileBinding } from '../src/types.js'

describe('AuroraSherpaWasmVoiceEngine', () => {
  it('keeps all capabilities unavailable without selected model bindings', async () => {
    const engine = new AuroraSherpaWasmVoiceEngine()

    await expect(engine.initialize(undefined)).resolves.toEqual({ vad: false, kws: false, stt: false, tts: false })
  })

  it('mounts exact selected files and advertises only initialized Sherpa capabilities', async () => {
    const mounted: string[] = []
    const calls: string[] = []
    const engine = new AuroraSherpaWasmVoiceEngine({
      engineAssets: engineAssets(),
      loadModule: async (_url, files) => {
        for (const file of files) mounted.push(`${file.task}:${file.virtualPath}:${file.byteLength}`)
        return {
          FS_createDataFile: (_parent, name) => mounted.push(`fs:/${name}`)
        }
      },
      loadHelpers: async () => ({
        createVad: () => new FakeVad(calls),
        createOfflineRecognizer: () => new FakeRecognizer(calls),
        createKws: () => new FakeKws(calls)
      })
    })

    const capabilities = await engine.initialize(bindings([
      modelFile('vad', 'silero-vad.onnx', [1]),
      modelFile('stt', 'moonshine-encoder.ort', [2]),
      modelFile('stt', 'moonshine-merged-decoder.ort', [3]),
      modelFile('stt', 'moonshine-tokens.txt', [4]),
      modelFile('kws', 'encoder.onnx', [5]),
      modelFile('kws', 'decoder.onnx', [6]),
      modelFile('kws', 'joiner.onnx', [7]),
      modelFile('kws', 'kws-tokens.txt', [8])
    ]))
    await engine.startSession()
    const inference = await engine.pushPcmI16(frame(), new Int16Array([0, 32767, -32768]))
    await engine.stopSession()
    engine.dispose()

    expect(capabilities).toEqual({ vad: true, kws: true, stt: true, tts: false })
    expect(mounted).toContain('vad:/vad-silero-vad.onnx:1')
    expect(mounted).toContain('stt:/stt-moonshine-encoder.ort:1')
    expect(mounted).toContain('fs:/stt-moonshine-merged-decoder.ort')
    expect(mounted).toContain('kws:/kws-joiner.onnx:1')
    expect(inference).toEqual({
      vad: { active: true, speechDetected: true, sequence: 0, redacted: true },
      kwsHits: [{ keyword: 'aurora', score: 0.75, sequence: 0, redacted: true }],
      stt: [{ text: 'hello', final: false, sequence: 0, redacted: true }],
      redacted: true
    })
    expect(calls).toEqual([
      'vad:reset',
      'stream:reset',
      'kws:reset',
      'vad:accept:3',
      'vad:pop',
      'stream:accept:16000:3',
      'recognizer:decode',
      'recognizer:result',
      'stream:accept:16000:3',
      'kws:decode',
      'kws:result',
      'vad:flush',
      'stream:finished',
      'stream:finished',
      'stream:free',
      'stream:free',
      'vad:free',
      'recognizer:free',
      'kws:free'
    ])
  })

  it('fails closed when selected files are present but matching engine assets are missing', async () => {
    const engine = new AuroraSherpaWasmVoiceEngine()

    await expect(engine.initialize(bindings([modelFile('vad', 'silero-vad.onnx', [1])])))
      .rejects.toMatchObject({ code: 'missing_vad_asr_engine' })
  })

  it('recomputes selected model SHA-256 before loading or mounting bytes', async () => {
    let loaded = false
    const engine = new AuroraSherpaWasmVoiceEngine({
      engineAssets: engineAssets(),
      loadModule: async () => {
        loaded = true
        return { FS_createDataFile: () => undefined }
      },
      loadHelpers: async () => ({ createVad: () => new FakeVad([]) })
    })

    await expect(engine.initialize(bindings([{ ...modelFile('vad', 'silero-vad.onnx', [1]), sha256: '0'.repeat(64) }])))
      .rejects.toMatchObject({ code: 'model_hash_mismatch' })
    expect(loaded).toBe(false)
  })

  it('rejects engine sources that declare an Emscripten data preload without fetching data assets', async () => {
    const fetched: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      fetched.push(String(input))
      return {
        ok: true,
        text: async () => 'var PACKAGE_NAME = "sherpa-onnx-wasm-main-vad-asr.data";'
      } as Response
    }

    await expect(fetchNeutralEngineSource('https://voice.example/sherpa-onnx-wasm-main-vad-asr.js', fetchImpl))
      .rejects.toMatchObject({ code: 'bundled_data_rejected' })
    expect(fetched).toEqual(['https://voice.example/sherpa-onnx-wasm-main-vad-asr.js'])
    expect(fetched.some((url) => url.endsWith('.data'))).toBe(false)
    expect(() => assertNoBundledDataPreload('var FS_createPreloadedFile = () => undefined')).not.toThrow()
    expect(() => assertNoBundledDataPreload('function engineOnly() { return 1 }')).not.toThrow()
  })
})

function bindings(files: readonly AuroraVoiceWebModelFileBinding[]): AuroraVoiceWebModelBindings {
  const models: AuroraVoiceWebModelBindings['models'] = [
    ...(files.some((file) => file.task === 'vad')
      ? [{
          task: 'vad' as const,
          family: 'silero-vad' as const,
          kind: 'vad' as const,
          files: [ref(files, 'vad', 'model', 'silero-vad.onnx')]
        }]
      : []),
    ...(files.some((file) => file.task === 'stt')
      ? [{
          task: 'stt' as const,
          family: 'moonshine' as const,
          kind: 'offline-asr' as const,
          files: [
            ref(files, 'stt', 'encoder', 'moonshine-encoder.ort'),
            ref(files, 'stt', 'mergedDecoder', 'moonshine-merged-decoder.ort'),
            ref(files, 'stt', 'tokens', 'moonshine-tokens.txt')
          ]
        }]
      : []),
    ...(files.some((file) => file.task === 'kws')
      ? [{
          task: 'kws' as const,
          family: 'sherpa-kws-transducer' as const,
          kind: 'keyword-spotter' as const,
          files: [
            ref(files, 'kws', 'encoder', 'encoder.onnx'),
            ref(files, 'kws', 'decoder', 'decoder.onnx'),
            ref(files, 'kws', 'joiner', 'joiner.onnx'),
            ref(files, 'kws', 'tokens', 'kws-tokens.txt')
          ],
          config: { keywords: 'aurora', keywordsScore: 1.0, keywordsThreshold: 0.25 }
        }]
      : [])
  ]
  return { files, models }
}

function ref(
  files: readonly AuroraVoiceWebModelFileBinding[],
  task: 'vad' | 'kws' | 'stt',
  role: AuroraVoiceWebModelBindings['models'][number]['files'][number]['role'],
  fileId: string
) {
  const file = files.find((candidate) => candidate.task === task && candidate.fileId === fileId)
  if (file === undefined) throw new Error(`missing fixture ${task}:${fileId}`)
  return { role, fileId: file.fileId, virtualPath: file.virtualPath }
}

function engineAssets() {
  return {
    vadAsrModuleUrl: 'https://voice.example/sherpa-onnx-wasm-main-vad-asr.js',
    vadHelperUrl: 'https://voice.example/sherpa-onnx-vad.js',
    asrHelperUrl: 'https://voice.example/sherpa-onnx-asr.js',
    kwsModuleUrl: 'https://voice.example/sherpa-onnx-wasm-kws-main.js',
    kwsHelperUrl: 'https://voice.example/sherpa-onnx-kws.js'
  }
}

function modelFile(task: 'vad' | 'kws' | 'stt', fileId: string, bytes: readonly number[]): AuroraVoiceWebModelFileBinding {
  return {
    task,
    fileId,
    virtualPath: `/${task}-${fileId}`,
    sha256: SHA_BY_BYTE[bytes[0] ?? 0] ?? '',
    byteLength: bytes.length,
    bytes: Uint8Array.from(bytes)
  }
}

const SHA_BY_BYTE: Record<number, string> = {
  1: '4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a',
  2: 'dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986',
  3: '084fed08b978af4d7d196a7446a86b58009e636b611db16211b65a9aadff29c5',
  4: 'e52d9c508c502347344d8c07ad91cbd6068afc75ff6292f062a09ca381c89e71',
  5: 'e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db',
  6: '67586e98fad27da0b9968bc039a1ef34c939b9b8e523a8bef89d478608c5ecf6',
  7: 'ca358758f6d27e6cf45272937977a748fd88391db679ceda7dc7bf1f005ee879',
  8: 'beead77994cf573341ec17b58bbf7eb34d2711c993c1d976b128b3188dc1829a'
}

function frame(): AuroraPcmFrameEnvelope {
  return {
    sessionId: 'owner:1',
    generation: 1,
    sequence: 0,
    discontinuity: false,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 3,
    byteLength: 6,
    queuedBytes: 6
  }
}

class FakeVad {
  constructor(private readonly calls: string[]) {}
  acceptWaveform(samples: Float32Array): void { this.calls.push(`vad:accept:${samples.length}`) }
  isDetected(): boolean { return true }
  isEmpty(): boolean { return this.calls.includes('vad:pop') }
  pop(): void { this.calls.push('vad:pop') }
  reset(): void { this.calls.push('vad:reset') }
  flush(): void { this.calls.push('vad:flush') }
  free(): void { this.calls.push('vad:free') }
}

class FakeRecognizer {
  constructor(private readonly calls: string[]) {}
  createStream(): FakeStream { return new FakeStream(this.calls) }
  isReady(): boolean { return !this.calls.includes('recognizer:decode') }
  decode(): void { this.calls.push('recognizer:decode') }
  getResult(): unknown { this.calls.push('recognizer:result'); return { text: 'hello' } }
  free(): void { this.calls.push('recognizer:free') }
}

class FakeKws {
  constructor(private readonly calls: string[]) {}
  createStream(): FakeStream { return new FakeStream(this.calls) }
  isReady(): boolean { return !this.calls.includes('kws:decode') }
  decode(): void { this.calls.push('kws:decode') }
  getResult(): unknown { this.calls.push('kws:result'); return { keyword: 'aurora', score: 0.75 } }
  reset(): void { this.calls.push('kws:reset') }
  free(): void { this.calls.push('kws:free') }
}

class FakeStream {
  constructor(private readonly calls: string[]) {}
  acceptWaveform(sampleRate: number, samples: Float32Array): void { this.calls.push(`stream:accept:${sampleRate}:${samples.length}`) }
  inputFinished(): void { this.calls.push('stream:finished') }
  reset(): void { this.calls.push('stream:reset') }
  free(): void { this.calls.push('stream:free') }
}

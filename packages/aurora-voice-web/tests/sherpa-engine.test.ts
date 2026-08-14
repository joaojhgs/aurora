import { describe, expect, it } from 'vitest'

import { AuroraSherpaWasmVoiceEngine } from '../src/sherpa-engine.js'
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
      loadModule: async (_url, files) => {
        for (const file of files) mounted.push(`${file.task}:${file.virtualPath}:${file.byteLength}`)
        return {
          FS_createDataFile: (_parent, name) => mounted.push(`fs:/${name}`)
        }
      },
      loadHelpers: async () => ({
        createVad: () => new FakeVad(calls),
        createOnlineRecognizer: () => new FakeRecognizer(calls),
        createKws: () => new FakeKws(calls)
      })
    })

    const capabilities = await engine.initialize(bindings([
      modelFile('vad', 'silero-vad.onnx', [1]),
      modelFile('stt', 'moonshine-encoder.ort', [2]),
      modelFile('stt', 'tokens.txt', [3]),
      modelFile('kws', 'encoder.onnx', [4]),
      modelFile('kws', 'decoder.onnx', [5]),
      modelFile('kws', 'joiner.onnx', [6]),
      modelFile('kws', 'tokens.txt', [7])
    ]))
    await engine.startSession()
    await engine.pushPcmI16(frame(), new Int16Array([0, 32767, -32768]))
    await engine.stopSession()
    engine.dispose()

    expect(capabilities).toEqual({ vad: true, kws: true, stt: true, tts: false })
    expect(mounted).toContain('vad:/vad-silero-vad.onnx:1')
    expect(mounted).toContain('stt:/stt-moonshine-encoder.ort:1')
    expect(mounted).toContain('kws:/kws-joiner.onnx:1')
    expect(calls).toEqual([
      'vad:reset',
      'recognizer:reset',
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

    await expect(engine.initialize({ files: [modelFile('vad', 'silero-vad.onnx', [1])] }))
      .rejects.toMatchObject({ code: 'missing_vad_asr_engine' })
  })
})

function bindings(files: readonly AuroraVoiceWebModelFileBinding[]): AuroraVoiceWebModelBindings {
  return {
    files,
    sherpaAssets: {
      vadAsrModuleUrl: 'https://voice.example/sherpa-vad-asr.js',
      vadHelperUrl: 'https://voice.example/sherpa-vad.js',
      asrHelperUrl: 'https://voice.example/sherpa-asr.js',
      kwsModuleUrl: 'https://voice.example/sherpa-kws.js',
      kwsHelperUrl: 'https://voice.example/sherpa-kws-helper.js'
    }
  }
}

function modelFile(task: 'vad' | 'kws' | 'stt', fileId: string, bytes: readonly number[]): AuroraVoiceWebModelFileBinding {
  return {
    task,
    fileId,
    virtualPath: `/${task}-${fileId}`,
    sha256: 'a'.repeat(64),
    byteLength: bytes.length,
    bytes: Uint8Array.from(bytes)
  }
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
  getResult(): unknown { this.calls.push('recognizer:result'); return { text: '' } }
  reset(): void { this.calls.push('recognizer:reset') }
  free(): void { this.calls.push('recognizer:free') }
}

class FakeKws {
  constructor(private readonly calls: string[]) {}
  createStream(): FakeStream { return new FakeStream(this.calls) }
  isReady(): boolean { return !this.calls.includes('kws:decode') }
  decode(): void { this.calls.push('kws:decode') }
  getResult(): unknown { this.calls.push('kws:result'); return { keyword: '' } }
  reset(): void { this.calls.push('kws:reset') }
  free(): void { this.calls.push('kws:free') }
}

class FakeStream {
  constructor(private readonly calls: string[]) {}
  acceptWaveform(sampleRate: number, samples: Float32Array): void { this.calls.push(`stream:accept:${sampleRate}:${samples.length}`) }
  inputFinished(): void { this.calls.push('stream:finished') }
  free(): void { this.calls.push('stream:free') }
}

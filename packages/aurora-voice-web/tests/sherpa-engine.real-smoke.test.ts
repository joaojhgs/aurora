import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { AuroraSherpaWasmVoiceEngine } from '../src/sherpa-engine.js'
import type { AuroraPcmFrameEnvelope, AuroraVoiceWebModelFileBinding, AuroraVoiceWebModelTask } from '../src/types.js'

const runSmoke = process.env.AURORA_VOICE_WEB_SHERPA_REAL_SMOKE === '1'

describe.skipIf(!runSmoke)('AuroraSherpaWasmVoiceEngine real Sherpa smoke', () => {
  it('initializes real same-origin-style Sherpa WASM assets from selected model files', async () => {
    const sherpaAssets: {
      vadAsrModuleUrl: string
      vadHelperUrl: string
      asrHelperUrl: string
      kwsModuleUrl?: string
      kwsHelperUrl?: string
    } = {
      vadAsrModuleUrl: requiredEnv('AURORA_VOICE_WEB_SHERPA_VAD_ASR_MODULE_URL'),
      vadHelperUrl: requiredEnv('AURORA_VOICE_WEB_SHERPA_VAD_HELPER_URL'),
      asrHelperUrl: requiredEnv('AURORA_VOICE_WEB_SHERPA_ASR_HELPER_URL')
    }
    if (process.env.AURORA_VOICE_WEB_SHERPA_KWS_MODULE_URL) sherpaAssets.kwsModuleUrl = process.env.AURORA_VOICE_WEB_SHERPA_KWS_MODULE_URL
    if (process.env.AURORA_VOICE_WEB_SHERPA_KWS_HELPER_URL) sherpaAssets.kwsHelperUrl = process.env.AURORA_VOICE_WEB_SHERPA_KWS_HELPER_URL
    const bindings = {
      files: await selectedFilesFromEnv(),
      sherpaAssets
    }
    const engine = new AuroraSherpaWasmVoiceEngine()
    const capabilities = await engine.initialize(bindings)

    expect(capabilities.vad || capabilities.stt || capabilities.kws).toBe(true)
    await engine.startSession()
    await engine.pushPcmI16(frame(), new Int16Array(1600))
    await engine.stopSession()
    engine.dispose()
  }, 60_000)
})

async function selectedFilesFromEnv(): Promise<readonly AuroraVoiceWebModelFileBinding[]> {
  const specs = (process.env.AURORA_VOICE_WEB_SHERPA_MODEL_FILES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (specs.length === 0) throw new Error('AURORA_VOICE_WEB_SHERPA_MODEL_FILES is required')
  return Promise.all(specs.map(async (spec) => {
    const [task, path, sha256] = spec.split(':')
    if (!isTask(task) || !path || !sha256) throw new Error('model file specs must be task:path:sha256')
    const bytes = await readFile(path)
    const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? 'model'
    return {
      task,
      fileId: name,
      virtualPath: `/${task}-${name.replace(/[^A-Za-z0-9_.:-]/g, '_')}`,
      sha256,
      byteLength: bytes.byteLength,
      bytes: new Uint8Array(bytes)
    }
  }))
}

function requiredEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function isTask(value: unknown): value is AuroraVoiceWebModelTask {
  return value === 'vad' || value === 'kws' || value === 'stt'
}

function frame(): AuroraPcmFrameEnvelope {
  return {
    sessionId: 'real-smoke:1',
    generation: 1,
    sequence: 0,
    discontinuity: false,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 1600,
    byteLength: 3200,
    queuedBytes: 3200
  }
}

import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join, normalize, relative, sep } from 'node:path'

const repoRoot = normalize(join(import.meta.dirname, '..', '..', '..', '..'))
const packageRoot = join(repoRoot, 'packages', 'aurora-voice-web')
const packDir = requiredPath('AURORA_POCKETTTS_PACK_DIR')
const wasmRoot = requiredPath('AURORA_SHERPA_WASM_TTS_ROOT')
const preparedAssetRoot = join(
  process.env.AURORA_ARTIFACTS_ROOT ?? join(repoRoot, '.artifacts'),
  'aurora-voice-web-sherpa-pockettts-browser-smoke-assets'
)
const nodeFsPromises = import('node:fs/promises').then((module) => module as unknown as NodeFsPromises)
const packFiles = [
  { fileId: 'lm-flow', role: 'lmFlow', name: 'lm_flow.int8.onnx' },
  { fileId: 'lm-main', role: 'lmMain', name: 'lm_main.int8.onnx' },
  { fileId: 'encoder', role: 'encoder', name: 'encoder.onnx' },
  { fileId: 'decoder', role: 'decoder', name: 'decoder.int8.onnx' },
  { fileId: 'text-conditioner', role: 'textConditioner', name: 'text_conditioner.onnx' },
  { fileId: 'vocab', role: 'vocabJson', name: 'vocab.json' },
  { fileId: 'token-scores', role: 'tokenScoresJson', name: 'token_scores.json' },
  { fileId: 'protocol', role: 'pocketProtocol', name: 'pocket_protocol.json' },
  { fileId: 'bos', role: 'bosBeforeVoice', name: 'bos_before_voice.bin' },
  { fileId: 'fixed-voice-state', role: 'fixedVoiceState', name: 'fixed_voice_state.bin' }
] as const

let server: Server
let baseUrl: string
let selectedModels: readonly SelectedModel[]
let requestedPaths: string[] = []

test.beforeAll(async () => {
  await prepareNeutralTtsAssets()
  selectedModels = await resolveSelectedModels()
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    requestedPaths.push(pathname)
    const headers = {
      'cache-control': 'no-store',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin'
    }

    if (pathname === '/index.html') {
      response.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><meta charset="utf-8"><title>Aurora Sherpa PocketTTS browser smoke</title>')
      return
    }

    const served = pathname.startsWith('/sherpa/')
      ? await serveFile(response, headers, preparedAssetRoot, pathname.slice('/sherpa/'.length))
      : pathname.startsWith('/models/')
        ? await serveModel(response, headers, pathname.slice('/models/'.length))
        : pathname.startsWith('/dist/')
          ? await serveFile(response, headers, packageRoot, pathname.slice(1))
          : false
    if (!served) {
      response.writeHead(404, headers)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Sherpa PocketTTS browser smoke server did not expose a TCP port'))
        return
      }
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

test.afterAll(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test.beforeEach(async ({ page }) => {
  requestedPaths = []
  await page.goto(baseUrl)
})

test('synthesizes a locally built PocketTTS pack with the browser WebAssembly runtime', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  const result = await page.evaluate(async ({ assets, models, text }) => {
    // @ts-expect-error Playwright serves the built package at this browser URL.
    const { createAuroraBrowserVoiceRuntime } = await import('/dist/browser.js')
    const fetched = await Promise.all(models.map(async (model) => {
      const response = await fetch(model.url)
      if (!response.ok) throw new Error(`model_fetch_${model.fileId}`)
      return { ...model, bytes: new Uint8Array(await response.arrayBuffer()) }
    }))
    const modelBindings = {
      files: fetched.map((model) => ({
        task: 'tts' as const,
        fileId: model.fileId,
        virtualPath: model.virtualPath,
        sha256: model.sha256,
        byteLength: model.byteLength,
        bytes: model.bytes
      })),
      models: [{
        task: 'tts' as const,
        family: 'pockettts' as const,
        kind: 'offline-tts' as const,
        files: fetched
          .filter((model) => model.role !== null)
          .map((model) => ({
            role: model.role,
            fileId: model.fileId,
            virtualPath: model.virtualPath
          })),
        config: { referenceAudioMode: 'internal' }
      }]
    }
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'sherpa-pockettts-browser-smoke',
      workerUrl: new URL('/dist/voice-worker.js', location.href),
      wasmUrl: new URL('/dist/wasm/aurora_voice_wasm_bg.wasm', location.href),
      sherpaAssets: {
        ttsModuleUrl: new URL(assets.ttsModuleUrl, location.href),
        ttsHelperUrl: new URL(assets.ttsHelperUrl, location.href)
      },
      modelBindings,
      ttsTimeoutMs: 900_000,
      workerTimeoutMs: 60_000,
      sessionIdFactory: (ownerId: string, generation: number) => `${ownerId}:${generation}`
    })
    let audio
    try {
      audio = await runtime.synthesizeSpeech({ text, generation: 1 })
    } catch (error) {
      const code = typeof error === 'object' && error !== null &&
        'code' in error && typeof error.code === 'string' && /^[a-z_]{1,48}$/.test(error.code)
        ? error.code
        : 'unknown'
      throw new Error(`voice_smoke_${code}`)
    } finally {
      await runtime.dispose()
    }
    return {
      sampleRateHz: audio.sampleRateHz,
      sampleCount: audio.sampleCount,
      pcmLength: audio.pcm.length,
      finite: audio.pcm.every((sample: number) => Number.isFinite(sample)),
      peak: audio.pcm.reduce((max: number, sample: number) => Math.max(max, Math.abs(sample)), 0)
    }
  }, {
    assets: {
      ttsModuleUrl: '/sherpa/sherpa-onnx-wasm-main-tts.js',
      ttsHelperUrl: '/sherpa/sherpa-onnx-tts.js'
    },
    models: selectedModels.map((model) => ({
      ...model,
      url: `/models/${model.fileId}`
    })),
    text: process.env.AURORA_POCKETTTS_TEXT || defaultText(packDir)
  })

  expect(result.sampleRateHz).toBe(24_000)
  expect(result.sampleCount).toBeGreaterThan(2400)
  expect(result.pcmLength).toBe(result.sampleCount)
  expect(result.finite).toBe(true)
  expect(result.peak).toBeGreaterThan(0)
  expect(result.peak).toBeLessThanOrEqual(32_767)
  expect(browserErrors).toEqual([])
  expect(requestedPaths.some((path) => path.endsWith('.data'))).toBe(false)
})

interface SelectedModel {
  readonly fileId: string
  readonly role: string | null
  readonly virtualPath: string
  readonly sha256: string
  readonly byteLength: number
  readonly sourcePath: string
}

async function prepareNeutralTtsAssets(): Promise<void> {
  const fs = await nodeFsPromises
  await fs.mkdir(preparedAssetRoot, { recursive: true })
  await copyNeutral(join(wasmRoot, 'sherpa-onnx-wasm-main-tts.js'), 'sherpa-onnx-wasm-main-tts.js')
  await copyNeutral(join(wasmRoot, 'sherpa-onnx-wasm-main-tts.wasm'), 'sherpa-onnx-wasm-main-tts.wasm')
  await copyNeutral(join(wasmRoot, 'sherpa-onnx-tts.js'), 'sherpa-onnx-tts.js')
  const source = await fs.readFile(join(preparedAssetRoot, 'sherpa-onnx-wasm-main-tts.js'), 'utf8')
  const helperSource = await fs.readFile(join(preparedAssetRoot, 'sherpa-onnx-tts.js'), 'utf8')
  expect(source).not.toMatch(/\.data(?:["'`)\s?&]|$)/i)
  expect(source).not.toMatch(/remote_package_size|getPreloadedPackage|expectedDataFileDownloads|PACKAGE_NAME/i)
  expect(source).toMatch(/export\s+default/)
  expect(helperSource).toContain('export { createOfflineTts, getDefaultOfflineTtsModelType };')
}

async function copyNeutral(sourcePath: string, name: string): Promise<void> {
  await (await nodeFsPromises).copyFile(sourcePath, join(preparedAssetRoot, name))
}

async function resolveSelectedModels(): Promise<readonly SelectedModel[]> {
  const models = []
  for (const file of packFiles) {
    models.push(await selectedModel(file.fileId, file.role, `/${file.name}`, join(packDir, file.name)))
  }
  return models
}

async function selectedModel(
  fileId: string,
  role: string | null,
  virtualPath: string,
  sourcePath: string
): Promise<SelectedModel> {
  const bytes = await (await nodeFsPromises).readFile(sourcePath)
  return {
    fileId,
    role,
    virtualPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    sourcePath
  }
}

async function serveModel(response: any, headers: Record<string, string>, fileId: string): Promise<boolean> {
  const model = selectedModels.find((candidate) => candidate.fileId === fileId)
  if (model === undefined) return false
  const body = await (await nodeFsPromises).readFile(model.sourcePath)
  response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream' })
  response.end(body)
  return true
}

async function serveFile(response: any, headers: Record<string, string>, root: string, relativePath: string): Promise<boolean> {
  const filePath = normalize(join(root, relativePath))
  const rel = relative(root, filePath)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) return false
  try {
    const body = await (await nodeFsPromises).readFile(filePath)
    response.writeHead(200, { ...headers, 'content-type': contentType(filePath) })
    response.end(body)
    return true
  } catch {
    return false
  }
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

function requiredPath(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the PocketTTS browser smoke`)
  }
  return value
}

function defaultText(pack: string): string {
  return pack.includes('fr-24l') ? 'Bonjour, ceci est un essai.' : 'Hello, this is a voice check.'
}

interface NodeFsPromises {
  copyFile(source: string, target: string): Promise<void>
  mkdir(path: string, options: { readonly recursive: true }): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, content: string): Promise<void>
}

import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { join, normalize, relative, sep } from 'node:path'

const repoRoot = normalize(join(import.meta.dirname, '..', '..', '..', '..'))
const packageRoot = join(repoRoot, 'packages', 'aurora-voice-web')
const repoArtifactsRoot = process.env.AURORA_ARTIFACTS_ROOT ?? join(repoRoot, '.artifacts')
const preparedAssetRoot = join(repoArtifactsRoot, 'aurora-voice-web-sherpa-browser-smoke-assets')
const nodeFsPromises = import('node:fs/promises').then((module) => module as unknown as NodeFsPromises)
const selectedModelIds = new Set([
  'silero-vad',
  'moonshine-encoder',
  'moonshine-decoder-merged',
  'moonshine-tokens',
  'kws-encoder',
  'kws-decoder',
  'kws-joiner',
  'kws-tokens',
  'kws-bpe-vocab'
])

let server: Server
let baseUrl: string
let neutralAssets: NeutralSherpaAssets
let selectedModels: readonly SelectedModel[]
let requestedPaths: string[] = []

test.beforeAll(async () => {
  neutralAssets = await prepareNeutralSherpaAssets()
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
      response.end('<!doctype html><meta charset="utf-8"><title>Aurora Sherpa browser smoke</title>')
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
        reject(new Error('Sherpa browser smoke server did not expose a TCP port'))
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

test('runs production worker inference with same-origin neutral Sherpa assets and selected model bytes', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  const result = await page.evaluate(async ({ assets, models }) => {
    // @ts-expect-error Playwright serves the built package at this browser URL.
    const { createAuroraBrowserVoiceRuntime } = await import('/dist/browser.js')

    class ControlledPcmSource {
      session: { readonly sessionId: string; readonly generation: number } | null = null
      sink: { pushFrame(frame: unknown): Promise<boolean> } | null = null
      sequence = 0

      async start(session: { readonly sessionId: string; readonly generation: number }, sink: { pushFrame(frame: unknown): Promise<boolean> }) {
        this.session = session
        this.sink = sink
        this.sequence = 0
      }

      async stop() {}
      async cancel() {}

      async push(samples: Int16Array, discontinuity = false) {
        if (this.session === null || this.sink === null) throw new Error('source_not_active')
        const accepted = await this.sink.pushFrame({
          sessionId: this.session.sessionId,
          generation: this.session.generation,
          sequence: this.sequence,
          discontinuity,
          sampleRateHz: 16000,
          channels: 1,
          pcm: samples
        })
        this.sequence += 1
        return accepted
      }
    }

    const fetched = await Promise.all(models.map(async (model) => {
      const response = await fetch(model.url)
      if (!response.ok) throw new Error(`model_fetch_${model.fileId}`)
      return { ...model, bytes: new Uint8Array(await response.arrayBuffer()) }
    }))
    const modelBindings = {
      files: fetched.map((model) => ({
        task: model.task,
        fileId: model.fileId,
        virtualPath: model.virtualPath,
        sha256: model.sha256,
        byteLength: model.byteLength,
        bytes: model.bytes
      })),
      models: [{
        task: 'vad',
        family: 'silero-vad',
        kind: 'vad',
        files: [{ role: 'model', fileId: 'silero-vad', virtualPath: '/silero-vad.onnx' }]
      }, {
        task: 'stt',
        family: 'moonshine',
        kind: 'offline-asr',
        files: [
          { role: 'encoder', fileId: 'moonshine-encoder', virtualPath: '/moonshine-encoder.ort' },
          { role: 'mergedDecoder', fileId: 'moonshine-decoder-merged', virtualPath: '/moonshine-decoder-merged.ort' },
          { role: 'tokens', fileId: 'moonshine-tokens', virtualPath: '/moonshine-tokens.txt' }
        ],
        config: { language: 'en', task: 'transcribe' }
      }, {
        task: 'kws',
        family: 'sherpa-kws-transducer',
        kind: 'keyword-spotter',
        files: [
          { role: 'encoder', fileId: 'kws-encoder', virtualPath: '/kws-encoder.onnx' },
          { role: 'decoder', fileId: 'kws-decoder', virtualPath: '/kws-decoder.onnx' },
          { role: 'joiner', fileId: 'kws-joiner', virtualPath: '/kws-joiner.onnx' },
          { role: 'tokens', fileId: 'kws-tokens', virtualPath: '/kws-tokens.txt' },
          { role: 'bpeVocab', fileId: 'kws-bpe-vocab', virtualPath: '/kws-bpe.model' }
        ],
        config: { keywords: '\u2581HE LL O \u2581WORLD', keywordsScore: 1.0, keywordsThreshold: 0.25 }
      }]
    }

    const source = new ControlledPcmSource()
    const events: Array<Record<string, unknown>> = []
    const runtime = createAuroraBrowserVoiceRuntime({
      ownerId: 'sherpa-browser-smoke',
      workerUrl: new URL('/dist/voice-worker.js', location.href),
      wasmUrl: new URL('/dist/wasm/aurora_voice_wasm_bg.wasm', location.href),
      sherpaAssets: {
        vadAsrModuleUrl: new URL(assets.vadAsrModuleUrl, location.href),
        vadHelperUrl: new URL(assets.vadHelperUrl, location.href),
        asrHelperUrl: new URL(assets.asrHelperUrl, location.href),
        kwsModuleUrl: new URL(assets.kwsModuleUrl, location.href),
        kwsHelperUrl: new URL(assets.kwsHelperUrl, location.href)
      },
      modelBindings,
      pcmSource: source,
      workerTimeoutMs: 60000,
      sessionIdFactory: (ownerId: string, generation: number) => `${ownerId}:${generation}`
    })
    runtime.onEvent((event: Record<string, unknown>) => events.push({ ...event }))
    const session = await runtime.start()
    const capabilities = runtime.snapshot().capabilities
    const frame = deterministicPcm(4800)
    const accepted = []
    for (let index = 0; index < 4; index += 1) accepted.push(await source.push(frame, index === 0))
    const capturedAudio = await runtime.stop()
    await runtime.completeTurn()
    await runtime.dispose()
    return {
      session,
      capabilities,
      accepted,
      capturedAudio: {
        sampleRateHz: capturedAudio?.sampleRateHz ?? null,
        channels: capturedAudio?.channels ?? null,
        sampleCount: capturedAudio?.sampleCount ?? null,
        redacted: capturedAudio?.redacted ?? null
      },
      inferenceEvents: events.filter((event) => event.kind === 'voice_inference').map((event) => event.inference)
    }

    function deterministicPcm(sampleCount: number) {
      const pcm = new Int16Array(sampleCount)
      for (let index = 0; index < sampleCount; index += 1) {
        const value = Math.sin((2 * Math.PI * 440 * index) / 16000) * 1200
        pcm[index] = Math.round(value)
      }
      return pcm
    }
  }, {
    assets: {
      vadAsrModuleUrl: '/sherpa/sherpa-onnx-wasm-main-vad-asr.js',
      vadHelperUrl: '/sherpa/sherpa-onnx-vad.js',
      asrHelperUrl: '/sherpa/sherpa-onnx-asr.js',
      kwsModuleUrl: '/sherpa/sherpa-onnx-wasm-kws-main.js',
      kwsHelperUrl: '/sherpa/sherpa-onnx-kws.js'
    },
    models: selectedModels.map((model) => ({
      ...model,
      url: `/models/${model.fileId}`
    }))
  })

  expect(result.session).toMatchObject({ ownerId: 'sherpa-browser-smoke', sessionId: 'sherpa-browser-smoke:1', generation: 1 })
  expect(result.capabilities).toEqual({ vad: true, kws: true, stt: true, tts: false })
  expect(result.accepted).toEqual([true, true, true, true])
  expect(result.capturedAudio).toEqual({ sampleRateHz: 16000, channels: 1, sampleCount: 19200, redacted: true })
  expect(result.inferenceEvents.length).toBeGreaterThan(0)
  expect(result.inferenceEvents.every((inference: any) =>
    inference?.redacted === true &&
    typeof inference.vad?.active === 'boolean' &&
    Array.isArray(inference.kwsHits) &&
    Array.isArray(inference.stt)
  )).toBe(true)
  expect(browserErrors).toEqual([])
  expect(requestedPaths.some((path) => path.endsWith('.data'))).toBe(false)
  expect(requestedPaths.filter((path) => path.startsWith('/models/')).map((path) => path.slice('/models/'.length)).sort())
    .toEqual([...selectedModelIds].sort())
})

interface NeutralSherpaAssets {
  readonly vadAsrModulePath: string
  readonly vadAsrWasmPath: string
  readonly kwsModulePath: string
  readonly kwsWasmPath: string
}

interface SelectedModel {
  readonly task: 'vad' | 'stt' | 'kws'
  readonly fileId: string
  readonly virtualPath: string
  readonly sha256: string
  readonly byteLength: number
  readonly sourcePath: string
}

async function prepareNeutralSherpaAssets(): Promise<NeutralSherpaAssets> {
  const sourceRoot = await latestNeutralSherpaRoot()
  const vadAsrModulePath = await findFile(sourceRoot, 'sherpa-onnx-wasm-main-vad-asr.js')
  const vadAsrWasmPath = await findFile(sourceRoot, 'sherpa-onnx-wasm-main-vad-asr.wasm')
  const kwsModulePath = await findFile(sourceRoot, 'sherpa-onnx-wasm-kws-main.js')
  const kwsWasmPath = await findFile(sourceRoot, 'sherpa-onnx-wasm-kws-main.wasm')
  await (await nodeFsPromises).mkdir(preparedAssetRoot, { recursive: true })
  await copyNeutral(vadAsrModulePath, 'sherpa-onnx-wasm-main-vad-asr.js')
  await copyNeutral(vadAsrWasmPath, 'sherpa-onnx-wasm-main-vad-asr.wasm')
  await copyNeutral(kwsModulePath, 'sherpa-onnx-wasm-kws-main.js')
  await copyNeutral(kwsWasmPath, 'sherpa-onnx-wasm-kws-main.wasm')
  await copyNeutral(await findFile(sourceRoot, 'sherpa-onnx-vad.js'), 'sherpa-onnx-vad.js', '\nexport { createVad };\n')
  await copyNeutral(await findFile(sourceRoot, 'sherpa-onnx-asr.js'), 'sherpa-onnx-asr.js', '\nexport { OfflineRecognizer };\n')
  await copyNeutral(await findFile(sourceRoot, 'sherpa-onnx-kws.js'), 'sherpa-onnx-kws.js', '\nexport { createKws };\n')
  const copied = await Promise.all([
    (await nodeFsPromises).readFile(join(preparedAssetRoot, 'sherpa-onnx-wasm-main-vad-asr.js'), 'utf8'),
    (await nodeFsPromises).readFile(join(preparedAssetRoot, 'sherpa-onnx-wasm-kws-main.js'), 'utf8')
  ])
  for (const source of copied) {
    expect(source).not.toMatch(/\.data(?:["'`)\s?&]|$)/i)
    expect(source).not.toMatch(/remote_package_size|getPreloadedPackage|expectedDataFileDownloads|PACKAGE_NAME/i)
  }
  return { vadAsrModulePath, vadAsrWasmPath, kwsModulePath, kwsWasmPath }
}

async function copyNeutral(sourcePath: string, name: string, suffix = ''): Promise<void> {
  const target = join(preparedAssetRoot, name)
  if (suffix === '') {
    await (await nodeFsPromises).copyFile(sourcePath, target)
    return
  }
  await (await nodeFsPromises).writeFile(target, `${await (await nodeFsPromises).readFile(sourcePath, 'utf8')}${suffix}`)
}

async function resolveSelectedModels(): Promise<readonly SelectedModel[]> {
  const modelRoot = join(repoArtifactsRoot, 'pockettts', 'p4-native-voice', 'models')
  const moonshineRoot = join(modelRoot, 'extracted', 'sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27')
  const kwsRoot = join(modelRoot, 'extracted', 'sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01')
  return Promise.all([
    selectedModel('vad', 'silero-vad', '/silero-vad.onnx', join(modelRoot, 'silero-vad-v4.0.onnx')),
    selectedModel('stt', 'moonshine-encoder', '/moonshine-encoder.ort', join(moonshineRoot, 'encoder_model.ort')),
    selectedModel('stt', 'moonshine-decoder-merged', '/moonshine-decoder-merged.ort', join(moonshineRoot, 'decoder_model_merged.ort')),
    selectedModel('stt', 'moonshine-tokens', '/moonshine-tokens.txt', join(moonshineRoot, 'tokens.txt')),
    selectedModel('kws', 'kws-encoder', '/kws-encoder.onnx', join(kwsRoot, 'encoder-epoch-12-avg-2-chunk-16-left-64.onnx')),
    selectedModel('kws', 'kws-decoder', '/kws-decoder.onnx', join(kwsRoot, 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx')),
    selectedModel('kws', 'kws-joiner', '/kws-joiner.onnx', join(kwsRoot, 'joiner-epoch-12-avg-2-chunk-16-left-64.onnx')),
    selectedModel('kws', 'kws-tokens', '/kws-tokens.txt', join(kwsRoot, 'tokens.txt')),
    selectedModel('kws', 'kws-bpe-vocab', '/kws-bpe.model', join(kwsRoot, 'bpe.model'))
  ])
}

async function selectedModel(task: SelectedModel['task'], fileId: string, virtualPath: string, sourcePath: string): Promise<SelectedModel> {
  const bytes = await (await nodeFsPromises).readFile(sourcePath)
  return {
    task,
    fileId,
    virtualPath,
    sha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
    sourcePath
  }
}

async function serveModel(response: any, headers: Record<string, string>, fileId: string): Promise<boolean> {
  if (!selectedModelIds.has(fileId)) return false
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

async function latestNeutralSherpaRoot(): Promise<string> {
  const explicit = process.env.AURORA_VOICE_WEB_SHERPA_NEUTRAL_ROOT
  if (explicit !== undefined && explicit !== '') return explicit
  return (await (await nodeFsPromises).readFile(join(repoArtifactsRoot, 'latest-sherpa-neutral-src.txt'), 'utf8')).trim()
}

async function findFile(root: string, name: string): Promise<string> {
  const entries = await (await nodeFsPromises).readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      try {
        return await findFile(path, name)
      } catch {
        // Continue searching siblings.
      }
    }
  }
  throw new Error(`Missing ${name} under ${root}`)
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface NodeFsPromises {
  copyFile(source: string, target: string): Promise<void>
  mkdir(path: string, options: { readonly recursive: true }): Promise<void>
  readFile(path: string): Promise<Uint8Array>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<readonly DirEntry[]>
  writeFile(path: string, content: string): Promise<void>
}

interface DirEntry {
  readonly name: string
  isDirectory(): boolean
  isFile(): boolean
}

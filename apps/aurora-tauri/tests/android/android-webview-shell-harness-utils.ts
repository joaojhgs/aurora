import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import os from 'node:os'
import { extname, join, normalize, relative, sep } from 'node:path'

export interface AndroidWebViewShellMetadata {
  readonly deviceSerial: string
  readonly sdk: string
  readonly release: string
  readonly cpuAbi: string
  readonly fingerprint: string
  readonly webViewPackage: string
  readonly webViewVersion: string
  readonly shellPackage: string
  readonly shellVersion: string
  readonly browserVersion: string
  readonly userAgent: string
  readonly targetUrl: string
}

export interface AndroidWebViewShellHarness {
  readonly baseUrl: string
  readonly requests: readonly string[]
  waitForResult<T>(timeoutMs: number): Promise<T>
  close(): Promise<void>
}

export const webViewShellPackage = 'org.chromium.webview_shell'

const webViewShellActivity = `${webViewShellPackage}/.WebViewBrowserActivity`
const defaultAdb = '/home/developer/Android/Sdk/platform-tools/adb'
const defaultDeviceSerial = 'emulator-5554'
const androidTestDir = import.meta.dirname
const maxWasmCoreBytes = 143 * 1024
const maxWasmLoaderBytes = 48 * 1024
const forbiddenArtifactExtensions = new Set(['.onnx', '.gguf', '.bin', '.safetensors', '.pt', '.pth', '.tflite', '.wav', '.flac', '.mp3'])
const expectedWasmFiles = [
  'aurora_voice_wasm.d.ts',
  'aurora_voice_wasm.js',
  'aurora_voice_wasm_bg.wasm',
  'aurora_voice_wasm_bg.wasm.d.ts'
]

interface AndroidWebViewShellHarnessOptions {
  readonly indexHtml?: string
  readonly files?: Readonly<Record<string, string>>
}

export function resolveAdb(): string {
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME ? join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : undefined,
    process.env.ANDROID_SDK_ROOT ? join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : undefined,
    defaultAdb,
    join(os.homedir(), '.local/share/android-sdk/platform-tools/adb'),
    'adb'
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find((candidate) => candidate === 'adb' || existsSync(candidate)) ?? 'adb'
}

export function resolveDeviceSerial(): string {
  return process.env.AURORA_ANDROID_DEVICE_SERIAL ?? defaultDeviceSerial
}

export async function createAndroidWebViewShellHarness(root: string, options: AndroidWebViewShellHarnessOptions = {}): Promise<AndroidWebViewShellHarness> {
  const normalizedRoot = normalize(root)
  const requests: string[] = []
  let settledResult: unknown
  let settledError: Error | undefined
  let resolveResult: (value: unknown) => void = () => undefined
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve
  })
  const server = createServer(async (request, response) => {
    try {
      await handleStaticRequest(normalizedRoot, requests, request, response, options, (value) => {
        settledResult = value
        resolveResult(value)
      })
    } catch (error) {
      settledError = error instanceof Error ? error : new Error(String(error))
      response.writeHead(500, {
        'content-type': 'application/json',
        'cache-control': 'no-store'
      })
      response.end(JSON.stringify({ error: settledError.message }))
    }
  })
  const port = await listen(server)
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async waitForResult<T>(timeoutMs: number): Promise<T> {
      if (settledError !== undefined) throw settledError
      if (settledResult !== undefined) return settledResult as T
      const timeout = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for Android WebView Shell self-reported result after ${timeoutMs}ms`)), timeoutMs)
      })
      return await Promise.race([resultPromise, timeout]) as T
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}

export function adbOutput(adb: string, serial: string, args: readonly string[]): string {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
  }
  return result.stdout
}

export function adbOutputOrEmpty(adb: string, serial: string, args: readonly string[]): string {
  const result = spawnSync(adb, ['-s', serial, ...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  return result.status === 0 ? result.stdout : ''
}

export function runAdb(adb: string, serial: string, args: readonly string[]): void {
  const result = spawnSync(adb, ['-s', serial, ...args], { stdio: 'pipe', encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(' ')} failed: ${`${result.stdout}\n${result.stderr}`.trim()}`)
  }
}

export async function launchWebViewShell(adb: string, serial: string, url: string): Promise<void> {
  runAdb(adb, serial, ['wait-for-device'])
  runAdb(adb, serial, ['shell', 'pm', 'enable', webViewShellPackage])
  spawnSync(adb, ['-s', serial, 'logcat', '-c'], { stdio: 'ignore' })
  spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', webViewShellPackage], { stdio: 'ignore' })
  runAdb(adb, serial, ['shell', 'svc', 'power', 'stayon', 'true'])
  runAdb(adb, serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'])
  spawnSync(adb, ['-s', serial, 'shell', 'wm', 'dismiss-keyguard'], { stdio: 'ignore' })
  runAdb(adb, serial, [
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-d',
    url,
    '-n',
    webViewShellActivity,
    '--activity-clear-top'
  ])
}

export function cleanupWebViewShell(adb: string, serial: string, reversedPorts: readonly number[]): void {
  spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', webViewShellPackage], { stdio: 'ignore' })
  for (const port of reversedPorts) {
    spawnSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], { stdio: 'ignore' })
  }
}

async function handleStaticRequest(
  root: string,
  requests: string[],
  request: IncomingMessage,
  response: ServerResponse,
  options: AndroidWebViewShellHarnessOptions,
  settleResult: (value: unknown) => void
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname
  requests.push(pathname)
  if (pathname === '/__aurora_result__') {
    if (request.method !== 'POST') {
      response.writeHead(405)
      response.end()
      return
    }
    const raw = await readRequestBody(request, 256 * 1024)
    const parsed = JSON.parse(raw) as unknown
    settleResult(parsed)
    response.writeHead(204, {
      'cache-control': 'no-store'
    })
    response.end()
    return
  }
  if (pathname === '/__aurora_requests__') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    })
    response.end(JSON.stringify([...requests]))
    return
  }
  if (pathname === '/__aurora_artifacts__') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    })
    response.end(JSON.stringify(await artifactSummary(root, requests)))
    return
  }
  if (pathname === '/__aurora_voice_harness__.js') {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(await fs.readFile(join(androidTestDir, 'android-voice-worker-webview-shell-harness.js')))
    return
  }
  if (options.files?.[pathname] !== undefined) {
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(options.files[pathname])
    return
  }
  if (pathname === '/index.html') {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(options.indexHtml ?? `<!doctype html><meta charset="utf-8"><title>Aurora voice Android WebView Shell proof</title><body>running<script type="module">
      try {
        await import('/__aurora_voice_harness__.js');
        const result = await globalThis.__auroraWorkerAudioBridge.runProof();
        result.selfReported = {
          userAgent: navigator.userAgent,
          href: location.href,
          readyState: document.readyState,
          runtimePath: 'self-reporting-page'
        };
        await fetch('/__aurora_result__', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(result)
        });
        document.body.textContent = 'passed';
      } catch (error) {
        await fetch('/__aurora_result__', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ok: false,
            error: {
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
              stack: error?.stack ?? ''
            },
            selfReported: {
              userAgent: navigator.userAgent,
              href: location.href,
              readyState: document.readyState,
              runtimePath: 'self-reporting-page'
            }
          })
        }).catch(() => undefined);
        document.body.textContent = 'failed';
      }
    </script></body>`)
    return
  }
  const filePath = normalize(join(root, pathname))
  const rel = relative(root, filePath)
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    response.writeHead(403)
    response.end()
    return
  }
  try {
    const body = await fs.readFile(filePath)
    response.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store',
      ...(filePath.endsWith('.wasm') ? { 'cross-origin-resource-policy': 'same-origin' } : {})
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('Android WebView Shell result exceeded the size limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function artifactSummary(root: string, requests: readonly string[]) {
  const files = await listFiles(join(root, 'dist'))
  const forbidden = []
  for (const file of files) {
    const name = relative(join(root, 'dist'), file).replaceAll(sep, '/')
    if (forbiddenArtifactExtensions.has(extname(name))) forbidden.push(name)
  }
  const wasmRoot = join(root, 'dist', 'wasm')
  const wasmFiles = (await listFiles(wasmRoot)).map((file) => relative(wasmRoot, file).replaceAll(sep, '/')).sort()
  const wasmSizes: Record<string, number> = {}
  for (const file of wasmFiles) {
    wasmSizes[file] = (await fs.stat(join(wasmRoot, file))).size
  }
  const exactWasmInventory = JSON.stringify(wasmFiles) === JSON.stringify(expectedWasmFiles)
  const wasmCoreWithinLimit = (wasmSizes['aurora_voice_wasm_bg.wasm'] ?? Number.POSITIVE_INFINITY) <= maxWasmCoreBytes
  const wasmLoaderWithinLimit = (wasmSizes['aurora_voice_wasm.js'] ?? Number.POSITIVE_INFINITY) <= maxWasmLoaderBytes
  return {
    servedDist: requests.some((request) => request.startsWith('/dist/')),
    workerRequested: requests.includes('/dist/voice-worker.js'),
    wasmRequested: requests.includes('/dist/wasm/aurora_voice_wasm_bg.wasm'),
    exactWasmInventory,
    wasmCoreWithinLimit,
    wasmLoaderWithinLimit,
    wasmFiles,
    wasmSizes,
    forbiddenArtifactCount: forbidden.length,
    fileCount: files.length
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  }))
  return nested.flat()
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Android WebView Shell harness did not expose a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  if (filePath.endsWith('.json')) return 'application/json'
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'application/octet-stream'
}

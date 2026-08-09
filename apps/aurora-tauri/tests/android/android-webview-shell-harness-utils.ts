import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
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

export interface AndroidBrowserTarget {
  readonly packageName: string
  readonly activityName: string
  readonly label: string
  readonly commandLineFile?: string
  readonly commandLineText?: string
}

export interface AndroidBrowserRestoreState {
  readonly packageEnabledState: string
  readonly stayOnWhilePluggedIn: string
  readonly reverseMappings: readonly AndroidAdbReverseMapping[]
  readonly commandLine?: {
    readonly file: string
    readonly existed: boolean
    readonly content: string
  }
}

export interface AndroidBrowserClaims {
  readonly browserSurface: string
  readonly package: string
  readonly physicalDevice: boolean
  readonly chromePackage: boolean
  readonly mockedWorker: boolean
  readonly mockedWasm: boolean
  readonly pcmSource: string
  readonly microphonePermission: boolean
  readonly acousticCapture: boolean
}

export interface AndroidAdbReverseMapping {
  readonly serial: string
  readonly local: string
  readonly remote: string
}

export interface AndroidEmulatorMetadata {
  readonly roKernelQemu: '1'
  readonly sdk: '35'
  readonly release: '15'
  readonly cpuAbi: 'x86_64'
  readonly fingerprint: string
}

export interface AndroidWebViewShellHarness {
  readonly baseUrl: string
  readonly requests: readonly string[]
  waitForResult<T>(timeoutMs: number): Promise<T>
  close(): Promise<void>
}

export const webViewShellPackage = 'org.chromium.webview_shell'
export const chromiumChromePackage = 'org.chromium.chrome'

export const webViewShellTarget: AndroidBrowserTarget = {
  packageName: webViewShellPackage,
  activityName: '.WebViewBrowserActivity',
  label: 'Android WebView Shell'
}

export const chromiumChromeTarget: AndroidBrowserTarget = {
  packageName: chromiumChromePackage,
  activityName: 'com.google.android.apps.chrome.IntentDispatcher',
  label: 'Android Chromium snapshot',
  commandLineFile: '/data/local/tmp/chrome-command-line',
  commandLineText: 'chrome --no-first-run --disable-fre --disable-sync --disable-features=FirstRunExperience\n'
}

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
const defaultWebViewClaims: AndroidBrowserClaims = {
  browserSurface: 'Android emulator WebView Shell',
  package: webViewShellPackage,
  physicalDevice: false,
  chromePackage: false,
  mockedWorker: false,
  mockedWasm: false,
  pcmSource: 'deterministic injected Int16Array source',
  microphonePermission: false,
  acousticCapture: false
}

interface AndroidWebViewShellHarnessOptions {
  readonly indexHtml?: string
  readonly files?: Readonly<Record<string, string>>
  readonly claims?: AndroidBrowserClaims
  readonly harnessPrefix?: string
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

export function assertExpectedAndroidEmulator(adb: string, serial: string): AndroidEmulatorMetadata {
  const roKernelQemu = adbOutput(adb, serial, ['shell', 'getprop', 'ro.kernel.qemu']).trim()
  const sdk = adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.sdk']).trim()
  const release = adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.version.release']).trim()
  const cpuAbi = adbOutput(adb, serial, ['shell', 'getprop', 'ro.product.cpu.abi']).trim()
  const fingerprint = adbOutput(adb, serial, ['shell', 'getprop', 'ro.build.fingerprint']).trim()
  if (roKernelQemu !== '1' || sdk !== '35' || release !== '15' || cpuAbi !== 'x86_64') {
    throw new Error(`Android browser proof requires emulator API35/x86_64; got ro.kernel.qemu=${roKernelQemu}, sdk=${sdk}, release=${release}, cpuAbi=${cpuAbi}`)
  }
  return {
    roKernelQemu,
    sdk,
    release,
    cpuAbi,
    fingerprint
  }
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
        setTimeout(() => reject(new Error(`Timed out waiting for Android browser self-reported result after ${timeoutMs}ms`)), timeoutMs)
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

export function packageVersion(adb: string, serial: string, packageName: string): string {
  const output = adbOutputOrEmpty(adb, serial, ['shell', 'dumpsys', 'package', packageName])
  return /versionName=([^\s]+)/u.exec(output)?.[1] ?? 'unknown'
}

export function packageBaseApkPath(adb: string, serial: string, packageName: string): string {
  const output = adbOutput(adb, serial, ['shell', 'pm', 'path', packageName]).trim()
  const line = output.split('\n').find((entry) => entry.startsWith('package:') && entry.endsWith('/base.apk'))
    ?? output.split('\n').find((entry) => entry.startsWith('package:'))
  if (line === undefined) throw new Error(`Could not resolve base APK path for ${packageName}: ${output}`)
  return line.slice('package:'.length)
}

export async function sha256DeviceFile(adb: string, serial: string, path: string): Promise<string> {
  const hash = createHash('sha256')
  const child = spawn(adb, ['-s', serial, 'exec-out', 'cat', path], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (exitCode !== 0) throw new Error(`adb exec-out cat ${path} failed: ${stderr}`)
  return hash.digest('hex')
}

export function captureAndroidBrowserState(adb: string, serial: string, target: AndroidBrowserTarget): AndroidBrowserRestoreState {
  return {
    packageEnabledState: packageEnabledState(adb, serial, target.packageName),
    stayOnWhilePluggedIn: adbOutputOrEmpty(adb, serial, ['shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in']).trim(),
    reverseMappings: adbReverseMappings(adb, serial),
    commandLine: target.commandLineFile === undefined ? undefined : captureCommandLine(adb, serial, target.commandLineFile)
  }
}

function packageEnabledState(adb: string, serial: string, packageName: string): string {
  const output = adbOutputOrEmpty(adb, serial, ['shell', 'dumpsys', 'package', packageName])
  return /User 0:.*\senabled=([0-9]+)/u.exec(output)?.[1] ?? '0'
}

function captureCommandLine(adb: string, serial: string, file: string): AndroidBrowserRestoreState['commandLine'] {
  const exists = deviceFileExists(adb, serial, file)
  return {
    file,
    existed: exists,
    content: exists ? adbOutputOrEmpty(adb, serial, ['shell', 'cat', file]) : ''
  }
}

export async function launchWebViewShell(adb: string, serial: string, url: string): Promise<void> {
  launchAndroidBrowser(adb, serial, webViewShellTarget, url)
}

export function launchAndroidBrowser(adb: string, serial: string, target: AndroidBrowserTarget, url: string): AndroidBrowserRestoreState {
  runAdb(adb, serial, ['wait-for-device'])
  assertExpectedAndroidEmulator(adb, serial)
  const restoreState = captureAndroidBrowserState(adb, serial, target)
  try {
    runAdb(adb, serial, ['shell', 'pm', 'enable', target.packageName])
    spawnSync(adb, ['-s', serial, 'logcat', '-c'], { stdio: 'ignore' })
    spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', target.packageName], { stdio: 'ignore' })
    runAdb(adb, serial, ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '7'])
    if (target.commandLineFile !== undefined && target.commandLineText !== undefined) {
      writeDeviceFile(adb, serial, target.commandLineFile, target.commandLineText)
    }
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
      `${target.packageName}/${target.activityName}`,
      '--activity-clear-top'
    ])
    return restoreState
  } catch (error) {
    cleanupAndroidBrowser(adb, serial, target, [], restoreState)
    throw error
  }
}

export function cleanupWebViewShell(adb: string, serial: string, reversedPorts: readonly number[], restoreState?: AndroidBrowserRestoreState): void {
  cleanupAndroidBrowser(adb, serial, webViewShellTarget, reversedPorts, restoreState)
}

export function cleanupAndroidBrowser(adb: string, serial: string, target: AndroidBrowserTarget, reversedPorts: readonly number[], restoreState?: AndroidBrowserRestoreState): void {
  spawnSync(adb, ['-s', serial, 'shell', 'am', 'force-stop', target.packageName], { stdio: 'ignore' })
  for (const port of reversedPorts) {
    const local = `tcp:${port}`
    spawnSync(adb, ['-s', serial, 'reverse', '--remove', local], { stdio: 'ignore' })
    const priorMapping = restoreState?.reverseMappings.find((mapping) => mapping.local === local)
    if (priorMapping !== undefined) {
      spawnSync(adb, ['-s', serial, 'reverse', priorMapping.local, priorMapping.remote], { stdio: 'ignore' })
    }
  }
  if (restoreState?.commandLine !== undefined) {
    restoreCommandLine(adb, serial, restoreState.commandLine)
  }
  if (restoreState !== undefined) {
    restoreStayOnWhilePluggedIn(adb, serial, restoreState.stayOnWhilePluggedIn)
    restorePackageEnabledState(adb, serial, target.packageName, restoreState.packageEnabledState)
  }
}

export function removeAdbReverseMapping(adb: string, serial: string, local: string): void {
  spawnSync(adb, ['-s', serial, 'reverse', '--remove', local], { stdio: 'ignore' })
}

export function adbReverseList(adb: string, serial: string): string {
  return adbOutputOrEmpty(adb, serial, ['reverse', '--list']).trim()
}

export function adbReverseMappings(adb: string, serial: string): readonly AndroidAdbReverseMapping[] {
  return adbReverseList(adb, serial)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [mappingSerial, local, remote] = line.split(/\s+/u)
      return { serial: mappingSerial, local, remote }
    })
}

export function restoreAdbReverseMappings(adb: string, serial: string, expectedMappings: readonly AndroidAdbReverseMapping[]): void {
  for (const mapping of expectedMappings) {
    removeAdbReverseMapping(adb, serial, mapping.local)
    spawnSync(adb, ['-s', serial, 'reverse', mapping.local, mapping.remote], { stdio: 'ignore' })
  }
}

export function restoreAdbReverseLocals(adb: string, serial: string, expectedMappings: readonly AndroidAdbReverseMapping[], locals: readonly string[]): void {
  for (const local of locals) {
    removeAdbReverseMapping(adb, serial, local)
    const priorMapping = expectedMappings.find((mapping) => mapping.local === local)
    if (priorMapping !== undefined) {
      spawnSync(adb, ['-s', serial, 'reverse', priorMapping.local, priorMapping.remote], { stdio: 'ignore' })
    }
  }
}

function restoreCommandLine(adb: string, serial: string, commandLine: NonNullable<AndroidBrowserRestoreState['commandLine']>): void {
  if (commandLine.existed) {
    writeDeviceFile(adb, serial, commandLine.file, commandLine.content)
  } else {
    spawnSync(adb, ['-s', serial, 'shell', 'rm', '-f', commandLine.file], { stdio: 'ignore' })
  }
}

function restoreStayOnWhilePluggedIn(adb: string, serial: string, value: string): void {
  if (value.length === 0 || value === 'null') {
    spawnSync(adb, ['-s', serial, 'shell', 'settings', 'delete', 'global', 'stay_on_while_plugged_in'], { stdio: 'ignore' })
  } else {
    spawnSync(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', value], { stdio: 'ignore' })
  }
}

function restorePackageEnabledState(adb: string, serial: string, packageName: string, state: string): void {
  if (state === '1') {
    spawnSync(adb, ['-s', serial, 'shell', 'pm', 'enable', packageName], { stdio: 'ignore' })
    return
  }
  if (state === '2') {
    spawnSync(adb, ['-s', serial, 'shell', 'pm', 'disable', packageName], { stdio: 'ignore' })
    return
  }
  if (state === '3') {
    spawnSync(adb, ['-s', serial, 'shell', 'pm', 'disable-user', packageName], { stdio: 'ignore' })
    return
  }
  spawnSync(adb, ['-s', serial, 'shell', 'pm', 'default-state', packageName], { stdio: 'ignore' })
}

function deviceFileExists(adb: string, serial: string, file: string): boolean {
  return spawnSync(adb, ['-s', serial, 'shell', 'ls', file], { stdio: 'ignore' }).status === 0
}

function writeDeviceFile(adb: string, serial: string, file: string, content: string): void {
  const result = spawnSync(adb, ['-s', serial, 'shell', 'tee', file], {
    input: content,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe']
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`adb shell tee ${file} failed: ${result.stderr}`)
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
    response.end(options.indexHtml ?? `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Aurora voice Android WebView Shell proof</title><body>running<script type="module">
      try {
        globalThis.__auroraAndroidBrowserClaims = ${JSON.stringify(options.claims ?? defaultWebViewClaims)};
        globalThis.__auroraAndroidHarnessPrefix = ${JSON.stringify(options.harnessPrefix ?? 'android-webview')};
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

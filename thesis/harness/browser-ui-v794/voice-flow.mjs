/*
 * Source-only 15-warmup/900-measured normal-UI voice campaign driver.
 * Root must provide the frozen manifest, admitted fixture/services, short TMPDIR,
 * private run root, backend observer, and runtime/warmup-gate.json. This file
 * never seeds browser storage, calls a service directly, or inserts transcript
 * or assistant text. No browser/model run is performed while preparing it.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, lstat, stat, realpath, rm, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const RUN_ROOT = '/tmp/aurora-root-padded-browser900-v794'
const PROFILE_ROOT = RUN_ROOT
const EXPECTED_WAV_SHA256 = 'da0ecc4ad0885746ab6e716585473917ab2b543a505bf0db09ebacfaa7943cbb'
const EXPECTED_WAV_BYTES = 219794
const EXPECTED_TRANSCRIPT = 'What is the capital of France? Answer with only the city name.'
const EXPECTED_TRANSCRIPT_WORDS = EXPECTED_TRANSCRIPT.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? []
const EXPECTED_COHORT = 'aurora-normal-ui-padded-file-mic-full-audio-v794'
const CAMPAIGN_CAP_MS = 57_600_000
const SETUP_CAP_MS = 180_000
const CASE_CAP_MS = 180_000
const CLEANUP_CAP_MS = 5_000
const WARMUP_COUNT = 15
const MEASURED_COUNT = 900
const TOTAL_COUNT = WARMUP_COUNT + MEASURED_COUNT
const MAX_CAPTURE_BYTES = 1_048_576
const MAX_FAILURE_RECORDS = 64
const ASSISTANT_ERROR_CODES = ['auth', 'permission', 'validation', 'timeout', 'unavailable_service', 'unsupported_feature', 'privacy_blocked', 'native_permission_missing', 'transport_loss', 'unknown']
const OUTPUT_OBSERVER_INIT = `(() => {
  const store = window.__auroraOutputEvents = [];
  const note = (kind, connected = null) => { store.push({ kind, connected, wallMs: Math.round(performance.now()) }); if (store.length > 256) store.shift(); };
  const connectedNodes = new WeakSet();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, ...rest) { try { if (destination === this.context.destination) connectedNodes.add(this); } catch (_) {} return connect.call(this, destination, ...rest); };
  const sourceStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...args) { note('webaudio_source_start', connectedNodes.has(this)); this.addEventListener('ended', () => note('webaudio_source_ended', connectedNodes.has(this)), { once: true }); return sourceStart.apply(this, args); };
  const mediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(...args) { for (const kind of ['playing', 'ended']) this.addEventListener(kind, () => note('media_' + kind, true), { once: true }); return mediaPlay.apply(this, args); };
})();`

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--') || values.has(key) || index + 1 >= argv.length) throw new Error('invalid_arguments')
    values.set(key, argv[++index])
  }
  const fields = new Map([
    ['--base-url', 'baseUrl'], ['--fixture-file', 'fixtureFile'],
    ['--chrome-executable', 'chromeExecutable'], ['--playwright-module', 'playwrightModule'],
    ['--wav', 'wav'], ['--frozen-manifest', 'manifest'], ['--frozen-manifest-sha256', 'manifestSha256'],
  ])
  if ([...fields.keys()].some((key) => !values.has(key)) || [...values.keys()].some((key) => !fields.has(key))) throw new Error('required_arguments_missing_or_unknown')
  return Object.fromEntries([...fields].map(([key, field]) => [field, values.get(key)]))
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function normalizedWords(value) { return value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) ?? [] }
function errorName(error) {
  const name = error instanceof Error ? error.name : ''
  return ['AbortError', 'Error', 'InvalidStateError', 'NetworkError', 'NotAllowedError', 'NotSupportedError', 'OperationError', 'SecurityError', 'SyntaxError', 'TimeoutError', 'TypeError', 'UnknownError'].includes(name) ? name : 'OtherError'
}
function failureCode(error) {
  const code = error?.message
  return ['transcript_predicate_failed', 'transcription_capture_failed', 'assistant_terminal_error', 'incorrect_reply', 'tts_output_not_confirmed', 'case_deadline_exceeded', 'warmup_gate_invalid', 'warmup_gate_timeout', 'unexpected_unowned_request', 'capture_write_timeout', 'active_case_cleanup_failed'].includes(code) ? code : 'operation_failed'
}

async function settleWithin(operation, timeoutMs) {
  let timer
  const marker = Symbol('timeout')
  try {
    const result = await Promise.race([operation, new Promise((resolve) => { timer = setTimeout(() => resolve(marker), timeoutMs) })])
    return result === marker ? { completed: false } : { completed: true, result }
  } finally { clearTimeout(timer) }
}

function wavDurationSeconds(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('input_not_riff_wave')
  let format = null
  let dataBytes = null
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) throw new Error('wav_chunk_out_of_bounds')
    if (tag === 'fmt ' && length >= 16) format = { audioFormat: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bitsPerSample: bytes.readUInt16LE(start + 14) }
    if (tag === 'data') dataBytes = length
    offset = end + (length & 1)
  }
  if (format?.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 22050 || format.bitsPerSample !== 16 || !dataBytes) throw new Error('wav_profile_mismatch')
  const seconds = dataBytes / (format.sampleRate * format.channels * (format.bitsPerSample / 8))
  if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 20) throw new Error('wav_duration_out_of_bounds')
  return seconds
}

function validateOutputWav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return false
  let pcm = false
  let dataBytes = 0
  let nonzero = false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + length > bytes.length) return false
    if (tag === 'fmt ' && length >= 16) pcm = bytes.readUInt16LE(start) === 1
    if (tag === 'data') { dataBytes = length; nonzero = bytes.subarray(start, start + length).some((sample) => sample !== 0) }
    offset = start + length + (length & 1)
  }
  return pcm && dataBytes > 0 && nonzero
}

async function privateFile(filename, root, basename = null) {
  const absolute = path.resolve(filename)
  const rootInfo = await stat(root)
  if (!rootInfo.isDirectory() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== path.resolve(root)) throw new Error('private_root_invalid')
  if (path.dirname(absolute) !== root || (basename && path.basename(absolute) !== basename)) throw new Error('private_file_path_invalid')
  const info = await lstat(absolute)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || await realpath(absolute) !== absolute) throw new Error('private_file_invalid')
  return absolute
}

function loopbackUrl(value) {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('fixture_url_invalid')
  return parsed
}

function sameBaseUrl(left, right) { return `${left.origin}${left.pathname.replace(/\/$/u, '')}` === `${right.origin}${right.pathname.replace(/\/$/u, '')}` }

async function writeExclusiveJson(filename, value) {
  const handle = await open(filename, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
}

async function appendJson(handle, value) { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync() }

async function main() {
  let args
  try { args = parseArgs(process.argv.slice(2)) } catch { console.error('AURORA_BROWSER900=invalid_arguments'); return 2 }

  const root = RUN_ROOT
  const runtimeDir = path.join(root, 'runtime')
  const resultsDir = path.join(root, 'browser900')
  const profileDir = path.join(PROFILE_ROOT, 'chrome-profile')
  const activeCasePath = path.join(runtimeDir, 'active-case.json')
  let fixture, baseUrl, gatewayUrl, wavBytes, wavDuration, frozen, frozenBytes, frozenHash, browser, context, page
  let chromeExecutable, playwrightModule
  try {
    if (await realpath(root) !== root || (await stat(root)).mode & 0o077) throw new Error('run_root_not_private')
    if (await realpath(runtimeDir) !== runtimeDir || (await stat(runtimeDir)).mode & 0o077) throw new Error('runtime_root_not_private')
    fixture = JSON.parse(await readFile(await privateFile(args.fixtureFile, root, 'fixture.private.json'), 'utf8'))
    if (!fixture || ['webBaseUrl', 'gatewayBaseUrl', 'username', 'password'].some((key) => typeof fixture[key] !== 'string' || !fixture[key])) throw new Error('fixture_fields_invalid')
    baseUrl = loopbackUrl(args.baseUrl)
    gatewayUrl = loopbackUrl(fixture.gatewayBaseUrl)
    if (baseUrl.pathname !== '/' || !sameBaseUrl(baseUrl, loopbackUrl(fixture.webBaseUrl))) throw new Error('base_url_does_not_match_fixture')
    chromeExecutable = await realpath(args.chromeExecutable)
    if (!(await stat(chromeExecutable)).isFile() || !path.isAbsolute(args.playwrightModule)) throw new Error('browser_runtime_unavailable')
    playwrightModule = await realpath(args.playwrightModule)
    if (!(await lstat(playwrightModule)).isFile()) throw new Error('playwright_module_unavailable')
    const wavPath = path.resolve(args.wav)
    if (wavPath !== path.join(root, 'candidate-input.wav')) throw new Error('fixed_audio_path_mismatch')
    const wavInfo = await lstat(wavPath)
    if (!wavInfo.isFile() || wavInfo.isSymbolicLink() || wavInfo.size !== EXPECTED_WAV_BYTES) throw new Error('fixed_audio_input_mismatch')
    wavBytes = await readFile(wavPath)
    if (sha256(wavBytes) !== EXPECTED_WAV_SHA256) throw new Error('fixed_audio_input_mismatch')
    wavDuration = wavDurationSeconds(wavBytes)
    const manifestPath = path.resolve(args.manifest)
    if (manifestPath !== path.join(root, 'frozen-manifest.json')) throw new Error('frozen_manifest_path_mismatch')
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || (manifestInfo.mode & 0o077) !== 0) throw new Error('frozen_manifest_not_private_regular_file')
    frozenBytes = await readFile(manifestPath)
    frozenHash = sha256(frozenBytes)
    if (!/^[a-f0-9]{64}$/u.test(args.manifestSha256) || frozenHash !== args.manifestSha256) throw new Error('frozen_manifest_hash_mismatch')
    frozen = JSON.parse(frozenBytes.toString('utf8'))
    const driverHash = sha256(await readFile(fileURLToPath(import.meta.url)))
    if (frozen.schema !== 'aurora.browser900.frozen.v794' || frozen.cohortId !== EXPECTED_COHORT
      || frozen.sourcePins?.driverSHA256 !== driverHash
      || frozen.input?.sha256 !== EXPECTED_WAV_SHA256 || frozen.input?.bytes !== EXPECTED_WAV_BYTES
      || frozen.plan?.warmups !== WARMUP_COUNT || frozen.plan?.measured !== MEASURED_COUNT
      || frozen.plan?.conditionCapSeconds !== CAMPAIGN_CAP_MS / 1000 || frozen.plan?.caseCapSeconds !== CASE_CAP_MS / 1000
      || frozen.strictTranscript !== EXPECTED_TRANSCRIPT || JSON.stringify(frozen.strictReplyWords) !== JSON.stringify(['paris'])) throw new Error('frozen_manifest_contract_mismatch')
    if (await lstat(resultsDir).then(() => true, () => false)) throw new Error('campaign_output_must_be_fresh')
    if (await lstat(profileDir).then(() => true, () => false)) throw new Error('browser_profile_must_be_fresh')
    if (await lstat(activeCasePath).then(() => true, () => false)) throw new Error('active_case_must_be_absent_at_start')
    await mkdir(resultsDir, { mode: 0o700 })
    await mkdir(path.join(resultsDir, 'attempts'), { mode: 0o700 })
    await mkdir(profileDir, { mode: 0o700 })
  } catch (error) {
    console.error(`AURORA_BROWSER900=preflight_failed:${error instanceof Error ? error.name : 'Error'}`)
    return 2
  }

  const campaignStartedAt = new Date().toISOString()
  const campaignStart = performance.now()
  const campaignDeadline = Date.now() + CAMPAIGN_CAP_MS
  const campaign = {
    schema: 'aurora.browser900.campaign.v794', cohortId: EXPECTED_COHORT, frozenManifestSHA256: frozenHash,
    startedAt: campaignStartedAt, completedAt: null, outcome: 'incomplete', scope: 'normal_browser_UI_file_microphone_to_actual_STT_to_visible_LLM_to_normal_TTS_WAV_and_connected_playback',
    counts: { plannedWarmups: WARMUP_COUNT, attemptedWarmups: 0, passedWarmups: 0, plannedMeasured: MEASURED_COUNT, attemptedMeasured: 0, passedMeasured: 0, incorrectMeasured: 0, failedMeasured: 0, unattemptedWarmups: WARMUP_COUNT, unattemptedMeasured: MEASURED_COUNT },
    input: { sha256: EXPECTED_WAV_SHA256, bytes: EXPECTED_WAV_BYTES, durationSeconds: wavDuration, chromiumFileAudioMode: 'noloop' },
    checks: { normalConnection: false, normalLogin: false, assistantUi: false, loopbackMicPermission: false, warmupNativeGate: false },
    unverified: ['physical_microphone', 'physical_acoustic_capture', 'physical_speaker_output', 'native_IDs_not_exposed_by_UI_remain_null'],
    setupFailure: null, fatalStop: null, cleanup: { browserClosed: false, profileRemoved: false, failureName: null },
  }
  const casesDir = path.join(resultsDir, 'attempts')
  const logHandle = await open(path.join(resultsDir, 'attempts.jsonl'), 'wx', 0o600)
  let currentDeadline = Math.min(campaignDeadline, Date.now() + SETUP_CAP_MS)
  let activeAttempt = null
  const requestOwners = new WeakMap()
  let unownedRelevantRequest = false
  let stage = 'browser_start'
  const remaining = () => Math.max(1, Math.min(campaignDeadline, currentDeadline) - Date.now())
  const bounded = async (operation, maxMs = remaining()) => {
    const timeoutMs = Math.min(remaining(), maxMs)
    if (timeoutMs <= 1) throw Object.assign(new Error('case_deadline_exceeded'), { name: 'TimeoutError' })
    let timer
    try {
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('case_deadline_exceeded'), { name: 'TimeoutError' })), timeoutMs) })])
    } finally { clearTimeout(timer) }
  }
  const record = async (type, fields = {}) => appendJson(logHandle, { type, at: new Date().toISOString(), campaignElapsedMs: Math.round(performance.now() - campaignStart), ...fields })
  const atomicActiveCase = async (value) => {
    const temp = `${activeCasePath}.tmp`
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync() } finally { await handle.close() }
    await rename(temp, activeCasePath)
  }
  const safeHeaders = (requestOrResponse) => {
    const headers = typeof requestOrResponse.headers === 'function' ? requestOrResponse.headers() : {}
    return Object.fromEntries(['x-correlation-id', 'x-request-id', 'traceparent'].filter((name) => typeof headers[name] === 'string').map((name) => [name, headers[name].slice(0, 160)]))
  }

  try {
    const { chromium } = await bounded(import(pathToFileURL(playwrightModule).href))
    context = await bounded(chromium.launchPersistentContext(profileDir, { executablePath: chromeExecutable, headless: true, timeout: Math.min(20_000, remaining()), viewport: { width: 1440, height: 1000 }, args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${path.resolve(args.wav)}%noloop`, '--autoplay-policy=no-user-gesture-required'] }))
    browser = context
    await bounded(context.grantPermissions(['microphone'], { origin: baseUrl.origin }))
    campaign.checks.loopbackMicPermission = true
    context.on('requestfailed', (request) => {
      if (campaign.requestFailures?.length >= MAX_FAILURE_RECORDS) return
      campaign.requestFailures ??= []
      const failure = request.failure()?.errorText ?? ''
      let origin = 'unknown_origin'
      try { origin = new URL(request.url()).origin } catch { /* finite marker */ }
      campaign.requestFailures.push({ method: request.method(), origin, category: failure.match(/net::ERR_[A-Z0-9_]+/u)?.[0] ?? 'request_failed' })
    })
    context.on('response', (response) => {
      if (response.status() < 400) return
      campaign.badResponses ??= []
      if (campaign.badResponses.length >= MAX_FAILURE_RECORDS) return
      let origin = 'unknown_origin'
      try { origin = new URL(response.url()).origin } catch { /* finite marker */ }
      campaign.badResponses.push({ status: response.status(), origin, resourceType: response.request().resourceType() })
    })
    page = await bounded(context.newPage())
    await bounded(page.addInitScript(OUTPUT_OBSERVER_INIT))
    await bounded(page.addInitScript(() => {
      const mic = { calls: 0, successes: 0, failures: [] }
      Object.defineProperty(window, '__auroraFileMicState', { configurable: false, value: mic })
      const media = navigator.mediaDevices
      const original = media?.getUserMedia?.bind(media)
      if (original) Object.defineProperty(media, 'getUserMedia', { configurable: true, value: async (constraints) => {
        mic.calls += 1
        try { const stream = await original(constraints); mic.successes += 1; return stream }
        catch (error) { mic.failures.push({ name: ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError', 'SecurityError', 'TypeError'].includes(error?.name) ? error.name : 'OtherError' }); throw error }
      } })
    }))
    page.setDefaultTimeout(20_000)
    page.on('pageerror', (error) => {
      campaign.pageErrors ??= []
      if (campaign.pageErrors.length >= MAX_FAILURE_RECORDS) return
      campaign.pageErrors.push({ name: errorName(error), messageSha256: sha256(Buffer.from(String(error.message ?? ''))), messageChars: String(error.message ?? '').length })
    })
    page.on('request', (request) => {
      let url
      try { url = new URL(request.url()) } catch { return }
      const isTranscribe = url.origin === gatewayUrl.origin && url.pathname === '/api/Transcription/Transcribe' && request.method() === 'POST'
      const isTts = url.origin === gatewayUrl.origin && url.pathname === '/api/TTS/Synthesize' && request.method() === 'POST'
      if (!isTranscribe && !isTts) return
      const owner = activeAttempt
      if (!owner) {
        unownedRelevantRequest = true
        void record('unowned_relevant_request', { route: isTranscribe ? 'transcription' : 'tts' })
        return
      }
      requestOwners.set(request, owner)
      const allowedHeaders = safeHeaders(request)
      const metadata = { requestId: allowedHeaders['x-request-id'] ?? null, correlationId: allowedHeaders['x-correlation-id'] ?? null, traceparent: allowedHeaders.traceparent ?? null, allowedHeaders }
      if (isTranscribe) {
        owner.transcription.requestCount += 1
        owner.transcription.requests.push(metadata)
        if (owner.transcription.requestCount === 1) {
          const captureTask = (async () => {
            try {
              const body = request.postDataJSON()
              const encoded = body?.audio_data
              if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error('audio_data_unavailable')
              const pcm = Buffer.from(encoded, 'base64')
              if (!pcm.length || pcm.length > MAX_CAPTURE_BYTES) throw new Error('audio_data_size_out_of_bounds')
              const filename = path.join(owner.directory, 'transcription-input.pcm')
              const output = await open(filename, 'wx', 0o600)
              try { await output.writeFile(pcm); await output.sync() } finally { await output.close() }
              owner.transcription = { ...owner.transcription, audioCaptured: true, format: typeof body.format === 'string' ? body.format : null, sampleRate: Number.isInteger(body.sample_rate) ? body.sample_rate : null, channels: Number.isInteger(body.channels) ? body.channels : null, bytes: pcm.length, sha256: sha256(pcm) }
            } catch (error) {
              owner.transcription.captureError = ['audio_data_unavailable', 'audio_data_size_out_of_bounds'].includes(error?.message) ? error.message : error?.code === 'EEXIST' ? 'output_conflict' : 'capture_failed'
            }
          })()
          owner.capturePromise = captureTask
        }
      } else {
        if (!owner.readAloudActive) { owner.tts.unexpectedRequestCount += 1; return }
        owner.tts.requestCount += 1
        try { metadata.textMatchesParis = request.postDataJSON()?.text === 'Paris' } catch { metadata.textMatchesParis = false }
        owner.tts.requests.push(metadata)
      }
    })
    page.on('response', (response) => {
      let url
      try { url = new URL(response.url()) } catch { return }
      if (url.origin === gatewayUrl.origin && url.pathname === '/api/Transcription/Transcribe') {
        const transcriptionOwner = requestOwners.get(response.request())
        if (transcriptionOwner) transcriptionOwner.transcription.responses.push({ status: response.status(), allowedHeaders: safeHeaders(response) })
        return
      }
      if (url.origin !== gatewayUrl.origin || url.pathname !== '/api/TTS/Synthesize') return
      const owner = requestOwners.get(response.request())
      if (!owner) return
      const capture = async () => {
        const result = { statusOk: response.status() === 200, wavValid: false, requestMatchesParis: false, responseHeaders: safeHeaders(response) }
        try {
          const reqText = response.request().postDataJSON()?.text
          result.requestMatchesParis = reqText === 'Paris'
          const raw = await bounded(response.body())
          let payload = JSON.parse(raw.toString('utf8'))
          for (let depth = 0; depth < 3 && payload && typeof payload === 'object' && 'data' in payload; depth += 1) payload = payload.data
          const encoded = payload && typeof payload === 'object' ? payload.audio_data : null
          const audio = typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
          result.wavValid = raw.length <= 2_097_152 && audio.length <= 2_097_152 && payload?.format === 'wav' && validateOutputWav(audio)
          if (result.wavValid) {
            const output = await open(path.join(owner.directory, 'read-aloud.wav'), 'wx', 0o600)
            try { await output.writeFile(audio); await output.sync() } finally { await output.close() }
            result.wavBytes = audio.length
            result.wavSha256 = sha256(audio)
          }
        } catch (error) { result.bodyErrorName = errorName(error) }
        owner.tts.response = result
        owner.tts.resolve(result)
      }
      const task = capture().catch(() => { const result = { statusOk: false, wavValid: false, requestMatchesParis: false, bodyErrorName: 'OtherError' }; owner.tts.response = result; owner.tts.resolve(result) })
      owner.pendingTtsCapture = task
    })
    await bounded(page.addInitScript(() => {
      const startup = { events: [] }
      Object.defineProperty(window, '__auroraAudioStartup', { configurable: false, value: startup })
      const note = (event, detail = {}) => { if (startup.events.length < 512) startup.events.push({ event, atMs: Math.round(performance.now()), ...detail }) }
      const finiteName = (error) => ['AbortError', 'Error', 'InvalidStateError', 'NetworkError', 'NotAllowedError', 'NotSupportedError', 'OperationError', 'SecurityError', 'SyntaxError', 'TypeError', 'UnknownError'].includes(error?.name) ? error.name : 'OtherError'
      const observeMethod = (target, property, eventName, state = null) => {
        if (!target || typeof target[property] !== 'function') return
        const original = target[property]
        try { Object.defineProperty(target, property, { configurable: true, writable: true, value: function (...args) {
          const detail = state ? { state: state(this) } : {}
          note(`${eventName}_started`, detail)
          let result
          try { result = original.apply(this, args) } catch (error) { note(`${eventName}_threw`, { name: finiteName(error), ...(state ? { state: state(this) } : {}) }); throw error }
          if (result?.then) result.then(() => note(`${eventName}_resolved`, state ? { state: state(this) } : {}), (error) => note(`${eventName}_rejected`, { name: finiteName(error), ...(state ? { state: state(this) } : {}) }))
          return result
        } }) } catch { note(`${eventName}_observer_unavailable`) }
      }
      const Native = window.AudioContext
      if (typeof Native === 'function') window.AudioContext = new Proxy(Native, { construct(target, args, newTarget) {
        note('audio_context_constructor_started')
        try { const value = Reflect.construct(target, args, newTarget); note('audio_context_constructor_succeeded', { state: value.state }); observeMethod(value, 'resume', 'audio_context_resume', (ctx) => ctx.state); if (value.audioWorklet) observeMethod(value.audioWorklet, 'addModule', 'audio_worklet_add_module'); return value }
        catch (error) { note('audio_context_constructor_failed', { name: finiteName(error) }); throw error }
      } })
      const NativeNode = window.AudioWorkletNode
      if (typeof NativeNode === 'function') window.AudioWorkletNode = new Proxy(NativeNode, { construct(target, args, newTarget) {
        note('audio_worklet_node_constructor_started', { state: args[0]?.state ?? null })
        try { const value = Reflect.construct(target, args, newTarget); note('audio_worklet_node_constructor_succeeded', { state: args[0]?.state ?? null }); return value }
        catch (error) { note('audio_worklet_node_constructor_failed', { name: finiteName(error), state: args[0]?.state ?? null }); throw error }
      } })
    }))

    stage = 'connection_open'
    await bounded(page.goto(baseUrl.href, { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remaining()) }))
    stage = 'connection_choice'
    const connectChoice = page.getByRole('radio', { name: 'Connect to Aurora' })
    await bounded(connectChoice.waitFor({ state: 'visible', timeout: Math.min(15_000, remaining()) }))
    if (await bounded(connectChoice.getAttribute('aria-checked')) !== 'true') await bounded(connectChoice.click())
    await bounded(page.getByRole('button', { name: 'Continue', exact: true }).click())
    await bounded(page.getByRole('button', { name: 'Connect with an address', exact: true }).click())
    await bounded(page.locator('#aurora-endpoint').fill(gatewayUrl.href.replace(/\/+$/u, '')))
    await bounded(page.getByRole('button', { name: 'Use this address', exact: true }).click())
    await bounded(page.waitForURL(/\/mesh(?:\?.*)?$/u, { timeout: Math.min(15_000, remaining()) }))
    campaign.checks.normalConnection = true
    stage = 'normal_ui_login'
    await bounded(page.goto(new URL('/onboarding', baseUrl.origin).href, { waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remaining()) }))
    await bounded(page.getByRole('button', { name: 'Continue', exact: true }).click())
    await bounded(page.locator('#aurora-username').fill(fixture.username))
    await bounded(page.locator('#aurora-password').fill(fixture.password))
    await bounded(page.getByRole('button', { name: 'Login', exact: true }).click())
    await bounded(page.getByText(/^Signed in as /u).waitFor({ state: 'visible', timeout: remaining() }))
    await bounded(page.getByRole('button', { name: 'Finish setup', exact: true }).click())
    await bounded(page.getByRole('link', { name: 'Open Mesh', exact: true }).waitFor({ state: 'visible', timeout: remaining() }))
    await bounded(page.getByRole('navigation', { name: 'Primary route navigation', exact: true }).getByRole('link', { name: 'Assistant', exact: true }).click())
    campaign.checks.normalLogin = true
    stage = 'assistant_ui_ready'
    await bounded(page.getByRole('heading', { name: 'Text chat with Aurora', exact: true }).waitFor({ state: 'attached', timeout: remaining() }))
    await bounded(page.getByRole('form', { name: 'Prompt composer', exact: true }).waitFor({ state: 'visible', timeout: remaining() }))
    campaign.checks.assistantUi = true
    campaign.setupCompletedAt = new Date().toISOString()
    await writeExclusiveJson(path.join(resultsDir, 'campaign-start.json'), { schema: campaign.schema, startedAt: campaignStartedAt, setupCompletedAt: campaign.setupCompletedAt, frozenManifestSHA256: frozenHash, checks: campaign.checks, sourceDriverSHA256: sha256(await readFile(fileURLToPath(import.meta.url))) })

    async function runAttempt(ordinal, phase) {
      const caseId = `browser-audio-v794-${String(ordinal).padStart(4, '0')}`
      const directory = path.join(casesDir, caseId)
      await mkdir(directory, { mode: 0o700 })
      const caseStartedPerf = performance.now()
      const caseState = {
        schema: 'aurora.browser900.case.v794', harness_case_id: caseId, ordinal, phase, frozen_manifest_sha256: frozenHash,
        startedAt: new Date().toISOString(), startedMonotonicMs: Math.round(performance.now() - campaignStart), finishedAt: null,
        outcome: 'failed', terminalKind: null, stage: 'new_conversation', failureCode: null, failureName: null,
        checks: { freshConversation: false, voiceConsent: false, microphoneCallDeltaOne: false, transcriptionRequestCountOne: false, capturedPcm: false, strictTranscript: false, freshAssistant: false, assistantSent: false, exactParis: false, ttsRequestCountOne: false, ttsResponseWavValid: false, connectedPlaybackStarted: false, connectedPlaybackEnded: false },
        actualIds: { userMessageId: null, assistantMessageId: null, transcriptionHeaders: [], ttsHeaders: [] },
        microphone: { before: null, afterStart: null, afterStop: null, callsDelta: null, successesDelta: null, failureNames: [] },
        transcription: { requestCount: 0, requests: [], responses: [], audioCaptured: false, format: null, sampleRate: null, channels: null, bytes: null, sha256: null, captureError: null },
        transcript: { chars: 0, sha256: null, matchesFrozenQuestion: false },
        assistant: { status: null, errorCode: null, chars: 0, sha256: null, exactParis: false },
        tts: { requestCount: 0, unexpectedRequestCount: 0, requests: [], response: null, browserEvents: [], responseAndPlaybackMatches: false },
        clocks: { processElapsedMs: null, domain: 'node_performance_now', stageTimestampsMs: [] },
      }
      let currentStep = 'new_conversation'
      let transcriptMismatch = false
      const ttsResponse = new Promise((resolve) => { caseState.tts.resolve = resolve })
      caseState.directory = directory
      activeAttempt = caseState
      currentDeadline = Math.min(campaignDeadline, Date.now() + CASE_CAP_MS)
      const caseRemaining = () => Math.max(1, currentDeadline - Date.now())
      const mark = async (step) => {
        currentStep = step
        caseState.stage = step
        caseState.clocks.stageTimestampsMs.push({ step, monotonicMs: Math.round(performance.now() - caseStartedPerf) })
        await record('case_checkpoint', { harness_case_id: caseId, phase, ordinal, step, checks: caseState.checks })
      }
      const observeMic = async () => bounded(page.evaluate(() => {
        const state = window.__auroraFileMicState
        return state ? { calls: state.calls, successes: state.successes, failures: state.failures.map((row) => row.name) } : null
      }), 500)
      const selectNewConversation = async () => {
        const trigger = page.getByRole('button', { name: 'Open conversations', exact: true })
        if (await bounded(trigger.isVisible())) {
          await bounded(trigger.click())
          const dialog = page.getByRole('dialog', { name: 'Conversations', exact: true })
          await bounded(dialog.waitFor({ state: 'visible', timeout: caseRemaining() }))
          await bounded(dialog.getByRole('button', { name: 'New conversation', exact: true }).click())
          await bounded(dialog.waitFor({ state: 'hidden', timeout: caseRemaining() }))
        } else await bounded(page.getByRole('button', { name: 'New conversation', exact: true }).click())
        const ids = await bounded(page.locator('[data-slot="message"]').evaluateAll((rows) => rows.map((row) => row.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null).filter(Boolean)))
        caseState.baselineMessageIds = ids
        caseState.checks.freshConversation = true
        await mark('new_conversation_selected')
      }
      const readFreshUser = async () => {
        const rows = await bounded(page.locator('[data-slot="message"][data-align="end"]').evaluateAll((items) => items.map((message) => ({ id: message.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null, text: message.querySelector('p')?.textContent ?? '', visible: Boolean(message.getClientRects().length) })).filter((item) => item.id && item.visible)))
        return rows.filter((item) => !caseState.baselineMessageIds.includes(item.id))
      }
      const readFreshAssistant = async () => {
        const rows = await bounded(page.locator('[data-slot="message"]').evaluateAll((items) => items.map((message) => {
          const id = message.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null
          const status = message.querySelector('span.sr-only')?.textContent?.trim() ?? ''
          return { id, status, errorCode: message.getAttribute('data-aurora-assistant-error-code'), text: message.querySelector('p')?.textContent ?? '', visible: Boolean(message.getClientRects().length) }
        }).filter((item) => item.id)))
        return rows.filter((item) => item.id && item.visible && !caseState.baselineMessageIds.includes(item.id) && ['Aurora · sent', 'Aurora · failed'].includes(item.status))
      }
      try {
        await record('case_started', { harness_case_id: caseId, phase, ordinal, frozen_manifest_sha256: frozenHash })
        await selectNewConversation()
        await bounded(page.bringToFront())
        const voiceStop = page.getByRole('button', { name: 'Stop connected voice access', exact: true })
        const pre = await bounded(page.evaluate(() => ({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })))
        const consentVisible = await bounded(voiceStop.isVisible())
        if (!consentVisible) {
          await bounded(page.getByRole('button', { name: 'Allow connected voice', exact: true }).click())
          await bounded(voiceStop.waitFor({ state: 'visible', timeout: caseRemaining() }))
        }
        caseState.focus = pre
        caseState.checks.voiceConsent = true
        const beforeMic = await observeMic()
        if (!beforeMic) throw new Error('microphone_state_unavailable')
        caseState.microphone.before = beforeMic
        await bounded(page.evaluate(() => { if (window.__auroraAudioStartup?.events) window.__auroraAudioStartup.events.length = 0 }), 500)
        await mark('before_push_to_talk')

        await atomicActiveCase({ schema: 'aurora.browser900.active-case.v1', harness_case_id: caseId, ordinal, phase, frozen_manifest_sha256: frozenHash })
        await mark('active_case_published')
        const pushToTalk = page.getByRole('button', { name: 'Push to talk', exact: true })
        await bounded(pushToTalk.waitFor({ state: 'visible', timeout: caseRemaining() }))
        await bounded(pushToTalk.click())
        const stopListening = page.getByRole('button', { name: 'Stop listening', exact: true })
        await bounded(stopListening.waitFor({ state: 'visible', timeout: Math.min(15_000, caseRemaining()) }))
        const afterStart = await observeMic()
        caseState.microphone.afterStart = afterStart
        await mark('capture_started')
        await bounded(new Promise((resolve) => setTimeout(resolve, Math.ceil(wavDuration * 1000) + 500)))
        await bounded(stopListening.click())
        const afterStop = await observeMic()
        caseState.microphone.afterStop = afterStop
        caseState.microphone.callsDelta = afterStop?.calls - beforeMic.calls ?? null
        caseState.microphone.successesDelta = afterStop?.successes - beforeMic.successes ?? null
        caseState.microphone.failureNames = afterStop?.failures?.slice(beforeMic.failures.length) ?? []
        caseState.checks.microphoneCallDeltaOne = caseState.microphone.callsDelta === 1 && caseState.microphone.successesDelta === 1 && caseState.microphone.failureNames.length === 0
        await mark('capture_stopped')

        await page.waitForFunction((knownIds) => [...document.querySelectorAll('[data-slot="message"][data-align="end"]')].some((message) => {
          const id = message.closest('[data-message-id]')?.getAttribute('data-message-id')
          return Boolean(id && !knownIds.includes(id))
        }), caseState.baselineMessageIds, { timeout: caseRemaining() })
        const freshUsers = await readFreshUser()
        if (freshUsers.length !== 1) throw new Error('fresh_user_message_not_unique')
        const user = freshUsers[0]
        caseState.actualIds.userMessageId = user.id
        const words = normalizedWords(user.text)
        caseState.transcript = { chars: user.text.length, sha256: sha256(Buffer.from(user.text)), matchesFrozenQuestion: words.length === EXPECTED_TRANSCRIPT_WORDS.length && words.every((word, index) => word === EXPECTED_TRANSCRIPT_WORDS[index]) }
        caseState.checks.strictTranscript = caseState.transcript.matchesFrozenQuestion
        if (caseState.capturePromise) await bounded(caseState.capturePromise)
        caseState.checks.transcriptionRequestCountOne = caseState.transcription.requestCount === 1
        caseState.checks.capturedPcm = caseState.transcription.audioCaptured
        caseState.actualIds.transcriptionHeaders = { requests: caseState.transcription.requests.map((request) => request.allowedHeaders), responses: caseState.transcription.responses.map((response) => response.allowedHeaders) }
        await mark('transcript_observed')
        if (!caseState.checks.microphoneCallDeltaOne || !caseState.checks.transcriptionRequestCountOne || !caseState.checks.capturedPcm || !caseState.checks.strictTranscript) {
          transcriptMismatch = !caseState.checks.strictTranscript || !caseState.checks.capturedPcm
          throw new Error(transcriptMismatch ? 'transcript_predicate_failed' : 'transcription_capture_failed')
        }

        await page.waitForFunction((knownIds) => [...document.querySelectorAll('[data-slot="message"]')].some((message) => {
          const id = message.closest('[data-message-id]')?.getAttribute('data-message-id')
          const status = message.querySelector('span.sr-only')?.textContent?.trim()
          return Boolean(id && !knownIds.includes(id) && message.getClientRects().length && ['Aurora · sent', 'Aurora · failed'].includes(status))
        }), caseState.baselineMessageIds, { timeout: caseRemaining() })
        const assistants = await readFreshAssistant()
        if (assistants.length !== 1) throw new Error('fresh_assistant_message_not_unique')
        const assistant = assistants[0]
        caseState.actualIds.assistantMessageId = assistant.id
        const replyWords = normalizedWords(assistant.text)
        const paris = replyWords.length === 1 && replyWords[0] === 'paris'
        caseState.assistant = { status: assistant.status, errorCode: assistant.errorCode, chars: assistant.text.length, sha256: sha256(Buffer.from(assistant.text)), exactParis: paris }
        caseState.checks.freshAssistant = !caseState.baselineMessageIds.includes(assistant.id)
        caseState.checks.assistantSent = assistant.status === 'Aurora · sent'
        caseState.checks.exactParis = paris && assistant.errorCode === null
        await mark('assistant_terminal_observed')
        if (!caseState.checks.assistantSent || !caseState.checks.exactParis) {
          caseState.outcome = assistant.status === 'Aurora · sent' ? 'incorrect' : 'failed'
          caseState.terminalKind = assistant.status === 'Aurora · sent' ? 'incorrect_reply' : 'assistant_error'
          if (phase === 'warmup') throw new Error(assistant.status === 'Aurora · sent' ? 'incorrect_reply' : 'assistant_terminal_error')
          if (assistant.status === 'Aurora · failed') {
            const knownErrorCode = ASSISTANT_ERROR_CODES.includes(assistant.errorCode)
            if (!knownErrorCode || ['timeout', 'unknown', 'transport_loss'].includes(assistant.errorCode)) {
              caseState.failureCode = assistant.errorCode === 'timeout' ? 'assistant_terminal_timeout' : 'assistant_terminal_ambiguous'
              campaign.fatalStop ??= caseState.failureCode
            }
          }
        } else {
          const row = page.locator('[data-slot="message"]').filter({ has: page.getByText('Aurora · sent', { exact: true }) }).filter({ has: page.getByText('Paris', { exact: true }) }).last()
          const readAloud = row.getByRole('button', { name: 'Read aloud', exact: true })
          await bounded(readAloud.waitFor({ state: 'visible', timeout: caseRemaining() }))
          const clickPageMs = await bounded(page.evaluate(() => performance.now()))
          caseState.readAloudActive = true
          await bounded(readAloud.click())
          const tts = await bounded(ttsResponse, caseRemaining())
          if (caseState.pendingTtsCapture) await bounded(caseState.pendingTtsCapture)
          caseState.checks.ttsRequestCountOne = caseState.tts.requestCount === 1 && caseState.tts.unexpectedRequestCount === 0
          caseState.checks.ttsResponseWavValid = Boolean(tts.requestMatchesParis && tts.statusOk && tts.wavValid)
          await page.waitForFunction((clickedAt) => {
            const events = (window.__auroraOutputEvents || []).filter((event) => event.wallMs >= clickedAt && event.connected === true)
            return events.some((event) => ['webaudio_source_start', 'media_playing'].includes(event.kind)) && events.some((event) => ['webaudio_source_ended', 'media_ended'].includes(event.kind))
          }, clickPageMs, { timeout: caseRemaining() })
          const browserEvents = await bounded(page.evaluate((from) => (window.__auroraOutputEvents || []).filter((event) => event.wallMs >= from).slice(-32), clickPageMs))
          caseState.tts.browserEvents = browserEvents.map((event) => ({ kind: event.kind, connected: event.connected, wallMs: event.wallMs }))
          caseState.checks.connectedPlaybackStarted = browserEvents.some((event) => ['webaudio_source_start', 'media_playing'].includes(event.kind) && event.connected === true)
          caseState.checks.connectedPlaybackEnded = browserEvents.some((event) => ['webaudio_source_ended', 'media_ended'].includes(event.kind) && event.connected === true)
          caseState.actualIds.ttsHeaders = { requests: caseState.tts.requests.map((request) => request.allowedHeaders), response: tts.responseHeaders ?? {} }
          caseState.tts.responseAndPlaybackMatches = caseState.checks.ttsRequestCountOne && caseState.checks.ttsResponseWavValid && caseState.checks.connectedPlaybackStarted && caseState.checks.connectedPlaybackEnded
          if (!caseState.tts.responseAndPlaybackMatches) throw new Error('tts_output_not_confirmed')
          caseState.outcome = 'passed'
          caseState.terminalKind = 'full_flow_passed'
        }
      } catch (error) {
        caseState.outcome = 'failed'
        caseState.failureCode = failureCode(error)
        caseState.failureName = errorName(error)
        caseState.terminalKind ??= transcriptMismatch ? 'transcript_mismatch' : 'operation_failed'
        campaign.fatalStop ??= caseState.failureCode
      } finally {
        caseState.clocks.processElapsedMs = Math.round(performance.now() - caseStartedPerf)
        caseState.finishedAt = new Date().toISOString()
        caseState.stage = currentStep
        if (caseState.capturePromise) {
          const completed = await settleWithin(caseState.capturePromise, Math.min(2_000, Math.max(1, currentDeadline - Date.now())))
          if (!completed.completed) { caseState.transcription.captureError ??= 'capture_write_timeout'; campaign.fatalStop = 'capture_write_timeout' }
        }
        if (activeAttempt === caseState) activeAttempt = null
        try { await atomicActiveCase({ schema: 'aurora.browser900.active-case.v1', harness_case_id: null, ordinal, phase, frozen_manifest_sha256: frozenHash }) }
        catch { caseState.failureCode ??= 'active_case_cleanup_failed'; caseState.outcome = 'failed'; campaign.fatalStop = 'active_case_cleanup_failed' }
        const startup = await settleWithin(page.evaluate(() => (window.__auroraAudioStartup?.events ?? []).slice()), 500)
        caseState.audioStartupEvents = startup.completed && Array.isArray(startup.result) ? startup.result : null
        const row = { schema: caseState.schema, harness_case_id: caseId, ordinal, phase, frozen_manifest_sha256: frozenHash, startedAt: caseState.startedAt, finishedAt: caseState.finishedAt, outcome: caseState.outcome, terminalKind: caseState.terminalKind, stage: caseState.stage, failureCode: caseState.failureCode, failureName: caseState.failureName, checks: caseState.checks, actualIds: caseState.actualIds, microphone: caseState.microphone, transcription: caseState.transcription, transcript: caseState.transcript, assistant: caseState.assistant, tts: caseState.tts, audioStartupEvents: caseState.audioStartupEvents, clocks: caseState.clocks }
        await writeExclusiveJson(path.join(directory, 'case.json'), row)
        await record('case_terminal', { harness_case_id: caseId, phase, ordinal, outcome: caseState.outcome, terminalKind: caseState.terminalKind, failureCode: caseState.failureCode, elapsedMs: caseState.clocks.processElapsedMs, actualIds: caseState.actualIds })
      }
      return caseState
    }

    campaign.outcome = 'running_warmups'
    await writeExclusiveJson(path.join(resultsDir, 'campaign.json'), campaign)
    for (let ordinal = 1; ordinal <= WARMUP_COUNT; ordinal += 1) {
      currentDeadline = Math.min(campaignDeadline, Date.now() + CASE_CAP_MS)
      const result = await runAttempt(ordinal, 'warmup')
      campaign.counts.attemptedWarmups += 1
      if (result.outcome === 'passed') campaign.counts.passedWarmups += 1
      campaign.counts.unattemptedWarmups = WARMUP_COUNT - campaign.counts.attemptedWarmups
      await record('campaign_progress', { counts: campaign.counts, warmup_case_id: result.harness_case_id, outcome: result.outcome })
      if (result.outcome !== 'passed' || campaign.fatalStop || unownedRelevantRequest) { campaign.fatalStop ??= 'warmup_gate_failed'; break }
    }
    if (campaign.counts.passedWarmups === WARMUP_COUNT && !campaign.fatalStop) {
      stage = 'await_native_warmup_gate'
      const gatePath = path.join(runtimeDir, 'warmup-gate.json')
      const expectedIds = Array.from({ length: WARMUP_COUNT }, (_, index) => `browser-audio-v794-${String(index + 1).padStart(4, '0')}`)
      const gateDeadline = Math.min(campaignDeadline, Date.now() + CASE_CAP_MS)
      let accepted = false
      while (Date.now() < gateDeadline) {
        try {
          const info = await lstat(gatePath)
          if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('warmup_gate_not_private_regular_file')
          const gateBytes = await readFile(gatePath)
          const gate = JSON.parse(gateBytes.toString('utf8'))
          const idsMatch = JSON.stringify(gate.warmup_case_ids) === JSON.stringify(expectedIds)
          if (gate.schema === 'aurora.browser900.warmup-gate.v1' && gate.status === 'passed' && gate.frozen_manifest_sha256 === frozenHash && idsMatch && gate.native_stages_complete === true && gate.actual_provider_identity_complete === true && gate.actual_rx7600_25of25_verified === true) {
            campaign.checks.warmupNativeGate = true
            campaign.warmupGateSHA256 = sha256(gateBytes)
            accepted = true
            break
          }
          throw new Error('warmup_gate_invalid')
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      if (!accepted) campaign.fatalStop = Date.now() >= campaignDeadline ? 'campaign_deadline_exceeded' : 'warmup_gate_timeout'
    } else campaign.fatalStop ??= 'warmup_gate_failed'

    if (campaign.checks.warmupNativeGate && !campaign.fatalStop && !unownedRelevantRequest) {
      campaign.outcome = 'running_measured'
      await writeExclusiveJson(path.join(resultsDir, 'warmup-gate-accepted.json'), { schema: 'aurora.browser900.warmup-gate-accepted.v794', frozenManifestSHA256: frozenHash, warmupCaseIds: Array.from({ length: WARMUP_COUNT }, (_, index) => `browser-audio-v794-${String(index + 1).padStart(4, '0')}`), gateSHA256: campaign.warmupGateSHA256, acceptedAt: new Date().toISOString() })
      for (let measured = 1; measured <= MEASURED_COUNT; measured += 1) {
        if (Date.now() >= campaignDeadline || campaign.fatalStop || unownedRelevantRequest) { campaign.fatalStop ??= 'campaign_deadline_exceeded'; break }
        const ordinal = WARMUP_COUNT + measured
        currentDeadline = Math.min(campaignDeadline, Date.now() + CASE_CAP_MS)
        const result = await runAttempt(ordinal, 'measured')
        campaign.counts.attemptedMeasured += 1
        if (result.outcome === 'passed') campaign.counts.passedMeasured += 1
        else if (result.outcome === 'incorrect') campaign.counts.incorrectMeasured += 1
        else campaign.counts.failedMeasured += 1
        campaign.counts.unattemptedMeasured = MEASURED_COUNT - campaign.counts.attemptedMeasured
        await record('campaign_progress', { counts: campaign.counts, measured_case_id: result.harness_case_id, outcome: result.outcome })
        if (campaign.fatalStop || unownedRelevantRequest) break
      }
    }
  } catch (error) {
    campaign.fatalStop ??= failureCode(error)
    campaign.failureName = errorName(error)
  } finally {
    campaign.completedAt = new Date().toISOString()
    campaign.counts.unattemptedWarmups = WARMUP_COUNT - campaign.counts.attemptedWarmups
    campaign.counts.unattemptedMeasured = MEASURED_COUNT - campaign.counts.attemptedMeasured
    if (!campaign.fatalStop && campaign.counts.attemptedMeasured === MEASURED_COUNT && campaign.counts.passedWarmups === WARMUP_COUNT) campaign.outcome = campaign.counts.incorrectMeasured || campaign.counts.failedMeasured ? 'completed_with_failures' : 'completed'
    else campaign.outcome = campaign.fatalStop ? 'stopped' : 'incomplete'
    campaign.elapsedMs = Math.round(performance.now() - campaignStart)
    const cleanupDeadline = Date.now() + CLEANUP_CAP_MS
    const cleanupRemaining = () => Math.max(1, cleanupDeadline - Date.now())
    if (activeAttempt) {
      try { await atomicActiveCase({ schema: 'aurora.browser900.active-case.v1', harness_case_id: null, ordinal: activeAttempt.ordinal, phase: activeAttempt.phase, frozen_manifest_sha256: frozenHash }) } catch { /* controller records interruption if ownership could not be cleared */ }
      activeAttempt = null
    }
    if (browser) {
      const closed = await settleWithin(browser.close(), cleanupRemaining())
      campaign.cleanup.browserClosed = closed.completed
      if (!closed.completed) campaign.cleanup.failureName = 'TimeoutError'
    } else campaign.cleanup.browserClosed = true
    if (campaign.cleanup.browserClosed) {
      const removed = await settleWithin((async () => {
        try {
          const info = await lstat(profileDir).catch((error) => error?.code === 'ENOENT' ? null : false)
          if (info === null) return true
          if (info === false) return false
          if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && info.uid !== process.getuid())
            || await realpath(profileDir) !== profileDir || path.dirname(profileDir) !== root) return false
          await rm(profileDir, { recursive: true })
          return true
        } catch { return false }
      })(), cleanupRemaining())
      campaign.cleanup.profileRemoved = removed.completed && removed.result === true
      if (!removed.completed) campaign.cleanup.failureName = 'TimeoutError'
      else if (!campaign.cleanup.profileRemoved) campaign.cleanup.failureName = 'OtherError'
    }
    if (!campaign.cleanup.browserClosed || !campaign.cleanup.profileRemoved) campaign.outcome = 'cleanup_failed'
    try {
      await record('campaign_terminal', { outcome: campaign.outcome, fatalStop: campaign.fatalStop, counts: campaign.counts, cleanup: campaign.cleanup })
      await writeExclusiveJson(path.join(resultsDir, 'campaign-terminal.json'), campaign)
    } catch { campaign.outcome = 'terminal_write_failed' }
    await logHandle.close()
  }

  console.log(`AURORA_BROWSER900=${campaign.outcome}:${campaign.counts.attemptedWarmups}+${campaign.counts.attemptedMeasured}`)
  return ['completed', 'completed_with_failures'].includes(campaign.outcome) && campaign.cleanup.browserClosed && campaign.cleanup.profileRemoved ? 0 : 1
}

main().then((code) => { process.exitCode = code }).catch(() => { console.error('AURORA_BROWSER900=driver_failed'); process.exitCode = 1 })

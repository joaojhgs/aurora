#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

const MAX_SECONDS = 30
const RUN_TIMEOUT_MS = 2_700_000
const CONTROL_HEADER = 'x-aurora-ios-voice-test'
const SETUP_STEPS = ['profile_read','profile_validation','preferences_read','model_status','speech_catalog','ownership_capture','device_option','onboarding_navigation','profile_creation','profile_readback']
const SETUP_FAILURE_CODES = ['profile_not_empty','model_not_owned','speech_catalog_unavailable','offline_profile_option_unavailable','setup_timeout','setup_failed']
const controlOrigin = process.env.AURORA_IOS_VOICE_LIVE_TEST_CONTROL_ORIGIN ?? 'http://127.0.0.1:39461'
const webviewOrigin = process.env.AURORA_IOS_VOICE_LIVE_TEST_WEBVIEW_ORIGIN ?? 'tauri://localhost'
const args = parseArgs(process.argv.slice(2))
const appPath = realpathSync(args.appPath)
const udid = args.udid
const nonce = randomBytes(16).toString('hex')
const resultPromise = deferred()
const workDir = mkdtempSync(join(tmpdir(), 'aurora-ios-voice-main-'))
let server
let installed = false
let launched = false
let bundleId = ''
let simulatorSelected = false
let report = { schema: 'aurora.ios-voice-main-flow.v2', status: 'failed', stage: 'preflight', setupStep: null, failureCode: null, chunks: 0, samples: 0, transcriptReceived: false, assistantFinalRendered: false, cancelled: false, profileCreated: false, speechReady: false, modelReady: false, profileRestored: false, preferencesRestored: false, ownedAssetsRemoved: false }

try {
  if (process.platform !== 'darwin') throw new Error('macOS is required for this simulator runner')
  if (!statSync(appPath).isDirectory() || !appPath.endsWith('.app')) throw new Error('appPath must name an existing .app directory')
  if (!/^[A-Fa-f0-9-]{36}$/u.test(udid)) throw new Error('--udid must be an explicit simulator UDID')
  const origin = validateOrigin(controlOrigin)
  if (!['tauri://localhost', 'http://tauri.localhost'].includes(webviewOrigin)) throw new Error('webview origin is not an approved Tauri origin')
  if (origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost' && origin.hostname !== '[::1]') throw new Error('control origin must use loopback')
  const appInfo = join(appPath, 'Info.plist')
  bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', appInfo], { encoding: 'utf8', timeout: 10_000 }).trim()
  if (!bundleId || bundleId.includes('\n')) throw new Error('app bundle identifier is invalid')
  const devices = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8', timeout: 15_000 }))
  const all = Object.values(devices.devices ?? {}).flat()
  if (!all.some((device) => device.udid === udid && device.state === 'Booted')) throw new Error('the exact requested simulator must already be booted')
  simulatorSelected = true
  const simulatorArchitecture = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8', timeout: 5_000 }).trim()
  if (!['arm64', 'x86_64'].includes(simulatorArchitecture)) throw new Error('simulator_architecture_unavailable')
  const executableName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', appInfo], { encoding: 'utf8', timeout: 10_000 }).trim()
  const appArchitectures = execFileSync('/usr/bin/lipo', ['-archs', join(appPath, executableName)], { encoding: 'utf8', timeout: 10_000 }).trim().split(/\s+/u)
  if (!appArchitectures.includes(simulatorArchitecture)) throw new Error('simulator_architecture_unavailable')
  const wavPath = await makeSyntheticWav(workDir)
  const wavBytes = readFileSync(wavPath)
  const fixtureSamples = validateWav(wavBytes)
  const wavBase64 = wavBytes.toString('base64')
  if (fixtureSamples > MAX_SECONDS * 16_000) throw new Error('fixture_generation')

  server = createServer((request, response) => handleRequest(request, response, { nonce, wavBase64, simulatorArchitecture, resultPromise, webviewOrigin }))
  await listen(server, Number(origin.port))
  execFileSync('xcrun', ['simctl', 'install', udid, appPath], { stdio: 'pipe', timeout: 30_000 })
  installed = true
  execFileSync('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId], { stdio: 'pipe', timeout: 20_000 })
  launched = true
  report = { ...report, stage: 'assistant_voice_flow' }
  const result = await withTimeout(resultPromise.promise, RUN_TIMEOUT_MS)
  report = { ...report, ...result, status: result.status, stage: result.stage }
} catch (error) {
  report = { ...report, status: 'failed', stage: safeFailureStage(error) }
} finally {
  if (launched) {
    if (bundleId) { try { execFileSync('xcrun', ['simctl', 'terminate', udid, bundleId], { stdio: 'ignore', timeout: 10_000 }) } catch {} }
  }
  if (server) await close(server)
  rmSync(workDir, { recursive: true, force: true })
  report = { ...report, simulatorSelected, appInstalled: installed, appLaunched: launched, audioDeleted: true }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (report.status !== 'passed') process.exitCode = 1
}

async function makeSyntheticWav(directory) {
  const aiff = join(directory, 'voice.aiff')
  const wav = join(directory, 'voice.wav')
  execFileSync('say', ['-o', aiff, 'Please say hello.'], { stdio: 'pipe', timeout: 30_000 })
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiff, wav], { stdio: 'pipe', timeout: 20_000 })
  const bytes = readFileSync(wav)
  if (bytes.length < 44 || bytes.length > MAX_SECONDS * 16_000 * 2 + 44) throw new Error('fixture_generation')
  return wav
}

function validateWav(bytes) {
  if (bytes.length < 44 || bytes.length > MAX_SECONDS * 16_000 * 2 + 4096 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('fixture_generation')
  let format = 0, channels = 0, rate = 0, bits = 0, dataLength = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8
    if (body + size > bytes.length) throw new Error('fixture_generation')
    if (id === 'fmt ') { if (size < 16) throw new Error('fixture_generation'); format = bytes.readUInt16LE(body); channels = bytes.readUInt16LE(body + 2); rate = bytes.readUInt32LE(body + 4); bits = bytes.readUInt16LE(body + 14) }
    if (id === 'data') dataLength = size
    offset = body + size + (size & 1)
  }
  if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16 || dataLength <= 0 || dataLength > MAX_SECONDS * 16_000 * 2 || dataLength % 2) throw new Error('fixture_generation')
  return dataLength / 2
}

function handleRequest(req, res, state) {
  const origin = req.headers.origin
  if (origin !== state.webviewOrigin) return send(res, 403)
  res.setHeader('Access-Control-Allow-Origin', state.webviewOrigin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${CONTROL_HEADER}`)
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'OPTIONS') {
    const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean).sort().join(',')
    if (!['x-aurora-ios-voice-test', 'content-type,x-aurora-ios-voice-test'].includes(requested)) return send(res, 403)
    if (!['GET', 'POST'].includes(req.headers['access-control-request-method'] ?? '')) return send(res, 403)
    return send(res, 204)
  }
  if (req.headers[CONTROL_HEADER] !== '1') return send(res, 403)
  if (req.method === 'GET' && req.url === '/run') {
    if (state.delivered) return send(res, 204)
    state.delivered = true
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ nonce: state.nonce, wavBase64: state.wavBase64, simulatorArchitecture: state.simulatorArchitecture }))
  }
  if (req.method === 'POST' && req.url === '/result') {
    let body = ''
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy() })
    req.on('end', () => {
      try {
        const value = JSON.parse(body)
        const keys = ['nonce','status','stage','setupStep','failureCode','chunks','samples','transcriptReceived','assistantFinalRendered','cancelled','profileCreated','speechReady','modelReady','profileRestored','preferencesRestored','ownedAssetsRemoved']
        if (Object.keys(value).sort().join() !== keys.sort().join() || value.nonce !== state.nonce || !['passed','failed'].includes(value.status) || !Number.isSafeInteger(value.chunks) || !Number.isSafeInteger(value.samples) || value.chunks < 0 || value.chunks > 118 || value.samples < 0 || value.samples > MAX_SECONDS * 16_000 || !['profile_setup','profile_created','speech_setup','speech_ready','model_setup','model_ready','voice_started','pcm_injected','transcript_returned','assistant_final_rendered','cancelled','unavailable'].includes(value.stage) || (value.setupStep !== null && !SETUP_STEPS.includes(value.setupStep)) || (value.failureCode !== null && !SETUP_FAILURE_CODES.includes(value.failureCode)) || ((value.setupStep !== null || value.failureCode !== null) && (value.status !== 'failed' || value.stage !== 'profile_setup')) || ((value.setupStep === null) !== (value.failureCode === null)) || typeof value.transcriptReceived !== 'boolean' || typeof value.assistantFinalRendered !== 'boolean' || typeof value.cancelled !== 'boolean' || typeof value.profileCreated !== 'boolean' || typeof value.speechReady !== 'boolean' || typeof value.modelReady !== 'boolean' || typeof value.profileRestored !== 'boolean' || typeof value.preferencesRestored !== 'boolean' || typeof value.ownedAssetsRemoved !== 'boolean') return send(res, 400)
        if (value.status === 'passed' && (value.stage !== 'assistant_final_rendered' || value.setupStep !== null || value.failureCode !== null || !value.transcriptReceived || !value.assistantFinalRendered || value.cancelled || !value.profileCreated || !value.speechReady || !value.modelReady || value.chunks <= 0 || value.samples <= 0 || !value.profileRestored || !value.preferencesRestored || !value.ownedAssetsRemoved)) return send(res, 400)
        state.resultPromise.resolve(Object.fromEntries(keys.filter((key) => key !== 'nonce').map((key) => [key, value[key]])))
        return send(res, 204)
      } catch { return send(res, 400) }
    })
    return
  }
  send(res, 404)
}

function parseArgs(argv) {
  const out = { udid: '', appPath: '' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--udid' && argv[index + 1]) out.udid = argv[++index]
    else if (argv[index] === '--app-path' && argv[index + 1]) out.appPath = argv[++index]
    else throw new Error('usage: ios-voice-main-flow.mjs --udid <owned-booted-UDID> --app-path <dedicated-debug.app>')
  }
  if (!out.udid || !out.appPath) throw new Error('explicit simulator UDID and app path are required')
  return out
}

function validateOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('control origin must be an explicit loopback HTTP origin')
  return url
}

function send(res, status) { res.statusCode = status; res.end() }
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function listen(server, port) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) }) }
function close(server) { return new Promise((resolve) => server.close(resolve)) }
function withTimeout(promise, ms) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('voice_timeout')), ms) })]).finally(() => clearTimeout(timer)) }
function safeFailureStage(error) { const text = error instanceof Error ? error.message : ''; return text === 'fixture_generation' ? 'fixture_prerequisite' : text === 'voice_timeout' ? 'voice_timeout' : 'prerequisite_or_main_flow_failed' }

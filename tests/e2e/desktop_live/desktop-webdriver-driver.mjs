#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertRoleSwitchEvidence } from './role-switch-evidence.mjs'

const args = new Set(process.argv.slice(2))
const forbiddenDesktopChildPattern = /\b(?:python(?:3(?:\.\d+)?)?|uv|aurora-sidecar)\b|(?:^|\s)main\.py(?:\s|$)/i
const hookResultEnvelopeSchema = 'aurora.desktop_live_e2e.webdriver_result.v1'
const desktopHookReadinessScript = `
  return {
    href: String(window.location.href),
    tauriPresent: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__),
    title: String(document.title || ''),
    readyState: String(document.readyState || ''),
    hookReady: typeof window.__AURORA_DESKTOP_LIVE_E2E__ === 'function',
    surface: String(
      document.documentElement.dataset.auroraSurface
      || document.body?.dataset.auroraSurface
      || ''
    ),
    overlaySurface: Boolean(
      document.documentElement.dataset.auroraSurface === 'overlay'
      || document.body?.dataset.auroraSurface === 'overlay'
      || document.documentElement.classList.contains('aurora-overlay-surface')
      || document.body?.classList.contains('aurora-overlay-surface')
    )
  };
`

class DesktopHookReadinessError extends Error {
  constructor(message, runtime) {
    super(message)
    this.name = 'DesktopHookReadinessError'
    this.runtime = runtime
  }
}

if (args.has('--self-test')) {
  await runSelfTest()
} else {
  await run()
}

async function run() {
  const webdriverUrl = process.env.AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_URL
  const reportPath = requireEnv('AURORA_DESKTOP_LIVE_E2E_DESKTOP_REPORT')
  const donePath = requireEnv('AURORA_DESKTOP_LIVE_E2E_DONE')
  const sessionNonce = requireEnv('AURORA_DESKTOP_LIVE_E2E_SESSION_NONCE')
  const application = process.env.AURORA_DESKTOP_LIVE_E2E_APPLICATION
  const pidFile = process.env.AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE
  const expectedWebRtcPrimitive = resolveExpectedWebRtcPrimitive()
  const scriptTimeoutMs = parsePositiveIntegerEnv(
    'AURORA_DESKTOP_LIVE_E2E_SCRIPT_TIMEOUT_MS',
    180_000,
  )
  let tauriPid = process.env.AURORA_DESKTOP_LIVE_E2E_TAURI_PID ?? 'unavailable'

  if (!webdriverUrl) {
    await writeBlocked(reportPath, donePath, {
      blocker: 'missing-webdriver-url',
      sessionNonce,
      tauriPid,
      detail:
        'Set AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_URL to a running tauri-driver/WebDriver endpoint.',
    })
    process.exit(2)
  }
  if (!application || !pidFile) {
    await writeBlocked(reportPath, donePath, {
      blocker: 'missing-driver-application',
      sessionNonce,
      tauriPid,
      detail:
        'AURORA_DESKTOP_LIVE_E2E_APPLICATION and AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE are required.',
    })
    process.exit(2)
  }

  let session
  try {
    session = await createSession(webdriverUrl, application)
    await setSessionTimeouts(webdriverUrl, session.sessionId, scriptTimeoutMs)
    tauriPid = await waitForApplicationPid(pidFile)
    await selectMainDesktopWindow(webdriverUrl, session.sessionId)
    await waitForDesktopHookContext(webdriverUrl, session.sessionId)
    // The overlay is created during app startup and WebKitWebDriver can make the
    // newest WebView current. Re-select main after readiness so the privileged
    // hook cannot be invoked in the intentionally restricted overlay context.
    await selectMainDesktopWindow(webdriverUrl, session.sessionId)
    const processTreeBefore = captureProcessTree(tauriPid)
    const payload = await buildHookPayload({ sessionNonce, tauriPid, reportPath, donePath })
    const hookResult = await invokeDesktopHook(webdriverUrl, session.sessionId, payload)
    if (hookResult?.status === 'passed') {
      const processTreeAfter = captureProcessTree(tauriPid)
      try {
        validatePassedHookResult(hookResult, {
          sessionNonce,
          tauriPid,
          expectedWebRtcPrimitive,
        })
      } catch (error) {
        await writeBlocked(reportPath, donePath, {
          blocker: 'desktop-webview-hook-invalid-report',
          sessionNonce,
          tauriPid,
          detail: error instanceof Error ? error.message : String(error),
          webdriver: {
            endpoint: redactEndpoint(webdriverUrl),
            sessionIdDigest: sha256Like(session.sessionId),
          },
          runtime: hookResult.runtime,
        })
        process.exit(2)
      }
      await writeJson(reportPath, {
        schema: 'aurora.desktop_live_e2e.webdriver_driver.v1',
        ...hookResult,
        sessionNonce,
        tauriPid: String(tauriPid),
        desktopResult: {
          ...(hookResult.desktopResult ?? {}),
          pidBinding: {
            ...(hookResult.desktopResult?.pidBinding ?? {}),
            actualOsPidVerified: true,
            observedPid: String(tauriPid),
          },
        },
        processTree: {
          beforeHook: processTreeBefore,
          afterHook: processTreeAfter,
        },
        webdriver: {
          endpoint: redactEndpoint(webdriverUrl),
          sessionIdDigest: sha256Like(session.sessionId),
        },
        secretsRedacted: true,
      })
      await writeJson(donePath, {
        ok: true,
        at: new Date().toISOString(),
      })
      return
    }
    await writeBlocked(reportPath, donePath, {
      blocker: hookResult?.blocker ?? 'desktop-webview-hook-incomplete',
      sessionNonce,
      tauriPid,
      detail:
        hookResult?.detail ??
        'window.__AURORA_DESKTOP_LIVE_E2E__ did not return a passed report.',
      webdriver: {
        endpoint: redactEndpoint(webdriverUrl),
        sessionIdDigest: sha256Like(session.sessionId),
      },
      runtime: hookResult?.runtime,
    })
    process.exit(2)
  } catch (error) {
    await writeBlocked(reportPath, donePath, {
      blocker: error instanceof DesktopHookReadinessError
        ? 'desktop-webview-hook-not-ready'
        : 'webdriver-connection-failed',
      sessionNonce,
      tauriPid,
      detail: error instanceof Error ? error.message : String(error),
      webdriver: {
        endpoint: redactEndpoint(webdriverUrl),
      },
      runtime: error instanceof DesktopHookReadinessError ? error.runtime : undefined,
    })
    process.exit(2)
  } finally {
    if (session) await deleteSession(webdriverUrl, session.sessionId).catch(() => undefined)
  }
}

async function createSession(baseUrl, application) {
  const browserName = process.env.AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_BROWSER
  const body = {
    capabilities: {
      alwaysMatch: {
        'tauri:options': {
          application,
        },
        ...(browserName ? { browserName } : {}),
      },
    },
  }
  const value = await request(baseUrl, 'POST', '/session', body, 'create-session')
  const sessionId = value.sessionId ?? value.value?.sessionId
  if (!sessionId) throw new Error('WebDriver did not return a session id')
  return { sessionId }
}

async function setSessionTimeouts(baseUrl, sessionId, scriptTimeoutMs) {
  await request(baseUrl, 'POST', `/session/${encodeURIComponent(sessionId)}/timeouts`, {
    script: scriptTimeoutMs,
  }, 'set-session-timeouts')
}

async function deleteSession(baseUrl, sessionId) {
  await request(
    baseUrl,
    'DELETE',
    `/session/${encodeURIComponent(sessionId)}`,
    undefined,
    'delete-session',
  )
}

async function executeScript(baseUrl, sessionId, script) {
  const value = await request(
    baseUrl,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/execute/sync`,
    { script, args: [] },
  )
  return value.value ?? value
}

async function executeAsyncScript(baseUrl, sessionId, script, args = []) {
  const value = await request(
    baseUrl,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/execute/async`,
    { script, args },
    'invoke-desktop-hook',
  )
  return value.value ?? value
}

async function listWindowHandles(baseUrl, sessionId) {
  const value = await request(
    baseUrl,
    'GET',
    `/session/${encodeURIComponent(sessionId)}/window/handles`,
    undefined,
    'list-window-handles',
  )
  const handles = value.value ?? value
  if (!Array.isArray(handles)) {
    throw new Error('WebDriver did not return a window handle list')
  }
  return handles.filter((handle) => typeof handle === 'string' && handle.length > 0)
}

async function switchToWindow(baseUrl, sessionId, handle) {
  await request(
    baseUrl,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/window`,
    { handle },
    'switch-window',
  )
}

async function selectMainDesktopWindow(
  baseUrl,
  sessionId,
  {
    timeoutMs = 30_000,
    pollMs = 50,
    listHandles = listWindowHandles,
    switchWindow = switchToWindow,
    execute = executeScript,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs
  let lastRuntime
  let lastTransientError

  while (Date.now() < deadline) {
    const handles = await listHandles(baseUrl, sessionId)
    for (const handle of handles) {
      try {
        await switchWindow(baseUrl, sessionId, handle)
        const runtime = normalizeDesktopHookRuntime(
          await execute(baseUrl, sessionId, desktopHookReadinessScript),
        )
        lastRuntime = runtime
        lastTransientError = undefined
        if (!runtime.overlaySurface) return { handle, runtime }
      } catch (error) {
        if (!isTransientDesktopContextError(error)) throw error
        lastTransientError = webdriverErrorCode(error)
      }
    }
    await sleep(pollMs)
  }

  const runtimeDetail = lastRuntime
    ? ` Last runtime: ${JSON.stringify(lastRuntime)}.`
    : ''
  const errorDetail = lastTransientError
    ? ` Last transient WebDriver error: ${lastTransientError}.`
    : ''
  throw new DesktopHookReadinessError(
    `Timed out selecting the main Tauri WebView.${runtimeDetail}${errorDetail}`,
    lastRuntime,
  )
}

async function waitForDesktopHookContext(
  baseUrl,
  sessionId,
  {
    timeoutMs = 30_000,
    pollMs = 50,
    execute = executeScript,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  } = {},
) {
  const deadline = Date.now() + timeoutMs
  let lastRuntime
  let lastTransientError

  while (Date.now() < deadline) {
    try {
      const runtime = await execute(baseUrl, sessionId, desktopHookReadinessScript)
      lastRuntime = normalizeDesktopHookRuntime(runtime)
      lastTransientError = undefined
      if (
        lastRuntime.readyState === 'complete'
        && lastRuntime.tauriPresent
        && lastRuntime.hookReady
      ) {
        return lastRuntime
      }
    } catch (error) {
      if (!isTransientDesktopContextError(error)) throw error
      // WebKit can reject a command while replacing its initial page context.
      // This retry is bounded to readiness polling and never retries the hook.
      lastTransientError = webdriverErrorCode(error)
    }
    await sleep(pollMs)
  }

  const runtimeDetail = lastRuntime
    ? ` Last runtime: ${JSON.stringify(lastRuntime)}.`
    : ''
  const errorDetail = lastTransientError
    ? ` Last transient WebDriver error: ${lastTransientError}.`
    : ''
  throw new DesktopHookReadinessError(
    `Timed out waiting for the loaded Tauri WebView and desktop live hook.${runtimeDetail}${errorDetail}`,
    lastRuntime,
  )
}

function normalizeDesktopHookRuntime(value) {
  if (!value || typeof value !== 'object') {
    return {
      href: '',
      tauriPresent: false,
      title: '',
      readyState: '',
      hookReady: false,
      surface: '',
      overlaySurface: false,
    }
  }
  return {
    href: typeof value.href === 'string' ? value.href : '',
    tauriPresent: value.tauriPresent === true,
    title: typeof value.title === 'string' ? value.title : '',
    readyState: typeof value.readyState === 'string' ? value.readyState : '',
    hookReady: value.hookReady === true,
    surface: typeof value.surface === 'string' ? value.surface : '',
    overlaySurface: value.overlaySurface === true,
  }
}

function webdriverErrorCode(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return detail.match(/"error"\s*:\s*"([^"]+)"/u)?.[1]
}

function isTransientDesktopContextError(error) {
  return webdriverErrorCode(error) === 'javascript error'
}

async function buildHookPayload({ sessionNonce, tauriPid, reportPath, donePath }) {
  return {
    schema: 'aurora.desktop_live_e2e.hook_payload.v1',
    sessionNonce,
    tauriPid: String(tauriPid),
    reportPath,
    donePath,
    readyPath: process.env.AURORA_DESKTOP_LIVE_E2E_READY,
    runtimeProfilePath: process.env.AURORA_DESKTOP_LIVE_E2E_RUNTIME_PROFILE,
    invitePath: process.env.AURORA_DESKTOP_LIVE_E2E_INVITE,
    roomSecret: process.env.AURORA_DESKTOP_LIVE_E2E_ROOM_SECRET,
    ready: await readJsonEnv('AURORA_DESKTOP_LIVE_E2E_READY'),
    runtimeProfile: await readJsonEnv('AURORA_DESKTOP_LIVE_E2E_RUNTIME_PROFILE'),
    invite: await readJsonEnv('AURORA_DESKTOP_LIVE_E2E_INVITE'),
  }
}

async function readJsonEnv(name) {
  const file = process.env[name]
  if (!file) return null
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function invokeDesktopHook(baseUrl, sessionId, payload) {
  const value = await executeAsyncScript(baseUrl, sessionId, `
    const payload = arguments[0];
    const envelopeSchema = arguments[1];
    const done = arguments[arguments.length - 1];
    const finish = (result) => {
      let serialized;
      try {
        serialized = JSON.stringify({ schema: envelopeSchema, result });
      } catch (error) {
        serialized = JSON.stringify({
          schema: envelopeSchema,
          result: {
            status: 'failed',
            blocker: 'desktop-webview-hook-serialization-failed',
            detail: error && typeof error.message === 'string' ? error.message : String(error)
          }
        });
      }
      done(serialized);
    };
    Promise.resolve().then(async () => {
      const runtime = {
        href: String(window.location.href),
        tauriPresent: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__),
        title: String(document.title || ''),
        readyState: String(document.readyState || '')
      };
      const deadline = Date.now() + 10000;
      while (typeof window.__AURORA_DESKTOP_LIVE_E2E__ !== 'function' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const hook = window.__AURORA_DESKTOP_LIVE_E2E__;
      if (typeof hook !== 'function') {
        return {
          status: 'blocked',
          blocker: 'missing-desktop-webview-hook',
          detail: 'window.__AURORA_DESKTOP_LIVE_E2E__ is not installed.',
          runtime
        };
      }
      const result = await hook(payload);
      if (!result || typeof result !== 'object') {
        return {
          status: 'blocked',
          blocker: 'desktop-webview-hook-returned-no-report',
          detail: 'window.__AURORA_DESKTOP_LIVE_E2E__ must return a report object.',
          runtime
        };
      }
      return { runtime, ...result };
    }).then(finish, (error) => finish({
      status: 'failed',
      blocker: 'desktop-webview-hook-threw',
      detail: error && typeof error.message === 'string' ? error.message : String(error)
    }));
  `, [payload, hookResultEnvelopeSchema])
  return parseHookResultEnvelope(value)
}

function parseHookResultEnvelope(value) {
  if (typeof value !== 'string') {
    throw new Error('Desktop WebView hook returned a non-JSON result envelope')
  }
  let envelope
  try {
    envelope = JSON.parse(value)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Desktop WebView hook returned invalid JSON: ${detail}`)
  }
  if (
    !envelope
    || typeof envelope !== 'object'
    || envelope.schema !== hookResultEnvelopeSchema
    || !envelope.result
    || typeof envelope.result !== 'object'
  ) {
    throw new Error('Desktop WebView hook returned an invalid result envelope')
  }
  return envelope.result
}

function validatePassedHookResult(
  result,
  {
    sessionNonce,
    tauriPid,
    expectedWebRtcPrimitive = 'tauri-native-webrtc',
  },
) {
  assert.equal(result.status, 'passed')
  assert.equal(result.sessionNonce, sessionNonce)
  assert.equal(String(result.tauriPid), String(tauriPid))
  assert.equal(result.secretsRedacted, true)
  assert.equal(result.noHttpFetchTransportUsed, true)
  assert.equal(result.browserResult?.noHttpFetchTransportUsed, true)
  assert.deepEqual(result.browserResult?.httpFetchCalls, [])
  const nativeWebRtcExpected = expectedWebRtcPrimitive === 'tauri-native-webrtc'
  assert.equal(result.desktopResult?.nativeWebRtcFallback?.used, nativeWebRtcExpected)
  assert.equal(
    result.desktopResult?.nativeWebRtcFallback?.primitive,
    expectedWebRtcPrimitive,
  )
  assert.equal(
    result.desktopResult?.nativeWebRtcFallback?.forcedByLiveGate,
    nativeWebRtcExpected,
  )
  assertRoleSwitchEvidence(result.roleSwitchEvidence, 'hook result')
  assert.ok(
    result.browserResult || result.desktopResult,
    'hook result must include browserResult or desktopResult evidence',
  )
}

async function waitForApplicationPid(pidFile, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = (await fs.readFile(pidFile, 'utf8')).trim()
      if (/^[1-9]\d{0,19}$/u.test(value)) return value
    } catch {
      // The tauri-driver application wrapper writes this after the session starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for the tauri-driver application PID')
}

function captureProcessTree(rootPid) {
  const entries = parseProcessTable(psOutput())
  const numericRootPid = Number(rootPid)
  const root = entries.find((entry) => entry.pid === numericRootPid)
  assert.ok(root, `tauri-driver application PID ${rootPid} must exist while the hook runs`)
  const descendants = descendantsOf(entries, numericRootPid)
  const forbidden = descendants.filter((entry) =>
    forbiddenDesktopChildPattern.test(`${entry.command} ${entry.args}`),
  )
  assert.deepEqual(
    forbidden,
    [],
    'driver-launched desktop client must not own Python or sidecar descendants',
  )
  return {
    rootPid: String(rootPid),
    rootCommand: root.command,
    descendantCount: descendants.length,
    forbiddenMatches: [],
    checkedAt: new Date().toISOString(),
  }
}

function psOutput() {
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], {
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`)
  return result.stdout
}

function parseProcessTable(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u)
      if (!match) return null
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3],
        args: match[4] ?? '',
      }
    })
    .filter(Boolean)
}

function descendantsOf(entries, rootPid) {
  const byParent = new Map()
  for (const entry of entries) {
    const children = byParent.get(entry.ppid) ?? []
    children.push(entry)
    byParent.set(entry.ppid, children)
  }
  const descendants = []
  const queue = [...(byParent.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const entry = queue.shift()
    descendants.push(entry)
    queue.push(...(byParent.get(entry.pid) ?? []))
  }
  return descendants
}

async function request(baseUrl, method, pathname, body, phase = 'webdriver-request') {
  let response
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    throw new Error(`${phase} failed: ${requestErrorDetail(error)}`)
  }
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(`WebDriver ${method} ${pathname} failed with ${response.status}: ${text}`)
  }
  return payload
}

function requestErrorDetail(error) {
  const detail = error instanceof Error ? error.message : String(error)
  const cause = error && typeof error === 'object' ? error.cause : undefined
  const code = cause && typeof cause === 'object' && typeof cause.code === 'string'
    ? cause.code
    : undefined
  return code ? `${detail} (${code})` : detail
}

async function writeBlocked(reportPath, donePath, details) {
  await writeJson(reportPath, {
    schema: 'aurora.desktop_live_e2e.webdriver_driver.v1',
    status: 'blocked',
    sessionNonce: details.sessionNonce,
    tauriPid: String(details.tauriPid),
    blocker: details.blocker,
    detail: details.detail,
    ...(details.webdriver ? { webdriver: details.webdriver } : {}),
    ...(details.runtime ? { runtime: details.runtime } : {}),
    requiredSharedChange:
      'Restore the maintained tauri-driver application wrapper and gated desktop WebView hook, then rerun the live desktop client command.',
    secretsRedacted: true,
  })
  await writeJson(donePath, {
    ok: false,
    at: new Date().toISOString(),
    reason: details.blocker,
  })
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function resolveExpectedWebRtcPrimitive() {
  const value = process.env.AURORA_DESKTOP_LIVE_E2E_EXPECTED_WEBRTC_PRIMITIVE
    ?? 'tauri-native-webrtc'
  if (value !== 'tauri-native-webrtc' && value !== 'browser-rtcpeerconnection') {
    throw new Error(
      'AURORA_DESKTOP_LIVE_E2E_EXPECTED_WEBRTC_PRIMITIVE must name a supported primitive',
    )
  }
  return value
}

function redactEndpoint(value) {
  return String(value).replace(/\/\/([^:@/]+):([^@/]+)@/, '//<redacted>@')
}

function sha256Like(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

async function runSelfTest() {
  assert.equal(redactEndpoint('http://user:pass@127.0.0.1:4444'), 'http://<redacted>@127.0.0.1:4444')
  assert.equal(sha256Like('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const processEntries = parseProcessTable([
    '123 1 aurora-tauri /tmp/aurora-tauri',
    '124 123 WebKitWebProces WebKitWebProcess',
    '200 1 python python main.py',
  ].join('\n'))
  assert.equal(descendantsOf(processEntries, 123).length, 1)
  assert.equal(
    descendantsOf(processEntries, 123).some((entry) =>
      forbiddenDesktopChildPattern.test(`${entry.command} ${entry.args}`),
    ),
    false,
  )
  assert.throws(() => requireEnv('AURORA_DESKTOP_LIVE_E2E_SELF_TEST_MISSING'))
  assert.equal(resolveExpectedWebRtcPrimitive(), 'tauri-native-webrtc')
  assert.deepEqual(
    parseHookResultEnvelope(JSON.stringify({
      schema: hookResultEnvelopeSchema,
      result: { status: 'passed' },
    })),
    { status: 'passed' },
  )
  assert.throws(() => parseHookResultEnvelope({ status: 'passed' }), /non-JSON result envelope/)
  assert.throws(() => parseHookResultEnvelope('{'), /returned invalid JSON/)
  assert.throws(
    () => parseHookResultEnvelope(JSON.stringify({ schema: 'wrong', result: {} })),
    /invalid result envelope/,
  )
  let selectedWindow = ''
  const windowSwitches = []
  const selected = await selectMainDesktopWindow('http://unused.test', 'session', {
    timeoutMs: 1_000,
    pollMs: 0,
    listHandles: async () => ['overlay-window', 'main-window'],
    switchWindow: async (_baseUrl, _sessionId, handle) => {
      selectedWindow = handle
      windowSwitches.push(handle)
    },
    execute: async () => ({
      href: selectedWindow === 'overlay-window'
        ? 'tauri://localhost/?surface=overlay'
        : 'tauri://localhost/',
      tauriPresent: true,
      title: 'Aurora',
      readyState: 'complete',
      hookReady: true,
      surface: selectedWindow === 'overlay-window' ? 'overlay' : '',
      overlaySurface: selectedWindow === 'overlay-window',
    }),
    sleep: async () => undefined,
  })
  assert.deepEqual(windowSwitches, ['overlay-window', 'main-window'])
  assert.equal(selected.handle, 'main-window')
  assert.equal(selected.runtime.overlaySurface, false)
  await assert.rejects(
    request('http://127.0.0.1:1', 'GET', '/status', undefined, 'self-test-phase'),
    /self-test-phase failed/,
  )
  let readinessAttempts = 0
  const readyRuntime = await waitForDesktopHookContext('http://unused.test', 'session', {
    timeoutMs: 1_000,
    pollMs: 0,
    execute: async () => {
      readinessAttempts += 1
      if (readinessAttempts === 1) {
        throw new Error(
          'WebDriver POST /execute/sync failed with 500: '
          + '{"value":{"error":"javascript error","message":"A JavaScript exception occurred"}}',
        )
      }
      if (readinessAttempts === 2) {
        return {
          href: 'tauri://localhost',
          tauriPresent: true,
          title: 'Aurora',
          readyState: 'complete',
          hookReady: false,
        }
      }
      return {
        href: 'tauri://localhost',
        tauriPresent: true,
        title: 'Aurora',
        readyState: 'complete',
        hookReady: true,
      }
    },
    sleep: async () => undefined,
  })
  assert.equal(readinessAttempts, 3)
  assert.equal(readyRuntime.hookReady, true)
  await assert.rejects(
    waitForDesktopHookContext('http://unused.test', 'session', {
      timeoutMs: 1_000,
      pollMs: 0,
      execute: async () => {
        throw new Error(
          'WebDriver POST /execute/sync failed with 404: '
          + '{"value":{"error":"invalid session id"}}',
        )
      },
      sleep: async () => undefined,
    }),
    /invalid session id/,
  )
  assert.doesNotThrow(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      noHttpFetchTransportUsed: true,
      browserResult: {
        noHttpFetchTransportUsed: true,
        httpFetchCalls: [],
      },
      desktopResult: { approved: true, nativeWebRtcFallback: nativeWebRtcFallbackEvidence() },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.doesNotThrow(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      noHttpFetchTransportUsed: true,
      browserResult: {
        noHttpFetchTransportUsed: true,
        httpFetchCalls: [],
      },
      desktopResult: {
        approved: true,
        nativeWebRtcFallback: browserWebRtcEvidence(),
      },
      secretsRedacted: true,
    }, {
      sessionNonce: 'nonce',
      tauriPid: '123',
      expectedWebRtcPrimitive: 'browser-rtcpeerconnection',
    }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      noHttpFetchTransportUsed: true,
      browserResult: {
        noHttpFetchTransportUsed: false,
        httpFetchCalls: ['https://unexpected.example/'],
      },
      desktopResult: { approved: true, nativeWebRtcFallback: nativeWebRtcFallbackEvidence() },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'wrong',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      desktopResult: { approved: true, nativeWebRtcFallback: nativeWebRtcFallbackEvidence() },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      desktopResult: { approved: true },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: false, from: 'remote-console', to: 'mesh-node' },
      desktopResult: { approved: true, nativeWebRtcFallback: nativeWebRtcFallbackEvidence() },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'mesh-node', to: 'remote-console' },
      desktopResult: { approved: true, nativeWebRtcFallback: nativeWebRtcFallbackEvidence() },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  console.log('desktop-webdriver-driver self-test passed')
}

function nativeWebRtcFallbackEvidence() {
  return {
    used: true,
    primitive: 'tauri-native-webrtc',
    forcedByLiveGate: true,
  }
}

function browserWebRtcEvidence() {
  return {
    used: false,
    primitive: 'browser-rtcpeerconnection',
    forcedByLiveGate: false,
  }
}

#!/usr/bin/env node
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertRoleSwitchEvidence } from './role-switch-evidence.mjs'

const args = new Set(process.argv.slice(2))

if (args.has('--self-test')) {
  runSelfTest()
} else {
  await run()
}

async function run() {
  const webdriverUrl = process.env.AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_URL
  const reportPath = requireEnv('AURORA_DESKTOP_LIVE_E2E_DESKTOP_REPORT')
  const donePath = requireEnv('AURORA_DESKTOP_LIVE_E2E_DONE')
  const sessionNonce = requireEnv('AURORA_DESKTOP_LIVE_E2E_SESSION_NONCE')
  const tauriPid = requireEnv('AURORA_DESKTOP_LIVE_E2E_TAURI_PID')

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

  let session
  try {
    session = await createSession(webdriverUrl)
    const payload = await buildHookPayload({ sessionNonce, tauriPid, reportPath, donePath })
    const hookResult = await invokeDesktopHook(webdriverUrl, session.sessionId, payload)
    if (hookResult?.status === 'passed') {
      try {
        validatePassedHookResult(hookResult, { sessionNonce, tauriPid })
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
      blocker: 'webdriver-connection-failed',
      sessionNonce,
      tauriPid,
      detail: error instanceof Error ? error.message : String(error),
      webdriver: {
        endpoint: redactEndpoint(webdriverUrl),
      },
    })
    process.exit(2)
  } finally {
    if (session) await deleteSession(webdriverUrl, session.sessionId).catch(() => undefined)
  }
}

async function createSession(baseUrl) {
  const body = {
    capabilities: {
      alwaysMatch: {
        browserName: process.env.AURORA_DESKTOP_LIVE_E2E_WEBDRIVER_BROWSER ?? 'wry',
      },
    },
  }
  const value = await request(baseUrl, 'POST', '/session', body)
  const sessionId = value.sessionId ?? value.value?.sessionId
  if (!sessionId) throw new Error('WebDriver did not return a session id')
  return { sessionId }
}

async function deleteSession(baseUrl, sessionId) {
  await request(baseUrl, 'DELETE', `/session/${encodeURIComponent(sessionId)}`)
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
  )
  return value.value ?? value
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
  return await executeAsyncScript(baseUrl, sessionId, `
    const payload = arguments[0];
    const done = arguments[arguments.length - 1];
    Promise.resolve().then(async () => {
      const runtime = {
        href: String(window.location.href),
        tauriPresent: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__),
        title: String(document.title || ''),
        readyState: String(document.readyState || '')
      };
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
    }).then(done, (error) => done({
      status: 'failed',
      blocker: 'desktop-webview-hook-threw',
      detail: error?.message ?? String(error)
    }));
  `, [payload])
}

function validatePassedHookResult(result, { sessionNonce, tauriPid }) {
  assert.equal(result.status, 'passed')
  assert.equal(result.sessionNonce, sessionNonce)
  assert.equal(String(result.tauriPid), String(tauriPid))
  assert.equal(result.secretsRedacted, true)
  assertRoleSwitchEvidence(result.roleSwitchEvidence, 'hook result')
  assert.ok(
    result.browserResult || result.desktopResult,
    'hook result must include browserResult or desktopResult evidence',
  )
}

async function request(baseUrl, method, pathname, body) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(`WebDriver ${method} ${pathname} failed with ${response.status}: ${text}`)
  }
  return payload
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
      'Expose a test-only desktop WebView interop hook or add a maintained tauri-driver/WebDriver workflow wrapper that can seed the runtime profile, approve pairing, execute the existing WebRTC interop contract, and write a passed desktop-client-report.json.',
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

function redactEndpoint(value) {
  return String(value).replace(/\/\/([^:@/]+):([^@/]+)@/, '//<redacted>@')
}

function sha256Like(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function runSelfTest() {
  assert.equal(redactEndpoint('http://user:pass@127.0.0.1:4444'), 'http://<redacted>@127.0.0.1:4444')
  assert.equal(sha256Like('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.throws(() => requireEnv('AURORA_DESKTOP_LIVE_E2E_SELF_TEST_MISSING'))
  assert.doesNotThrow(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      desktopResult: { approved: true },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'wrong',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'remote-console', to: 'mesh-node' },
      desktopResult: { approved: true },
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
      desktopResult: { approved: true },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  assert.throws(() =>
    validatePassedHookResult({
      status: 'passed',
      sessionNonce: 'nonce',
      tauriPid: '123',
      roleSwitchEvidence: { passed: true, from: 'mesh-node', to: 'remote-console' },
      desktopResult: { approved: true },
      secretsRedacted: true,
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
  )
  console.log('desktop-webdriver-driver self-test passed')
}

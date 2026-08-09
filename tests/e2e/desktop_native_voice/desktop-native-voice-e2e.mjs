#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const defaultArtifactDir = path.join(repoRoot, 'reports/desktop-native-voice-e2e')
const runnerScript = path.join(repoRoot, 'scripts/desktop_native_voice_e2e.sh')
const applicationWrapperScript = path.join(repoRoot, 'scripts/desktop_live_application.sh')
const nativeVoiceApplicationWrapperScript = path.join(repoRoot, 'scripts/desktop_native_voice_application.sh')
const sidecarSentinelScript = path.join(repoRoot, 'tests/e2e/desktop_native_voice/sidecar-sentinel.mjs')
const hookEnvelopeSchema = 'aurora.desktop_native_voice_e2e.webdriver_result.v1'
const hookPayloadSchema = 'aurora.desktop_native_voice_e2e.hook_payload.v1'
const webdriverReportSchema = 'aurora.desktop_native_voice_e2e.webdriver_report.v1'
const gatewayReportSchema = 'aurora.desktop_native_voice_e2e.gateway_report.v1'
const aggregateReportSchema = 'aurora.desktop_native_voice_e2e.report.v1'
const forbiddenReportText =
  /\b(?:authorization|bearer|token|rawAudio|audioData|audio_data|transcript|leaseId|lease_id|modelPath)\b/iu
const sensitiveFieldName = /^(?:audioData|audio_data|text|leaseId|lease_id|token|authorization|transcript)$/iu
const remoteAudioConsentReason = 'remote_audio_consent_required'
const interruptScopes = new Set(['generation', 'session', 'tool_call', 'tts_playback'])
const interruptStatuses = new Set(['cancelled', 'failed', 'no_active_work', 'not_supported'])

const args = new Set(process.argv.slice(2))

if (args.has('--self-test')) {
  await runSelfTest()
} else if (args.has('--check-only') || process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E !== '1') {
  await runCheckOnly()
} else {
  await runLive()
}

async function runCheckOnly() {
  const artifactDir = resolveArtifactDir()
  await fs.mkdir(artifactDir, { recursive: true })
  const report = {
    schema: 'aurora.desktop_native_voice_e2e.check.v1',
    status: 'ready-to-run',
    liveEnabled: process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E === '1',
    webdriverCommandConfigured: Boolean(process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_URL),
    prerequisites: {
      pnpm: commandAvailable('pnpm'),
      node: commandAvailable('node'),
      maintainedRunner: await fileExists(runnerScript),
      applicationWrapper: await fileExists(applicationWrapperScript),
      nativeVoiceApplicationWrapper: await fileExists(nativeVoiceApplicationWrapperScript),
      managedSidecarSentinel: await fileExists(sidecarSentinelScript),
    },
    launchContract: nativeVoiceLaunchContract(),
    reportPolicy: reportPolicy(),
    stopCondition:
      'Full live mode requires AURORA_DESKTOP_NATIVE_VOICE_E2E=1 and a built Tauri desktop binary. It starts a loopback fake Gateway and drives native voice through tauri-driver.',
    secretsRedacted: true,
  }
  await writeJson(path.join(artifactDir, 'desktop-native-voice-check.json'), report)
  assert.equal(report.prerequisites.maintainedRunner, true)
  assert.equal(report.prerequisites.applicationWrapper, true)
  assert.equal(report.prerequisites.nativeVoiceApplicationWrapper, true)
  assert.equal(report.prerequisites.managedSidecarSentinel, true)
  console.log(JSON.stringify(report, null, 2))
}

async function runLive() {
  const artifactDir = resolveArtifactDir()
  await fs.mkdir(artifactDir, { recursive: true })
  const reportPath = path.join(artifactDir, 'desktop-native-voice-webdriver-report.json')
  const donePath = path.join(artifactDir, 'desktop-native-voice-done.json')
  const gatewayReportPath = path.join(artifactDir, 'desktop-native-voice-gateway-report.json')
  const finalReportPath = path.join(artifactDir, 'report.json')
  const driverLogPath = path.join(artifactDir, 'desktop-native-voice-driver.log')
  const appPidFile = process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_APP_PID_FILE
  const application = process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_APPLICATION
  const webdriverUrl = process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_URL
  const timeoutMs = parsePositiveIntegerEnv('AURORA_DESKTOP_NATIVE_VOICE_E2E_TIMEOUT_MS', 15_000)
  const sessionNonce = `native-${crypto.randomBytes(20).toString('base64url')}`
  const gateway = await startFakeGateway()
  let session

  try {
    for (const file of [reportPath, donePath, gatewayReportPath, finalReportPath, driverLogPath]) {
      await fs.rm(file, { force: true })
    }
    if (!application || !webdriverUrl || !appPidFile) {
      throw new Error('missing application, WebDriver URL, or application PID file')
    }
    process.env.AURORA_GATEWAY_URL = gateway.origin
    session = await createSession(webdriverUrl, application)
    await setSessionTimeouts(webdriverUrl, session.sessionId, Math.max(timeoutMs + 30_000, 60_000))
    const tauriPid = await waitForApplicationPid(appPidFile, 30_000)
    const payload = {
      schema: hookPayloadSchema,
      sessionNonce,
      tauriPid,
      expectedGatewayOrigin: gateway.origin,
      reportPath,
      donePath,
      timeoutMs,
    }
    const hookResult = await invokeDesktopHook(webdriverUrl, session.sessionId, payload)
    await writeJson(path.join(artifactDir, 'desktop-native-voice-hook-result.json'), hookResult)
    validateHookReport(hookResult, { sessionNonce, tauriPid })
    await writeJson(reportPath, {
      schema: webdriverReportSchema,
      ...hookResult,
      webdriver: {
        endpoint: redactEndpoint(webdriverUrl),
        sessionIdDigest: sha256Hex(session.sessionId),
      },
      secretsRedacted: true,
    })
    await writeJson(donePath, {
      ok: true,
      at: new Date().toISOString(),
    })
    const gatewayReport = gateway.report()
    validateGatewayReport(gatewayReport)
    await writeJson(gatewayReportPath, gatewayReport)
    const finalReport = {
      schema: aggregateReportSchema,
      status: 'passed',
      desktopReportDigest: sha256Hex(JSON.stringify(hookResult)),
      gatewayReportDigest: sha256Hex(JSON.stringify(gatewayReport)),
      tauriPidDigest: sha256Hex(String(tauriPid)),
      sessionNonceDigest: sha256Hex(sessionNonce),
      requiredRoutes: gatewayReport.requiredRouteHits,
      reportPolicy: reportPolicy(),
      secretsRedacted: true,
    }
    assertNoSensitiveMaterial(finalReport, 'aggregate report')
    await writeJson(finalReportPath, finalReport)
    await fs.writeFile(driverLogPath, `${JSON.stringify({
      status: 'passed',
      reportDigest: finalReport.desktopReportDigest,
      gatewayDigest: finalReport.gatewayReportDigest,
    }, null, 2)}\n`)
  } catch (error) {
    await writeJson(path.join(artifactDir, 'desktop-native-voice-gateway-failure-report.json'), gateway.report())
    await writeJson(path.join(artifactDir, 'desktop-native-voice-failure.json'), {
      schema: 'aurora.desktop_native_voice_e2e.failure.v1',
      status: 'failed',
      error: sanitize(String(error instanceof Error ? error.message : error)),
      secretsRedacted: true,
    })
    throw error
  } finally {
    if (session && process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_URL) {
      await deleteSession(process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_WEBDRIVER_URL, session.sessionId)
        .catch(() => undefined)
    }
    await gateway.close()
  }
}

async function startFakeGateway() {
  const configuredPort = process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_GATEWAY_PORT
    ? Number.parseInt(process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_GATEWAY_PORT, 10)
    : 0
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
    throw new Error('AURORA_DESKTOP_NATIVE_VOICE_E2E_GATEWAY_PORT must be a TCP port')
  }
  const requests = []
  const requiredRoutes = new Map([
    ['/api/STTCoordinator/CapturePrepare', 0],
    ['/api/STTCoordinator/CaptureRelease', 0],
    ['/api/Transcription/Transcribe', 0],
    ['/api/Orchestrator/ExternalUserInput', 0],
    ['/api/Orchestrator/Interrupt', 0],
    ['/api/TTS/Synthesize', 0],
  ])
  let captureGeneration = 1
  let orchestratorTurns = 0
  const server = http.createServer(async (request, response) => {
    try {
      if (!request.url) throw new Error('missing request URL')
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, { status: 'ok', service: 'aurora-native-voice-e2e' })
      }
      if (request.method === 'GET' && url.pathname === '/api/events/stream') {
        requiredRoutes.set('/api/events/stream', (requiredRoutes.get('/api/events/stream') ?? 0) + 1)
        requests.push(summarizeRequest(request, url, null))
        return sendSse(response, [])
      }
      if (request.method !== 'POST') {
        response.writeHead(405)
        response.end()
        return
      }
      const body = await readJsonBody(request)
      requests.push(summarizeRequest(request, url, body))
      if (requiredRoutes.has(url.pathname)) {
        requiredRoutes.set(url.pathname, (requiredRoutes.get(url.pathname) ?? 0) + 1)
      }
      switch (url.pathname) {
        case '/api/STTCoordinator/CapturePrepare':
          return sendJson(response, {
            granted: true,
            status: 'granted',
            lease_id: String(body.lease_id ?? body.leaseId),
            generation: captureGeneration++,
            owner: 'native',
            python_capture_active: false,
            stopped_python_capture: true,
            redacted: true,
          })
        case '/api/STTCoordinator/CaptureRelease':
          {
          const releasedGeneration = Number(body.generation ?? 1)
          return sendJson(response, {
            released: true,
            status: 'released',
            generation: releasedGeneration + 1,
            owner: 'none',
            python_capture_active: Boolean(body.restart_python_capture ?? body.restartPythonCapture),
            restarted_python_capture: Boolean(body.restart_python_capture ?? body.restartPythonCapture),
            redacted: true,
          })
          }
        case '/api/Transcription/Transcribe':
          {
          const sampleRate = Number(body.sample_rate ?? body.sampleRate ?? 16_000)
          const rawAudioBytes = typeof body.audio_data === 'string'
            ? Buffer.from(body.audio_data, 'base64').length
            : 0
          return sendJson(response, {
            text: 'aurora desktop native voice test',
            model_used: 'desktop-native-voice-e2e',
            duration_ms: rawAudioBytes > 0
              ? Math.round((rawAudioBytes / 2 / sampleRate) * 1000)
              : 0,
            confidence: 0.99,
            language: 'en',
          })
          }
        case '/api/Orchestrator/ExternalUserInput':
          orchestratorTurns += 1
          if (orchestratorTurns > 1) await sleep(5_000)
          return sendJson(response, {
            text: 'Aurora native voice response',
            session_id: body.session_id ?? body.sessionId ?? 'native-voice-session',
            request_id: body.request_id ?? body.requestId ?? 'native-voice-request',
            correlation_id: body.correlation_id ?? body.correlationId ?? 'native-voice-correlation',
            metadata: {},
          })
        case '/api/Orchestrator/Interrupt':
          return sendJson(response, fakeInterruptResponse(body))
        case '/api/TTS/Synthesize':
          return sendJson(response, {
            audio_data: wavPcm16SilenceBase64(Number(body.sample_rate ?? body.sampleRate ?? 16_000), 160),
            format: 'wav',
            sample_rate: Number(body.sample_rate ?? body.sampleRate ?? 16_000),
            channels: 1,
            duration_ms: 10,
            text: String(body.text ?? 'Aurora native voice response'),
          })
        default:
          response.writeHead(404)
          response.end()
      }
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'bad_request', redacted: true }))
    }
  })
  await new Promise((resolve) => server.listen(configuredPort, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake Gateway did not bind')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    report() {
      const requiredRouteHits = Object.fromEntries(requiredRoutes)
      const report = {
        schema: gatewayReportSchema,
        status: 'passed',
        originClass: 'loopback',
        requestCount: requests.length,
        requests,
        requiredRouteHits,
        missingRoutes: Object.entries(requiredRouteHits)
          .filter(([, count]) => count === 0)
          .map(([route]) => route),
        secretsRedacted: true,
      }
      assertNoSensitiveMaterial(report, 'fake Gateway report')
      return report
    },
  }
}

function nativeVoiceLaunchContract() {
  return {
    command: 'scripts/desktop_native_voice_e2e.sh',
    application: 'scripts/desktop_native_voice_application.sh',
    webdriverCapability: 'tauri:options.application',
    env: {
      AURORA_TAURI_DEV_AUTOSIDECAR: '0',
      VITE_AURORA_DESKTOP_NATIVE_VOICE_E2E: '1',
      VITE_AURORA_TAURI_DEV_AUTOSIDECAR: '0',
      AURORA_GATEWAY_URL: 'loopback fake Gateway set by runner',
      AURORA_TAURI_SIDECAR_PROGRAM: 'repository-owned Node sentinel',
    },
    forbiddenWebViewCapabilities: ['getUserMedia', 'Worker', 'SharedWorker', 'browser model loads'],
      requiredNativeCommands: [
        'aurora_native_voice_status',
        'aurora_native_voice_start',
        'aurora_native_voice_finish',
        'aurora_native_voice_cancel',
      ],
      existingWrapperEnv: [
        'AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN',
        'AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE',
      ],
  }
}

function reportPolicy() {
  return {
    storesOnly: [
      'allowlisted route paths',
      'HTTP method names',
      'header-name allowlist',
      'request body SHA-256 digests',
      'safe request body top-level field names',
      'status phases and monotonic sequence numbers',
    ],
    excludes: ['speech samples', 'recognized speech text', 'credentials', 'capture identifiers'],
  }
}

async function invokeDesktopHook(baseUrl, sessionId, payload) {
  const value = await executeAsyncScript(baseUrl, sessionId, `
    const payload = arguments[0];
    const envelopeSchema = arguments[1];
    const done = arguments[arguments.length - 1];
    const describeError = (error) => {
      if (typeof error === 'string') return error;
      if (!error || typeof error !== 'object') return String(error);
      const bounded = {};
      for (const key of ['code', 'message', 'kind', 'reason', 'reasonCode', 'status', 'error']) {
        const value = error[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          bounded[key] = value;
        }
      }
      return Object.keys(bounded).length > 0 ? JSON.stringify(bounded) : 'structured command error';
    };
    const finish = (result) => {
      let serialized;
      try {
        serialized = JSON.stringify({ schema: envelopeSchema, result });
      } catch (error) {
        serialized = JSON.stringify({
          schema: envelopeSchema,
          result: {
            status: 'failed',
            blocker: 'desktop-native-voice-hook-serialization-failed',
            detail: describeError(error)
          }
        });
      }
      done(serialized);
    };
    Promise.resolve().then(async () => {
      const runtime = {
        href: String(window.location.href),
        title: String(document.title || ''),
        readyState: String(document.readyState || ''),
        tauriPresent: Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__),
      };
      const deadline = Date.now() + 10000;
      while (typeof window.__AURORA_DESKTOP_NATIVE_VOICE_E2E__ !== 'function' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const hook = window.__AURORA_DESKTOP_NATIVE_VOICE_E2E__;
      if (typeof hook !== 'function') {
        return {
          status: 'blocked',
          blocker: 'missing-desktop-native-voice-hook',
          detail: 'window.__AURORA_DESKTOP_NATIVE_VOICE_E2E__ is not installed.',
          runtime
        };
      }
      return await hook(payload);
    }).then((result) => finish({ runtime: { readyState: String(document.readyState || '') }, ...result }), (error) => finish({
      status: 'failed',
      blocker: 'desktop-native-voice-hook-threw',
      detail: describeError(error)
    }));
  `, [payload, hookEnvelopeSchema])
  return parseHookEnvelope(value)
}

function parseHookEnvelope(value) {
  if (typeof value !== 'string') {
    throw new Error('desktop native voice hook returned a non-JSON result envelope')
  }
  const envelope = JSON.parse(value)
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.schema !== hookEnvelopeSchema ||
    !envelope.result ||
    typeof envelope.result !== 'object'
  ) {
    throw new Error('desktop native voice hook returned an invalid result envelope')
  }
  return envelope.result
}

function validateHookReport(report, { sessionNonce, tauriPid }) {
  if (report.schema !== 'aurora.desktop_native_voice_e2e.webview_report.v1') {
    const status = typeof report.status === 'string' ? report.status : 'unknown'
    const blocker = typeof report.blocker === 'string' ? report.blocker : 'invalid-report-schema'
    const detail = typeof report.detail === 'string'
      ? sanitizeHookDiagnostic(report.detail)
      : 'no bounded diagnostic was returned'
    console.error(JSON.stringify({
      schema: 'aurora.desktop_native_voice_e2e.diagnostic.v1',
      status,
      blocker,
      detail,
      secretsRedacted: true,
    }))
    throw new Error(`desktop native voice hook did not return a report: ${status}/${blocker}`)
  }
  assert.equal(report.status, 'passed')
  assert.match(String(report.sessionNonceDigest), /^[0-9a-f]{64}$/u, 'sessionNonceDigest is required')
  assert.match(String(report.tauriPidDigest), /^[0-9a-f]{64}$/u, 'tauriPidDigest is required')
  assert.equal(report.sessionNonceDigest, sha256Hex(sessionNonce))
  assert.equal(report.tauriPidDigest, sha256Hex(String(tauriPid)))
  assert.equal(report.secretsRedacted, true)
  assert.equal(report.noWebViewMicrophone, true)
  assert.equal(report.noWebViewModelLoads, true)
  assert.equal(report.noBrowserWorkers, true)
  assert.equal(report.desktopResult?.monotonicStatuses, true)
  assert.equal(report.desktopResult?.distinctGenerations, true)
  assert.equal(report.desktopResult?.windowHidden, true)
  assert.equal(report.desktopResult?.sidecarLoopback, true)
  assert.equal(report.desktopResult?.persistedRoleSource, 'runtime-profile')
  assertRouteScenarios(report.desktopResult?.routeScenarios)
  assert.deepEqual(report.desktopResult?.forbiddenWebViewCalls, [])
  assert.match(String(report.desktopResult?.reportHash), /^[0-9a-f]{64}$/u)
  assertLifecycle(report.desktopResult?.completedTurn, 'completed')
  assertLifecycle(report.desktopResult?.cancelledTurn, 'cancelled')
  assert.ok(
    Array.isArray(report.desktopResult?.statusSequence) &&
      report.desktopResult.statusSequence.length >= 4,
    'status sequence must include real native events',
  )
  for (const event of report.desktopResult.statusSequence) {
    assert.match(String(event.sequence), /^[1-9]\d{0,19}$/u)
    assert.ok(['starting', 'listening', 'processing', 'speaking', 'stopping', 'idle'].includes(event.phase))
    assert.ok(['completed', 'cancelled', 'unknown'].includes(event.turn))
    assert.equal(event.redacted, true)
    assert.ok(event.reasonCode === null || /^[a-z0-9_]{1,64}$/u.test(String(event.reasonCode)))
    assert.deepEqual(Object.keys(event).sort(), ['phase', 'reasonCode', 'redacted', 'sequence', 'turn'])
  }
  assert.deepEqual(report.desktopResult?.commands, [
    'aurora_secure_storage_get',
    'aurora_secure_storage_set',
    'aurora_secure_storage_delete',
    'aurora_native_voice_status',
    'aurora_native_voice_start',
    'aurora_native_voice_finish',
    'aurora_native_voice_cancel',
  ])
  assertNoSensitiveMaterial(report, 'desktop native voice hook report')
}

function assertRouteScenarios(value) {
  assert.ok(Array.isArray(value), 'route scenario matrix is required')
  const byName = new Map(value.map((scenario) => [scenario?.name, scenario]))
  for (const name of [
    'remote-console-without-sidecar',
    'remote-console-with-running-sidecar',
    'mesh-node-python-full-with-sidecar',
  ]) {
    assert.ok(byName.has(name), `missing route scenario ${name}`)
  }
  for (const scenario of value) {
    assert.equal(scenario.redacted, true)
    assert.ok(['remote-gateway', 'loopback-sidecar'].includes(scenario.expectedScope))
    assert.ok(['remote-console', 'mesh-node'].includes(scenario.persistedNodeMode))
    assert.ok(['none', 'python-full'].includes(scenario.persistedRuntimeTier))
    assert.ok(typeof scenario.sidecarRunning === 'boolean')
    assert.ok(['this_device', 'connected_device', 'unavailable'].includes(scenario.observedConnection))
    assert.ok(typeof scenario.observedAvailable === 'boolean')
    assert.ok(scenario.observedReasonCode === null || /^[a-z0-9_]{1,128}$/u.test(String(scenario.observedReasonCode)))
    assert.ok(scenario.startBlockedReasonCode === null || /^[a-z0-9_]{1,128}$/u.test(String(scenario.startBlockedReasonCode)))
    assert.deepEqual(Object.keys(scenario).sort(), [
      'expectedScope',
      'name',
      'observedAvailable',
      'observedConnection',
      'observedReasonCode',
      'persistedNodeMode',
      'persistedRuntimeTier',
      'redacted',
      'sidecarRunning',
      'startBlockedReasonCode',
    ])
  }
  const remoteNoSidecar = byName.get('remote-console-without-sidecar')
  const remoteWithSidecar = byName.get('remote-console-with-running-sidecar')
  for (const scenario of [remoteNoSidecar, remoteWithSidecar]) {
    assert.equal(scenario.persistedNodeMode, 'remote-console')
    assert.equal(scenario.persistedRuntimeTier, 'none')
    assert.equal(scenario.expectedScope, 'remote-gateway')
    assert.equal(scenario.startBlockedReasonCode, remoteAudioConsentReason)
    assert.notEqual(scenario.observedConnection, 'this_device')
  }
  assert.equal(remoteNoSidecar.sidecarRunning, false)
  assert.equal(remoteWithSidecar.sidecarRunning, true)
  const local = byName.get('mesh-node-python-full-with-sidecar')
  assert.equal(local.persistedNodeMode, 'mesh-node')
  assert.equal(local.persistedRuntimeTier, 'python-full')
  assert.equal(local.expectedScope, 'loopback-sidecar')
  assert.equal(local.sidecarRunning, true)
  assert.equal(local.observedConnection, 'this_device')
  assert.equal(local.observedAvailable, true)
  assert.equal(local.startBlockedReasonCode, null)
}

function assertLifecycle(value, turn) {
  assert.equal(value?.turn, turn)
  assert.equal(value?.startObserved, true)
  assert.equal(value?.terminalObserved, true)
  assert.ok(Number.isSafeInteger(value?.eventCount) && value.eventCount > 0)
  assert.ok(Array.isArray(value?.phases))
  assert.ok(value.phases.includes('starting'))
  assert.ok(value.phases.includes('stopping'))
  assert.deepEqual(Object.keys(value).sort(), [
    'eventCount',
    'phases',
    'startObserved',
    'terminalObserved',
    'turn',
  ])
}

function validateGatewayReport(report) {
  assert.equal(report.status, 'passed')
  assert.deepEqual(report.missingRoutes, [])
  assert.ok(
    Number.isSafeInteger(report.requiredRouteHits?.['/api/Orchestrator/Interrupt']) &&
      report.requiredRouteHits['/api/Orchestrator/Interrupt'] > 0,
    'cancelled second turn must reach /api/Orchestrator/Interrupt',
  )
  assert.equal(report.secretsRedacted, true)
}

function fakeInterruptResponse(body) {
  const requestedScopes = normalizeInterruptScopes(body?.scopes)
  const response = {
    interrupt_id: `interrupt-${sha256Hex(JSON.stringify({
      session_id: body?.session_id ?? body?.sessionId ?? null,
      request_id: body?.request_id ?? body?.requestId ?? null,
      requested_scopes: requestedScopes,
      reason: body?.reason ?? 'user_interrupt',
    })).slice(0, 32)}`,
    status: 'cancelled',
    requested_scopes: requestedScopes,
    results: requestedScopes.map((scope) => ({
      scope,
      status: 'cancelled',
      message: '',
      cancelled_count: 1,
    })),
    session_id: normalizeOptionalId(body?.session_id ?? body?.sessionId),
    request_id: normalizeOptionalId(body?.request_id ?? body?.requestId),
    event_topic: 'Orchestrator.Interrupted',
    audit_event: 'orchestrator.interrupt.requested',
    idempotent: true,
    secrets_redacted: true,
  }
  assertValidInterruptResponse(response)
  return response
}

function normalizeInterruptScopes(value) {
  if (!Array.isArray(value)) return Array.from(interruptScopes)
  const scopes = []
  for (const scope of value) {
    if (interruptScopes.has(scope) && !scopes.includes(scope)) scopes.push(scope)
  }
  return scopes.length > 0 ? scopes : Array.from(interruptScopes)
}

function normalizeOptionalId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : null
}

function assertValidInterruptResponse(value) {
  assert.equal(typeof value, 'object')
  assert.equal(typeof value.interrupt_id, 'string', 'interrupt_id is required')
  assert.match(value.interrupt_id, /^.{1,256}$/u, 'interrupt_id is required')
  assert.equal(typeof value.status, 'string', 'status is required')
  assert.match(value.status, /^.{1,64}$/u, 'status is required')
  assert.ok(Array.isArray(value.requested_scopes), 'requested_scopes is required')
  assert.ok(value.requested_scopes.length > 0 && value.requested_scopes.length <= 4)
  for (const scope of value.requested_scopes) assert.ok(interruptScopes.has(scope), `invalid scope ${scope}`)
  assert.ok(Array.isArray(value.results), 'results is required')
  assert.equal(value.results.length, value.requested_scopes.length)
  for (const result of value.results) {
    assert.ok(interruptScopes.has(result?.scope), `invalid result scope ${String(result?.scope)}`)
    assert.ok(interruptStatuses.has(result?.status), `invalid result status ${String(result?.status)}`)
    assert.equal(typeof result.message, 'string')
    assert.ok(result.message.length <= 1000)
    assert.ok(Number.isSafeInteger(result.cancelled_count))
    assert.ok(result.cancelled_count >= 0)
  }
  assert.ok(value.session_id === null || (typeof value.session_id === 'string' && value.session_id.length <= 256))
  assert.ok(value.request_id === null || (typeof value.request_id === 'string' && value.request_id.length <= 256))
  assert.equal(value.event_topic, 'Orchestrator.Interrupted')
  assert.equal(value.audit_event, 'orchestrator.interrupt.requested')
  assert.equal(value.idempotent, true)
  assert.equal(value.secrets_redacted, true)
  assertNoSensitiveMaterial(value, 'fake interrupt response')
}

async function createSession(baseUrl, application) {
  const value = await webdriverRequest(baseUrl, 'POST', '/session', {
    capabilities: {
      alwaysMatch: {
        'tauri:options': { application },
      },
    },
  }, 'create-session')
  const sessionId = value.sessionId ?? value.value?.sessionId
  if (!sessionId) throw new Error('WebDriver did not return a session id')
  return { sessionId }
}

async function setSessionTimeouts(baseUrl, sessionId, scriptTimeoutMs) {
  await webdriverRequest(baseUrl, 'POST', `/session/${encodeURIComponent(sessionId)}/timeouts`, {
    script: scriptTimeoutMs,
  }, 'set-session-timeouts')
}

async function deleteSession(baseUrl, sessionId) {
  await webdriverRequest(baseUrl, 'DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, 'delete-session')
}

async function executeAsyncScript(baseUrl, sessionId, script, scriptArgs = []) {
  const value = await webdriverRequest(
    baseUrl,
    'POST',
    `/session/${encodeURIComponent(sessionId)}/execute/async`,
    { script, args: scriptArgs },
    'execute-async-script',
  )
  return value.value ?? value
}

async function webdriverRequest(baseUrl, method, pathname, body, phase) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((error) => {
    throw new Error(`${phase} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const text = await response.text()
  const payload = text ? JSON.parse(text) : {}
  if (!response.ok) throw new Error(`${phase} failed with ${response.status}: ${text}`)
  return payload.value ?? payload
}

async function waitForApplicationPid(pidFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = (await fs.readFile(pidFile, 'utf8')).trim()
      if (/^[1-9]\d{0,19}$/u.test(value)) return value
    } catch {
      // Wrapper writes this after WebDriver launches the application.
    }
    await sleep(50)
  }
  throw new Error('timed out waiting for the Tauri application PID')
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)
  if (body.length > 2 * 1024 * 1024) throw new Error('request too large')
  return body.length === 0 ? {} : JSON.parse(body.toString('utf8'))
}

function summarizeRequest(request, url, body) {
  const bodyText = body ? JSON.stringify(body) : ''
  const summary = {
    method: request.method,
    path: url.pathname,
    queryKeys: Array.from(url.searchParams.keys()).sort(),
    headerNames: Object.keys(request.headers)
      .filter((name) => ['accept', 'content-type', 'idempotency-key', 'x-request-id'].includes(name.toLowerCase()))
      .sort(),
    bodySha256: sha256Hex(bodyText),
    bodyFieldCount: body && typeof body === 'object' ? Object.keys(body).length : 0,
    safeBodyFieldNames: body && typeof body === 'object'
      ? Object.keys(body).filter((name) => !sensitiveFieldName.test(name)).sort()
      : [],
    bodyByteLength: Buffer.byteLength(bodyText),
  }
  assertNoSensitiveMaterial(summary, 'request summary')
  return summary
}

function sendJson(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function sendSse(response, events) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'close',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.end()
}

function wavPcm16SilenceBase64(sampleRate, samples) {
  const dataBytes = samples * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer.toString('base64')
}

function resolveArtifactDir() {
  return path.resolve(process.env.AURORA_DESKTOP_NATIVE_VOICE_E2E_ARTIFACT_DIR ?? defaultArtifactDir)
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`)
  return value
}

function commandAvailable(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
  })
  return result.status === 0
}

async function fileExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function portAvailable() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address && typeof address !== 'string'))
    })
  })
}

function redactEndpoint(value) {
  return String(value).replace(/\/\/([^:@/]+):([^@/]+)@/u, '//<redacted>@')
}

function sanitize(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer <redacted>')
    .replace(/token["']?\s*[:=]\s*["'][^"']+["']/giu, 'token:<redacted>')
}

function sanitizeHookDiagnostic(value) {
  return sanitize(String(value))
    .replace(/https?:\/\/[^\s"']+/giu, '<redacted-url>')
    .replace(/\b[0-9a-f]{24,}\b/giu, '<redacted-id>')
    .replace(/\b(?:authorization|bearer|token|rawAudio|audioData|audio_data|transcript|leaseId|lease_id|modelPath)\b/giu, '<redacted-field>')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, 512)
}

function assertNoSensitiveMaterial(value, label) {
  const text = JSON.stringify(value)
  if (forbiddenReportText.test(text)) throw new Error(`${label} contains sensitive material`)
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

async function writeJson(file, value) {
  assertNoSensitiveMaterial(value, path.basename(file))
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runSelfTest() {
  assert.equal(wavPcm16SilenceBase64(16_000, 160).length > 0, true)
  assert.equal(await portAvailable(), true)
  assert.equal(redactEndpoint('http://user:pass@127.0.0.1:4444'), 'http://<redacted>@127.0.0.1:4444')
  assert.throws(() => assertNoSensitiveMaterial({ token: 'secret' }, 'fixture'), /sensitive/u)
  const report = {
    schema: 'aurora.desktop_native_voice_e2e.gateway_report.v1',
    status: 'passed',
    missingRoutes: [],
    requiredRouteHits: {
      '/api/STTCoordinator/CapturePrepare': 1,
      '/api/STTCoordinator/CaptureRelease': 1,
      '/api/Transcription/Transcribe': 1,
      '/api/Orchestrator/ExternalUserInput': 1,
      '/api/Orchestrator/Interrupt': 1,
      '/api/TTS/Synthesize': 1,
    },
    secretsRedacted: true,
  }
  validateGatewayReport(report)
  assert.throws(() => validateGatewayReport({ ...report, missingRoutes: ['/api/TTS/Synthesize'] }))
  assert.throws(() =>
    validateGatewayReport({
      ...report,
      requiredRouteHits: { ...report.requiredRouteHits, '/api/Orchestrator/Interrupt': 0 },
    }),
    /Interrupt/u,
  )
  const interrupt = fakeInterruptResponse({
    scopes: ['generation', 'tool_call', 'tts_playback', 'session'],
    session_id: 'native-voice-session',
    request_id: 'native-voice-request',
    reason: 'user_interrupt',
  })
  assertValidInterruptResponse(interrupt)
  assert.deepEqual(interrupt.requested_scopes, ['generation', 'tool_call', 'tts_playback', 'session'])
  assert.throws(() => assertValidInterruptResponse({ status: 'cancelled' }), /interrupt_id/u)
  const launch = nativeVoiceLaunchContract()
  assert.ok(launch.existingWrapperEnv.includes('AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN'))
  assert.ok(launch.existingWrapperEnv.includes('AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE'))
  assert.equal('VITE_AURORA_RUNTIME_MODE' in launch.env, false)
  const script = await fs.readFile(runnerScript, 'utf8')
  assert.match(script, /read_application_pid/u)
  assert.match(script, /wait_for_pid_exit/u)
  assert.match(script, /AURORA_DESKTOP_LIVE_E2E_APPLICATION_BIN/u)
  assert.match(script, /AURORA_DESKTOP_LIVE_E2E_APP_PID_FILE/u)
  assert.match(script, /desktop_native_voice_application\.sh/u)
  assert.match(script, /AURORA_DESKTOP_NATIVE_VOICE_E2E_SIDECAR_PID_FILE/u)
  assert.match(script, /tauri\.desktop-native-voice-e2e\.conf\.json/u)
  assert.doesNotMatch(script, /VITE_AURORA_RUNTIME_MODE/u)
  assert.equal(await fileExists(sidecarSentinelScript), true)
  for (const capability of ['aurora-main.json', 'aurora-thin.json']) {
    const value = JSON.parse(await fs.readFile(
      path.join(repoRoot, 'apps/aurora-tauri/src-tauri/capabilities', capability),
      'utf8',
    ))
    assert.equal(value.permissions.includes('core:window:allow-hide'), false)
  }
  const liveConfig = JSON.parse(await fs.readFile(
    path.join(repoRoot, 'apps/aurora-tauri/src-tauri/tauri.desktop-native-voice-e2e.conf.json'),
    'utf8',
  ))
  assert.equal(
    liveConfig.app.security.capabilities[2].permissions.includes('core:window:allow-hide'),
    true,
  )
  assert.throws(() =>
    validateHookReport({
      schema: 'aurora.desktop_native_voice_e2e.webview_report.v1',
      status: 'passed',
      sessionNonce: 'plain',
      tauriPid: '123',
      secretsRedacted: true,
      noWebViewMicrophone: true,
      noWebViewModelLoads: true,
      noBrowserWorkers: true,
      desktopResult: {
        monotonicStatuses: true,
        distinctGenerations: true,
        windowHidden: true,
        sidecarLoopback: true,
        persistedRoleSource: 'runtime-profile',
        routeScenarios: [
          {
            name: 'remote-console-without-sidecar',
            persistedNodeMode: 'remote-console',
            persistedRuntimeTier: 'none',
            sidecarRunning: false,
            expectedScope: 'remote-gateway',
            observedConnection: 'unavailable',
            observedAvailable: false,
            observedReasonCode: remoteAudioConsentReason,
            startBlockedReasonCode: remoteAudioConsentReason,
            redacted: true,
          },
          {
            name: 'remote-console-with-running-sidecar',
            persistedNodeMode: 'remote-console',
            persistedRuntimeTier: 'none',
            sidecarRunning: true,
            expectedScope: 'remote-gateway',
            observedConnection: 'unavailable',
            observedAvailable: false,
            observedReasonCode: remoteAudioConsentReason,
            startBlockedReasonCode: remoteAudioConsentReason,
            redacted: true,
          },
          {
            name: 'mesh-node-python-full-with-sidecar',
            persistedNodeMode: 'mesh-node',
            persistedRuntimeTier: 'python-full',
            sidecarRunning: true,
            expectedScope: 'loopback-sidecar',
            observedConnection: 'this_device',
            observedAvailable: true,
            observedReasonCode: null,
            startBlockedReasonCode: null,
            redacted: true,
          },
        ],
        forbiddenWebViewCalls: [],
        reportHash: '0'.repeat(64),
        commands: [
          'aurora_secure_storage_get',
          'aurora_secure_storage_set',
          'aurora_secure_storage_delete',
          'aurora_native_voice_status',
          'aurora_native_voice_start',
          'aurora_native_voice_finish',
          'aurora_native_voice_cancel',
        ],
        completedTurn: { turn: 'completed', startObserved: true, terminalObserved: true, eventCount: 1, phases: ['starting', 'stopping'] },
        cancelledTurn: { turn: 'cancelled', startObserved: true, terminalObserved: true, eventCount: 1, phases: ['starting', 'stopping'] },
        statusSequence: [
          { sequence: 1, phase: 'starting', turn: 'completed', redacted: true },
          { sequence: 2, phase: 'stopping', turn: 'completed', redacted: true },
          { sequence: 3, phase: 'starting', turn: 'cancelled', redacted: true },
          { sequence: 4, phase: 'stopping', turn: 'cancelled', redacted: true },
        ],
      },
    }, { sessionNonce: 'nonce', tauriPid: '123' }),
    /sessionNonceDigest/u,
  )
  assert.equal(parseHookEnvelope(JSON.stringify({
    schema: hookEnvelopeSchema,
    result: { status: 'passed' },
  })).status, 'passed')
  console.log('desktop native voice E2E self-test passed')
}

// @vitest-environment node

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acceptanceCommands, buildIsolatedAssistantConfig, cleanupAcceptanceResources, readFixtureReady, stopChild, throwAcceptanceErrors, waitForOwnedStack } from '../scripts/run-android-native-turn-ui-acceptance.mjs'

const root = resolve(__dirname, '..')
const fixturePath = resolve(root, 'scripts/fixture-openai-stream.mjs')

async function startFixture() {
  const child = spawn('node', [fixturePath], {
    env: { ...process.env, AURORA_MODEL_FIXTURE_PORT: '0', AURORA_MODEL_FIXTURE_PAUSE_TIMEOUT_MS: '100' },
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  })
  const baseUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
    let buffer = ''
    const timer = setTimeout(() => rejectPromise(new Error('fixture readiness timeout')), 5_000)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      for (const line of buffer.split(/\r?\n/u)) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.baseUrl) {
            clearTimeout(timer)
            resolvePromise(parsed.baseUrl)
            return
          }
        } catch { /* wait for complete metadata */ }
      }
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => rejectPromise(new Error(`fixture exited: ${code ?? 'unknown'}`)))
  })
  return { child, baseUrl }
}

async function pollUntil<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error('poll timeout')
}

describe('native turn UI acceptance source wiring', () => {
  it('configures the real Python stack with the hosted-peer service boundaries', () => {
    const config = buildIsolatedAssistantConfig({ gatewayPort: 43123, brokerUrl: 'mqtt://broker.test', appId: 'app-test', room: 'room-test', roomPassword: 'secret-for-fixture' })
    expect(config.services.auth.enabled).toBe(true)
    expect(config.services.db.enabled).toBe(true)
    expect(config.services.orchestrator.enabled).toBe(true)
    expect(config.services.tooling.enabled).toBe(true)
    expect(config.services.scheduler.enabled).toBe(false)
    expect(config.services.stt.coordinator.enabled).toBe(false)
    expect(config.services.stt.transcription.enabled).toBe(false)
    expect(config.services.stt.wakeword.enabled).toBe(false)
    expect(config.services.gateway.webrtc).toMatchObject({ strategy: 'mqtt', app_id: 'app-test', room: 'room-test', password: 'secret-for-fixture' })
    expect(acceptanceCommands()).toMatchObject({ modelFixture: ['node', expect.stringContaining('fixture-openai-stream.mjs')], threeNode: ['pnpm', 'android:three-node:live'], voiceTurn: ['pnpm', 'android:voice:live'] })
  })

  it('gates one model request by an exact arm and explicit resume', async () => {
    const fixture = await startFixture()
    const turnId = 'turn-behavior-a'
    try {
      const unarmed = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' })
      expect(unarmed.status).toBe(409)
      expect((await fetch(`${fixture.baseUrl}/__fixture/arm/${turnId}`, { method: 'POST' })).ok).toBe(true)
      const mismatch = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-aurora-acceptance-turn-id': 'turn-behavior-b' }, body: '{}' })
      expect(mismatch.status).toBe(409)
      const response = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-aurora-acceptance-turn-id': turnId }, body: '{}' })
      expect(response.ok).toBe(true)
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(new TextDecoder().decode(first.value)).toContain('Fixture partial response')
      expect((await (await fetch(`${fixture.baseUrl}/__fixture/status/${turnId}`)).json()).pending).toBe(true)
      const duplicate = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-aurora-acceptance-turn-id': turnId }, body: '{}' })
      expect(duplicate.status).toBe(409)
      expect((await fetch(`${fixture.baseUrl}/__fixture/resume/${turnId}`, { method: 'POST' })).ok).toBe(true)
      let stream = ''
      while (!stream.includes('[DONE]')) {
        const next = await reader.read()
        stream += new TextDecoder().decode(next.value)
        if (next.done) break
      }
      expect(stream).toContain('Fixture completed response')
      expect(stream).toContain('[DONE]')
    } finally {
      await stopChild(fixture.child)
    }
  })

  it('fails a paused request closed and removes it after disconnect or timeout', async () => {
    const fixture = await startFixture()
    try {
      const timeoutId = 'turn-behavior-timeout'
      await fetch(`${fixture.baseUrl}/__fixture/arm/${timeoutId}`, { method: 'POST' })
      const timeoutResponse = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-aurora-acceptance-turn-id': timeoutId }, body: '{}' })
      await timeoutResponse.body!.getReader().read()
      const timeoutStatus = await pollUntil(
        async () => await (await fetch(`${fixture.baseUrl}/__fixture/status/${timeoutId}`)).json() as { pending: boolean; completed: boolean },
        (status) => status.pending === false,
      )
      expect(timeoutStatus.completed).toBe(false)

      const disconnectId = 'turn-behavior-disconnect'
      await fetch(`${fixture.baseUrl}/__fixture/arm/${disconnectId}`, { method: 'POST' })
      const controller = new AbortController()
      const disconnectResponse = await fetch(`${fixture.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'x-aurora-acceptance-turn-id': disconnectId }, body: '{}', signal: controller.signal })
      await disconnectResponse.body!.getReader().read()
      controller.abort()
      await pollUntil(
        async () => await (await fetch(`${fixture.baseUrl}/__fixture/status/${disconnectId}`)).json() as { pending: boolean },
        (status) => status.pending === false,
      )
    } finally {
      await stopChild(fixture.child)
    }
  })

  it('requires owned healthy mesh identity before bootstrap continues', async () => {
    const silent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      await expect(readFixtureReady(silent, 50)).rejects.toThrow('readiness metadata')
      expect(silent.stdout.listenerCount('data')).toBe(0)
    } finally {
      await stopChild(silent)
    }
    const malformed = spawn(process.execPath, ['-e', "process.stdout.write('not-json\\n'); setTimeout(() => {}, 10000)"], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    try {
      await expect(readFixtureReady(malformed, 50)).rejects.toThrow('readiness metadata')
    } finally {
      await stopChild(malformed)
    }
    const exited = spawn(process.execPath, ['-e', ''], { stdio: ['ignore', 'pipe', 'ignore'] })
    await expect(readFixtureReady(exited, 500)).rejects.toThrow('exited before readiness')
    const server = createServer((request, response) => {
      expect(request.headers['x-api-key']).toBe('fixture-key')
      expect(request.method).toBe(request.url === '/api/health' ? 'GET' : 'POST')
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/health') return response.end(JSON.stringify({ status: 'healthy', gateway: 'up' }))
      if (request.url === '/api/Gateway/GetMeshStatus') return response.end(JSON.stringify({ local: { mesh_started: true, webrtc_started: true, node_name: 'owned-node' } }))
      response.end(JSON.stringify({ app_id: 'owned-app', room: 'owned-room' }))
    })
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address() as { port: number }
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => {}, 10000)"], { detached: true, stdio: 'ignore' })
    try {
      await expect(waitForOwnedStack({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-key', expectedNodeName: 'owned-node', expectedAppId: 'owned-app', expectedRoom: 'owned-room', child, timeoutMs: 1_000 })).resolves.toMatchObject({ mesh: { local: { node_name: 'owned-node' } } })
    } finally {
      await stopChild(child)
      expect(child.exitCode ?? child.signalCode).not.toBeNull()
      await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()))
    }
  })

  it('refuses to report cleanup success for a child that remains live after escalation', async () => {
    const liveChild: any = { pid: undefined, exitCode: null, signalCode: null, kill: () => true, once: () => liveChild }
    await expect(stopChild(liveChild, { graceMs: 10 })).rejects.toThrow('refusing temporary-data deletion')
  })

  it('retains body and both cleanup failures as independent causes', async () => {
    const bodyFailure = new Error('body failure')
    const cleanupErrors = await cleanupAcceptanceResources({
      python: { kind: 'python' },
      fixture: { kind: 'fixture' },
      configDir: 'owned-temp',
      stop: async (child: { kind: string }) => { throw new Error(`${child.kind} cleanup failure`) },
      remove: () => { throw new Error('config removal failure') },
    })
    try {
      throwAcceptanceErrors(bodyFailure, cleanupErrors)
      throw new Error('expected aggregate failure')
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.map((cause) => (cause as Error).message)).toEqual([
        'body failure',
        'python cleanup failure',
        'fixture cleanup failure',
      ])
    }
  })
})

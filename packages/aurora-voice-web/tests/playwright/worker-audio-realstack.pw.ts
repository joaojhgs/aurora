import { expect, test } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, relative, sep } from 'node:path'

const repoRoot = normalize(join(import.meta.dirname, '..', '..', '..', '..'))
const packageRoot = join(repoRoot, 'packages', 'aurora-voice-web')
const nodeFsPromises = import('node:fs/promises')

let server: Server
let baseUrl: string
const serverRequestedPaths = new Set<string>()

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    serverRequestedPaths.add(pathname)
    if (pathname === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end('<!doctype html><meta charset="utf-8"><title>Aurora real browser audio gate</title>')
      return
    }

    const filePath = normalize(join(packageRoot, pathname))
    const rel = relative(packageRoot, filePath)
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      response.writeHead(403)
      response.end()
      return
    }

    try {
      const body = await (await nodeFsPromises).readFile(filePath)
      response.writeHead(200, {
        'content-type': contentType(filePath),
        'cache-control': 'no-store'
      })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('real browser audio server did not expose a TCP port'))
        return
      }
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
})

test('foreground click drives native browser capture through production Worker and WASM', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'evidence-boundary',
    description: 'Uses Chromium fake media through native getUserMedia (wrapped only to count calls and inspect track cleanup), AudioContext, AudioWorklet, production Worker, and generated WASM. Mobile coverage is Playwright emulation, not Android device, physical microphone, or OS prompt coverage.'
  })
  const requestedPaths = new Set<string>()
  serverRequestedPaths.clear()
  page.on('request', (request) => requestedPaths.add(new URL(request.url()).pathname))
  await page.goto(baseUrl)
  await page.addScriptTag({ type: 'module', content: realAudioHarnessModule() })
  await page.getByRole('button', { name: 'Run foreground voice' }).click()

  const result = await page.evaluate(async () => window.__auroraRealAudioGate.completion)

  expect(result.permission).toBe('granted')
  expect(result.getUserMediaCalls).toBe(2)
  expect(result.first.session).toMatchObject({
    ownerId: 'real-browser-audio',
    sessionId: 'real-browser-audio:1',
    generation: 1,
    foregroundOnly: true
  })
  expect(result.first.activeSnapshot).toMatchObject({ state: 'active', generation: 1 })
  expect(result.first.audio).toMatchObject({
    sessionId: 'real-browser-audio:1',
    generation: 1,
    sampleRateHz: 16_000,
    channels: 1,
    redacted: true
  })
  expect(result.first.audio.sampleCount).toBeGreaterThan(0)
  expect(result.first.audio.durationMs).toBeGreaterThan(0)
  expect(result.first.trackStatesBeforeStop).toEqual(['live'])
  expect(result.first.trackStatesAfterStop).toEqual(['ended'])
  expect(result.first.stoppedSnapshot).toMatchObject({ state: 'stopped', generation: 1 })
  expect(result.first.completedSnapshot).toMatchObject({ state: 'idle', sessionId: null, generation: 1 })

  expect(result.second.session).toMatchObject({ sessionId: 'real-browser-audio:2', generation: 2 })
  expect(result.second.audio.sampleCount).toBeGreaterThan(0)
  expect(result.second.trackStatesAfterStop).toEqual(['ended'])
  expect(result.finalSnapshot).toMatchObject({ state: 'idle', sessionId: null, generation: 2, queuedBytes: 0 })
  expect(result.eventKinds.filter((kind) => kind === 'session_started')).toHaveLength(2)
  expect(result.eventKinds.filter((kind) => kind === 'session_stopped')).toHaveLength(2)
  expect(result.eventKinds.filter((kind) => kind === 'frame_accepted').length).toBeGreaterThanOrEqual(4)
  expect(result.eventsRedacted).toBe(true)

  expect(requestedPaths).toContain('/dist/browser.js')
  expect(serverRequestedPaths).toContain('/dist/audio-worklet-processor.js')
  expect(serverRequestedPaths).toContain('/dist/voice-worker.js')
  expect(serverRequestedPaths).toContain('/dist/wasm/aurora_voice_wasm_bg.wasm')
})

function realAudioHarnessModule(): string {
  return `
    import { createAuroraBrowserVoiceRuntime } from '/dist/browser.js';

    const button = document.createElement('button');
    button.textContent = 'Run foreground voice';
    document.body.append(button);

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    window.__auroraRealAudioGate = { completion };

    button.addEventListener('click', () => {
      run().then(resolveCompletion, rejectCompletion);
    }, { once: true });

    async function run() {
      const mediaDevices = navigator.mediaDevices;
      const originalDescriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
      const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
      const streams = [];
      let getUserMediaCalls = 0;
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async (constraints) => {
          getUserMediaCalls += 1;
          const stream = await nativeGetUserMedia(constraints);
          streams.push(stream);
          return stream;
        }
      });

      const runtime = createAuroraBrowserVoiceRuntime({ ownerId: 'real-browser-audio' });
      const events = [];
      runtime.onEvent((event) => events.push(event));
      try {
        const permission = navigator.permissions === undefined
          ? 'unavailable'
          : (await navigator.permissions.query({ name: 'microphone' })).state;
        const first = await runTurn(runtime, streams, events, 2);
        const second = await runTurn(runtime, streams, events, 4);
        const finalSnapshot = runtime.snapshot();
        await runtime.dispose();
        return {
          permission,
          getUserMediaCalls,
          first,
          second,
          finalSnapshot,
          eventKinds: events.map((event) => event.kind),
          eventsRedacted: events.every((event) => event.redacted === true)
        };
      } finally {
        await runtime.dispose().catch(() => undefined);
        if (originalDescriptor === undefined) {
          delete mediaDevices.getUserMedia;
        } else {
          Object.defineProperty(mediaDevices, 'getUserMedia', originalDescriptor);
        }
      }
    }

    async function runTurn(runtime, streams, events, acceptedTarget) {
      const session = await runtime.start();
      await waitFor(() => events.filter((event) => event.kind === 'frame_accepted').length >= acceptedTarget);
      const activeSnapshot = runtime.snapshot();
      const stream = streams.at(-1);
      const trackStatesBeforeStop = stream?.getAudioTracks().map((track) => track.readyState) ?? [];
      const captured = await runtime.stop();
      const stoppedSnapshot = runtime.snapshot();
      const trackStatesAfterStop = stream?.getAudioTracks().map((track) => track.readyState) ?? [];
      await runtime.completeTurn();
      return {
        session,
        activeSnapshot,
        stoppedSnapshot,
        completedSnapshot: runtime.snapshot(),
        trackStatesBeforeStop,
        trackStatesAfterStop,
        audio: {
          sessionId: captured?.sessionId ?? null,
          generation: captured?.generation ?? null,
          sampleRateHz: captured?.sampleRateHz ?? null,
          channels: captured?.channels ?? null,
          sampleCount: captured?.sampleCount ?? null,
          durationMs: captured?.durationMs ?? null,
          redacted: captured?.redacted ?? null
        }
      };
    }

    async function waitFor(predicate) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('native browser audio did not produce acknowledged frames');
    }
  `
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.html':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

interface RealAudioTurnResult {
  readonly session: {
    readonly ownerId: string
    readonly sessionId: string
    readonly generation: number
    readonly foregroundOnly: true
  }
  readonly activeSnapshot: Record<string, unknown>
  readonly stoppedSnapshot: Record<string, unknown>
  readonly completedSnapshot: Record<string, unknown>
  readonly trackStatesBeforeStop: readonly MediaStreamTrackState[]
  readonly trackStatesAfterStop: readonly MediaStreamTrackState[]
  readonly audio: {
    readonly sessionId: string | null
    readonly generation: number | null
    readonly sampleRateHz: number | null
    readonly channels: number | null
    readonly sampleCount: number
    readonly durationMs: number
    readonly redacted: true | null
  }
}

declare global {
  interface Window {
    __auroraRealAudioGate: {
      readonly completion: Promise<{
        readonly permission: PermissionState | 'unavailable'
        readonly getUserMediaCalls: number
        readonly first: RealAudioTurnResult
        readonly second: RealAudioTurnResult
        readonly finalSnapshot: Record<string, unknown>
        readonly eventKinds: readonly string[]
        readonly eventsRedacted: boolean
      }>
    }
  }
}

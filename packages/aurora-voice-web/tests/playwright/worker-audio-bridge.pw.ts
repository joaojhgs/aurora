import { expect, test, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, relative, sep } from 'node:path'

const repoRoot = normalize(join(import.meta.dirname, '..', '..', '..', '..'))
const packageRoot = join(repoRoot, 'packages', 'aurora-voice-web')
const forbiddenArtifactExtensions = new Set(['.onnx', '.gguf', '.bin', '.safetensors', '.pt', '.pth', '.tflite', '.wav', '.flac', '.mp3'])
const maxWasmCoreBytes = 145 * 1024
const maxWasmLoaderBytes = 48 * 1024
const nodeFsPromises = import('node:fs/promises').then((module) => module as unknown as NodeFsPromises)

let server: Server
let baseUrl: string

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname

    if (pathname === '/index.html') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      })
      response.end('<!doctype html><meta charset="utf-8"><title>Aurora voice Worker audio bridge</title>')
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
        reject(new Error('worker audio bridge server did not expose a TCP port'))
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

test.beforeEach(async ({ page }) => {
  await page.goto(baseUrl)
})

test('production module Worker uses generated Rust/WASM facade for start frame stop complete repeat', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'bridge-boundary',
    description: 'Runs the production browser facade with its default module Worker; no injected worker or WASM bridge is used.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    const harness = await window.__auroraWorkerAudioBridge.createRuntime('browser-worker-complete')

    const first = await harness.start()
    await harness.push([100, -100, 200, -200])
    await harness.push([321, -321])
    const firstAudio = await harness.stop()
    const stoppedSnapshot = harness.snapshot()
    await harness.complete()
    const completedSnapshot = harness.snapshot()

    const second = await harness.start()
    await harness.push([7, 8, 9])
    const secondAudio = await harness.stop()
    await harness.complete()

    return {
      first,
      firstAudio: audioReport(firstAudio),
      stoppedSnapshot,
      completedSnapshot,
      second,
      secondAudio: audioReport(secondAudio),
      finalSnapshot: harness.snapshot(),
      events: harness.events()
    }

    function audioReport(audio: BrowserCapturedAudio | null) {
      return {
        sessionId: audio?.sessionId ?? null,
        generation: audio?.generation ?? null,
        sampleRateHz: audio?.sampleRateHz ?? null,
        channels: audio?.channels ?? null,
        sampleCount: audio?.sampleCount ?? null,
        durationMs: audio?.durationMs ?? null,
        pcm: Array.from(audio?.pcm ?? []),
        redacted: audio?.redacted ?? null
      }
    }
  })

  expect(result.first).toMatchObject({ ownerId: 'browser-worker-complete', sessionId: 'browser-worker-complete:1', generation: 1, foregroundOnly: true })
  expect(result.firstAudio).toMatchObject({
    sessionId: 'browser-worker-complete:1',
    generation: 1,
    sampleRateHz: 16_000,
    channels: 1,
    sampleCount: 6,
    pcm: [100, -100, 200, -200, 321, -321],
    redacted: true
  })
  expect(result.stoppedSnapshot).toMatchObject({ state: 'stopped', sessionId: 'browser-worker-complete:1', generation: 1 })
  expect(result.completedSnapshot).toMatchObject({ state: 'idle', sessionId: null, generation: 1 })
  expect(result.second).toMatchObject({ sessionId: 'browser-worker-complete:2', generation: 2 })
  expect(result.secondAudio).toMatchObject({ sessionId: 'browser-worker-complete:2', generation: 2, sampleCount: 3, pcm: [7, 8, 9], redacted: true })
  expect(result.finalSnapshot).toMatchObject({ state: 'idle', sessionId: null, generation: 2, queuedBytes: 0 })
  expect(result.events.map((event) => event.kind)).toEqual([
    'session_started',
    'frame_accepted',
    'frame_accepted',
    'session_stopped',
    'session_started',
    'frame_accepted',
    'session_stopped'
  ])
  expect(result.events.every((event) => event.redacted === true)).toBe(true)
  expect(redactedEventJson(result.events)).not.toMatch(/321|-321|transcript|secret|pcm|pointer/i)
})

test('production module Worker uses generated Rust/WASM facade for abandon repeat', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'bridge-boundary',
    description: 'Exercises the stopped-turn abandon path through the production Worker/WASM facade, then proves a new turn can start.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    const harness = await window.__auroraWorkerAudioBridge.createRuntime('browser-worker-abandon')
    const first = await harness.start()
    await harness.push([1, 2, 3, 4])
    const firstAudio = await harness.stop()
    await harness.abandon()
    const abandonedSnapshot = harness.snapshot()

    const second = await harness.start()
    await harness.push([5, 6])
    const secondAudio = await harness.stop()
    await harness.complete()

    return {
      first,
      firstAudio: { sampleCount: firstAudio?.sampleCount ?? null, redacted: firstAudio?.redacted ?? null },
      abandonedSnapshot,
      second,
      secondAudio: { sampleCount: secondAudio?.sampleCount ?? null, redacted: secondAudio?.redacted ?? null },
      finalSnapshot: harness.snapshot(),
      events: harness.events()
    }
  })

  expect(result.first).toMatchObject({ sessionId: 'browser-worker-abandon:1', generation: 1 })
  expect(result.firstAudio).toEqual({ sampleCount: 4, redacted: true })
  expect(result.abandonedSnapshot).toMatchObject({ state: 'cancelled', sessionId: null, generation: 1 })
  expect(result.second).toMatchObject({ sessionId: 'browser-worker-abandon:2', generation: 2 })
  expect(result.secondAudio).toEqual({ sampleCount: 2, redacted: true })
  expect(result.finalSnapshot).toMatchObject({ state: 'idle', sessionId: null, generation: 2 })
  expect(result.events.every((event) => event.redacted === true)).toBe(true)
})

test('production snapshots keep capabilities false and payload details redacted', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'privacy-boundary',
    description: 'Runtime snapshots and event objects are inspected; raw audio is only checked on the explicit capturedAudio return value.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    const harness = await window.__auroraWorkerAudioBridge.createRuntime('browser-worker-redacted')
    const before = harness.snapshot()
    await harness.start()
    await harness.push([12345, -12345])
    const during = harness.snapshot()
    const audio = await harness.stop()
    const stopped = harness.snapshot()
    await harness.complete()
    return {
      snapshots: [before, during, stopped, harness.snapshot()],
      events: harness.events(),
      captured: {
        sampleCount: audio?.sampleCount ?? null,
        redacted: audio?.redacted ?? null
      }
    }
  })

  for (const snapshot of result.snapshots) {
    expect(snapshot.capabilities).toEqual({ vad: false, kws: false, stt: false, tts: false })
    expect(snapshot.lifecycle).toMatchObject({ foregroundOnly: true, visible: true, frozen: false, eligible: true })
    expect(snapshot).not.toHaveProperty('pcm')
    expect(snapshot).not.toHaveProperty('transcript')
  }
  expect(result.captured).toEqual({ sampleCount: 2, redacted: true })
  expect(redactedEventJson(result.events)).not.toMatch(/12345|-12345|transcript|secret|pcm|pointer/i)
})

test('built production artifacts contain no model payloads and stay under browser weight gates', async () => {
  const wasmDir = join(packageRoot, 'dist', 'wasm')
  const files = await listFiles(wasmDir)
  const relativeFiles = files.map((file) => relative(wasmDir, file).replaceAll(sep, '/')).sort()

  expect(relativeFiles).toEqual([
    'aurora_voice_wasm.d.ts',
    'aurora_voice_wasm.js',
    'aurora_voice_wasm_bg.wasm',
    'aurora_voice_wasm_bg.wasm.d.ts'
  ])

  for (const file of files) {
    const info = await (await nodeFsPromises).stat(file)
    const name = relative(wasmDir, file)
    expect(info.size, `${name} must not be empty`).toBeGreaterThan(0)
    expect(forbiddenArtifactExtensions.has(extname(name)), `${name} must not be a model/audio artifact`).toBe(false)
    if (name.endsWith('.wasm')) expect(info.size, `${name} wasm core size`).toBeLessThanOrEqual(maxWasmCoreBytes)
    if (name.endsWith('.js')) expect(info.size, `${name} wasm loader size`).toBeLessThanOrEqual(maxWasmLoaderBytes)
  }
})

test('deterministic production BrowserAudioWorklet source releases capture on cancel and lifecycle loss without device-permission claim', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'audio-boundary',
    description: 'Uses production BrowserAudioWorkletPcmSource with injected browser-like MediaStream/AudioContext/WorkletNode resources so every desktop and emulated project runs without permission prompts or skips.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    return window.__auroraWorkerAudioBridge.runAudioWorkletLifecycleProbe()
  })

  expect(result.cancel.releaseMs).toBeLessThanOrEqual(250)
  expect(result.cancel.trackStopped).toBe(true)
  expect(result.cancel.contextClosed).toBe(true)
  expect(result.cancel.portClosed).toBe(true)
  expect(result.cancel.frames).toHaveLength(0)
  expect(result.lifecycle.releaseMs).toBeLessThanOrEqual(250)
  expect(result.lifecycle.reasons).toEqual(['track_ended'])
  expect(result.lifecycle.trackStopped).toBe(true)
  expect(result.lifecycle.contextClosed).toBe(true)
  expect(result.lifecycle.portClosed).toBe(true)
})

test('production browser lifecycle cancels page-hidden and frozen sessions without automatic restart', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'page-lifecycle-boundary',
    description: 'Uses the production browser lifecycle adapter and Worker/WASM runtime with synthetic page lifecycle signals; it does not claim browser background execution.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    const harness = await window.__auroraWorkerAudioBridge.createRuntime('browser-page-lifecycle')
    const waitForState = async (state: 'cancelled') => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (harness.snapshot().state === state) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`voice runtime did not reach ${state}`)
    }

    const first = await harness.start()
    window.dispatchEvent(new Event('pagehide'))
    await waitForState('cancelled')
    const hidden = harness.snapshot()

    window.dispatchEvent(new Event('pageshow'))
    const restoredWithoutRestart = harness.snapshot()
    const second = await harness.start()
    document.dispatchEvent(new Event('freeze'))
    await waitForState('cancelled')
    const frozen = harness.snapshot()

    document.dispatchEvent(new Event('resume'))
    const resumedWithoutRestart = harness.snapshot()
    await harness.dispose()
    return {
      first,
      second,
      hidden,
      restoredWithoutRestart,
      frozen,
      resumedWithoutRestart,
      cancelled: harness.cancelled(),
      events: harness.events()
    }
  })

  expect(result.first).toMatchObject({ generation: 1 })
  expect(result.second).toMatchObject({ generation: 2 })
  expect(result.hidden).toMatchObject({ state: 'cancelled', sessionId: null, lifecycle: { reason: 'pagehide', eligible: false } })
  expect(result.restoredWithoutRestart).toMatchObject({ state: 'cancelled', sessionId: null, lifecycle: { reason: 'visible', eligible: true } })
  expect(result.frozen).toMatchObject({ state: 'cancelled', sessionId: null, lifecycle: { reason: 'frozen', eligible: false } })
  expect(result.resumedWithoutRestart).toMatchObject({ state: 'cancelled', sessionId: null, lifecycle: { reason: 'visible', eligible: true } })
  expect(result.cancelled).toEqual(['browser-page-lifecycle:1', 'browser-page-lifecycle:2'])
  expect(result.events.filter((event) => event.kind === 'lifecycle_lost').map((event) => event.reason)).toEqual(['pagehide', 'frozen'])
  expect(result.events.every((event) => event.redacted === true)).toBe(true)
})

test('production Worker/WASM bridge keeps main-thread timer and computed long-task p95 under 50 ms', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'responsiveness-boundary',
    description: 'The portable p95 is computed from event-loop timer drift; native PerformanceObserver longtask entries are also reported when a browser exposes them.'
  })
  await installVoiceHarness(page)

  const result = await page.evaluate(async () => {
    const monitor = window.__auroraWorkerAudioBridge.createResponsivenessMonitor()
    const harness = await window.__auroraWorkerAudioBridge.createRuntime('browser-worker-responsive')
    await monitor.run(async () => {
      await harness.start()
      for (let sequence = 0; sequence < 48; sequence += 1) {
        await harness.push([sequence, -sequence, sequence + 1, -sequence - 1])
      }
      await harness.stop()
      await harness.complete()
    })
    return {
      metrics: monitor.metrics(),
      finalSnapshot: harness.snapshot()
    }
  })

  expect(result.finalSnapshot).toMatchObject({ state: 'idle', queuedBytes: 0 })
  expect(result.metrics.sampleCount).toBeGreaterThanOrEqual(8)
  expect(result.metrics.timerP95Ms).toBeLessThanOrEqual(50)
  expect(result.metrics.computedLongTaskP95Ms).toBeLessThanOrEqual(50)
  if (result.metrics.observedLongTaskP95Ms !== null) {
    expect(result.metrics.observedLongTaskP95Ms).toBeLessThanOrEqual(50)
  }
})

async function installVoiceHarness(page: Page): Promise<void> {
  await page.addScriptTag({ type: 'module', content: voiceHarnessModule() })
  await page.waitForFunction(() => window.__auroraWorkerAudioBridge !== undefined)
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await (await nodeFsPromises).readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry: DirEntry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  }))
  return nested.flat()
}

interface NodeFsPromises {
  readFile(path: string): Promise<Uint8Array>
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<readonly DirEntry[]>
  stat(path: string): Promise<{ readonly size: number }>
}

interface DirEntry {
  readonly name: string
  isDirectory(): boolean
}

interface BrowserCapturedAudio {
  readonly sessionId: string
  readonly generation: number
  readonly sampleRateHz: 16_000
  readonly channels: 1
  readonly sampleCount: number
  readonly durationMs: number
  readonly pcm: Int16Array
  readonly redacted: true
}

function voiceHarnessModule(): string {
  return `
    import { createAuroraBrowserVoiceRuntime, BrowserAudioWorkletPcmSource } from '/dist/browser.js';

    class ControlledPcmSource {
      constructor() {
        this.session = null;
        this.sink = null;
        this.sequence = 0;
        this.cancelled = [];
        this.stopped = [];
      }

      async start(session, sink) {
        this.session = session;
        this.sink = sink;
        this.sequence = 0;
      }

      async stop(sessionId) {
        this.stopped.push(sessionId);
      }

      async cancel(sessionId) {
        this.cancelled.push(sessionId);
      }

      async push(samples, options = {}) {
        if (this.session === null || this.sink === null) throw new Error('source not active');
        const pcm = Int16Array.from(samples);
        const accepted = await this.sink.pushFrame({
          sessionId: this.session.sessionId,
          generation: this.session.generation,
          sequence: this.sequence,
          discontinuity: options.discontinuity === true,
          sampleRateHz: 16000,
          channels: 1,
          pcm
        });
        this.sequence += 1;
        return accepted;
      }
    }

    window.__auroraWorkerAudioBridge = {
      createRuntime,
      runAudioWorkletLifecycleProbe,
      createResponsivenessMonitor
    };

    async function createRuntime(ownerId) {
      const source = new ControlledPcmSource();
      const events = [];
      const runtime = createAuroraBrowserVoiceRuntime({
        ownerId,
        pcmSource: source,
        workerTimeoutMs: 10000,
        sessionIdFactory: (runtimeOwnerId, generation) => runtimeOwnerId + ':' + generation
      });
      runtime.onEvent((event) => events.push({ ...event }));
      return {
        start: () => runtime.start(),
        push: (samples, options) => source.push(samples, options),
        stop: () => runtime.stop(),
        complete: () => runtime.completeTurn(),
        abandon: () => runtime.abandonTurn(),
        cancel: (reason) => runtime.cancel(reason),
        dispose: () => runtime.dispose(),
        cancelled: () => [...source.cancelled],
        snapshot: () => runtime.snapshot(),
        events: () => events.map((event) => ({ ...event }))
      };
    }

    async function runAudioWorkletLifecycleProbe() {
      const cancelPorts = new FakeBrowserPorts();
      const cancelSink = new RecordingSink();
      const cancelSource = new BrowserAudioWorkletPcmSource(cancelPorts.options());
      await cancelSource.start(session('audio-cancel'), cancelSink);
      cancelPorts.postFromWorklet({ type: 'audio', sessionId: 'audio-cancel', sampleRateHz: 48000, samples: constant(480, 0.25) });
      const cancelStartedAt = performance.now();
      await cancelSource.cancel('audio-cancel');

      const lifecyclePorts = new FakeBrowserPorts();
      const lifecycleSink = new RecordingSink();
      const reasons = [];
      const lifecycleSource = new BrowserAudioWorkletPcmSource(lifecyclePorts.options({
        onLifecycleLost: (reason) => reasons.push(reason)
      }));
      await lifecycleSource.start(session('audio-lifecycle'), lifecycleSink);
      const lifecycleStartedAt = performance.now();
      lifecyclePorts.stream.track.end();
      await waitFor(() => lifecyclePorts.trackStopped && lifecyclePorts.contextClosed && lifecyclePorts.portClosed);

      return {
        cancel: {
          releaseMs: cancelPorts.releaseMs(cancelStartedAt),
          trackStopped: cancelPorts.trackStopped,
          contextClosed: cancelPorts.contextClosed,
          portClosed: cancelPorts.portClosed,
          frames: cancelSink.frames.map((frame) => ({ sequence: frame.sequence, sampleCount: frame.pcm.length }))
        },
        lifecycle: {
          releaseMs: lifecyclePorts.releaseMs(lifecycleStartedAt),
          reasons,
          trackStopped: lifecyclePorts.trackStopped,
          contextClosed: lifecyclePorts.contextClosed,
          portClosed: lifecyclePorts.portClosed,
          frames: lifecycleSink.frames.map((frame) => ({ sequence: frame.sequence, sampleCount: frame.pcm.length }))
        }
      };
    }

    function createResponsivenessMonitor() {
      const timerDeltas = [];
      const observedLongTasks = [];
      let observer = null;
      let running = false;
      let timeout = 0;

      if (typeof PerformanceObserver === 'function') {
        try {
          observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) observedLongTasks.push(entry.duration);
          });
          observer.observe({ entryTypes: ['longtask'] });
        } catch {
          observer = null;
        }
      }

      const tick = () => {
        if (!running) return;
        const started = performance.now();
        timeout = setTimeout(() => {
          timerDeltas.push(Math.max(0, performance.now() - started));
          tick();
        }, 0);
      };

      return {
        async run(operation) {
          running = true;
          tick();
          try {
            await operation();
            await delay(32);
          } finally {
            running = false;
            clearTimeout(timeout);
            observer?.disconnect();
          }
        },
        metrics() {
          const computedLongTasks = timerDeltas.filter((value) => value >= 50);
          return {
            sampleCount: timerDeltas.length,
            timerP95Ms: percentile(timerDeltas, 0.95),
            computedLongTaskP95Ms: computedLongTasks.length === 0 ? 0 : percentile(computedLongTasks, 0.95),
            observedLongTaskP95Ms: observedLongTasks.length === 0 ? null : percentile(observedLongTasks, 0.95)
          };
        }
      };
    }

    class RecordingSink {
      constructor() {
        this.frames = [];
      }

      async pushFrame(frame) {
        this.frames.push({ ...frame, pcm: new Int16Array(frame.pcm) });
        return true;
      }
    }

    class FakeBrowserPorts {
      constructor() {
        this.trackStoppedAt = null;
        this.contextClosedAt = null;
        this.portClosedAt = null;
        this.sourceDisconnected = false;
        this.nodeDisconnected = false;
        this.stream = { track: new FakeMediaStreamTrack((at) => { this.trackStoppedAt = at; }) };
        this.context = new FakeAudioContext((at) => { this.contextClosedAt = at; }, () => { this.sourceDisconnected = true; });
        this.workletNode = new FakeWorkletNode((at) => { this.portClosedAt = at; }, () => { this.nodeDisconnected = true; });
      }

      get trackStopped() {
        return this.trackStoppedAt !== null;
      }

      get contextClosed() {
        return this.contextClosedAt !== null;
      }

      get portClosed() {
        return this.portClosedAt !== null;
      }

      options(overrides = {}) {
        return {
          mediaDevices: {
            getUserMedia: async () => ({ getTracks: () => [this.stream.track] })
          },
          audioContextFactory: () => this.context,
          workletNodeFactory: () => this.workletNode,
          processorUrl: '/dist/audio-worklet-processor.js',
          ...overrides
        };
      }

      postFromWorklet(message) {
        this.workletNode.port.emit(message);
      }

      releaseMs(startedAt) {
        return Math.max(
          this.trackStoppedAt ?? startedAt,
          this.contextClosedAt ?? startedAt,
          this.portClosedAt ?? startedAt
        ) - startedAt;
      }
    }

    class FakeMediaStreamTrack {
      constructor(onStop) {
        this.onStop = onStop;
        this.ended = new Set();
        this.stopped = false;
      }

      addEventListener(type, listener) {
        if (type === 'ended') this.ended.add(listener);
      }

      removeEventListener(type, listener) {
        if (type === 'ended') this.ended.delete(listener);
      }

      stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.onStop(performance.now());
      }

      end() {
        for (const listener of [...this.ended]) listener();
      }
    }

    class FakeAudioContext {
      constructor(onClose, onSourceDisconnect) {
        this.sampleRate = 48000;
        this.state = 'running';
        this.onClose = onClose;
        this.onSourceDisconnect = onSourceDisconnect;
        this.audioWorklet = { addModule: async () => undefined };
      }

      createMediaStreamSource() {
        return {
          connect: (destination) => destination,
          disconnect: () => this.onSourceDisconnect()
        };
      }

      async close() {
        this.state = 'closed';
        this.onClose(performance.now());
      }
    }

    class FakeWorkletNode {
      constructor(onClose, onDisconnect) {
        this.onDisconnect = onDisconnect;
        this.port = new FakeMessagePort(onClose);
      }

      disconnect() {
        this.onDisconnect();
      }
    }

    class FakeMessagePort {
      constructor(onClose) {
        this.onmessage = null;
        this.onClose = onClose;
        this.closed = false;
      }

      postMessage(message) {
        if (message?.type === 'stop' || message?.type === 'cancel') {
          const type = message.type === 'stop' ? 'stopped' : 'cancelled';
          queueMicrotask(() => this.emit({ type, requestId: message.requestId }));
        }
      }

      emit(data) {
        this.onmessage?.({ data });
      }

      close() {
        if (this.closed) return;
        this.closed = true;
        this.onClose(performance.now());
      }
    }

    function session(sessionId) {
      return Object.freeze({
        ownerId: 'browser-audio',
        sessionId,
        generation: 1,
        startedAtMs: performance.now(),
        foregroundOnly: true
      });
    }

    function constant(length, value) {
      return new Float32Array(length).fill(value);
    }

    async function waitFor(predicate) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await delay(5);
      }
      throw new Error('condition was not reached');
    }

    async function delay(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    function percentile(values, fraction) {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
      return sorted[index];
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

function redactedEventJson<T extends { readonly occurredAtMs: number }>(events: readonly T[]): string {
  return JSON.stringify(events.map(({ occurredAtMs: _occurredAtMs, ...event }) => event))
}

declare global {
  interface Window {
    __auroraWorkerAudioBridge: {
      createRuntime(ownerId: string): Promise<{
        start(): Promise<{
          readonly ownerId: string
          readonly sessionId: string
          readonly generation: number
          readonly startedAtMs: number
          readonly foregroundOnly: true
        }>
        push(samples: readonly number[], options?: { readonly discontinuity?: boolean }): Promise<boolean>
        stop(): Promise<{
          readonly sessionId: string
          readonly generation: number
          readonly sampleRateHz: 16_000
          readonly channels: 1
          readonly sampleCount: number
          readonly durationMs: number
          readonly pcm: Int16Array
          readonly redacted: true
        } | null>
        complete(): Promise<void>
        abandon(): Promise<void>
        cancel(reason?: string): Promise<void>
        dispose(): Promise<void>
        cancelled(): string[]
        snapshot(): {
          readonly ownerId: string
          readonly state: 'idle' | 'active' | 'cancelled' | 'stopped'
          readonly sessionId: string | null
          readonly generation: number
          readonly nextSequence: number
          readonly queuedBytes: number
          readonly capabilities: { readonly vad: boolean; readonly kws: boolean; readonly stt: boolean; readonly tts: boolean }
          readonly lifecycle: { readonly foregroundOnly: true; readonly visible: boolean; readonly frozen: boolean; readonly eligible: boolean; readonly reason: string }
        }
        events(): Array<{
          readonly kind: string
          readonly ownerId: string
          readonly sessionId: string | null
          readonly generation: number
          readonly sequence: number | null
          readonly sampleCount: number
          readonly byteLength: number
          readonly queuedBytes: number
          readonly reason: string | null
          readonly redacted: true
          readonly occurredAtMs: number
        }>
      }>
      runAudioWorkletLifecycleProbe(): Promise<{
        readonly cancel: {
          readonly releaseMs: number
          readonly trackStopped: boolean
          readonly contextClosed: boolean
          readonly portClosed: boolean
          readonly frames: Array<{ readonly sequence: number; readonly sampleCount: number }>
        }
        readonly lifecycle: {
          readonly releaseMs: number
          readonly reasons: readonly string[]
          readonly trackStopped: boolean
          readonly contextClosed: boolean
          readonly portClosed: boolean
          readonly frames: Array<{ readonly sequence: number; readonly sampleCount: number }>
        }
      }>
      createResponsivenessMonitor(): {
        run(operation: () => Promise<void>): Promise<void>
        metrics(): {
          readonly sampleCount: number
          readonly timerP95Ms: number
          readonly computedLongTaskP95Ms: number
          readonly observedLongTaskP95Ms: number | null
        }
      }
    }
  }
}

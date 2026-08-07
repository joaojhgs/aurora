const browser = await import('/dist/browser.js')
const { createAuroraBrowserVoiceRuntime } = browser

class ControlledPcmSource {
  constructor() {
    this.session = null
    this.sink = null
    this.sequence = 0
  }

  async start(session, sink) {
    this.session = session
    this.sink = sink
    this.sequence = 0
  }

  async stop(_sessionId) {}

  async cancel(_sessionId) {}

  async push(samples, options = {}) {
    if (this.session === null || this.sink === null) throw new Error('source not active')
    const pcm = Int16Array.from(samples)
    const accepted = await this.sink.pushFrame({
      sessionId: this.session.sessionId,
      generation: this.session.generation,
      sequence: this.sequence,
      discontinuity: options.discontinuity === true,
      sampleRateHz: 16000,
      channels: 1,
      pcm
    })
    this.sequence += 1
    return accepted
  }
}

globalThis.__auroraWorkerAudioBridge = {
  async runProof() {
    const metadata = globalThis.__auroraAndroidWebViewMetadata ?? null
    const claims = globalThis.__auroraAndroidBrowserClaims ?? {
      browserSurface: 'Android emulator WebView Shell',
      package: 'org.chromium.webview_shell',
      physicalDevice: false,
      chromePackage: false,
      mockedWorker: false,
      mockedWasm: false,
      pcmSource: 'deterministic injected Int16Array source',
      microphonePermission: false,
      acousticCapture: false
    }
    const completeRepeat = await completeRepeatProbe()
    const abandonRepeat = await abandonRepeatProbe()
    const redaction = await redactionProbe()
    const requests = await fetch('/__aurora_requests__').then((response) => response.json()).catch(() => [])
    const artifacts = await fetch('/__aurora_artifacts__').then((response) => response.json()).catch(() => ({}))
    const consoleErrors = globalThis.__auroraConsoleErrors ?? []
    const leakPayload = JSON.stringify({
      completeEvents: completeRepeat.events,
      abandonEvents: abandonRepeat.events,
      snapshots: redaction.snapshots,
      consoleErrors
    })
    return {
      metadata,
      completeRepeat,
      abandonRepeat,
      redaction,
      requests,
      artifacts,
      consoleErrors,
      claims,
      workerSideErrors: [
        ...completeRepeat.events,
        ...abandonRepeat.events,
        ...redaction.events
      ].filter((event) => event.kind === 'error'),
      leakScan: {
        eventLeak: /12345|-12345|321|-321|pcm|transcript|secret|pointer/i.test(JSON.stringify([...completeRepeat.events, ...abandonRepeat.events])),
        snapshotLeak: /12345|-12345|321|-321|pcm|transcript|secret|pointer/i.test(JSON.stringify(redaction.snapshots)),
        consoleLeak: /12345|-12345|321|-321|pcm|transcript|secret|pointer/i.test(JSON.stringify(consoleErrors)),
        rawPcmLeak: /12345|-12345|should-not-leak/i.test(leakPayload),
        transcriptLeak: /transcript|open sesame/i.test(leakPayload)
      }
    }
  }
}

async function createRuntime(ownerId) {
  const source = new ControlledPcmSource()
  const events = []
  const runtime = createAuroraBrowserVoiceRuntime({
    ownerId,
    pcmSource: source,
    workerTimeoutMs: 15000,
    sessionIdFactory: (runtimeOwnerId, generation) => `${runtimeOwnerId}:${generation}`
  })
  runtime.onEvent((event) => events.push({ ...event }))
  return {
    start: () => runtime.start(),
    push: (samples, options) => source.push(samples, options),
    stop: () => runtime.stop(),
    complete: () => runtime.completeTurn(),
    abandon: () => runtime.abandonTurn(),
    dispose: () => runtime.dispose(),
    snapshot: () => runtime.snapshot(),
    events: () => events.map((event) => ({ ...event }))
  }
}

async function completeRepeatProbe() {
  const harness = await createRuntime(`${harnessPrefix()}-complete`)
  try {
    const first = await harness.start()
    await harness.push([100, -100, 200, -200])
    await harness.push([321, -321])
    const firstAudio = audioReport(await harness.stop())
    const stoppedSnapshot = harness.snapshot()
    await harness.complete()
    const completedSnapshot = harness.snapshot()
    const second = await harness.start()
    await harness.push([7, 8, 9])
    const secondAudio = audioReport(await harness.stop())
    await harness.complete()
    return {
      first,
      firstAudio,
      stoppedSnapshot,
      completedSnapshot,
      second,
      secondAudio,
      finalSnapshot: harness.snapshot(),
      events: harness.events()
    }
  } finally {
    await harness.dispose().catch(() => undefined)
  }
}

async function abandonRepeatProbe() {
  const harness = await createRuntime(`${harnessPrefix()}-abandon`)
  try {
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
  } finally {
    await harness.dispose().catch(() => undefined)
  }
}

async function redactionProbe() {
  const harness = await createRuntime(`${harnessPrefix()}-redacted`)
  try {
    const before = harness.snapshot()
    await harness.start()
    await harness.push([12345, -12345])
    const during = harness.snapshot()
    const audio = await harness.stop()
    const stopped = harness.snapshot()
    await harness.complete()
    return {
      snapshots: [before, during, stopped, harness.snapshot()],
      captured: {
        sampleCount: audio?.sampleCount ?? null,
        redacted: audio?.redacted ?? null
      },
      events: harness.events()
    }
  } finally {
    await harness.dispose().catch(() => undefined)
  }
}

function audioReport(audio) {
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

function harnessPrefix() {
  return globalThis.__auroraAndroidHarnessPrefix ?? 'android-webview'
}

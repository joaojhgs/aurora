import { expect, test } from '@playwright/test'

test('hosted Assistant push-to-talk completes a bounded demo turn through native browser capture', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'evidence-boundary',
    description: 'Uses Chromium fake media through native getUserMedia, AudioContext, AudioWorklet, and the production-built hosted Next Assistant path with built @aurora/voice-web Worker/WASM assets. The explicit demo transport returns a deterministic transcript. This is not a physical-microphone, OS permission-prompt, Android-device, acoustic-recognition, or local-browser-STT check.',
  })

  const consoleErrors: string[] = []
  const requestedUrls = new Set<string>()
  const requestedPayloads: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('request', (request) => {
    requestedUrls.add(request.url())
    const payload = request.postData()
    if (payload !== null) requestedPayloads.push(payload)
  })

  await page.addInitScript(() => {
    const probe: HostedBrowserVoiceProbe = {
      getUserMediaCalls: 0,
      constraints: [],
      streams: [],
      audioContextCalls: 0,
      audioWorkletUrls: [],
      audioFrameMessages: 0,
      workerUrls: [],
      errors: [],
    }
    window.__auroraHostedBrowserVoiceProbe = probe

    const mediaDevices = window.navigator.mediaDevices
    const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async (constraints: MediaStreamConstraints) => {
        probe.getUserMediaCalls += 1
        probe.constraints.push(constraints)
        try {
          const stream = await nativeGetUserMedia(constraints)
          probe.streams.push(stream)
          return stream
        } catch (error) {
          probe.errors.push(`getUserMedia: ${String(error)}`)
          throw error
        }
      },
    })

    const NativeAudioContext = window.AudioContext
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: new Proxy(NativeAudioContext, {
        construct(target, argumentsList, newTarget) {
          probe.audioContextCalls += 1
          const context = Reflect.construct(target, argumentsList, newTarget) as AudioContext
          const nativeAddModule = context.audioWorklet.addModule.bind(context.audioWorklet)
          Object.defineProperty(context.audioWorklet, 'addModule', {
            configurable: true,
            value: async (url: string | URL) => {
              probe.audioWorkletUrls.push(String(url))
              try {
                await nativeAddModule(url)
              } catch (error) {
                probe.errors.push(`audioWorklet.addModule: ${String(error)}`)
                throw error
              }
            },
          })
          return context
        },
      }),
    })

    const NativeWorker = window.Worker
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: new Proxy(NativeWorker, {
        construct(target, argumentsList, newTarget) {
          probe.workerUrls.push(String(argumentsList[0]))
          try {
            return Reflect.construct(target, argumentsList, newTarget)
          } catch (error) {
            probe.errors.push(`Worker: ${String(error)}`)
            throw error
          }
        },
      }),
    })

    const NativeAudioWorkletNode = window.AudioWorkletNode
    Object.defineProperty(window, 'AudioWorkletNode', {
      configurable: true,
      value: new Proxy(NativeAudioWorkletNode, {
        construct(target, argumentsList, newTarget) {
          const node = Reflect.construct(target, argumentsList, newTarget) as AudioWorkletNode
          node.port.addEventListener('message', (event) => {
            const payload = event.data as { type?: unknown } | null
            if (payload !== null && typeof payload === 'object' && payload.type === 'audio') {
              probe.audioFrameMessages += 1
            }
          })
          node.port.start()
          return node
        },
      }),
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('heading', { name: 'Text chat with Aurora' })).toBeAttached()
  await expect(page.getByRole('form', { name: 'Prompt composer' })).toBeVisible()
  await expect(page.getByText('Continue', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await expect(page.getByText('Start with a prompt', { exact: true })).toBeVisible()

  const consentButton = page.getByRole('button', { name: 'Allow connected voice' })
  await expect(consentButton).toBeVisible()
  await consentButton.click()
  await expect(page.getByRole('button', { name: 'Stop connected voice access' })).toBeVisible()

  const pushToTalk = page.getByRole('button', { name: 'Push to talk' })
  await expect(pushToTalk).toBeVisible()
  await pushToTalk.click()

  const stopListening = page.getByRole('button', { name: 'Stop listening' })
  try {
    await expect(stopListening).toBeVisible({ timeout: 10_000 })
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      alert: document.querySelector('[role="alert"]')?.textContent ?? null,
      probe: window.__auroraHostedBrowserVoiceProbe,
    }))
    throw new Error(`Hosted browser capture did not start: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    })
  }
  await expect(page.getByRole('form', { name: 'Prompt composer' })).toHaveAttribute('data-voice-active', 'true')
  await expect.poll(
    () => page.evaluate(() => window.__auroraHostedBrowserVoiceProbe.audioFrameMessages),
    { message: 'AudioWorklet should deliver captured audio before push-to-talk stops', timeout: 10_000 },
  ).toBeGreaterThan(0)
  await stopListening.click()

  await expect(page.getByText('hello Aurora', { exact: true })).toBeVisible()
  await expect(page.getByText('Sample reply: I heard “hello Aurora”.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Push to talk' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Model: Automatic' })).toBeVisible()

  const visibleProductCopy = await page.locator('body').innerText()
  expect(visibleProductCopy).not.toMatch(
    /Mock Aurora response|mock-local|EXECUTING|dispatch to local|Dispatch routes|Using local|Connected to local|Connected device default|Peer identity|local-peer|Device profile|Remote route pending|Mesh route pending|Mesh Peer|operator cockpit|\bRBAC\b|call diagnostics|diagnostics\.serviceHealth|on the local node|Assistant action|Action requested/iu
  )

  const probe = await page.evaluate(() => ({
    getUserMediaCalls: window.__auroraHostedBrowserVoiceProbe.getUserMediaCalls,
    constraints: window.__auroraHostedBrowserVoiceProbe.constraints,
    audioContextCalls: window.__auroraHostedBrowserVoiceProbe.audioContextCalls,
    audioWorkletUrls: window.__auroraHostedBrowserVoiceProbe.audioWorkletUrls,
    audioFrameMessages: window.__auroraHostedBrowserVoiceProbe.audioFrameMessages,
    workerUrls: window.__auroraHostedBrowserVoiceProbe.workerUrls,
    errors: window.__auroraHostedBrowserVoiceProbe.errors,
    trackStates: window.__auroraHostedBrowserVoiceProbe.streams.flatMap((stream) =>
      stream.getTracks().map((track) => track.readyState),
    ),
  }))
  expect(probe.getUserMediaCalls).toBe(1)
  expect(probe.constraints).toHaveLength(1)
  expect(probe.audioContextCalls).toBe(1)
  expect(probe.audioWorkletUrls).toHaveLength(1)
  expect(probe.audioFrameMessages).toBeGreaterThan(0)
  expect(probe.workerUrls).toHaveLength(1)
  expect(probe.errors).toEqual([])
  expect(probe.trackStates).not.toHaveLength(0)
  expect(probe.trackStates).toEqual(expect.arrayContaining(['ended']))
  expect(probe.trackStates.every((state) => state === 'ended')).toBe(true)

  const pageOrigin = new URL(page.url()).origin
  const workerAssetUrl = new URL(probe.workerUrls[0]!, page.url())
  const workletAssetUrl = new URL(probe.audioWorkletUrls[0]!, page.url())
  const wasmParameter = workerAssetUrl.searchParams.get('wasm')
  expect(workerAssetUrl.origin).toBe(pageOrigin)
  expect(workletAssetUrl.origin).toBe(pageOrigin)
  expect(wasmParameter).not.toBeNull()
  const wasmAssetUrl = new URL(wasmParameter!)
  expect(wasmAssetUrl.origin).toBe(pageOrigin)

  const workerResponse = await page.context().request.get(workerAssetUrl.href)
  expect(workerResponse.ok(), `Worker asset should return a successful response; received ${workerResponse.status()}`).toBe(true)
  expect(workerResponse.headers()['content-type']).toMatch(/javascript/iu)
  expect(await workerResponse.text()).toContain('audio_frame')

  const workletResponse = await page.context().request.get(workletAssetUrl.href)
  expect(workletResponse.ok(), `Worklet asset should return a successful response; received ${workletResponse.status()}`).toBe(true)
  expect(workletResponse.headers()['content-type']).toMatch(/javascript/iu)
  expect(await workletResponse.text()).toContain('aurora-voice-pcm-source')

  const wasmResponse = await page.context().request.get(wasmAssetUrl.href)
  expect(wasmResponse.ok(), `WASM asset should return a successful response; received ${wasmResponse.status()}`).toBe(true)
  expect(wasmResponse.headers()['content-type']).toMatch(/application\/wasm/iu)
  expect([...((await wasmResponse.body()).subarray(0, 4))]).toEqual([0, 97, 115, 109])

  const persistedBrowserState = await page.evaluate(() => ({
    local: { ...window.localStorage },
    session: { ...window.sessionStorage },
    text: document.body.innerText,
  }))
  const redactionSurface = JSON.stringify({
    consoleErrors,
    persistedBrowserState,
    requestedPayloads,
  })
  expect(redactionSurface).not.toContain('audio_data')
  expect(redactionSurface).not.toContain('cHJpdmF0ZS1kZW1vLWF1ZGlv')
  expect(redactionSurface).not.toContain('demo-focused')
  expect(consoleErrors).toEqual([])

  expect([...requestedUrls].some((url) => url.includes('/api/Transcription/Transcribe'))).toBe(false)

  const layout = await page.evaluate(() => {
    window.scrollTo({ left: 0, top: 0 })
    return {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollX: window.scrollX,
    }
  })
  expect(layout.scrollX).toBe(0)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth)

  const screenshot = testInfo.outputPath('assistant-browser-voice-complete.png')
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach('hosted-browser-voice-complete', {
    path: screenshot,
    contentType: 'image/png',
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('form', { name: 'Prompt composer' })).toBeVisible()
  const mobileComposerLayout = await page.locator('.aui-composer-control-row').evaluate((row) => {
    const selectors = [
      '[aria-label="Attach context"]',
      '[data-voice-access]',
      '.aui-composer-input-shell',
      '[aria-label="Push to talk"]',
      '.aui-composer-send',
    ]
    const rects = selectors.map((selector) => row.querySelector(selector)?.getBoundingClientRect() ?? null)
    const tops = rects.flatMap((rect) => rect === null ? [] : [rect.top])
    return {
      controlsPresent: rects.every((rect) => rect !== null),
      maximumTopDifference: tops.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...tops) - Math.min(...tops),
      rowFits: row.scrollWidth <= row.clientWidth,
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })
  expect(mobileComposerLayout).toMatchObject({
    controlsPresent: true,
    rowFits: true,
    documentFits: true,
  })
  expect(mobileComposerLayout.maximumTopDifference).toBeLessThanOrEqual(2)
  const mobileScreenshot = testInfo.outputPath('assistant-browser-voice-mobile.png')
  await page.screenshot({ path: mobileScreenshot, fullPage: true })
  await testInfo.attach('hosted-browser-voice-mobile-viewport', {
    path: mobileScreenshot,
    contentType: 'image/png',
  })
})

interface HostedBrowserVoiceProbe {
  getUserMediaCalls: number
  constraints: MediaStreamConstraints[]
  streams: MediaStream[]
  audioContextCalls: number
  audioWorkletUrls: string[]
  audioFrameMessages: number
  workerUrls: string[]
  errors: string[]
}

declare global {
  interface Window {
    __auroraHostedBrowserVoiceProbe: HostedBrowserVoiceProbe
  }
}

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AuroraClient,
  MockAuroraTransport,
  ORCHESTRATOR_METHODS,
  ORCHESTRATOR_MODEL_METHODS,
  modelRuntimeCatalogFixture,
  type AuroraStreamRequest,
  type AuroraTransportRequest,
  type ToolApprovalConfirmRequest,
  type ToolingProjectionToolInfo,
} from '@aurora/client'
import {
  type LightweightAssistantProvider,
  type LightweightProviderRequest,
  type LightweightToolClientPort,
  type LightweightProviderResponse,
} from '@aurora/client/lightweight-orchestrator'
import {
  buildEnvelopeAad,
  MemoryLocalDataBackend,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LocalDataSession,
} from '@aurora/client/local-data'

import { AssistantView } from '../src/assistant-view'
import type { LightweightAssistantDependencies } from '../src/local-assistant/lightweight-assistant'
import type { NativeMobileVoicePort, NativeMobileVoiceStatus } from '../src/native-mobile-voice'
import { getAuroraSurfaceProfile, type AuroraSurfaceProfile } from '../src/platform-surface'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []
const scope = Object.freeze({ profileId: 'profile-unified', localNodeId: 'node-unified' })

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Element.prototype.scrollIntoView = () => undefined
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window.URL, 'createObjectURL')
  Reflect.deleteProperty(window.URL, 'revokeObjectURL')
})

describe('unified Assistant execution controls', () => {
  it('keeps the active turn mounted and follows the live edge when a local answer completes', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    })
    let resolveResponse!: (response: LightweightProviderResponse) => void
    const response = new Promise<LightweightProviderResponse>((resolve) => {
      resolveResponse = resolve
    })
    const provider: LightweightAssistantProvider = {
      async complete() {
        return await response
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'android',
        transportKind: 'mesh',
        nativePlatform: 'android',
        nodeMode: 'mesh-node',
        runtimeTier: 'lightweight-ts',
      }),
    })

    await enterPrompt(container, 'keep this turn at the bottom')
    await waitUntil(() => container.textContent?.includes('Waiting for Aurora...') === true)
    const beforeIds = [...container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"][data-message-id]')]
      .map((item) => item.dataset.messageId)
    expect(beforeIds).toHaveLength(2)
    expect(container.querySelectorAll('[data-scroll-anchor="true"]')).toHaveLength(0)
    const viewport = container.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!
    let scrollHeight = 1_180
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 880, writable: true },
    })
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      viewport.scrollTop = Number(options.top ?? viewport.scrollTop)
    })
    Object.defineProperty(viewport, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    })

    await act(async () => {
      resolveResponse({ type: 'message', content: 'Finished without remounting the turn.' })
      await response
    })
    await waitUntil(() => container.textContent?.includes('Finished without remounting the turn.') === true)
    scrollHeight = 1_200
    await act(async () => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver)
      }
      await Promise.resolve()
    })

    const afterIds = [...container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"][data-message-id]')]
      .map((item) => item.dataset.messageId)
    expect(afterIds).toEqual(beforeIds)
    expect(container.querySelectorAll('[data-scroll-anchor="true"]')).toHaveLength(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' })
    expect(viewport.scrollTop).toBe(900)
  })

  it('plays read-aloud audio returned by Aurora on connected client surfaces', async () => {
    const synthesisPayloads: unknown[] = []
    const playedSources: string[] = []
    const pausedSources: string[] = []
    const revokedUrls = vi.fn()
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:aurora-read-aloud'),
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokedUrls,
    })
    vi.stubGlobal('Audio', class {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly src: string) {}
      async play() {
        playedSources.push(this.src)
      }
      pause() {
        pausedSources.push(this.src)
      }
      removeAttribute() {}
      load() {}
    })
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Read this response on the client.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register('TTS.Synthesize', (request) => {
        synthesisPayloads.push(request.payload)
        return {
          audio_data: 'UklGRg==',
          format: 'wav',
          sample_rate: 22_050,
          channels: 1,
          duration_ms: 240,
          text: 'Read this response on the client.',
        }
      })
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await enterPrompt(container, 'give me something to read')
    await waitUntil(() => container.textContent?.includes('Read this response on the client.') === true)
    const readAloud = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Read aloud')
    if (!readAloud) throw new Error('missing read-aloud action')
    await act(async () => {
      readAloud.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitUntil(() => playedSources.length === 1)

    expect(synthesisPayloads).toEqual([{
      text: 'Read this response on the client.',
      voice: null,
      speed: 1,
      format: 'wav',
    }])
    expect(playedSources).toEqual(['blob:aurora-read-aloud'])

    const stop = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Stop')
    if (!stop) throw new Error('missing stop read-aloud action')
    await act(async () => {
      stop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(pausedSources).toEqual(['blob:aurora-read-aloud'])
    expect(revokedUrls).toHaveBeenCalledWith('blob:aurora-read-aloud')
    expect(revokedUrls).toHaveBeenCalledTimes(1)
  })

  it('keeps desktop-local read-aloud on the Python-owned speaker path', async () => {
    const playbackPayloads: unknown[] = []
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Read this response on the desktop speaker.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register('TTS.Request', (request) => {
        playbackPayloads.push(request.payload)
        return { status: 'queued' }
      })
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'desktop-local',
        transportKind: 'tauri-local',
        nativePlatform: 'linux',
        nodeMode: 'mesh-node',
        runtimeTier: 'python-full',
      }),
    })

    await enterPrompt(container, 'read locally')
    await waitUntil(() => container.textContent?.includes('Read this response on the desktop speaker.') === true)
    const readAloud = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Read aloud')
    if (!readAloud) throw new Error('missing read-aloud action')
    await act(async () => {
      readAloud.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(playbackPayloads).toEqual([{
      text: 'Read this response on the desktop speaker.',
      voice: null,
      speed: 1,
      interrupt: true,
    }])
  })

  it('opens the connected-device model groups so real models are immediately selectable', async () => {
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Unused.' }
      },
    }
    await renderUnifiedAssistant(
      new AuroraClient({
        transport: MockAuroraTransport.empty()
          .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture)),
      }),
      provider,
    )

    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Model: Configured default"]')
    if (!trigger) throw new Error('missing model selector trigger')
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    const source = document.querySelector<HTMLButtonElement>('.aui-model-source-trigger')
    const providers = [...document.querySelectorAll<HTMLButtonElement>('.aui-model-provider-trigger')]
    expect(source?.textContent).toContain('Home Aurora')
    expect(source?.getAttribute('aria-expanded')).toBe('true')
    expect(providers.length).toBeGreaterThan(0)
    expect(providers.every((providerTrigger) => providerTrigger.getAttribute('aria-expanded') === 'true')).toBe(true)
    expect(document.querySelector('[data-slot="model-selector-content"]')?.getAttribute('data-side')).toBe('top')
    expect(document.body.textContent).toContain('llama-3-8b-instruct')
  })

  it('runs the shared Assistant composer locally with the model selected in the real catalog', async () => {
    const providerCalls: LightweightProviderRequest[] = []
    const backendCalls: AuroraTransportRequest[] = []
    const provider: LightweightAssistantProvider = {
      async complete(request) {
        providerCalls.push(request)
        return { type: 'message', content: 'Answered on this device.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register(ORCHESTRATOR_METHODS.externalUserInput, (request) => {
        backendCalls.push(request)
        return assistantResponse(request, 'Unexpected connected response.')
      })
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await chooseModelSelectorItem('Model: Configured default', 'llama-3-8b-instruct')
    await enterPrompt(container, 'answer locally')
    await waitUntil(() => providerCalls.length === 1)

    expect(providerCalls[0]).toEqual(expect.objectContaining({
      providerId: 'local:Orchestrator:llama-cpp',
      modelId: 'llama-3-8b-instruct',
    }))
    expect(backendCalls).toEqual([])
    expect(container.textContent).toContain('Answered on this device.')
    expect(container.textContent).toContain('Local · llama-3-8b-instruct')
  })

  it('lists and reopens encrypted on-device chats from the mobile conversations sheet', async () => {
    const provider: LightweightAssistantProvider = {
      async complete(request) {
        const prompt = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? ''
        return { type: 'message', content: `Reply to ${prompt}` }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, { localData })

    await enterPrompt(container, 'first saved chat')
    await waitUntil(() => container.textContent?.includes('Reply to first saved chat') === true)
    const firstConversationId = (await localData.conversations.listConversations())[0]?.id
    if (!firstConversationId) throw new Error('missing first saved conversation')
    const newConversation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('New conversation'))
    if (!newConversation) throw new Error('missing new conversation button')
    await act(async () => {
      newConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await enterPrompt(container, 'second saved chat')
    await waitUntil(() => container.textContent?.includes('Reply to second saved chat') === true)
    const secondConversationId = (await localData.conversations.listConversations())
      .find((conversation) => conversation.id !== firstConversationId)?.id
    if (!secondConversationId) throw new Error('missing second saved conversation')
    const historyTrigger = container.querySelector<HTMLButtonElement>('[aria-label="Open conversations"]')
    if (!historyTrigger) throw new Error('missing mobile conversations trigger')
    await act(async () => {
      historyTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => {
      const sheet = document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]')
      return sheet?.textContent?.includes('first saved chat') === true
        && sheet.textContent.includes('second saved chat')
    })

    const sheet = document.body.querySelector<HTMLElement>('[data-slot="sheet-content"]')
    const firstChat = [...(sheet?.querySelectorAll<HTMLButtonElement>('.aui-thread-row-button') ?? [])]
      .find((button) => button.textContent?.includes('first saved chat'))
    if (!firstChat) throw new Error('missing first saved local chat')
    await act(async () => {
      firstChat.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await waitUntil(() => container.textContent?.includes('Reply to first saved chat') === true)
    expect(container.textContent).not.toContain('Reply to second saved chat')
    await waitUntil(async () => {
      const conversations = await localData.conversations.listConversations()
      const first = conversations.find((conversation) => conversation.id === firstConversationId)
      const second = conversations.find((conversation) => conversation.id === secondConversationId)
      return Boolean(first && second && first.updatedAtMs > second.updatedAtMs)
    })
    await waitUntil(() => document.body.querySelector('[data-slot="sheet-content"]') === null)
  })

  it('keeps the last prompt retryable after an on-device response is stopped', async () => {
    let attempts = 0
    const provider: LightweightAssistantProvider = {
      async complete(request) {
        attempts += 1
        if (attempts > 1) {
          return { type: 'message', content: 'Answered after retry.' }
        }
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Stopped', 'AbortError')),
            { once: true },
          )
        })
        throw new Error('unreachable')
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await enterPrompt(container, 'retry this prompt')
    await waitUntil(() => container.querySelector('[aria-label="Stop assistant generation"]') !== null)
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop assistant generation"]')
    if (!stop) throw new Error('missing Assistant stop button')
    await act(async () => {
      stop.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await waitUntil(() => container.querySelector('[aria-label="Retry last assistant prompt"]') !== null)
    expect(container.textContent).toContain('Aurora stopped responding.')
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry last assistant prompt"]')
    if (!retry) throw new Error('missing Assistant retry button')
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await waitUntil(() => attempts === 2 && container.textContent?.includes('Answered after retry.') === true)
    expect(container.textContent).toContain('retry this prompt')
  })

  it('switches the same composer to dispatch and sends the turn through the connected Aurora device', async () => {
    const providerCalls: LightweightProviderRequest[] = []
    const backendCalls: AuroraTransportRequest[] = []
    const streamCalls: AuroraStreamRequest[] = []
    const provider: LightweightAssistantProvider = {
      async complete(request) {
        providerCalls.push(request)
        return {
          type: 'message',
          content: providerCalls.length === 1 ? 'Local setup response.' : 'Local continuation response.',
        }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register(ORCHESTRATOR_METHODS.externalUserInput, (request) => {
        backendCalls.push(request)
        return assistantResponse(request, 'Answered by Home Aurora.')
      })
      .stream('assistant', async function* (request) {
        const payload = request.payload as Record<string, unknown>
        if (typeof payload?.text !== 'string') return
        streamCalls.push(request)
        yield {
          id: 'assistant-connected-complete',
          kind: 'assistant.completed',
          payload: {
            text: 'Answered by Home Aurora.',
            session_id: payload.session_id,
            request_id: payload.request_id,
            metadata: {
              model: 'llama-3-8b-instruct',
              provider_label: 'Home Aurora',
            },
          },
          correlation_id: request.correlationId,
        }
      })
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, { localData })

    await enterPrompt(container, 'start a local-only chat')
    await waitUntil(() => container.textContent?.includes('Local setup response.') === true)
    const localConversationId = (await localData.conversations.listConversations())[0]?.id
    expect(localConversationId).toBeTruthy()
    await chooseModelSelectorItem('Using this device', 'Home Aurora')
    expect(container.textContent).toContain('Local setup response.')
    await enterPrompt(container, 'answer on the connected device')
    await waitUntil(() => backendCalls.length >= 1 && streamCalls.length >= 1)

    expect(providerCalls).toHaveLength(1)
    expect(backendCalls[0]?.payload).toEqual(expect.objectContaining({
      text: 'answer on the connected device',
      source: 'ui',
      stream: true,
    }))
    expect(streamCalls[0]?.payload).toEqual(expect.objectContaining({
      text: 'answer on the connected device',
      source: 'ui',
      stream: true,
    }))
    expect((streamCalls[0]?.payload as { session_id?: string }).session_id).toBe(localConversationId)
    expect(container.textContent).toContain('Local setup response.')
    expect(container.textContent).toContain('Answered by Home Aurora.')
    expect([...container.querySelectorAll('.aui-chat-runtime')].map((node) => node.textContent)).toContain(
      'Home Aurora · llama-3-8b-instruct',
    )
    expect(container.textContent).toContain('Home Aurora · llama-3-8b-instruct')

    const messagesAfterDispatch = await localData.conversations.listMessages(localConversationId!)
    expect(messagesAfterDispatch.map((message) => [message.role, message.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
      ['user', 'complete'],
      ['assistant', 'complete'],
    ])

    await chooseModelSelectorItem('Using Home Aurora', 'This device')
    expect(container.textContent).toContain('Local setup response.')
    expect(container.textContent).toContain('Answered by Home Aurora.')
    await enterPrompt(container, 'continue locally after dispatch')
    await waitUntil(() => providerCalls.length === 2 && container.textContent?.includes('Local continuation response.') === true)

    expect(providerCalls[1]?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'start a local-only chat'],
      ['assistant', 'Local setup response.'],
      ['user', 'answer on the connected device'],
      ['assistant', 'Answered by Home Aurora.'],
      ['user', 'continue locally after dispatch'],
    ])
    expect(container.textContent).toContain('Local setup response.')
    expect(container.textContent).toContain('Answered by Home Aurora.')
    expect([...container.querySelectorAll('.aui-chat-runtime')].map((node) => node.textContent)).toContain(
      'Home Aurora · llama-3-8b-instruct',
    )

    const messagesAfterLocalContinuation = await localData.conversations.listMessages(localConversationId!)
    expect(messagesAfterLocalContinuation
      .filter((message) => message.role === 'assistant')
      .map((message) => message.toolEnvelope !== null)).toEqual([true, true, true])

    const newConversation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('New conversation'))
    if (!newConversation) throw new Error('missing new conversation button')
    await act(async () => {
      newConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    const historyTrigger = container.querySelector<HTMLButtonElement>('[aria-label="Open conversations"]')
    if (!historyTrigger) throw new Error('missing mobile conversations trigger')
    await act(async () => {
      historyTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => document.body.querySelector('[data-slot="sheet-content"]')?.textContent?.includes('start a local-only chat') === true)
    const savedConversation = [...(document.body.querySelector('[data-slot="sheet-content"]')?.querySelectorAll<HTMLButtonElement>('.aui-thread-row-button') ?? [])]
      .find((button) => button.textContent?.includes('start a local-only chat'))
    if (!savedConversation) throw new Error('missing saved mixed-execution conversation')
    await act(async () => {
      savedConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => container.textContent?.includes('Local continuation response.') === true)

    const restoredRuntimeLabels = [...container.querySelectorAll('.aui-chat-runtime')]
      .map((node) => node.textContent)
    expect(restoredRuntimeLabels.filter((label) => label === 'Local · Configured default')).toHaveLength(2)
    expect(restoredRuntimeLabels).toContain('Home Aurora · llama-3-8b-instruct')
  })

  it('renders connected-device response deltas before the final answer arrives', async () => {
    let releaseFinal!: () => void
    const finalReady = new Promise<void>((resolve) => {
      releaseFinal = resolve
    })
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Unused local response.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register(ORCHESTRATOR_METHODS.externalUserInput, (request) => assistantResponse(request, 'Hello from the connected device.'))
      .stream('assistant', async function* (request) {
        const payload = request.payload as Record<string, unknown>
        yield {
          id: 'remote-assistant-delta',
          kind: 'assistant.delta',
          payload: {
            delta: 'Hel',
            session_id: payload.session_id,
            request_id: payload.request_id,
          },
          correlation_id: request.correlationId,
        }
        await finalReady
        yield {
          id: 'remote-assistant-completed',
          kind: 'assistant.completed',
          payload: {
            text: 'Hello from the connected device.',
            session_id: payload.session_id,
            request_id: payload.request_id,
          },
          correlation_id: request.correlationId,
        }
      })
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await chooseModelSelectorItem('Using this device', 'Home Aurora')
    await enterPrompt(container, 'show this answer as it arrives')
    await waitUntil(() => container.textContent?.includes('Hel') === true)
    expect(container.textContent).not.toContain('Hello from the connected device.')

    await act(async () => {
      releaseFinal()
      await finalReady
    })
    await waitUntil(() => container.textContent?.includes('Hello from the connected device.') === true)
  })

  it('plays streamed connected-device audio without duplicating the completed answer or leaving speaking active', async () => {
    const playedSources: string[] = []
    Object.defineProperty(window.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:aurora-streamed-tts'),
    })
    Object.defineProperty(window.URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    vi.stubGlobal('Audio', class {
      onended: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(readonly src: string) {}
      async play() {
        playedSources.push(this.src)
        this.onended?.()
      }
      pause() {}
    })
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Unused local response.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register(ORCHESTRATOR_METHODS.externalUserInput, (request) => assistantResponse(request, 'Targeted audio works.'))
      .stream('assistant', async function* (request) {
        const payload = request.payload as Record<string, unknown>
        const common = {
          session_id: payload.session_id,
          request_id: payload.request_id,
          metadata: {
            model: 'llama-3-8b-instruct',
            provider_label: 'Home Aurora',
            tts_status: 'streaming',
            tts_stream_id: 'tts-targeted-audio',
          },
        }
        yield {
          id: 'remote-assistant-delta-1',
          kind: 'assistant.delta',
          payload: { ...common, text: 'Targeted', delta: 'Targeted' },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-assistant-delta-2',
          kind: 'assistant.delta',
          payload: { ...common, text: 'Targeted audio works.', delta: ' audio works.' },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-assistant-completed',
          kind: 'assistant.completed',
          payload: { ...common, text: 'Targeted audio works.' },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-assistant-audio',
          kind: 'tts.audio_chunk',
          payload: {
            stream_id: 'tts-targeted-audio',
            sequence: 0,
            audio_data: 'UklGRg==',
            format: 'wav',
            sample_rate: 22_050,
            channels: 1,
            duration_ms: 120,
            is_final: false,
          },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-assistant-audio-final',
          kind: 'tts.audio_chunk',
          payload: {
            stream_id: 'tts-targeted-audio',
            sequence: 1,
            audio_data: '',
            format: 'wav',
            sample_rate: 22_050,
            channels: 1,
            duration_ms: 0,
            is_final: true,
          },
          correlation_id: request.correlationId,
        }
      })
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await chooseModelSelectorItem('Using this device', 'Home Aurora')
    await enterPrompt(container, 'play the targeted response')
    await waitUntil(() => playedSources.length === 1)
    await waitUntil(() => container.querySelector('.aui-chat-assistant.aui-chat-sent') !== null)

    const assistantText = container.querySelector('.aui-chat-assistant .aui-chat-bubble p')?.textContent
    const readAloud = [...container.querySelectorAll<HTMLButtonElement>('.aui-chat-assistant .aui-message-action-button')]
      .find((button) => button.textContent?.trim() === 'Read aloud')
    expect(assistantText).toBe('Targeted audio works.')
    expect(playedSources).toEqual(['blob:aurora-streamed-tts'])
    expect(readAloud?.getAttribute('aria-pressed')).toBe('false')
    expect(container.textContent).not.toContain('TTS audio chunk received')
  })

  it('restores dispatched tool activity from the same encrypted on-device chat', async () => {
    const provider: LightweightAssistantProvider = {
      async complete() {
        return { type: 'message', content: 'Unused local response.' }
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
      .register(ORCHESTRATOR_METHODS.externalUserInput, (request) => assistantResponse(request, 'The connected device is online.'))
      .stream('assistant', async function* (request) {
        const payload = request.payload as Record<string, unknown>
        yield {
          id: 'remote-tool-running',
          kind: 'tool.running',
          payload: {
            session_id: payload.session_id,
            request_id: payload.request_id,
            tool: {
              tool_call_id: 'remote-device-status',
              tool_name: 'device_status',
              display_name: 'Device status',
              status: 'running',
              summary: 'Checking the connected device.',
              target: 'Home Aurora',
              data_leaves_device: true,
              redacted_args_preview: {},
            },
          },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-tool-completed',
          kind: 'tool.completed',
          payload: {
            session_id: payload.session_id,
            request_id: payload.request_id,
            tool: {
              tool_call_id: 'remote-device-status',
              tool_name: 'device_status',
              display_name: 'Device status',
              status: 'completed',
              summary: 'The connected device responded.',
              target: 'Home Aurora',
              data_leaves_device: true,
              redacted_args_preview: {},
              result_preview: { online: true },
            },
          },
          correlation_id: request.correlationId,
        }
        yield {
          id: 'remote-assistant-completed',
          kind: 'assistant.completed',
          payload: {
            text: 'The connected device is online.',
            session_id: payload.session_id,
            request_id: payload.request_id,
          },
          correlation_id: request.correlationId,
        }
      })
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, { localData })

    await chooseModelSelectorItem('Using this device', 'Home Aurora')
    await enterPrompt(container, 'check the connected device')
    await waitUntil(() => container.textContent?.includes('The connected device is online.') === true)
    await waitUntil(async () => {
      const conversationId = (await localData.conversations.listConversations())[0]?.id
      if (!conversationId) return false
      return (await localData.conversations.listMessages(conversationId)).length === 4
    })

    const conversationId = (await localData.conversations.listConversations())[0]?.id
    if (!conversationId) throw new Error('missing dispatched conversation')
    const persisted = await localData.conversations.listMessages(conversationId)
    expect(persisted.map((message) => [message.role, message.status, message.toolEnvelope !== null])).toEqual([
      ['user', 'complete', false],
      ['tool', 'complete', true],
      ['tool', 'complete', true],
      ['assistant', 'complete', true],
    ])

    const newConversation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('New conversation'))
    if (!newConversation) throw new Error('missing new conversation button')
    await act(async () => {
      newConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => container.textContent?.includes('The connected device is online.') === false)

    const historyTrigger = container.querySelector<HTMLButtonElement>('[aria-label="Open conversations"]')
    if (!historyTrigger) throw new Error('missing mobile conversations trigger')
    await act(async () => {
      historyTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    await waitUntil(() => document.body.querySelector('[data-slot="sheet-content"]')?.textContent?.includes('check the connected device') === true)
    const savedConversation = [...(document.body.querySelector('[data-slot="sheet-content"]')?.querySelectorAll<HTMLButtonElement>('.aui-thread-row-button') ?? [])]
      .find((button) => button.textContent?.includes('check the connected device'))
    if (!savedConversation) throw new Error('missing saved dispatched conversation')
    await act(async () => {
      savedConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await waitUntil(() => container.textContent?.includes('The connected device is online.') === true)
    expect(container.querySelector('.aui-chat-assistant [data-slot="tool-fallback-root"]')).not.toBeNull()
    expect(container.querySelector('.aui-chat-tool')).toBeNull()
    expect(container.textContent).toContain('Action finished')
    expect([...container.querySelectorAll('.aui-chat-runtime')].map((node) => node.textContent)).toContain(
      'Home Aurora · llama-3-8b-instruct',
    )
  })

  it('renders a completed on-device action with the shared tool-call component instead of a chat bubble', async () => {
    const responses: LightweightProviderResponse[] = [
      {
        type: 'tool_calls',
        toolCalls: [{
          id: 'tool-call-device-status',
          toolName: 'local.device_status',
          arguments: {},
          route: 'local',
        }],
      },
      { type: 'message', content: 'This device is online.' },
    ]
    const provider: LightweightAssistantProvider = {
      async complete() {
        const response = responses.shift()
        if (!response) throw new Error('Unexpected provider call.')
        return response
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      tools: automaticToolPort(),
      availableTools: [automaticTool()],
    })

    await enterPrompt(container, 'check this device')
    await waitUntil(() => container.textContent?.includes('This device is online.') === true)

    expect(container.querySelectorAll('[data-slot="tool-fallback-root"]')).toHaveLength(1)
    expect(container.querySelector('.aui-chat-tool')).toBeNull()
    expect(container.querySelector('.aui-chat-assistant [data-slot="tool-fallback-root"]')).not.toBeNull()
    expect(container.textContent).toContain('Action finished')
    expect(container.textContent).not.toContain('Action completed.')
  })

  it('renders tool-only mobile history entries as the shared tool-call row without assistant bubble chrome', async () => {
    const responses: LightweightProviderResponse[] = [
      {
        type: 'tool_calls',
        toolCalls: [{
          id: 'tool-call-device-status',
          toolName: 'local.device_status',
          arguments: {},
          route: 'local',
        }],
      },
      { type: 'message', content: '' },
    ]
    const provider: LightweightAssistantProvider = {
      async complete() {
        const response = responses.shift()
        if (!response) throw new Error('Unexpected provider call.')
        return response
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      tools: automaticToolPort(),
      availableTools: [automaticTool()],
    })

    await enterPrompt(container, 'check this device silently')
    await waitUntil(() => container.textContent?.includes('Action finished') === true)

    expect(container.querySelector('.aui-chat-tool [data-slot="tool-fallback-root"]')).not.toBeNull()
    expect(container.querySelector('.aui-chat-assistant [data-slot="tool-fallback-root"]')).toBeNull()
    expect(container.querySelector('.aui-chat-assistant .aui-chat-message-header')).toBeNull()
    expect(container.querySelectorAll('.aui-chat-assistant .aui-chat-bubble')).toHaveLength(0)
    expect(container.textContent).not.toContain('Saved message')
    expect(container.textContent).not.toContain('Action completed.')
  })

  it('resumes an on-device tool from the shared inline approval card with the chosen scope', async () => {
    const confirmations: ToolApprovalConfirmRequest[] = []
    const responses: LightweightProviderResponse[] = [
      {
        type: 'tool_calls',
        toolCalls: [{
          id: 'tool-call-local-echo',
          toolName: 'local.echo',
          arguments: { value: 'hello' },
          route: 'local',
        }],
      },
      { type: 'message', content: 'Approved action completed.' },
    ]
    const provider: LightweightAssistantProvider = {
      async complete() {
        const response = responses.shift()
        if (!response) throw new Error('Unexpected provider call.')
        return response
      },
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      tools: approvalToolPort(confirmations),
      availableTools: [approvalTool()],
    })

    await enterPrompt(container, 'run the local action')
    await waitUntil(() => container.textContent?.includes('Needs approval') === true)
    const sessionButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Session')
    if (!sessionButton) throw new Error('missing Session approval button')
    await act(async () => {
      sessionButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitUntil(() => confirmations.length === 1 && container.textContent?.includes('Approved action completed.') === true)

    expect(confirmations[0]).toEqual(expect.objectContaining({
      approve: true,
      grant_scope: 'session',
      approval_request_id: 'approval-local-echo',
    }))
    expect(container.textContent).toContain('Action finished.')
    expect(container.textContent).not.toContain('Needs approval')
  })

  it('opens native-persisted background turns after a service restart reuses a generation', async () => {
    const provider: LightweightAssistantProvider = {
      async complete() {
        throw new Error('Native-completed background turns must not be redispatched.')
      },
    }
    const firstConversationId = 'voice-conversation-native-first'
    const secondConversationId = 'voice-conversation-native-second'
    const envelopeCrypto = new TestEnvelopeCryptoPort()
    const localData = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    for (const [conversationId, suffix, transcript, response, createdAtMs] of [
      [firstConversationId, 'first', 'what did aurora hear first', 'Aurora heard the first saved turn.', 1],
      [secondConversationId, 'second', 'what did aurora hear second', 'Aurora heard the second saved turn.', 3],
    ] as const) {
      await localData.conversations.upsertConversation({
        id: conversationId,
        profileId: scope.profileId,
        localNodeId: scope.localNodeId,
        titleEnvelope: null,
        createdAtMs,
        updatedAtMs: createdAtMs + 1,
        archivedAtMs: null,
      })
      for (const [id, sequence, role, text] of [
        [`voice-user-native-${suffix}`, 0, 'user', transcript],
        [`voice-assistant-native-${suffix}`, 1, 'assistant', response],
      ] as const) {
        await localData.conversations.appendMessage({
          id,
          conversationId,
          sequence,
          role,
          contentEnvelope: await envelopeCrypto.encrypt(
            'local-structured-data',
            new TextEncoder().encode(text),
            buildEnvelopeAad({
              table: 'aurora_messages',
              recordId: id,
              field: 'content_envelope_json',
              profileId: scope.profileId,
              localNodeId: scope.localNodeId,
            }),
          ),
          toolEnvelope: null,
          status: 'complete',
          createdAtMs: createdAtMs + sequence,
        })
      }
    }
    const nativeStatus: NativeMobileVoiceStatus = {
      available: true,
      running: true,
      captureActive: false,
      backgroundActive: true,
      phase: 'listening',
      reasonCode: null,
      redacted: true,
    }
    const takeBackgroundResult = vi.fn()
      .mockResolvedValueOnce({
        generation: 7,
        transcript: 'what did aurora hear first',
        assistantText: 'Aurora heard the first saved turn.',
        errorCode: null,
        persisted: true,
        conversationId: firstConversationId,
        persistenceErrorCode: null,
      })
      .mockResolvedValueOnce({
        generation: 7,
        transcript: 'what did aurora hear second',
        assistantText: 'Aurora heard the second saved turn.',
        errorCode: null,
        persisted: true,
        conversationId: secondConversationId,
        persistenceErrorCode: null,
      })
      .mockResolvedValue(null)
    const nativeMobileVoice: NativeMobileVoicePort = {
      status: vi.fn(async () => nativeStatus),
      start: vi.fn(async () => nativeStatus),
      finish: vi.fn(async () => nativeStatus),
      cancel: vi.fn(async () => nativeStatus),
      takeTranscript: vi.fn(async () => null),
      backgroundStatus: vi.fn(async () => nativeStatus),
      startBackground: vi.fn(async () => nativeStatus),
      stopBackground: vi.fn(async () => nativeStatus),
      takeBackgroundResult,
    }
    const transport = MockAuroraTransport.empty()
      .register(ORCHESTRATOR_MODEL_METHODS.getCatalog, () => structuredClone(modelRuntimeCatalogFixture))
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider, {
      localData,
      envelopeCrypto,
      nativeMobileVoice,
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: 'mobile-native',
        transportKind: 'native-mobile',
        nativePlatform: 'android',
        nativeVoiceAvailable: true,
        nativeWakewordAvailable: true,
        localSpeechPackState: 'ready',
        localSpeechEngineCapabilities: { vad: true, kws: true, stt: true, tts: true },
      }),
    })

    await waitUntil(() => takeBackgroundResult.mock.calls.length > 0)
    await waitUntil(() => container.textContent?.includes('Aurora heard the second saved turn.') === true)
    expect(container.textContent).not.toContain('Aurora heard the first saved turn.')
    expect(await localData.conversations.listMessages(firstConversationId)).toHaveLength(2)
    expect(await localData.conversations.listMessages(secondConversationId)).toHaveLength(2)
  })

})

async function renderUnifiedAssistant(
  client: AuroraClient,
  provider: LightweightAssistantProvider,
  overrides: {
    tools?: LightweightToolClientPort
    availableTools?: readonly ToolingProjectionToolInfo[]
    localData?: LocalDataSession
    envelopeCrypto?: EnvelopeCryptoPort
    surfaceProfile?: AuroraSurfaceProfile
    nativeMobileVoice?: NativeMobileVoicePort
  } = {},
): Promise<HTMLElement> {
  client.auth.setApiKeySystem()
  const localData = overrides.localData ?? await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
  const localAssistant: LightweightAssistantDependencies = {
    provider,
    tools: overrides.tools ?? unusedToolPort(),
    localData,
    envelopeCrypto: overrides.envelopeCrypto ?? new TestEnvelopeCryptoPort(),
    scope,
    availableTools: overrides.availableTools ?? [],
    ids: idSequence(),
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <AssistantView
        client={client}
        route={connectedRoute()}
        executionHost="connected-device"
        localAssistant={localAssistant}
        surfaceProfile={overrides.surfaceProfile}
        nativeAvailable={overrides.nativeMobileVoice ? true : undefined}
        nativePlatform={overrides.nativeMobileVoice ? 'android' : undefined}
        nativeMobileVoice={overrides.nativeMobileVoice}
        initialSession={{ sessionId: null, messages: [] }}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
  })
  await waitUntil(() => document.querySelector('[aria-label="Model: Configured default"]') !== null)
  return container
}

function idSequence(): () => string {
  let next = 0
  return () => `unified-${next++}`
}

function connectedRoute(): RouteAvailability {
  return {
    item: { id: 'assistant', label: 'Assistant', privacyClass: 'personal' },
    state: 'available-local',
    explanation: 'Assistant is available from Home Aurora.',
    providerLabel: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
    blockers: [],
    repairActions: [],
    candidateProviders: [{
      id: 'local:home-aurora:Orchestrator',
      providerId: 'local:home-aurora:Orchestrator',
      providerKind: 'local',
      peerId: 'peer-home',
      nodeName: 'Home Aurora',
      serviceInstanceId: 'local:home-aurora:Orchestrator',
      label: `local / ${ORCHESTRATOR_METHODS.externalUserInput}`,
      state: 'available-local',
      selectable: true,
      reason: 'available',
      requiredAction: null,
    }],
    evidenceSources: [ORCHESTRATOR_METHODS.externalUserInput],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
  } as unknown as RouteAvailability
}

async function chooseModelSelectorItem(triggerLabel: string, itemText: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${triggerLabel}"]`)
  if (!trigger) throw new Error(`missing selector trigger ${triggerLabel}`)
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
  const item = [...document.querySelectorAll<HTMLElement>('[data-slot="model-selector-item"]')]
    .find((candidate) => candidate.textContent?.includes(itemText))
  if (!item) throw new Error(`missing selector item ${itemText}`)
  await act(async () => {
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function enterPrompt(container: HTMLElement, prompt: string): Promise<void> {
  const composer = container.querySelector<HTMLTextAreaElement>('#assistant-prompt')
  if (!composer) throw new Error('missing Assistant composer')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(composer, prompt)
    composer.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  const send = container.querySelector<HTMLButtonElement>('[aria-label="Send assistant prompt"]')
  if (!send) throw new Error('missing Assistant send button')
  expect(send.disabled).toBe(false)
  await act(async () => {
    send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for unified Assistant state: ${document.body.textContent ?? ''}`)
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

function assistantResponse(request: AuroraTransportRequest, text: string) {
  const payload = request.payload as Record<string, unknown>
  return {
    text,
    session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    request_id: typeof payload.request_id === 'string' ? payload.request_id : null,
    correlation_id: typeof payload.correlation_id === 'string' ? payload.correlation_id : null,
    metadata: {
      model: 'llama-3-8b-instruct',
      provider_label: 'Home Aurora',
    },
  }
}

function unusedToolPort(): LightweightToolClientPort {
  const unused = async (): Promise<never> => {
    throw new Error('No tool call was expected in this test.')
  }
  return {
    prepareExecution: unused,
    requestApproval: unused,
    confirmExecution: unused,
    execute: unused,
  }
}

function automaticToolPort(): LightweightToolClientPort {
  const unexpectedApproval = async (): Promise<never> => {
    throw new Error('This action should not require approval.')
  }
  return {
    async prepareExecution(payload) {
      return {
        ok: true,
        policy_decision: {
          allowed: true,
          share: true,
          approval_required: false,
          approval_mode: 'none',
          decision_id: 'decision-device-status',
          reason: null,
          token_ttl_seconds: 0,
        },
        args_hash: 'args-device-status',
        resource_selector_hash: 'selector-device-status',
        route_decision_id: 'route-device-status',
        correlation_id: payload.correlation_id ?? 'corr-device-status',
        provider_peer_id: scope.localNodeId,
        provider_service_instance_id: 'local:Tooling',
        global_tool_id: 'local.device_status',
        local_tool_name: 'local.device_status',
        args_schema_hash: 'b'.repeat(64),
        source: 'native',
        source_id: 'local:native',
        trust_tier: 'trusted',
        capability_class: 'device',
        resource_scope: [],
        display_args_preview: {},
        argument_visibility: {},
        secrets_redacted: true,
      }
    },
    requestApproval: unexpectedApproval,
    confirmExecution: unexpectedApproval,
    async execute(payload) {
      return {
        ok: true,
        data: { online: true },
        status: 'success',
        correlation_id: payload.correlation_id ?? null,
        provider_peer_id: scope.localNodeId,
        global_tool_id: 'local.device_status',
      }
    },
  }
}

function approvalToolPort(confirmations: ToolApprovalConfirmRequest[]): LightweightToolClientPort {
  return {
    async prepareExecution(payload) {
      return {
        ok: false,
        policy_decision: {
          allowed: false,
          share: true,
          approval_required: true,
          approval_mode: 'ask_each_time',
          decision_id: 'decision-local-echo',
          reason: 'approval_token_required',
          token_ttl_seconds: 300,
        },
        args_hash: 'args-local-echo',
        resource_selector_hash: 'selector-local-echo',
        route_decision_id: 'route-local-echo',
        correlation_id: payload.correlation_id ?? 'corr-local-echo',
        provider_peer_id: scope.localNodeId,
        provider_service_instance_id: 'local:Tooling',
        global_tool_id: 'local.echo',
        local_tool_name: 'local.echo',
        args_schema_hash: 'a'.repeat(64),
        source: 'core',
        source_id: 'local:core',
        trust_tier: 'trusted',
        capability_class: 'utility',
        resource_scope: [],
        display_args_preview: { value: 'hello' },
        argument_visibility: { value: 'visible' },
        secrets_redacted: true,
      }
    },
    async requestApproval(payload) {
      return {
        ok: true,
        approval_request_id: 'approval-local-echo',
        policy_decision: {
          decision_id: 'decision-local-echo',
          allowed: false,
          approval_required: true,
          approval_mode: 'ask_each_time',
          token_ttl_seconds: 300,
          reason: 'approval_token_required',
        },
        expires_at: 1_900_000_000,
        correlation_id: payload.correlation_id ?? 'corr-local-echo',
        error: null,
      }
    },
    async confirmExecution(payload) {
      confirmations.push(payload)
      return {
        ok: payload.approve !== false,
        approval_token: payload.approve === false ? null : 'token-local-echo',
        expires_at: 1_900_000_000,
        policy_decision_id: 'decision-local-echo',
        correlation_id: payload.correlation_id ?? null,
        error: payload.approve === false ? 'approval_denied' : null,
      }
    },
    async execute(payload) {
      return {
        ok: true,
        data: { echoed: payload.arguments.value },
        status: 'success',
        correlation_id: payload.correlation_id ?? null,
        provider_peer_id: scope.localNodeId,
        global_tool_id: 'local.echo',
      }
    },
  }
}

function approvalTool(): ToolingProjectionToolInfo {
  return {
    name: 'local.echo',
    local_name: 'local.echo',
    global_tool_id: 'local.echo',
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: 'action.local.echo',
    share_group_id: 'group.local.echo',
    share_group_label: 'Echo',
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: scope.localNodeId,
    provider_service_instance_id: 'local:Tooling',
    provider_label: 'This device',
    provider_granted_permissions: null,
    provider_available: true,
    namespace: scope.localNodeId,
    display_name: 'Echo',
    aliases: [],
    description: 'Echo a value on this device.',
    args_schema: { type: 'object' },
    schema: { type: 'object' },
    argument_visibility: { value: 'visible' },
    source_type: 'local',
    source: 'core',
    source_id: 'local:core',
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: 'local',
    safety_class: 'review',
    risk_class: 'mutating',
    data_egress: false,
    mutating: true,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: true,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: scope.localNodeId,
      provider_service_instance_id: 'local:Tooling',
      provider_kind: 'local',
      source: 'core',
      advertised_name: 'local.echo',
    },
  }
}

function automaticTool(): ToolingProjectionToolInfo {
  return {
    ...approvalTool(),
    name: 'local.device_status',
    local_name: 'local.device_status',
    global_tool_id: 'local.device_status',
    tool_contract_id: 'read.local.device_status',
    share_group_id: 'group.local.device_status',
    share_group_label: 'Device status',
    display_name: 'Device status',
    description: 'Read this device status.',
    argument_visibility: {},
    capability_class: 'device',
    safety_class: 'safe',
    risk_class: 'low',
    mutating: false,
    confirmation_required: false,
    provenance: {
      provider_peer_id: scope.localNodeId,
      provider_service_instance_id: 'local:Tooling',
      provider_kind: 'local',
      source: 'native',
      advertised_name: 'local.device_status',
    },
  }
}

class TestEnvelopeCryptoPort implements EnvelopeCryptoPort {
  private readonly plaintextByKeyId = new Map<string, Uint8Array>()
  private readonly aadByKeyId = new Map<string, Uint8Array>()
  private nextKey = 0

  async encrypt(
    keyPurpose: LocalDataKeyPurpose,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<EncryptedDataEnvelopeV1> {
    const keyId = `test-${keyPurpose}-${this.nextKey++}`
    this.plaintextByKeyId.set(keyId, new Uint8Array(plaintext))
    this.aadByKeyId.set(keyId, new Uint8Array(aad))
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId,
      nonceB64Url: 'AAAAAAAAAAAAAAAA',
      ciphertextAndTagB64Url: 'AAAAAAAAAAAAAAAAAAAAAA',
      createdAtMs: Date.now(),
    }
  }

  async decrypt(envelope: EncryptedDataEnvelopeV1, aad: Uint8Array): Promise<Uint8Array> {
    expect([...aad]).toEqual([...(this.aadByKeyId.get(envelope.keyId) ?? [])])
    return new Uint8Array(this.plaintextByKeyId.get(envelope.keyId) ?? [])
  }

  async rotateKey(): Promise<{ previousKeyId: string; newKeyId: string }> {
    return { previousKeyId: 'test-old', newKeyId: 'test-new' }
  }
}

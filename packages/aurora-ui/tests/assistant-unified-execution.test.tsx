// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  MemoryLocalDataBackend,
  type EncryptedDataEnvelopeV1,
  type EnvelopeCryptoPort,
  type LocalDataKeyPurpose,
  type LocalDataSession,
} from '@aurora/client/local-data'

import { AssistantView } from '../src/assistant-view'
import type { LightweightAssistantDependencies } from '../src/local-assistant/lightweight-assistant'
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
})

describe('unified Assistant execution controls', () => {
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
    const container = await renderUnifiedAssistant(new AuroraClient({ transport }), provider)

    await enterPrompt(container, 'first saved chat')
    await waitUntil(() => container.textContent?.includes('Reply to first saved chat') === true)
    const newConversation = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('New conversation'))
    if (!newConversation) throw new Error('missing new conversation button')
    await act(async () => {
      newConversation.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    await enterPrompt(container, 'second saved chat')
    await waitUntil(() => container.textContent?.includes('Reply to second saved chat') === true)
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
        return { type: 'message', content: 'Local setup response.' }
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
    await chooseModelSelectorItem('Executing locally', 'Dispatch to Home Aurora')
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
    expect(container.textContent).toContain('Home Aurora · llama-3-8b-instruct')

    const messagesAfterDispatch = await localData.conversations.listMessages(localConversationId!)
    expect(messagesAfterDispatch.map((message) => [message.role, message.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
      ['user', 'complete'],
      ['assistant', 'complete'],
    ])

    await chooseModelSelectorItem('Executing by dispatch to Home Aurora', 'Locally')
    expect(container.textContent).toContain('Local setup response.')
    expect(container.textContent).toContain('Answered by Home Aurora.')
    await enterPrompt(container, 'continue locally after dispatch')
    await waitUntil(() => providerCalls.length === 2)

    expect(providerCalls[1]?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'start a local-only chat'],
      ['assistant', 'Local setup response.'],
      ['user', 'answer on the connected device'],
      ['assistant', 'Answered by Home Aurora.'],
      ['user', 'continue locally after dispatch'],
    ])
    expect(container.textContent).toContain('Local setup response.')
    expect(container.textContent).toContain('Answered by Home Aurora.')
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
})

async function renderUnifiedAssistant(
  client: AuroraClient,
  provider: LightweightAssistantProvider,
  overrides: {
    tools?: LightweightToolClientPort
    availableTools?: readonly ToolingProjectionToolInfo[]
    localData?: LocalDataSession
  } = {},
): Promise<HTMLElement> {
  client.auth.setApiKeySystem()
  const localData = overrides.localData ?? await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
  const localAssistant: LightweightAssistantDependencies = {
    provider,
    tools: overrides.tools ?? unusedToolPort(),
    localData,
    envelopeCrypto: new TestEnvelopeCryptoPort(),
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
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

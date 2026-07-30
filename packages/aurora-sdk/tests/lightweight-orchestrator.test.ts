import { describe, expect, it, vi } from 'vitest'

import { MemoryLocalDataBackend, type LocalDataSession } from '../src/local-data/index.js'
import { LightweightOrchestratorError } from '../src/lightweight-orchestrator/limits.js'
import { createOpenAICompatibleToolProvider, parseOpenAICompatibleResponse } from '../src/lightweight-orchestrator/provider.js'
import { createLightweightOrchestrator } from '../src/lightweight-orchestrator/react-loop.js'
import type {
  LightweightAssistantProvider,
  LightweightToolClientPort,
  LightweightToolExecutionResponse
} from '../src/lightweight-orchestrator/types.js'
import type { JsonObject, ToolingPrepareExecutionRequest, ToolingPrepareExecutionResponse, ToolingProjectionToolInfo } from '../src/types.js'

describe('lightweight orchestrator', () => {
  it('completes a bounded local text turn and stores scoped conversation state', async () => {
    const session = await dataSession()
    const orchestrator = createLightweightOrchestrator({
      provider: sequenceProvider([{ type: 'message', content: 'done on device' }]),
      tools: toolPort(),
      localData: session,
      scope,
      availableTools: [tool('local.echo', 'local')]
    })

    const result = await orchestrator.runTurn({ text: 'hello' })

    expect(result).toMatchObject({ status: 'completed', assistantText: 'done on device' })
    const conversations = await session.conversations.listConversations()
    const messages = await session.conversations.listMessages(result.conversationId)
    expect(conversations[0]).toMatchObject({ profileId: 'profile-1', localNodeId: 'node-1' })
    expect(messages.map((message) => [message.role, message.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete']
    ])
  })

  it('runs a remote mesh tool only through prepare and execute', async () => {
    const calls: string[] = []
    const session = await dataSession()
    const orchestrator = createLightweightOrchestrator({
      provider: sequenceProvider([
        { type: 'tool_calls', toolCalls: [{ id: 'call-1', toolName: 'remote.search', arguments: { q: 'x' }, route: 'remote' }] },
        { type: 'message', content: 'remote result' }
      ]),
      tools: toolPort({ calls }),
      localData: session,
      scope,
      availableTools: [tool('remote.search', 'remote')]
    })

    await expect(orchestrator.runTurn({ text: 'search' })).resolves.toMatchObject({
      status: 'completed',
      assistantText: 'remote result'
    })
    expect(calls).toEqual(['prepare:remote.search:remote', 'execute:remote.search:remote'])
  })

  it('runs mixed local and remote tool turns through the Tooling API port', async () => {
    const calls: string[] = []
    const session = await dataSession()
    const orchestrator = createLightweightOrchestrator({
      provider: sequenceProvider([
        {
          type: 'tool_calls',
          toolCalls: [
            { id: 'local-call', toolName: 'local.echo', arguments: { text: 'a' }, route: 'local' },
            { id: 'remote-call', toolName: 'remote.search', arguments: { q: 'b' }, route: 'remote' }
          ]
        },
        { type: 'message', content: 'mixed' }
      ]),
      tools: toolPort({ calls }),
      localData: session,
      scope,
      availableTools: [tool('local.echo', 'local'), tool('remote.search', 'remote')]
    })

    await expect(orchestrator.runTurn({ text: 'both' })).resolves.toMatchObject({ status: 'completed', assistantText: 'mixed' })
    expect(calls).toEqual([
      'prepare:local.echo:local',
      'execute:local.echo:local',
      'prepare:remote.search:remote',
      'execute:remote.search:remote'
    ])
  })

  it('emits confirmation, denies without execute, and rejects token replay', async () => {
    const calls: string[] = []
    const session = await dataSession()
    const orchestrator = createLightweightOrchestrator({
      provider: sequenceProvider([
        { type: 'tool_calls', toolCalls: [{ id: 'danger', toolName: 'local.delete', arguments: { id: '1' }, route: 'local' }] }
      ]),
      tools: toolPort({ calls, approvalRequired: true }),
      localData: session,
      scope,
      availableTools: [tool('local.delete', 'local', { confirmation_required: true })],
      ids: idSequence('1', '2', '3', '4')
    })

    const pending = await orchestrator.runTurn({ text: 'delete' })
    expect(pending.status).toBe('awaiting_confirmation')
    expect(pending.confirmation).toMatchObject({ secretsRedacted: true })

    await expect(orchestrator.resumeConfirmation({ token: pending.confirmation!.token, decision: 'deny' })).resolves.toMatchObject({
      status: 'cancelled'
    })
    expect(calls).toEqual(['prepare:local.delete:local'])
    await expect(orchestrator.resumeConfirmation({ token: pending.confirmation!.token, decision: 'approve' })).rejects.toMatchObject({
      reasonCode: 'confirmation_token_replayed'
    })
  })

  it('approves a confirmation exactly once and resumes provider completion', async () => {
    const calls: string[] = []
    const session = await dataSession()
    const orchestrator = createLightweightOrchestrator({
      provider: sequenceProvider([
        { type: 'tool_calls', toolCalls: [{ id: 'danger', toolName: 'local.delete', arguments: { id: '1' }, route: 'local' }] },
        { type: 'message', content: 'deleted' }
      ]),
      tools: toolPort({ calls, approvalRequired: true }),
      localData: session,
      scope,
      availableTools: [tool('local.delete', 'local', { confirmation_required: true })],
      ids: idSequence('1', '2', '3', '4', '5', '6')
    })

    const pending = await orchestrator.runTurn({ text: 'delete' })
    await expect(orchestrator.resumeConfirmation({ token: pending.confirmation!.token, decision: 'approve' })).resolves.toMatchObject({
      status: 'completed',
      assistantText: 'deleted'
    })
    expect(calls).toEqual(['prepare:local.delete:local', 'execute:local.delete:local'])
  })

  it('fails closed for each configured limit class', async () => {
    const session = await dataSession()
    expect(() => createLightweightOrchestrator({
      provider: sequenceProvider([]),
      tools: toolPort(),
      localData: session,
      scope,
      availableTools: Array.from({ length: 33 }, (_, index) => tool(`local.${index}`, 'local'))
    })).toThrow(LightweightOrchestratorError)

    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'message', content: 'x' }]), session, { maxPromptBytes: 1 }).runTurn({ text: 'wide' }))
      .rejects.toMatchObject({ reasonCode: 'prompt_too_large' })

    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'tool_calls', toolCalls: [{ id: 'a', toolName: 'local.echo', arguments: { text: 'x'.repeat(17 * 1024) }, route: 'local' }] }]), session).runTurn({ text: 'x' }))
      .rejects.toMatchObject({ reasonCode: 'tool_arguments_too_large' })

    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'message', content: 'x'.repeat(257 * 1024) }]), session).runTurn({ text: 'x' }))
      .rejects.toMatchObject({ reasonCode: 'provider_response_too_large' })

    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'tool_calls', toolCalls: [
      { id: 'a', toolName: 'local.echo', arguments: {}, route: 'local' },
      { id: 'b', toolName: 'local.echo', arguments: {}, route: 'local' },
      { id: 'c', toolName: 'local.echo', arguments: {}, route: 'local' },
      { id: 'd', toolName: 'local.echo', arguments: {}, route: 'local' },
      { id: 'e', toolName: 'local.echo', arguments: {}, route: 'local' }
    ] }]), session).runTurn({ text: 'x' })).rejects.toMatchObject({ reasonCode: 'tool_iteration_limit_exceeded' })
  })

  it('fails closed for malformed, duplicate, unknown, unsafe, ambiguous, and Python-only routes', async () => {
    const session = await dataSession()
    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'tool_calls', toolCalls: [
      { id: 'dup', toolName: 'local.echo', arguments: {}, route: 'local' },
      { id: 'dup', toolName: 'local.echo', arguments: {}, route: 'local' }
    ] }]), session).runTurn({ text: 'x' })).rejects.toMatchObject({ reasonCode: 'duplicate_tool_call_id' })

    await expect(orchestratorWithProvider(sequenceProvider([{ type: 'tool_calls', toolCalls: [{ id: 'a', toolName: 'missing', arguments: {}, route: 'local' }] }]), session).runTurn({ text: 'x' }))
      .rejects.toMatchObject({ reasonCode: 'unknown_tool_id' })

    expect(() => createLightweightOrchestrator({
      provider: sequenceProvider([]),
      tools: toolPort(),
      localData: session,
      scope,
      availableTools: [tool('*', 'local')]
    })).toThrow(LightweightOrchestratorError)

    expect(() => createLightweightOrchestrator({
      provider: sequenceProvider([]),
      tools: toolPort(),
      localData: session,
      scope,
      availableTools: [tool('same', 'local'), tool('same', 'remote')]
    })).toThrow(LightweightOrchestratorError)

    expect(() => createLightweightOrchestrator({
      provider: sequenceProvider([]),
      tools: toolPort(),
      localData: session,
      scope,
      availableTools: [tool('python.rag.search', 'local')]
    })).toThrow(LightweightOrchestratorError)

    expect(() => parseOpenAICompatibleResponse({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 't', arguments: '[]' } }] } }] }))
      .toThrow(LightweightOrchestratorError)
  })

  it('cancels during provider calls and tool execution with redacted diagnostics', async () => {
    const session = await dataSession()
    const abort = new AbortController()
    const provider: LightweightAssistantProvider = {
      async complete({ signal }) {
        abort.abort()
        await Promise.resolve()
        if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
        return { type: 'message', content: 'late' }
      }
    }

    await expect(orchestratorWithProvider(provider, session).runTurn({ text: 'x', signal: abort.signal })).resolves.toMatchObject({
      status: 'cancelled',
      diagnostics: { secretsRedacted: true, reasonCode: 'turn_cancelled' }
    })

    const toolAbort = new AbortController()
    const toolSession = await dataSession()
    const running = orchestratorWithProvider(sequenceProvider([{ type: 'tool_calls', toolCalls: [{ id: 'a', toolName: 'local.echo', arguments: {}, route: 'local' }] }]), toolSession, {}, toolPort({
      execute: async () => {
        toolAbort.abort()
        throw new DOMException('cancelled', 'AbortError')
      }
    })).runTurn({ text: 'x', signal: toolAbort.signal })
    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('uses injected timers for provider timeout', async () => {
    vi.useFakeTimers()
    try {
      const session = await dataSession()
      const provider: LightweightAssistantProvider = {
        async complete({ signal }) {
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true })
          })
          return { type: 'message', content: 'late' }
        }
      }
      const promise = orchestratorWithProvider(provider, session, { providerCallTimeoutMs: 10 }).runTurn({ text: 'x' })
      await vi.advanceTimersByTimeAsync(11)
      await expect(promise).resolves.toMatchObject({ status: 'cancelled' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks stale pending local work cancelled on restart recovery', async () => {
    const session = await dataSession()
    await session.conversations.upsertConversation({
      id: 'conversation-1',
      profileId: scope.profileId,
      localNodeId: scope.localNodeId,
      titleEnvelope: null,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      archivedAtMs: null
    })
    await session.conversations.appendMessage({
      id: 'message-pending',
      conversationId: 'conversation-1',
      sequence: 0,
      role: 'tool',
      contentEnvelope: null,
      toolEnvelope: null,
      status: 'pending',
      createdAtMs: 1000
    })

    const recovery = await orchestratorWithProvider(sequenceProvider([]), session).recoverStalePending()

    expect(recovery).toEqual({ cancelledMessages: 1, conversationIds: ['conversation-1'] })
    await expect(session.conversations.listMessages('conversation-1')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'system', status: 'cancelled' })
    ]))
  })

  it('keeps profile and local node selectors isolated', async () => {
    const backend = new MemoryLocalDataBackend()
    const session = await backend.open('profile-1', 'node-1')
    const orchestrator = orchestratorWithProvider(sequenceProvider([{ type: 'message', content: 'ok' }]), session)
    await orchestrator.runTurn({ text: 'x', conversationId: 'conversation-1' })

    await expect(backend.open('profile-2', 'node-1')).rejects.toThrow()
  })

  it('builds an OpenAI-compatible fetch provider without adding SDK dependencies', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'hello' } }]
      }), { status: 200 })
    })
    const provider = createOpenAICompatibleToolProvider({
      endpoint: 'https://example.invalid/v1/chat/completions',
      model: 'model',
      fetch: fetchMock as typeof fetch
    })

    await expect(provider.complete({ messages: [], tools: [], maxToolCalls: 1, signal: new AbortController().signal })).resolves.toEqual({
      type: 'message',
      content: 'hello'
    })
  })
})

const scope = Object.freeze({ profileId: 'profile-1', localNodeId: 'node-1' })

async function dataSession(): Promise<LocalDataSession> {
  return await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
}

function orchestratorWithProvider(
  provider: LightweightAssistantProvider,
  session: LocalDataSession,
  limits: Record<string, number> = {},
  tools: LightweightToolClientPort = toolPort()
) {
  return createLightweightOrchestrator({
    provider,
    tools,
    localData: session,
    scope,
    availableTools: [tool('local.echo', 'local')],
    limits,
    ids: idSequence('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
  })
}

function sequenceProvider(responses: Awaited<ReturnType<LightweightAssistantProvider['complete']>>[]): LightweightAssistantProvider {
  const queue = [...responses]
  return {
    async complete() {
      const response = queue.shift()
      if (!response) throw new LightweightOrchestratorError('provider_response_malformed')
      return response
    }
  }
}

function toolPort(options: {
  calls?: string[]
  approvalRequired?: boolean
  execute?: (payload: ToolingPrepareExecutionRequest) => Promise<LightweightToolExecutionResponse>
} = {}): LightweightToolClientPort {
  return {
    async prepareExecution(payload) {
      const request = payload as ToolingPrepareExecutionRequest
      options.calls?.push(`prepare:${request.tool_name}:${selectorLocation(request.resource_selector)}`)
      return prepareResponse(request, options.approvalRequired === true)
    },
    async execute(payload) {
      const request = payload as ToolingPrepareExecutionRequest
      options.calls?.push(`execute:${request.tool_name}:${selectorLocation(request.resource_selector)}`)
      if (options.execute) return await options.execute(request)
      return {
        ok: true,
        data: { value: request.tool_name },
        error: null,
        error_code: null,
        status: 'success',
        correlation_id: request.correlation_id ?? null,
        provider_peer_id: selectorLocation(request.resource_selector) === 'remote' ? 'peer-python' : 'node-1',
        global_tool_id: request.tool_name
      }
    }
  }
}

function prepareResponse(request: ToolingPrepareExecutionRequest, approvalRequired: boolean): ToolingPrepareExecutionResponse {
  return {
    ok: true,
    policy_decision: {
      allowed: true,
      share: true,
      approval_required: approvalRequired,
      approval_mode: approvalRequired ? 'ask_each_time' : 'approve_all_local_safe',
      decision_id: `decision-${request.tool_name}`,
      reason: null,
      token_ttl_seconds: 300
    },
    args_hash: `args-${request.tool_name}`,
    resource_selector_hash: `selector-${request.tool_name}`,
    route_decision_id: `route-${request.tool_name}`,
    correlation_id: request.correlation_id ?? `corr-${request.tool_name}`,
    provider_peer_id: selectorLocation(request.resource_selector) === 'remote' ? 'peer-python' : 'node-1',
    provider_service_instance_id: selectorLocation(request.resource_selector) === 'remote' ? 'python:Tooling' : 'local:Tooling',
    global_tool_id: request.tool_name,
    local_tool_name: request.tool_name,
    args_schema_hash: 'a'.repeat(64),
    source: selectorLocation(request.resource_selector) === 'remote' ? 'mesh_peer' : 'core',
    source_id: 'source-1',
    trust_tier: approvalRequired ? 'untrusted' : 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    display_args_preview: {},
    argument_visibility: {},
    secrets_redacted: true
  }
}

function selectorLocation(selector: JsonObject | null | undefined): string {
  const value = selector?.execution_location
  return typeof value === 'string' ? value : 'none'
}

function tool(
  name: string,
  executionLocation: 'local' | 'remote',
  overrides: Partial<ToolingProjectionToolInfo> = {}
): ToolingProjectionToolInfo {
  return {
    name,
    local_name: name,
    global_tool_id: `aurora-tool:v1:${executionLocation}:${name}`,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: `contract.${name}`,
    share_group_id: `group.${name}`,
    share_group_label: name,
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: executionLocation === 'local' ? 'node-1' : 'peer-python',
    provider_service_instance_id: executionLocation === 'local' ? 'local:Tooling' : 'python:Tooling',
    provider_label: null,
    provider_granted_permissions: null,
    provider_available: true,
    namespace: executionLocation === 'local' ? 'node-1' : 'peer-python',
    display_name: name,
    aliases: [],
    description: name,
    args_schema: { type: 'object' },
    schema: { type: 'object' },
    argument_visibility: {},
    source_type: executionLocation === 'local' ? 'local' : 'mesh_peer',
    source: executionLocation === 'local' ? 'core' : 'mesh_peer',
    source_id: `${executionLocation}:source`,
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: executionLocation,
    safety_class: 'safe',
    risk_class: 'safe',
    data_egress: executionLocation === 'remote',
    mutating: false,
    external: executionLocation === 'remote',
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: false,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: executionLocation === 'local' ? 'node-1' : 'peer-python',
      provider_service_instance_id: executionLocation === 'local' ? 'local:Tooling' : 'python:Tooling',
      provider_kind: executionLocation === 'local' ? 'local' : 'mesh_peer',
      source: executionLocation === 'local' ? 'core' : 'mesh_peer',
      advertised_name: name
    },
    ...overrides
  }
}

function idSequence(...values: string[]): () => string {
  const queue = [...values]
  let index = 0
  return () => queue.shift() ?? `generated-${index++}`
}

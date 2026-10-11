import { describe, expect, it, vi } from 'vitest'
import type { ToolApprovalConfirmRequest } from '../src/admin.js'
import { MemoryLocalDataBackend } from '../src/local-data/index.js'
import { createLightweightOrchestrator } from '../src/lightweight-orchestrator/react-loop.js'
import type { LightweightProviderRequest } from '../src/lightweight-orchestrator/types.js'
import type { LocalInferenceCompletionRequest, LocalInferenceSessionPort } from '../src/local-inference/types.js'
import { createLocalInferenceProvider } from '../src/local-inference/provider.js'
import { createLocalCompositeProvider } from '../src/local-inference/composite-provider.js'
import type {
  JsonObject,
  ToolingPrepareExecutionRequest,
  ToolingPrepareExecutionResponse,
  ToolingProjectionToolInfo
} from '../src/types.js'

const scope = { profileId: 'profile-local', localNodeId: 'node-local' }

describe('local inference provider', () => {
  it('asks for clarification instead of proposing a low-confidence local action', async () => {
    const client: LocalInferenceSessionPort = {
      isReady: () => true,
      complete: async () => ({
        type: 'tool_calls', content: '', confidence: 0.6,
        toolCalls: [{ name: 'save_note', arguments: { value: 'note' } }]
      })
    }
    const provider = createLocalInferenceProvider({ client, modelId: 'actions-on-device', sessionId: 'actions' })
    const response = await provider.complete({
      messages: [{ role: 'user', content: 'Save a note' }], tools: [], maxToolCalls: 1,
      signal: new AbortController().signal
    })
    expect(response).toEqual({
      type: 'message', content: 'Please clarify what you want to do, or ask a connected Aurora device.'
    })
  })

  it('completes an offline answer only through the explicitly ready selected session', async () => {
    const completionRequests: LocalInferenceCompletionRequest[] = []
    const signal = new AbortController().signal
    let ready = true
    const client: LocalInferenceSessionPort = {
      isReady: vi.fn((modelId, sessionId) => ready && modelId === 'chat-on-device' && sessionId === 'conversation-1'),
      async complete(request, receivedSignal) {
        completionRequests.push(request)
        expect(receivedSignal).toBe(signal)
        return { type: 'message', content: 'This answer came from the selected on-device session.' }
      }
    }
    const provider = createLocalInferenceProvider({
      client,
      modelId: 'chat-on-device',
      sessionId: 'conversation-1',
      completionOptions: { maxTokens: 384, temperature: 0.1, stopSequences: ['<end>'] }
    })

    const providerRequest: LightweightProviderRequest = {
      messages: [{ role: 'user', content: 'How does this work offline?' }],
      tools: [],
      maxToolCalls: 4,
      modelId: null,
      providerId: null,
      signal
    }
    const response = await provider.complete(providerRequest)

    expect(response).toEqual({ type: 'message', content: 'This answer came from the selected on-device session.' })
    expect(client.isReady).toHaveBeenCalledWith('chat-on-device', 'conversation-1')
    expect(completionRequests).toEqual([{
      modelId: 'chat-on-device',
      sessionId: 'conversation-1',
      messages: [{ role: 'user', content: 'How does this work offline?' }],
      options: { maxTokens: 384, temperature: 0.1, forceTools: false, stopSequences: ['<end>'] }
    }])

    ready = false
    await expect(provider.complete(providerRequest)).rejects.toMatchObject({ reasonCode: 'unavailable_service' })
    expect(completionRequests).toHaveLength(1)
  })

  it('runs a local tool only after approval and resumes with serialized tool history', async () => {
    const session = await new MemoryLocalDataBackend().open(scope.profileId, scope.localNodeId)
    const localTool = toolInfo()
    const peerTool = {
      ...localTool,
      name: 'weather.lookup',
      local_name: 'weather.lookup',
      global_tool_id: 'aurora-tool:v1:peer:weather.lookup',
      provider_peer_id: 'peer-remote',
      provider_service_instance_id: 'remote:Tooling',
      namespace: 'peer-remote',
      display_name: 'Remote weather',
      source_type: 'mesh_peer' as const,
      source: 'mesh_peer' as const,
      source_id: 'remote-weather',
      execution_location: 'remote' as const,
      data_egress: true,
      external: true,
      provenance: {
        provider_peer_id: 'peer-remote',
        provider_service_instance_id: 'remote:Tooling',
        provider_kind: 'mesh_peer' as const,
        source: 'mesh_peer' as const,
        advertised_name: 'weather.lookup'
      }
    }
    const receivedRequests: LocalInferenceCompletionRequest[] = []
    let toolAlias: string | undefined
    const client: LocalInferenceSessionPort = {
      isReady: () => true,
      async complete(request) {
        receivedRequests.push(request)
        expect(request.tools).toHaveLength(1)
        expect(request.tools?.[0]?.function.description).toBe(localTool.description)
        toolAlias = request.tools?.[0]?.function.name
        if (!toolAlias) throw new Error('The selected local tool was not passed to inference')
        if (receivedRequests.length > 1) {
          return { type: 'message', content: '', confidence: 0.94 }
        }
        return {
          type: 'tool_calls',
          content: '',
          confidence: 0.94,
          toolCalls: [{ name: toolAlias, arguments: { value: 'note' } }]
        }
      }
    }
    const executionCalls: string[] = []
    const composite = createLocalCompositeProvider({
      client,
      actions: { modelId: 'actions-on-device', sessionId: 'conversation-actions' },
      ids: () => 'local-call-1'
    })
    const turnSignals: Array<AbortSignal | undefined> = []
    const provider = {
      complete(request: LightweightProviderRequest) {
        turnSignals.push(request.turnSignal)
        return composite.complete(request)
      }
    }
    const orchestrator = createLightweightOrchestrator({
      provider,
      tools: {
        async prepareExecution(request) {
          executionCalls.push('prepare')
          return prepared(request)
        },
        async requestApproval() {
          executionCalls.push('approval')
          return {
            ok: true,
            approval_request_id: 'approval-1',
            policy_decision: { decision_id: 'decision-1', allowed: false, approval_required: true },
            expires_at: Date.now() + 60_000,
            correlation_id: 'correlation-1',
            error: null
          }
        },
        async confirmExecution(request: ToolApprovalConfirmRequest) {
          executionCalls.push('confirm')
          expect(request).toMatchObject({
            approval_request_id: 'approval-1',
            approve: true,
            grant_scope: 'once'
          })
          return {
            ok: true,
            approval_token: 'approved-token',
            expires_at: Math.floor(Date.now() / 1_000) + 60,
            policy_decision_id: 'decision-1',
            correlation_id: 'correlation-1',
            error: null
          }
        },
        async execute(request) {
          executionCalls.push('execute')
          expect(request.approval_token).toBe('approved-token')
          expect(request.confirmed).toBe(true)
          return {
            ok: true,
            data: { saved: true },
            error: null,
            error_code: null,
            status: 'success',
            correlation_id: request.correlation_id ?? null,
            provider_peer_id: 'node-local',
            global_tool_id: request.tool_name
          }
        }
      },
      localData: session,
      scope,
      availableTools: [localTool, peerTool],
      ids: () => 'turn-1'
    })

    try {
      const result = await orchestrator.runTurn({ text: 'save a note' })
      expect(result.status).toBe('awaiting_confirmation')
      expect(result.confirmation?.toolCall).toMatchObject({
        toolName: localTool.global_tool_id,
        providerToolName: toolAlias,
        route: 'local',
        arguments: { value: 'note' }
      })
      expect(receivedRequests[0]).toMatchObject({
        modelId: 'actions-on-device',
        sessionId: 'conversation-actions',
        tools: [{ type: 'function', function: { description: localTool.description, parameters: localTool.args_schema } }]
      })
      expect(executionCalls).toEqual(['prepare', 'approval'])
      expect(turnSignals[0]?.aborted).toBe(false)

      const resumed = await orchestrator.resumeConfirmation({
        token: result.confirmation!.token,
        decision: 'approve'
      })
      expect(resumed).toMatchObject({
        status: 'completed',
        assistantText: 'Done — 1 action completed.'
      })
      expect(executionCalls).toEqual(['prepare', 'approval', 'confirm', 'execute'])
      expect(receivedRequests).toHaveLength(2)
      expect(turnSignals).toHaveLength(2)
      expect(turnSignals[0]).toBeDefined()
      expect(turnSignals[1]).toBe(turnSignals[0])
      expect(turnSignals[0]?.aborted).toBe(true)
      expect(receivedRequests[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [{
            id: 'local-call-1',
            type: 'function',
            function: { name: toolAlias, arguments: '{"value":"note"}' }
          }]
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'local-call-1',
          name: toolAlias,
          content: expect.stringContaining('"saved":true')
        })
      ]))
    } finally {
      orchestrator.cancel()
      await session.close()
    }
  })
})

function prepared(request: ToolingPrepareExecutionRequest): ToolingPrepareExecutionResponse {
  return {
    ok: false,
    policy_decision: {
      allowed: false,
      share: true,
      approval_required: true,
      approval_mode: 'ask_each_time',
      decision_id: 'decision-1',
      reason: 'approval_token_required',
      token_ttl_seconds: 60
    },
    args_hash: 'args-hash',
    resource_selector_hash: 'selector-hash',
    route_decision_id: 'route-1',
    correlation_id: 'correlation-1',
    provider_peer_id: 'node-local',
    provider_service_instance_id: 'local:Tooling',
    global_tool_id: request.tool_name,
    local_tool_name: 'notes.create',
    args_schema_hash: 'schema-hash',
    source: 'core',
    trust_tier: 'untrusted',
    capability_class: 'utility',
    resource_scope: [],
    display_args_preview: {},
    argument_visibility: {},
    secrets_redacted: true
  }
}

function toolInfo(): ToolingProjectionToolInfo {
  const globalToolId = 'aurora-tool:v1:local:notes.create'
  const argsSchema: JsonObject = { type: 'object', properties: { value: { type: 'string' } } }
  return {
    name: 'notes.create',
    local_name: 'notes.create',
    global_tool_id: globalToolId,
    tool_id_scheme: 'aurora-tool',
    tool_id_version: 1,
    tool_contract_id: 'contract.notes.create',
    share_group_id: 'group.notes',
    share_group_label: 'Notes',
    legacy_global_tool_ids: [],
    exportable: true,
    provider_peer_id: 'node-local',
    provider_service_instance_id: 'local:Tooling',
    provider_label: null,
    provider_granted_permissions: null,
    provider_available: true,
    namespace: 'node-local',
    display_name: 'Create note',
    aliases: [],
    description: 'Create a note on this device',
    args_schema: argsSchema,
    schema: argsSchema,
    argument_visibility: {},
    source_type: 'local',
    source: 'core',
    source_id: 'notes',
    trust_tier: 'trusted',
    capability_class: 'utility',
    resource_scope: [],
    execution_location: 'local',
    safety_class: 'safe',
    risk_class: 'safe',
    data_egress: false,
    mutating: true,
    external: false,
    admin: false,
    privacy_hints: [],
    required_permissions: ['Tooling.ExecuteTool'],
    confirmation_required: true,
    rate_limit_hints: null,
    provenance: {
      provider_peer_id: 'node-local',
      provider_service_instance_id: 'local:Tooling',
      provider_kind: 'local',
      source: 'core',
      advertised_name: 'notes.create'
    }
  }
}

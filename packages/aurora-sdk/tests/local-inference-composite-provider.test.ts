import { describe, expect, it, vi } from 'vitest'
import type { LightweightProviderRequest } from '../src/lightweight-orchestrator/types.js'
import { createLocalCompositeProvider } from '../src/local-inference/composite-provider.js'
import type { LocalInferenceCompletionRequest, LocalInferenceSessionPort } from '../src/local-inference/types.js'
import type { JsonObject, ToolingProjectionToolInfo } from '../src/types.js'

describe('local composite inference provider', () => {
  it('keeps an action proposal and its tool-result follow-up on the actions session', async () => {
    const localTool = toolInfo()
    const completions: LocalInferenceCompletionRequest[] = []
    const client: LocalInferenceSessionPort = {
      isReady: vi.fn(async () => true),
      async complete(request) {
        completions.push(request)
        if (completions.length > 1) return { type: 'message', content: 'The approved action is complete.' }
        const alias = request.tools?.[0]?.function.name
        if (!alias) throw new Error('Action declaration was not passed to the selected session')
        return {
          type: 'tool_calls',
          content: '',
          toolCalls: [{ name: alias, arguments: { value: 'note' } }]
        }
      }
    }
    const provider = createLocalCompositeProvider({
      client,
      actions: { modelId: 'actions-on-device', sessionId: 'actions-session' },
      chat: { modelId: 'chat-on-device', sessionId: 'chat-session' },
      ids: () => 'action-call-1'
    })
    const firstRequest = providerRequest('Save this note.', [localTool])

    const proposed = await provider.complete(firstRequest)
    expect(proposed.type).toBe('tool_calls')
    if (proposed.type !== 'tool_calls') throw new Error('Expected an action proposal')
    expect(proposed.toolCalls).toMatchObject([{
      id: 'action-call-1',
      toolName: localTool.global_tool_id,
      route: 'local',
      arguments: { value: 'note' }
    }])
    expect(completions[0]).toMatchObject({
      modelId: 'actions-on-device',
      sessionId: 'actions-session'
    })

    const action = proposed.toolCalls[0]!
    const resumed = await provider.complete({
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        { role: 'assistant', content: '', toolCalls: proposed.toolCalls },
        {
          role: 'tool',
          toolCallId: action.id,
          name: action.providerToolName ?? action.toolName,
          content: JSON.stringify({ ok: true, data: { saved: true } })
        }
      ]
    })

    expect(resumed).toEqual({ type: 'message', content: 'The approved action is complete.' })
    expect(completions).toHaveLength(2)
    expect(completions.map(({ sessionId }) => sessionId)).toEqual(['actions-session', 'actions-session'])
    expect(completions[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        tool_calls: [{
          id: 'action-call-1',
          type: 'function',
          function: { name: action.providerToolName, arguments: '{"value":"note"}' }
        }]
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'action-call-1',
        name: action.providerToolName,
        content: expect.stringContaining('"saved":true')
      })
    ]))
  })

  it('uses chat for QA and degrades to the sole ready session', async () => {
    const completions: LocalInferenceCompletionRequest[] = []
    let chatReady = true
    const client: LocalInferenceSessionPort = {
      async isReady(modelId, sessionId) {
        if (modelId === 'actions-on-device' && sessionId === 'actions-session') return true
        if (modelId === 'chat-on-device' && sessionId === 'chat-session') return chatReady
        return false
      },
      async complete(request) {
        completions.push(request)
        return { type: 'message', content: 'An offline answer.' }
      }
    }
    const provider = createLocalCompositeProvider({
      client,
      actions: { modelId: 'actions-on-device', sessionId: 'actions-session' },
      chat: { modelId: 'chat-on-device', sessionId: 'chat-session' }
    })

    await expect(provider.complete(providerRequest('What is a local session?'))).resolves.toEqual({
      type: 'message', content: 'An offline answer.'
    })
    expect(completions[0]).toMatchObject({ modelId: 'chat-on-device', sessionId: 'chat-session' })

    chatReady = false
    await expect(provider.complete(providerRequest('Explain this offline.'))).resolves.toEqual({
      type: 'message', content: 'An offline answer.'
    })
    expect(completions[1]).toMatchObject({ modelId: 'actions-on-device', sessionId: 'actions-session' })
  })
})

function providerRequest(
  text: string,
  tools: readonly ToolingProjectionToolInfo[] = []
): LightweightProviderRequest & { readonly turnSignal: AbortSignal } {
  return {
    messages: [{ role: 'user', content: text }],
    tools,
    maxToolCalls: 4,
    modelId: null,
    providerId: null,
    signal: new AbortController().signal,
    turnSignal: new AbortController().signal
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

import type { JsonObject } from '../types.js'
import {
  buildOpenAIToolAliases,
  serializeProviderMessages,
  type OpenAIToolAliasMap
} from '../lightweight-orchestrator/provider.js'
import {
  assertSerializedBound,
  DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS,
  LightweightOrchestratorError,
  type LightweightOrchestratorLimits
} from '../lightweight-orchestrator/limits.js'
import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse,
  LightweightToolCall
} from '../lightweight-orchestrator/types.js'
import type {
  LocalInferenceCompletionOptions,
  LocalInferenceCompletionRequest,
  LocalInferenceSessionPort,
  LocalInferenceToolDeclaration
} from './types.js'

export interface LocalInferenceProviderOptions {
  readonly client: LocalInferenceSessionPort
  readonly modelId: string
  readonly sessionId: string
  readonly ids?: () => string
  readonly completionOptions?: LocalInferenceCompletionOptions
  readonly limits?: Partial<LightweightOrchestratorLimits>
}

export const LOCAL_ACTIONS_CONFIDENCE_THRESHOLD = 0.8

/** Adapts one explicitly ready local engine session to the existing assistant provider contract. */
export function createLocalInferenceProvider(options: LocalInferenceProviderOptions): LightweightAssistantProvider {
  const limits = { ...DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS, ...options.limits }
  const completionOptions: LocalInferenceCompletionOptions = {
    maxTokens: options.completionOptions?.maxTokens ?? 512,
    temperature: options.completionOptions?.temperature ?? 0.2,
    forceTools: options.completionOptions?.forceTools ?? false,
    ...(options.completionOptions?.toolRagTopK === undefined ? {} : { toolRagTopK: options.completionOptions.toolRagTopK }),
    ...(options.completionOptions?.stopSequences === undefined ? {} : { stopSequences: options.completionOptions.stopSequences })
  }

  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      if (request.signal.aborted) throw cancelled()
      const modelId = request.modelId ?? options.modelId
      const localTools = request.tools.filter(isAllowedLocalExecutionTool)
      const aliases = buildOpenAIToolAliases(localTools)
      const localRequest: LocalInferenceCompletionRequest = {
        modelId,
        sessionId: options.sessionId,
        messages: serializeProviderMessages(request.messages, aliases),
        ...(localTools.length === 0 ? {} : { tools: serializeTools(localTools, aliases) }),
        options: completionOptions
      }
      assertSerializedBound(localRequest, limits.maxProviderRequestBytes, 'provider_request_too_large')

      const ready = await options.client.isReady(modelId, options.sessionId)
      if (request.signal.aborted) throw cancelled()
      if (!ready) {
        throw new LightweightOrchestratorError('unavailable_service', 'Selected on-device assistant is unavailable')
      }

      let raw: unknown
      try {
        raw = await options.client.complete(localRequest, request.signal)
      } catch (error) {
        if (request.signal.aborted) throw cancelled()
        throw error
      }
      if (request.signal.aborted) throw cancelled()
      assertSerializedBound(raw, limits.maxProviderResponseBytes, 'provider_response_too_large')
      return mapResponse(raw, aliases, request, options.ids)
    }
  }
}

function serializeTools(
  tools: LightweightProviderRequest['tools'],
  aliases: OpenAIToolAliasMap
): LocalInferenceToolDeclaration[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: aliases.byGlobalToolId.get(tool.global_tool_id)?.alias ?? tool.global_tool_id,
      description: tool.description,
      parameters: tool.args_schema
    }
  }))
}

function mapResponse(
  raw: unknown,
  aliases: OpenAIToolAliasMap,
  request: LightweightProviderRequest,
  ids?: () => string
): LightweightProviderResponse {
  if (!isRecord(raw) || typeof raw.content !== 'string') {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  if (raw.confidence !== undefined && raw.confidence !== null &&
      (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1)) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  if (raw.type === 'message') {
    return { type: 'message', content: raw.content || summarizeToolResults(request.messages) }
  }
  if (raw.type !== 'tool_calls' || !Array.isArray(raw.toolCalls) || raw.toolCalls.length === 0 || raw.toolCalls.length > request.maxToolCalls) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  if (typeof raw.confidence === 'number' && raw.confidence < LOCAL_ACTIONS_CONFIDENCE_THRESHOLD) {
    return { type: 'message', content: 'Please clarify what you want to do, or ask a connected Aurora device.' }
  }
  return {
    type: 'tool_calls',
    content: raw.content,
    toolCalls: raw.toolCalls.map((call, index) => mapToolCall(call, index, aliases, ids))
  }
}

/** A terminal action model may return no prose; report only the actual results of this turn. */
function summarizeToolResults(messages: LightweightProviderRequest['messages']): string {
  let lastUserIndex = -1
  messages.forEach((message, index) => { if (message.role === 'user') lastUserIndex = index })
  let completed = 0
  let failed = 0
  for (const message of messages.slice(lastUserIndex + 1)) {
    if (message.role !== 'tool') continue
    try {
      const result: unknown = JSON.parse(message.content)
      if (isRecord(result) && result.ok === true) completed += 1
      else failed += 1
    } catch { failed += 1 }
  }
  if (completed === 0) return failed > 0 ? 'No actions were completed.' : 'I could not complete that request.'
  const successful = `${completed} ${completed === 1 ? 'action' : 'actions'} completed`
  return failed > 0 ? `${successful}; ${failed} could not be completed.` : `Done — ${successful}.`
}

function mapToolCall(
  raw: unknown,
  index: number,
  aliases: OpenAIToolAliasMap,
  ids?: () => string
): LightweightToolCall {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name || !isRecord(raw.arguments)) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const alias = aliases.byAlias.get(raw.name)
  if (!alias || alias.executionLocation !== 'local') {
    throw new LightweightOrchestratorError('python_only_tool_not_local', 'On-device assistant returned a tool that is not available locally')
  }
  return {
    id: ids?.() ?? `local:${index}:${crypto.randomUUID()}`,
    toolName: alias?.globalToolId ?? raw.name,
    providerToolName: raw.name,
    arguments: raw.arguments as JsonObject,
    route: 'local'
  }
}

function isAllowedLocalExecutionTool(
  tool: LightweightProviderRequest['tools'][number]
): boolean {
  return tool.execution_location === 'local' &&
    tool.source_type === 'local' &&
    tool.provider_available !== false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cancelled(): LightweightOrchestratorError {
  return new LightweightOrchestratorError('provider_call_cancelled')
}

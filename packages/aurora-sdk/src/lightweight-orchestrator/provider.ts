import type {
  JsonObject,
  OrchestratorInferChatRequest,
  OrchestratorInferChatResponse,
  ToolingProjectionToolInfo
} from '../types.js'
import {
  assertSerializedBound,
  assertTextBound,
  DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS,
  LightweightOrchestratorError,
  type LightweightOrchestratorLimits
} from './limits.js'
import type {
  LightweightAssistantProvider,
  LightweightProviderMessage,
  LightweightProviderRequest,
  LightweightProviderResponse,
  LightweightToolCall
} from './types.js'

const OPENAI_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface OpenAICompatibleProviderOptions {
  readonly endpoint: string
  readonly apiKey?: string
  readonly model: string
  readonly fetch?: typeof fetch
  readonly headers?: Record<string, string>
  readonly limits?: Partial<LightweightOrchestratorLimits>
}

export interface AuroraInferenceProviderOptions {
  readonly infer: (
    request: OrchestratorInferChatRequest,
    signal: AbortSignal
  ) => Promise<OrchestratorInferChatResponse>
  readonly providerId?: string | null
  readonly modelId?: string | null
  readonly limits?: Partial<LightweightOrchestratorLimits>
}

/**
 * Use a connected Aurora peer only for model inference while the lightweight
 * conversation loop and all tool decisions remain on this device.
 */
export function createAuroraInferenceProvider(
  options: AuroraInferenceProviderOptions
): LightweightAssistantProvider {
  const limits = { ...DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS, ...options.limits }
  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      if (request.signal.aborted) throw new LightweightOrchestratorError('provider_call_cancelled')
      const aliases = buildOpenAIToolAliases(request.tools)
      const payload: OrchestratorInferChatRequest = {
        messages: serializeProviderMessages(request.messages, aliases),
        stream: false,
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: aliases.byGlobalToolId.get(tool.global_tool_id)?.alias ?? tool.global_tool_id,
            description: tool.description,
            parameters: tool.args_schema
          }
        })),
        tool_choice: 'auto',
        metadata: {
          caller_runtime: 'lightweight',
          max_tool_calls: request.maxToolCalls
        },
        ...(request.providerId ?? options.providerId
          ? { provider_id: request.providerId ?? options.providerId! }
          : {}),
        ...(request.modelId ?? options.modelId
          ? { model_id: request.modelId ?? options.modelId! }
          : {})
      }
      assertSerializedBound(payload, limits.maxProviderRequestBytes, 'provider_request_too_large')
      const response = await options.infer(payload, request.signal)
      if (request.signal.aborted) throw new LightweightOrchestratorError('provider_call_cancelled')
      assertSerializedBound(response, limits.maxProviderResponseBytes, 'provider_response_too_large')
      return parseAuroraInferenceResponse(response, aliases.byAlias)
    }
  }
}

export function createOpenAICompatibleToolProvider(options: OpenAICompatibleProviderOptions): LightweightAssistantProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new LightweightOrchestratorError('provider_fetch_unavailable', 'Lightweight assistant provider fetch is unavailable')
  }
  const limits = { ...DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS, ...options.limits }
  return {
    async complete(request: LightweightProviderRequest): Promise<LightweightProviderResponse> {
      const aliases = buildOpenAIToolAliases(request.tools)
      const body = {
        model: options.model,
        messages: serializeProviderMessages(request.messages, aliases),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: aliases.byGlobalToolId.get(tool.global_tool_id)?.alias ?? tool.global_tool_id,
            description: tool.description,
            parameters: tool.args_schema
          }
        }))
      }
      assertSerializedBound(body, limits.maxProviderRequestBytes, 'provider_request_too_large')
      const response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers
        },
        body: JSON.stringify(body),
        signal: request.signal
      })
      if (!response.ok) {
        throw new LightweightOrchestratorError('provider_http_error', 'Lightweight assistant provider request failed', {
          status: response.status,
          secretsRedacted: true
        })
      }
      const raw = await response.text()
      assertTextBound(raw, limits.maxProviderResponseBytes, 'provider_response_too_large')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new LightweightOrchestratorError('provider_response_malformed')
      }
      return parseOpenAICompatibleResponse(parsed, aliases.byAlias)
    }
  }
}

export function parseOpenAICompatibleResponse(
  raw: unknown,
  aliases: ReadonlyMap<string, OpenAIToolAlias> = new Map()
): LightweightProviderResponse {
  if (raw === null || typeof raw !== 'object') {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const choice = Array.isArray((raw as { choices?: unknown }).choices)
    ? (raw as { choices: unknown[] }).choices[0]
    : undefined
  const message = choice && typeof choice === 'object'
    ? (choice as { message?: unknown }).message
    : undefined
  if (message === null || typeof message !== 'object') {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const content = typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content
    : ''
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls
  if (toolCalls === undefined || toolCalls === null) {
    return { type: 'message', content }
  }
  if (!Array.isArray(toolCalls)) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  return {
    type: 'tool_calls',
    content,
    toolCalls: toolCalls.map((toolCall) => parseOpenAIToolCall(toolCall, aliases))
  }
}

export function parseAuroraInferenceResponse(
  raw: OrchestratorInferChatResponse,
  aliases: ReadonlyMap<string, OpenAIToolAlias> = new Map()
): LightweightProviderResponse {
  if (raw === null || typeof raw !== 'object' || raw.secrets_redacted !== true) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const message = raw.message
  const content = typeof message?.content === 'string'
    ? message.content
    : typeof raw.text === 'string'
      ? raw.text
      : ''
  const toolCalls = message?.tool_calls
  if (toolCalls === undefined || toolCalls === null || toolCalls.length === 0) {
    return { type: 'message', content }
  }
  if (!Array.isArray(toolCalls)) throw new LightweightOrchestratorError('provider_response_malformed')
  return {
    type: 'tool_calls',
    content,
    toolCalls: toolCalls.map((toolCall) => parseAuroraToolCall(toolCall, aliases))
  }
}

function parseAuroraToolCall(
  raw: JsonObject,
  aliases: ReadonlyMap<string, OpenAIToolAlias>
): LightweightToolCall {
  const fn = isRecord(raw.function) ? raw.function : null
  const name = readString(raw.name) ?? readString(fn?.name)
  const id = readString(raw.id)
  const rawArgs = raw.args ?? raw.arguments ?? fn?.arguments
  if (!id || !name) throw new LightweightOrchestratorError('provider_response_malformed')
  const args = parseToolArguments(rawArgs)
  const alias = aliases.get(name)
  return {
    id,
    toolName: alias?.globalToolId ?? name,
    providerToolName: name,
    arguments: args,
    route: alias?.executionLocation ?? 'remote'
  }
}

function parseToolArguments(value: unknown): JsonObject {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new LightweightOrchestratorError('provider_response_malformed')
    }
  }
  if (!isRecord(parsed)) throw new LightweightOrchestratorError('provider_response_malformed')
  return parsed as JsonObject
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface OpenAIToolAlias {
  readonly alias: string
  readonly globalToolId: string
  readonly executionLocation: 'local' | 'remote'
}

export interface OpenAIToolAliasMap {
  readonly byAlias: ReadonlyMap<string, OpenAIToolAlias>
  readonly byGlobalToolId: ReadonlyMap<string, OpenAIToolAlias>
}

export function buildOpenAIToolAliases(tools: readonly ToolingProjectionToolInfo[]): OpenAIToolAliasMap {
  const byAlias = new Map<string, OpenAIToolAlias>()
  const byGlobalToolId = new Map<string, OpenAIToolAlias>()
  for (const tool of tools) {
    const alias = openAIToolAlias(tool.global_tool_id)
    const mapped: OpenAIToolAlias = {
      alias,
      globalToolId: tool.global_tool_id,
      executionLocation: tool.execution_location
    }
    const existing = byAlias.get(alias)
    if (existing && existing.globalToolId !== mapped.globalToolId) {
      throw new LightweightOrchestratorError('tool_alias_collision')
    }
    byAlias.set(alias, mapped)
    byGlobalToolId.set(tool.global_tool_id, mapped)
  }
  return { byAlias, byGlobalToolId }
}

function openAIToolAlias(globalToolId: string): string {
  const suffix = stableHash(globalToolId)
  const rawBase = globalToolId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  const base = rawBase.length > 0 ? rawBase : 'tool'
  const alias = `${base.slice(0, 55)}_${suffix}`
  if (!OPENAI_FUNCTION_NAME.test(alias)) throw new LightweightOrchestratorError('unsafe_tool_alias')
  return alias
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function serializeProviderMessages(
  messages: readonly LightweightProviderMessage[],
  aliases: OpenAIToolAliasMap
): OrchestratorInferChatRequest['messages'] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name
      ? { name: aliases.byGlobalToolId.get(message.name)?.alias ?? message.name }
      : {}),
    ...(message.toolCalls && message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.providerToolName
                ?? aliases.byGlobalToolId.get(toolCall.toolName)?.alias
                ?? toolCall.toolName,
              arguments: JSON.stringify(toolCall.arguments)
            }
          }))
        }
      : {})
  }))
}

function parseOpenAIToolCall(raw: unknown, aliases: ReadonlyMap<string, OpenAIToolAlias>): LightweightToolCall {
  if (raw === null || typeof raw !== 'object') {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const id = readString((raw as { id?: unknown }).id)
  const fn = (raw as { function?: unknown }).function
  if (!id || fn === null || typeof fn !== 'object') {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const toolName = readString((fn as { name?: unknown }).name)
  const argsText = readString((fn as { arguments?: unknown }).arguments)
  if (!toolName || argsText === null) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  let parsedArgs: unknown
  try {
    parsedArgs = JSON.parse(argsText) as unknown
  } catch {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  const alias = aliases.get(toolName)
  return {
    id,
    toolName: alias?.globalToolId ?? toolName,
    providerToolName: alias?.alias ?? toolName,
    arguments: parsedArgs as JsonObject,
    route: alias?.executionLocation ?? 'remote'
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

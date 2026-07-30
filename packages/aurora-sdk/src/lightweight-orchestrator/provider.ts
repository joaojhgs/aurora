import type { JsonObject } from '../types.js'
import {
  assertSerializedBound,
  assertTextBound,
  DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS,
  LightweightOrchestratorError,
  type LightweightOrchestratorLimits
} from './limits.js'
import type {
  LightweightAssistantProvider,
  LightweightProviderRequest,
  LightweightProviderResponse,
  LightweightToolCall
} from './types.js'
import type { ToolingProjectionToolInfo } from '../types.js'

const OPENAI_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface OpenAICompatibleProviderOptions {
  readonly endpoint: string
  readonly apiKey?: string
  readonly model: string
  readonly fetch?: typeof fetch
  readonly headers?: Record<string, string>
  readonly limits?: Partial<LightweightOrchestratorLimits>
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
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
          ...(message.name ? { name: message.name } : {})
        })),
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

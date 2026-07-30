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
            name: tool.local_name || tool.name,
            description: tool.description,
            parameters: tool.args_schema
          }
        }))
      }
      assertSerializedBound(body, limits.maxProviderResponseBytes, 'provider_request_too_large')
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
      return parseOpenAICompatibleResponse(JSON.parse(raw))
    }
  }
}

export function parseOpenAICompatibleResponse(raw: unknown): LightweightProviderResponse {
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
    toolCalls: toolCalls.map(parseOpenAIToolCall)
  }
}

function parseOpenAIToolCall(raw: unknown): LightweightToolCall {
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
  const parsedArgs = JSON.parse(argsText) as unknown
  if (parsedArgs === null || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
    throw new LightweightOrchestratorError('provider_response_malformed')
  }
  return {
    id,
    toolName,
    arguments: parsedArgs as JsonObject,
    route: 'remote'
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

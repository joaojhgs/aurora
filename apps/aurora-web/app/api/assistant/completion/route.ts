import { NextResponse, type NextRequest } from 'next/server'
import {
  DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS,
  LightweightOrchestratorError,
  assertSerializedBound,
  assertTextBound,
  createOpenAICompatibleToolProvider,
  type LightweightProviderMessage,
} from '@aurora/client/lightweight-orchestrator'
import type { ToolingProjectionToolInfo } from '@aurora/client'
import {
  assistantCompletionPublicConfig,
  assistantCompletionServerConfig,
} from '../../../assistant-completion-config'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

export function GET(request: NextRequest) {
  if (!sameOriginRequest(request)) return unavailableResponse(404)
  const config = assistantCompletionPublicConfig()
  if (!config.enabled) {
    return jsonResponse({ enabled: false })
  }
  return jsonResponse(config)
}

export async function POST(request: NextRequest) {
  if (!sameOriginRequest(request)) return unavailableResponse(404)
  const config = assistantCompletionServerConfig()
  if (!config) {
    return unavailableResponse(404)
  }
  let body: unknown
  try {
    const raw = await request.text()
    assertTextBound(raw, DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS.maxProviderRequestBytes, 'provider_request_too_large')
    body = JSON.parse(raw) as unknown
  } catch {
    return unavailableResponse(400)
  }
  let providerRequest: ReturnType<typeof normalizeProviderRequest>
  try {
    providerRequest = normalizeProviderRequest(body, request.signal)
  } catch {
    return unavailableResponse(400)
  }
  if (!providerRequest) {
    return unavailableResponse(400)
  }
  try {
    assertSerializedBound(providerRequest, DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS.maxProviderRequestBytes, 'provider_request_too_large')
    const provider = createOpenAICompatibleToolProvider(config)
    const response = await provider.complete(providerRequest)
    return jsonResponse(response)
  } catch (error) {
    const status = error instanceof LightweightOrchestratorError && error.reasonCode.includes('too_large')
      ? 400
      : 502
    return unavailableResponse(status)
  }
}

function normalizeProviderRequest(body: unknown, signal: AbortSignal) {
  if (!body || typeof body !== 'object') return null
  const value = body as {
    messages?: unknown
    tools?: unknown
    maxToolCalls?: unknown
  }
  if (!Array.isArray(value.messages) || !Array.isArray(value.tools)) return null
  if (
    value.messages.length > DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS.maxHistoryMessages
    || value.tools.length > DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS.maxToolSchemas
  ) return null
  const maxToolCalls = typeof value.maxToolCalls === 'number' && Number.isFinite(value.maxToolCalls)
    ? Math.max(0, Math.floor(value.maxToolCalls))
    : 0
  if (maxToolCalls > DEFAULT_LIGHTWEIGHT_ORCHESTRATOR_LIMITS.maxTotalTools) return null
  const messages = value.messages.filter(isProviderMessage)
  const tools = value.tools.filter(isProjectionTool)
  if (messages.length !== value.messages.length || tools.length !== value.tools.length) return null
  return {
    messages,
    tools,
    maxToolCalls,
    signal,
  }
}

function isProviderMessage(value: unknown): value is LightweightProviderMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    role?: unknown
    content?: unknown
    toolCallId?: unknown
    name?: unknown
  }
  return (
    (candidate.role === 'system'
      || candidate.role === 'user'
      || candidate.role === 'assistant'
      || candidate.role === 'tool')
    && typeof candidate.content === 'string'
    && (candidate.toolCallId === undefined || candidate.toolCallId === null || typeof candidate.toolCallId === 'string')
    && (candidate.name === undefined || candidate.name === null || typeof candidate.name === 'string')
  )
}

function isProjectionTool(value: unknown): value is ToolingProjectionToolInfo {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    global_tool_id?: unknown
    execution_location?: unknown
    exportable?: unknown
    provider_available?: unknown
    args_schema?: unknown
  }
  return (
    typeof candidate.global_tool_id === 'string'
    && (candidate.execution_location === 'local' || candidate.execution_location === 'remote')
    && typeof candidate.exportable === 'boolean'
    && (candidate.provider_available === undefined
      || candidate.provider_available === null
      || typeof candidate.provider_available === 'boolean')
    && candidate.args_schema !== null
    && typeof candidate.args_schema === 'object'
    && !Array.isArray(candidate.args_schema)
  )
}

function sameOriginRequest(request: NextRequest): boolean {
  const requestOrigin = effectiveRequestOrigin(request)
  const origin = request.headers.get('origin')
  if (origin && origin !== requestOrigin) return false
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  const referer = request.headers.get('referer')
  if (!origin && referer) {
    try {
      if (new URL(referer).origin !== requestOrigin) return false
    } catch {
      return false
    }
  }
  return true
}

function effectiveRequestOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim()
  const host = forwardedHost || request.headers.get('host')
  if (!host) return request.nextUrl.origin
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim()
  const protocol =
    forwardedProtocol === 'http' || forwardedProtocol === 'https'
      ? forwardedProtocol
      : request.nextUrl.protocol.replace(/:$/u, '')
  try {
    return new URL(`${protocol}://${host}`).origin
  } catch {
    return request.nextUrl.origin
  }
}

function jsonResponse(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: noStoreHeaders(),
  })
}

function unavailableResponse(
  status: number,
  body: unknown = { ok: false, error: 'assistant_unavailable' },
): NextResponse {
  return jsonResponse(body, status)
}

function noStoreHeaders(): HeadersInit {
  return {
    'cache-control': 'no-store, max-age=0',
  }
}
